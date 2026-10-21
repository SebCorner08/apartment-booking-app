function registerPricingRoutes(app, {
  pricingService,
  bookingService,
  checkAdminAuth,
  broadcastAdminUpdate,
}) {
  const {
    MAX_NIGHTS,
    validateRequiredTaxUpdate,
    calculateTotalPrice,
    calculateMonthlyPrice,
    calculateWeeklyPrice,
    weeklyDuration,
    loadRatesFromDB,
    loadTaxSettingsFromDB,
    savePricingSettings,
  } = pricingService;

  app.get("/api/tax-rates", async (req, res) => {
    try {
      res.json(await loadTaxSettingsFromDB());
    } catch (err) {
      console.error("Error loading tax settings:", err);
      res.status(503).json({ error: "Pricing configuration unavailable" });
    }
  });

  app.post("/api/calculate-price", async (req, res) => {
    const { checkIn, checkOut, rental_type, months } = req.body;
    try {
      const rates = await loadRatesFromDB();
      if (rental_type === "monthly") {
        const monthsInt = parseInt(months, 10);
        if (!Number.isInteger(monthsInt) || monthsInt < 1 || monthsInt > 12) {
          return res.status(400).json({ error: "Invalid number of months" });
        }
        return res.json(
          calculateMonthlyPrice(monthsInt, rates.monthly_rate, rates),
        );
      }

      if (rental_type === "weekly") {
        if (rates.weekly_rate <= 0) {
          return res.status(400).json({ error: "Weekly rentals are not currently available" });
        }
        const duration = weeklyDuration(checkIn, checkOut);
        if (!duration) {
          return res.status(400).json({ error: "Weekly stays must be 1–52 whole weeks (7 nights per week) with valid dates" });
        }
        return res.json(calculateWeeklyPrice(
          duration.weeks, rates.weekly_rate, rates.cleaning_fee, rates,
        ));
      }

      const nights = bookingService.nightsBetween(checkIn, checkOut);
      if (!nights) {
        return res
          .status(400)
          .json({ error: "Missing or invalid check-in/check-out dates" });
      }
      if (nights > MAX_NIGHTS) {
        return res
          .status(400)
          .json({ error: `Maximum stay is ${MAX_NIGHTS} nights` });
      }
      if (nights < rates.minimum_nights) {
        return res
          .status(400)
          .json({ error: `Minimum stay is ${rates.minimum_nights} nights` });
      }
      res.json(
        calculateTotalPrice(
          nights,
          rates.nightly_rate,
          rates.cleaning_fee,
          rates,
        ),
      );
    } catch (err) {
      console.error("Error loading rates:", err);
      res.status(503).json({ error: "Pricing configuration unavailable" });
    }
  });

  app.get("/api/monthly-rate", async (req, res) => {
    try {
      const rates = await loadRatesFromDB();
      res.json({ monthly_rate: rates.monthly_rate });
    } catch (err) {
      console.error("Error loading monthly rate:", err);
      res.status(503).json({ error: "Pricing configuration unavailable" });
    }
  });

  app.get("/api/weekly-rate", async (req, res) => {
    try {
      const rates = await loadRatesFromDB();
      res.json({ weekly_rate: rates.weekly_rate, available: rates.weekly_rate > 0 });
    } catch (err) {
      console.error("Error loading weekly rate:", err);
      res.status(503).json({ error: "Pricing configuration unavailable" });
    }
  });

  app.get("/api/admin/monthly-rate", checkAdminAuth, async (req, res) => {
    try {
      const rates = await loadRatesFromDB();
      res.json({ monthly_rate: rates.monthly_rate });
    } catch (err) {
      console.error("Error loading monthly rate:", err);
      res.status(503).json({ error: "Pricing configuration unavailable" });
    }
  });

  app.post("/api/admin/monthly-rate", checkAdminAuth, async (req, res) => {
    const { monthly_rate } = req.body;
    if (monthly_rate === undefined || monthly_rate === null) {
      return res.status(400).json({ error: "Invalid monthly rate" });
    }
    try {
      const pricing = await savePricingSettings({ monthly_rate });
      broadcastAdminUpdate();
      res.json({
        message: "Monthly rate updated",
        monthly_rate: pricing.monthly_rate,
      });
    } catch (err) {
      if (err instanceof TypeError) return res.status(400).json({ error: err.message });
      console.error("Error saving monthly rate:", err);
      res.status(500).json({ error: "Unable to save pricing configuration" });
    }
  });

  app.get("/api/admin/tax-settings", checkAdminAuth, async (req, res) => {
    try {
      res.json(await loadRatesFromDB());
    } catch (err) {
      console.error("Error loading admin pricing settings:", err);
      res.status(503).json({ error: "Pricing configuration unavailable" });
    }
  });

  app.post("/api/admin/tax-settings", checkAdminAuth, async (req, res) => {
    try {
      const updates = validateRequiredTaxUpdate(req.body);
      const pricing = await savePricingSettings(updates);
      broadcastAdminUpdate();
      res.json({ message: "Pricing settings updated", ...pricing });
    } catch (err) {
      if (err instanceof TypeError) return res.status(400).json({ error: err.message });
      console.error("Error saving pricing settings:", err);
      res.status(500).json({ error: "Unable to save pricing configuration" });
    }
  });
}

module.exports = { registerPricingRoutes };
