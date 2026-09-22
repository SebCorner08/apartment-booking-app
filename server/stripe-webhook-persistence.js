const { run, get } = require("./db-promises");

async function persistManualCharge(db, session) {
  const metadata = session.metadata || {};
  const chargeId = metadata.charge_id;
  if (!chargeId || session.payment_status !== "paid") return false;

  const result = await run(
    db,
    `UPDATE manual_charges
     SET status = 'paid',
         paid_at = COALESCE(paid_at, datetime('now')),
         stripe_session_id = COALESCE(stripe_session_id, ?)
     WHERE id = ?
       AND COALESCE(status, '') <> 'paid'
       AND (stripe_session_id IS NULL OR stripe_session_id = ?)`,
    [session.id, chargeId, session.id],
  );

  if (result.changes > 0) {
    console.log(`✅ Cobro manual #${chargeId} confirmado vía webhook`);
    return true;
  }

  // A zero-row update is safe only when this is a genuine duplicate delivery.
  const existing = await get(
    db,
    `SELECT id, status, stripe_session_id FROM manual_charges WHERE id = ?`,
    [chargeId],
  );
  if (!existing) {
    throw new Error(`Manual charge #${chargeId} not found`);
  }
  if (
    existing.stripe_session_id &&
    existing.stripe_session_id !== session.id
  ) {
    throw new Error(`Manual charge #${chargeId} belongs to another Stripe session`);
  }
  if (existing.status !== "paid") {
    throw new Error(`Manual charge #${chargeId} was not persisted as paid`);
  }

  return false;
}

async function persistBooking(db, session) {
  const metadata = session.metadata || {};
  const { checkIn, checkOut, hold_id: holdId } = metadata;
  if (!checkIn || !checkOut || session.payment_status !== "paid") return false;

  const rentalType = metadata.rental_type || "short_stay";
  const guests = parseInt(metadata.guests, 10) || 2;
  const insert = await run(
    db,
    `INSERT OR IGNORE INTO bookings
       (checkIn, checkOut, bookingStatus, stripePaymentId, rental_type, guests)
     VALUES (?, ?, 'confirmed', ?, ?, ?)`,
    [checkIn, checkOut, session.id, rentalType, guests],
  );

  if (insert.changes === 0) {
    const existing = await get(
      db,
      `SELECT id, checkIn, checkOut, bookingStatus
       FROM bookings WHERE stripePaymentId = ?`,
      [session.id],
    );
    if (!existing) {
      throw new Error(
        `Booking for Stripe session ${session.id} was ignored but no existing booking was found`,
      );
    }
    if (
      existing.checkIn !== checkIn ||
      existing.checkOut !== checkOut ||
      existing.bookingStatus !== "confirmed"
    ) {
      throw new Error(
        `Existing booking for Stripe session ${session.id} does not match the paid session`,
      );
    }
  } else {
    console.log(`✅ Reserva confirmada vía webhook: ${checkIn} → ${checkOut}`);
  }

  if (holdId) {
    // The hold update is part of webhook persistence. A database error must
    // fail the webhook so Stripe retries. A missing/already-confirmed hold is
    // not fatal because the booking itself is already durably idempotent.
    await run(
      db,
      `UPDATE booking_holds
       SET status = 'confirmed',
           stripe_session_id = COALESCE(?, stripe_session_id)
       WHERE id = ?`,
      [session.id, holdId],
    );
  }

  return insert.changes > 0;
}

async function releaseFailedOrExpiredHold(db, session) {
  const holdId = session.metadata?.hold_id;
  if (holdId) {
    await run(
      db,
      `UPDATE booking_holds
       SET status = 'released'
       WHERE id = ? AND status = 'active'`,
      [holdId],
    );
  }

  if (session.id) {
    await run(
      db,
      `UPDATE booking_holds
       SET status = 'released'
       WHERE stripe_session_id = ? AND status = 'active'`,
      [session.id],
    );
  }

  console.log(`🔓 Bloqueo liberado por pago expirado/fallido: ${session.id}`);
}

async function processStripeEvent({ event, db, broadcastAdminUpdate = () => {} }) {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    let changed = false;

    // Await every required write before the webhook can acknowledge Stripe.
    changed = (await persistManualCharge(db, session)) || changed;
    changed = (await persistBooking(db, session)) || changed;

    if (changed) broadcastAdminUpdate();
    return { handled: true, changed };
  }

  if (
    event.type === "checkout.session.expired" ||
    event.type === "checkout.session.async_payment_failed"
  ) {
    await releaseFailedOrExpiredHold(db, event.data.object);
    return { handled: true, changed: true };
  }

  return { handled: false, changed: false };
}

async function handleStripeWebhookRequest({
  req,
  res,
  stripe,
  db,
  webhookSecret,
  broadcastAdminUpdate = () => {},
  logger = console,
}) {
  if (!webhookSecret) {
    logger.error(
      "STRIPE_WEBHOOK_SECRET no configurado; el webhook no puede verificarse.",
    );
    return res.status(500).send("Webhook not configured");
  }

  if (!stripe?.webhooks?.constructEvent) {
    logger.error("Stripe no configurado; el webhook no puede verificarse.");
    return res.status(500).send("Stripe not configured");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      webhookSecret,
    );
  } catch (err) {
    logger.error("Firma de webhook de Stripe inválida:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await processStripeEvent({ event, db, broadcastAdminUpdate });
  } catch (err) {
    // Do not acknowledge Stripe until all required persistence succeeds.
    // A 5xx response tells Stripe to retry the signed event later.
    logger.error("Error persistiendo webhook de Stripe:", err.message);
    return res.status(500).json({ error: "Webhook persistence failed" });
  }

  return res.json({ received: true });
}

module.exports = {
  handleStripeWebhookRequest,
  processStripeEvent,
  persistManualCharge,
  persistBooking,
  releaseFailedOrExpiredHold,
};
