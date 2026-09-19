const jwt = require("jsonwebtoken");
const { get: getDb, run: runDb } = require("../db-promises");

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
      guest_name,
      guest_email,
    },
  };
}

function validateStripeSession(session, chargeId, charge) {
  const metadata = session && session.metadata;
  const amountMatches =
    session &&
    (session.amount_total == null ||
      session.amount_total === Math.round(Number(charge.amount) * 100));
  const currencyMatches =
    session && (session.currency == null || session.currency === "usd");

  if (
    !session ||
    !session.id ||
    !metadata ||
    metadata.charge_id !== String(chargeId) ||
    metadata.guest_name !== charge.guest_name ||
    metadata.guest_email !== charge.guest_email ||
    session.mode !== "payment" ||
    !amountMatches ||
    !currencyMatches
  ) {
    const error = new Error("Stripe session does not match the manual charge");
    error.statusCode = 409;
    throw error;
  }
}

async function persistManualChargeSession(db, chargeId, sessionId) {
  const result = await runDb(
    db,
    `UPDATE manual_charges
     SET stripe_session_id = ?
     WHERE id = ?
       AND (stripe_session_id IS NULL OR stripe_session_id = ?)`,
    [sessionId, chargeId, sessionId],
  );

  if (result.changes !== 1) {
    throw new Error("Manual charge session linkage was not written");
  }
}

function manualChargeRecoveryBody(error, chargeId) {
  return {
    error,
    code: "MANUAL_CHARGE_RECOVERY_REQUIRED",
    recovery: { charge_id: chargeId },
  };
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
      recovery_charge_id: recoveryChargeId,
    } = req.body;
    if (!guest_name || !guest_email || !description || !amount) {
      return res.status(400).json({
        error:
          "Missing required fields: guest_name, guest_email, description, amount",
      });
    }
    if (amount <= 0) return res.status(400).json({ error: "Amount must be greater than 0" });

    const charge = { guest_name, guest_email, description, amount };
    let chargeId;
    let existingCharge = null;

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
        if (!manualChargeMatches(existingCharge, charge)) {
          return res.status(409).json({
            error: "Recovery request does not match the existing manual charge",
          });
        }
        if (existingCharge.status !== "pending") {
          return res.status(409).json({
            error: "Only pending manual charges can be recovered",
          });
        }
      } else {
        const inserted = await runDb(
          db,
          `INSERT INTO manual_charges
             (guest_name, guest_email, description, amount)
           VALUES (?, ?, ?, ?)`,
          [guest_name, guest_email, description, amount],
        );
        chargeId = inserted.lastID;
      }
    } catch (dbErr) {
      return res.status(500).json({ error: dbErr.message });
    }

    let sessionId = existingCharge && existingCharge.stripe_session_id;
    let sessionUrl = null;

    try {
      if (mockPayments) {
        const expectedSessionId = `mock_charge_${chargeId}`;
        if (sessionId != null && sessionId !== expectedSessionId) {
          return res.status(409).json({
            error: "Manual charge is already linked to another session",
          });
        }
        sessionId = expectedSessionId;
        sessionUrl = `${domain}/success.html?charge_id=${chargeId}`;
      } else if (stripe) {
        const session = sessionId != null
          ? await stripe.checkout.sessions.retrieve(sessionId)
          : await stripe.checkout.sessions.create(
              manualChargeSessionParams({ chargeId, ...charge, domain }),
              { idempotencyKey: `manual-charge-${chargeId}` },
            );

        validateStripeSession(session, chargeId, charge);
        sessionId = session.id;
        sessionUrl = session.url;
      } else if (recoveryChargeId != null) {
        return res.status(503).json(
          manualChargeRecoveryBody(
            "Payment provider is unavailable; retry this existing charge when configuration is restored",
            chargeId,
          ),
        );
      }
    } catch (stripeErr) {
      console.error("Stripe error creating or recovering manual charge:", stripeErr);
      return res.status(stripeErr.statusCode || 502).json(
        manualChargeRecoveryBody(
          stripeErr.statusCode === 409
            ? stripeErr.message
            : "Unable to create or recover the payment session; retry this existing charge",
          chargeId,
        ),
      );
    }

    if (sessionId) {
      try {
        await persistManualChargeSession(db, chargeId, sessionId);
      } catch (dbErr) {
        console.error("Manual charge session persistence failed:", dbErr);
        return res.status(503).json(
          manualChargeRecoveryBody(
            "Payment session created but its manual-charge linkage was not saved; retry this existing charge",
            chargeId,
          ),
        );
      }
    }

    broadcastAdminUpdate();
    return res.status(201).json({
      message: "Charge created",
      id: chargeId,
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
    db.run(
      `UPDATE manual_charges SET status = 'paid', paid_at = datetime('now') WHERE id = ?`,
      [req.params.id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
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
