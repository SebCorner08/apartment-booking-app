const jwt = require("jsonwebtoken");

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
    const { guest_name, guest_email, description, amount } = req.body;
    if (!guest_name || !guest_email || !description || !amount) {
      return res.status(400).json({
        error:
          "Missing required fields: guest_name, guest_email, description, amount",
      });
    }
    if (amount <= 0) return res.status(400).json({ error: "Amount must be greater than 0" });

    const sql = `
      INSERT INTO manual_charges (guest_name, guest_email, description, amount)
      VALUES (?, ?, ?, ?)
    `;
    db.run(
      sql,
      [guest_name, guest_email, description, amount],
      async function (err) {
        if (err) return res.status(500).json({ error: err.message });

        const chargeId = this.lastID;
        let sessionId = null;
        let sessionUrl = null;

        if (mockPayments) {
          sessionId = `mock_charge_${Date.now()}`;
          sessionUrl = `${domain}/success.html?charge_id=${chargeId}`;
          db.run(
            `UPDATE manual_charges SET stripe_session_id = ? WHERE id = ?`,
            [sessionId, chargeId],
          );
        } else if (stripe) {
          try {
            const session = await stripe.checkout.sessions.create({
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
            });
            sessionId = session.id;
            sessionUrl = session.url;
            db.run(
              `UPDATE manual_charges SET stripe_session_id = ? WHERE id = ?`,
              [sessionId, chargeId],
            );
          } catch (stripeErr) {
            console.error("Stripe error creating manual charge:", stripeErr);
          }
        }

        broadcastAdminUpdate();
        res.status(201).json({
          message: "Charge created",
          id: chargeId,
          stripe_session_id: sessionId,
          url: sessionUrl,
        });
      },
    );
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
