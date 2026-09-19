const jwt = require("jsonwebtoken");
const { get: getDb, run: runDb } = require("../db-promises");

// Stripe may prune idempotency keys once they are at least 24 hours old.
const STRIPE_IDEMPOTENCY_SAFE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MANUAL_CHARGE_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeManualChargeRequestId(requestId) {
  if (
    typeof requestId !== "string" ||
    !MANUAL_CHARGE_REQUEST_ID_PATTERN.test(requestId)
  ) {
    return null;
  }
  return requestId.toLowerCase();
}

function manualChargeMatches(row, {
  guest_name,
  guest_email,
  description,
  amount,
}) {
  return (
    row.guest_name === guest_name &&
    row.guest_email === guest_email &&
    row.description === description &&
    Number(row.amount) === Number(amount)
  );
}

function manualChargeSessionParams({
  chargeId,
  requestId,
  guest_name,
  guest_email,
  description,
  amount,
  domain,
}) {
  return {
    payment_method_types: ["card"],
    customer_email: guest_email,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: description,
            description: `Manual charge for ${guest_name}`,
          },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    success_url: `${domain}/success.html?charge_id=${chargeId}`,
    cancel_url: `${domain}/cancel.html`,
    metadata: {
      charge_id: String(chargeId),
      request_id: requestId,
      guest_name,
      guest_email,
    },
  };
}

function validateStripeSession(
  session,
  chargeId,
  requestId,
  charge,
  { expectedSessionId = null, requirePaid = false } = {},
) {
  const metadata = session && session.metadata;
  const expectedAmount = Math.round(Number(charge.amount) * 100);

  if (
    !session ||
    !session.id ||
    (expectedSessionId != null && session.id !== expectedSessionId) ||
    (requirePaid && session.payment_status !== "paid") ||
    !metadata ||
    metadata.charge_id !== String(chargeId) ||
    metadata.request_id !== requestId ||
    metadata.guest_name !== charge.guest_name ||
    metadata.guest_email !== charge.guest_email ||
    session.mode !== "payment" ||
    session.amount_total !== expectedAmount ||
    session.currency !== "usd"
  ) {
    const error = new Error("Stripe session does not match the manual charge");
    error.statusCode = 409;
    error.requiresManualReconciliation = true;
    throw error;
  }
}

async function claimManualCharge(db, requestId, charge) {
  await runDb(
    db,
    `INSERT INTO manual_charges
       (guest_name, guest_email, description, amount, request_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(request_id) WHERE request_id IS NOT NULL DO NOTHING`,
    [
      charge.guest_name,
      charge.guest_email,
      charge.description,
      charge.amount,
      requestId,
    ],
  );

  const claimed = await getDb(
    db,
    `SELECT * FROM manual_charges WHERE request_id = ?`,
    [requestId],
  );
  if (!claimed) {
    throw new Error("Manual charge request claim was not persisted");
  }
  return claimed;
}

async function findLegacyUnresolvedCharge(db, charge) {
  return getDb(
    db,
    `SELECT * FROM manual_charges
     WHERE request_id IS NULL
       AND guest_name = ?
       AND guest_email = ?
       AND description = ?
       AND amount = ?
       AND status = 'pending'
       AND stripe_session_id IS NULL
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [
      charge.guest_name,
      charge.guest_email,
      charge.description,
      charge.amount,
    ],
  );
}

function manualChargeCreatedAtMs(createdAt) {
  if (typeof createdAt !== "string" || !createdAt.trim()) return null;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(createdAt);
  const normalized = hasTimezone
    ? createdAt
    : `${createdAt.replace(" ", "T")}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function canRetryStripeCreate(existingCharge, now = Date.now()) {
  const createdAt = manualChargeCreatedAtMs(existingCharge.created_at);
  if (createdAt == null) return false;
  const age = now - createdAt;
  return age >= 0 && age < STRIPE_IDEMPOTENCY_SAFE_WINDOW_MS;
}

async function persistManualChargeSession(db, chargeId, sessionId) {
  const result = await runDb(
    db,
    `UPDATE manual_charges
     SET stripe_session_id = ?
     WHERE id = ?
       AND status = 'pending'
       AND stripe_session_id IS NULL`,
    [sessionId, chargeId],
  );

  if (result.changes === 1) return true;

  const existing = await getDb(
    db,
    `SELECT status, stripe_session_id FROM manual_charges WHERE id = ?`,
    [chargeId],
  );
  if (
    existing &&
    existing.stripe_session_id === sessionId &&
    (existing.status === "pending" || existing.status === "paid")
  ) {
    return false;
  }

  const error = new Error(
    "Manual charge state changed before its Stripe session could be linked",
  );
  error.requiresManualReconciliation = true;
  throw error;
}

function manualChargeRecoveryBody(error, chargeId) {
  return {
    error,
    code: "MANUAL_CHARGE_RECOVERY_REQUIRED",
    recovery: { charge_id: chargeId },
  };
}

function manualChargeReconciliationBody(error, chargeId) {
  return {
    error,
    code: "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
    recovery: { charge_id: chargeId },
  };
}

function manualChargeRequestBody(error, code, chargeId) {
  const body = { error, code };
  if (chargeId != null) body.recovery = { charge_id: chargeId };
  return body;
}

function registerAdminRoutes(app, {
  loginLimiter,
  adminPassword,
  jwtSecret,
  adminSessionMinutes,
  adminWsTicketTtlMs,
  adminCookieOptions,
  isAllowedOrigin,
  checkAdminAuth,
  issueAdminWebSocketTicket,
  db,
  broadcastAdminUpdate,
  mockPayments,
  domain,
  stripe,
}) {
  app.post("/api/admin/login", loginLimiter, (req, res) => {
    const { password } = req.body;
    if (password === adminPassword) {
      const user = { name: "admin", role: "admin" };
      const token = jwt.sign(user, jwtSecret, {
        expiresIn: `${adminSessionMinutes}m`,
      });
      res.cookie("admin_session", token, adminCookieOptions());
      res.json({
        user,
        session_expires_in_minutes: adminSessionMinutes,
      });
    } else {
      res.status(401).json({ error: "Invalid password" });
    }
  });

  app.post("/api/admin/logout", (req, res) => {
    if (!isAllowedOrigin(req.headers.origin)) return res.sendStatus(403);
    const options = adminCookieOptions();
    delete options.maxAge;
    res.clearCookie("admin_session", options);
    res.sendStatus(204);
  });

  app.post("/api/admin/websocket-ticket", checkAdminAuth, (req, res) => {
    const ticket = issueAdminWebSocketTicket(req.headers.origin, req.user);
    if (!ticket) return res.sendStatus(401);
    res.set("Cache-Control", "no-store");
    res.json({
      ticket,
      expires_in_seconds: adminWsTicketTtlMs / 1000,
    });
  });

  app.get("/api/admin/bookings", checkAdminAuth, (req, res) => {
    db.all("SELECT * FROM bookings ORDER BY checkIn DESC", [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const nowStr = new Date().toISOString().split("T")[0];
      res.json({
        active: rows.filter(
          (row) => row.bookingStatus === "confirmed" && row.checkOut > nowStr,
        ),
        completed: rows.filter(
          (row) => row.bookingStatus === "confirmed" && row.checkOut <= nowStr,
        ),
        cancelled: rows.filter((row) => row.bookingStatus === "cancelled"),
      });
    });
  });

  app.post("/api/admin/bookings/:id/cancel", checkAdminAuth, (req, res) => {
    db.run(
      `UPDATE bookings SET bookingStatus = 'cancelled' WHERE id = ?`,
      [req.params.id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        broadcastAdminUpdate();
        res.json({ message: "Booking cancelled", changes: this.changes });
      },
    );
  });

  app.delete("/api/admin/bookings/:id", checkAdminAuth, (req, res) => {
    db.run(`DELETE FROM bookings WHERE id = ?`, [req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      broadcastAdminUpdate();
      res.json({ message: "Booking deleted", changes: this.changes });
    });
  });

  app.post("/api/admin/charges", checkAdminAuth, async (req, res) => {
    const {
      guest_name,
      guest_email,
      description,
      amount,
      request_id: rawRequestId,
      recovery_charge_id: recoveryChargeId,
    } = req.body;
    if (!guest_name || !guest_email || !description || !amount) {
      return res.status(400).json({
        error:
          "Missing required fields: guest_name, guest_email, description, amount",
      });
    }
    const normalizedAmount = Number(amount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      return res
        .status(400)
        .json({ error: "Amount must be greater than 0" });
    }

    if (rawRequestId == null || rawRequestId === "") {
      return res.status(400).json(
        manualChargeRequestBody(
          "A request_id is required for safe manual-charge retries",
          "MANUAL_CHARGE_REQUEST_ID_REQUIRED",
        ),
      );
    }
    const requestId = normalizeManualChargeRequestId(rawRequestId);
    if (!requestId) {
      return res.status(400).json(
        manualChargeRequestBody(
          "request_id must be a canonical UUID v4",
          "MANUAL_CHARGE_REQUEST_ID_INVALID",
        ),
      );
    }

    const charge = {
      guest_name,
      guest_email,
      description,
      amount: normalizedAmount,
    };
    let chargeId;
    let existingCharge;

    try {
      if (recoveryChargeId != null) {
        chargeId = Number(recoveryChargeId);
        if (!Number.isSafeInteger(chargeId) || chargeId <= 0) {
          return res.status(400).json({ error: "Invalid recovery_charge_id" });
        }

        existingCharge = await getDb(
          db,
          `SELECT * FROM manual_charges WHERE id = ?`,
          [chargeId],
        );
        if (!existingCharge) {
          return res.status(404).json({ error: "Manual charge not found" });
        }
      } else {
        existingCharge = await getDb(
          db,
          `SELECT * FROM manual_charges WHERE request_id = ?`,
          [requestId],
        );

        if (!existingCharge) {
          const legacyCharge = await findLegacyUnresolvedCharge(db, charge);
          if (legacyCharge) {
            return res.status(409).json(
              manualChargeReconciliationBody(
                "A matching legacy charge has no durable request identity; reconcile it in Stripe before continuing",
                legacyCharge.id,
              ),
            );
          }

          existingCharge = await claimManualCharge(db, requestId, charge);
        }
        chargeId = existingCharge.id;
      }

      if (existingCharge.request_id == null) {
        return res.status(409).json(
          manualChargeReconciliationBody(
            "This legacy charge has no durable request identity; reconcile it in Stripe before continuing",
            chargeId,
          ),
        );
      }
      if (existingCharge.request_id !== requestId) {
        return res.status(409).json(
          manualChargeRequestBody(
            "request_id does not match the existing manual charge",
            "MANUAL_CHARGE_REQUEST_ID_CONFLICT",
            chargeId,
          ),
        );
      }
      if (!manualChargeMatches(existingCharge, charge)) {
        return res.status(409).json(
          manualChargeRequestBody(
            "request_id is already bound to different manual-charge fields",
            "MANUAL_CHARGE_REQUEST_ID_CONFLICT",
            chargeId,
          ),
        );
      }
      if (
        existingCharge.status === "paid" &&
        existingCharge.stripe_session_id == null
      ) {
        return res.status(409).json(
          manualChargeReconciliationBody(
            "This paid manual charge has no durable Stripe session linkage; reconcile it in Stripe before continuing",
            chargeId,
          ),
        );
      }
      if (
        existingCharge.status !== "pending" &&
        existingCharge.status !== "paid"
      ) {
        return res.status(409).json(
          manualChargeReconciliationBody(
            "This manual charge is not pending or durably paid; reconcile it before continuing",
            chargeId,
          ),
        );
      }
    } catch (dbErr) {
      return res.status(500).json({ error: dbErr.message });
    }

    const isPaidRetry = existingCharge.status === "paid";
    let sessionId = existingCharge.stripe_session_id;
    let sessionUrl = null;

    try {
      if (mockPayments) {
        const expectedSessionId = `mock_charge_${chargeId}`;
        if (sessionId != null && sessionId !== expectedSessionId) {
          if (isPaidRetry) {
            return res.status(409).json(
              manualChargeReconciliationBody(
                "The paid manual charge is linked to an unexpected mock payment session",
                chargeId,
              ),
            );
          }
          return res.status(409).json({
            error: "Manual charge is already linked to another session",
          });
        }
        sessionId = expectedSessionId;
        sessionUrl = `${domain}/success.html?charge_id=${chargeId}`;
      } else if (stripe) {
        let session;
        if (sessionId != null) {
          session = await stripe.checkout.sessions.retrieve(sessionId);
        } else {
          if (!canRetryStripeCreate(existingCharge)) {
            return res.status(409).json(
              manualChargeReconciliationBody(
                "Automatic recovery is no longer safe; reconcile this charge in Stripe before continuing",
                chargeId,
              ),
            );
          }
          session = await stripe.checkout.sessions.create(
            manualChargeSessionParams({
              chargeId,
              requestId,
              ...charge,
              domain,
            }),
            { idempotencyKey: `manual-charge-${requestId}` },
          );
        }

        validateStripeSession(session, chargeId, requestId, charge, {
          expectedSessionId: existingCharge.stripe_session_id,
          requirePaid: isPaidRetry,
        });
        sessionId = session.id;
        sessionUrl = session.url;
      } else if (sessionId != null || recoveryChargeId != null) {
        return res.status(503).json(
          manualChargeRecoveryBody(
            "Payment provider is unavailable; retry this existing charge when configuration is restored",
            chargeId,
          ),
        );
      }
    } catch (stripeErr) {
      console.error("Stripe error creating or recovering manual charge:", stripeErr);
      if (stripeErr.requiresManualReconciliation) {
        return res.status(409).json(
          manualChargeReconciliationBody(stripeErr.message, chargeId),
        );
      }
      return res.status(stripeErr.statusCode || 502).json(
        manualChargeRecoveryBody(
          "Unable to create or recover the payment session; retry this existing charge",
          chargeId,
        ),
      );
    }

    let shouldBroadcast = !isPaidRetry;
    if (sessionId && !isPaidRetry) {
      try {
        shouldBroadcast = await persistManualChargeSession(
          db,
          chargeId,
          sessionId,
        );
      } catch (dbErr) {
        console.error("Manual charge session persistence failed:", dbErr);
        if (dbErr.requiresManualReconciliation) {
          return res.status(409).json(
            manualChargeReconciliationBody(dbErr.message, chargeId),
          );
        }
        return res.status(503).json(
          manualChargeRecoveryBody(
            "Payment session created but its manual-charge linkage was not saved; retry this existing charge",
            chargeId,
          ),
        );
      }
    }

    if (shouldBroadcast) broadcastAdminUpdate();
    return res.status(201).json({
      message: "Charge created",
      id: chargeId,
      request_id: requestId,
      stripe_session_id: sessionId,
      url: sessionUrl,
    });
  });

  app.get("/api/admin/charges", checkAdminAuth, (req, res) => {
    db.all(
      `SELECT * FROM manual_charges ORDER BY created_at DESC`,
      [],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      },
    );
  });

  app.post("/api/admin/charges/:id/pay", checkAdminAuth, (req, res) => {
    const unclaimedSessionCondition = mockPayments
      ? "(stripe_session_id IS NULL OR stripe_session_id = 'mock_charge_' || id)"
      : "stripe_session_id IS NULL";
    db.run(
      `UPDATE manual_charges
       SET status = 'paid', paid_at = datetime('now')
       WHERE id = ?
         AND status = 'pending'
         AND ${unclaimedSessionCondition}`,
      [req.params.id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes !== 1) {
          return res.status(409).json(
            manualChargeReconciliationBody(
              "Only a pending manual charge without a live Stripe session can be marked paid manually",
              req.params.id,
            ),
          );
        }
        broadcastAdminUpdate();
        res.json({ message: "Charge marked as paid", changes: this.changes });
      },
    );
  });

  app.delete("/api/admin/charges/:id", checkAdminAuth, (req, res) => {
    db.run(
      `DELETE FROM manual_charges WHERE id = ?`,
      [req.params.id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        broadcastAdminUpdate();
        res.json({ message: "Charge deleted", changes: this.changes });
      },
    );
  });
}

module.exports = { registerAdminRoutes };
