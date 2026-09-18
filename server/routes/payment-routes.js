function registerStripeWebhookRoute(app, {
  express,
  stripe,
  db,
  webhookSecret,
  broadcastAdminUpdate,
}) {
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const {
        handleStripeWebhookRequest,
      } = require("../stripe-webhook-persistence");
      return handleStripeWebhookRequest({
        req,
        res,
        stripe,
        db,
        webhookSecret,
        broadcastAdminUpdate,
      });
    },
  );
}

function registerPaymentRoutes(app, {
  checkoutLimiter,
  mockPayments,
  mockSessions,
  stripe,
  db,
  domain,
  airbnbIcalUrl,
  maxGuests,
  maxAdvanceMonths,
  pricingService,
  bookingService,
  syncAirbnbCalendar,
  broadcastAdminUpdate,
}) {
  app.post("/api/create-checkout-session", checkoutLimiter, async (req, res) => {
    const { checkIn, checkOut, rental_type, months, guests } = req.body;

    if (!mockPayments && !stripe) {
      return res
        .status(503)
        .json({ error: "Payments are not configured on the server" });
    }

    const guestsInt = guests === undefined ? 2 : parseInt(guests, 10);
    if (!Number.isInteger(guestsInt) || guestsInt < 1 || guestsInt > maxGuests) {
      return res
        .status(400)
        .json({ error: `Guests must be between 1 and ${maxGuests}` });
    }

    const todayStr = new Date().toISOString().split("T")[0];
    const maxAdvanceDate = new Date();
    maxAdvanceDate.setUTCMonth(maxAdvanceDate.getUTCMonth() + maxAdvanceMonths);
    const maxAdvanceStr = maxAdvanceDate.toISOString().split("T")[0];

    let finalCheckIn = checkIn;
    let finalCheckOut = checkOut;
    let nights = null;
    let monthsInt = null;

    if (rental_type === "monthly") {
      monthsInt = parseInt(months, 10);
      if (!Number.isInteger(monthsInt) || monthsInt < 1 || monthsInt > 12) {
        return res.status(400).json({ error: "Invalid number of months" });
      }
      if (!bookingService.isDateString(checkIn) || checkIn < todayStr) {
        return res.status(400).json({ error: "Missing or invalid start date" });
      }
      if (checkIn > maxAdvanceStr) {
        return res.status(400).json({
          error: `Bookings can only be made up to ${maxAdvanceMonths} months in advance`,
        });
      }
      const end = new Date(`${checkIn}T00:00:00Z`);
      end.setUTCMonth(end.getUTCMonth() + monthsInt);
      finalCheckOut = end.toISOString().split("T")[0];
    } else {
      nights = bookingService.nightsBetween(checkIn, checkOut);
      if (!nights) {
        return res
          .status(400)
          .json({ error: "Missing or invalid check-in/check-out dates" });
      }
      if (checkIn < todayStr) {
        return res
          .status(400)
          .json({ error: "Check-in date cannot be in the past" });
      }
      if (checkIn > maxAdvanceStr) {
        return res.status(400).json({
          error: `Bookings can only be made up to ${maxAdvanceMonths} months in advance`,
        });
      }
      if (nights > pricingService.MAX_NIGHTS) {
        return res
          .status(400)
          .json({ error: `Maximum stay is ${pricingService.MAX_NIGHTS} nights` });
      }
    }

    let holdId = null;
    try {
      const rates = await pricingService.loadRatesFromDB();
      if (rental_type !== "monthly" && nights < rates.minimum_nights) {
        return res
          .status(400)
          .json({ error: `Minimum stay is ${rates.minimum_nights} nights` });
      }
      const pricing =
        rental_type === "monthly"
          ? pricingService.calculateMonthlyPrice(monthsInt, rates.monthly_rate, rates)
          : pricingService.calculateTotalPrice(
              nights,
              rates.nightly_rate,
              rates.cleaning_fee,
              rates,
            );

      if (!pricing.total || pricing.total <= 0) {
        return res.status(400).json({ error: "Invalid booking amount" });
      }

      if (airbnbIcalUrl) await syncAirbnbCalendar();

      bookingService.cleanupExpiredHolds();
      holdId = await bookingService.createHold({
        checkIn: finalCheckIn,
        checkOut: finalCheckOut,
        rentalType: rental_type === "monthly" ? "monthly" : "short_stay",
      });
      if (!holdId) {
        return res
          .status(409)
          .json({ error: "Selected dates are no longer available" });
      }

      const metadata = {
        hold_id: holdId,
        checkIn: finalCheckIn,
        checkOut: finalCheckOut,
        rental_type: rental_type === "monthly" ? "monthly" : "short_stay",
        guests: String(guestsInt),
      };

      let productName;
      let productDescription;
      if (rental_type === "monthly") {
        metadata.months = String(monthsInt);
        productName = "Lakeside Serenity - Monthly Rental";
        productDescription = `${monthsInt} month(s): ${finalCheckIn} to ${finalCheckOut}`;
      } else {
        metadata.nights = String(nights);
        productName = "Lakeside Serenity - Apartment Stay";
        productDescription = `${nights} night(s): ${finalCheckIn} to ${finalCheckOut}`;
      }

      if (mockPayments) {
        const mockId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        mockSessions.set(mockId, { payment_status: "paid", metadata });
        db.run(`UPDATE booking_holds SET stripe_session_id = ? WHERE id = ?`, [
          mockId,
          holdId,
        ]);
        return res.json({
          id: mockId,
          url: `${domain}/success.html?session_id=${mockId}`,
          pricing,
        });
      }

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: productName, description: productDescription },
              unit_amount: Math.round(pricing.total * 100),
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        success_url: `${domain}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${domain}/cancel.html`,
        metadata,
      });

      db.run(`UPDATE booking_holds SET stripe_session_id = ? WHERE id = ?`, [
        session.id,
        holdId,
      ]);
      res.json({ id: session.id, url: session.url, pricing });
    } catch (error) {
      if (holdId) bookingService.releaseHold(holdId);
      console.error("Stripe error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/bookings", async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "Missing required fields" });

    try {
      let session;
      if (mockPayments && sessionId.startsWith("mock_")) {
        const mock = mockSessions.get(sessionId);
        if (!mock) return res.status(400).json({ error: "Mock session not found" });
        session = { id: sessionId, ...mock };
      } else {
        session = await stripe.checkout.sessions.retrieve(sessionId);
      }

      if (session.payment_status !== "paid") {
        return res.status(400).json({ error: "Payment not confirmed" });
      }

      const meta = session.metadata || {};
      const checkIn = meta.checkIn;
      const checkOut = meta.checkOut;
      if (!checkIn || !checkOut) {
        return res.status(400).json({ error: "Session has no booking metadata" });
      }
      const rentalType = meta.rental_type || "short_stay";
      const guests = parseInt(meta.guests, 10) || 2;
      const sql = `INSERT OR IGNORE INTO bookings (checkIn, checkOut, bookingStatus, stripePaymentId, rental_type, guests) VALUES (?, ?, ?, ?, ?, ?)`;
      const params = [
        checkIn,
        checkOut,
        "confirmed",
        session.id,
        rentalType,
        guests,
      ];

      db.run(sql, params, function (err) {
        if (err) {
          console.error("Database error:", err);
          return res.status(500).json({ error: err.message });
        }
        if (this.changes > 0) broadcastAdminUpdate();
        bookingService.confirmHold(meta.hold_id, session.id);
        res.status(201).json({
          message: "Booking created successfully",
          bookingId: this.lastID,
          checkIn,
          checkOut,
        });
      });
    } catch (error) {
      console.error("Booking creation error:", error);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerStripeWebhookRoute, registerPaymentRoutes };
