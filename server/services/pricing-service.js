const {
  DEFAULT_PRICING,
  MAX_NIGHTS,
  normalizePricingRow,
  mergePricingSettings,
  validateRequiredTaxUpdate,
} = require("../pricing-settings");

function createPricingService(db) {
  function getTaxConfig() {
    return {
      mecklenburg_sales: DEFAULT_PRICING.mecklenburg_sales,
      mecklenburg_occupancy: DEFAULT_PRICING.mecklenburg_occupancy,
    };
  }

  function calculateTotalPrice(
    nights,
    pricePerNight,
    cleaningFee = DEFAULT_PRICING.cleaning_fee,
    taxRates = null,
  ) {
    if (!taxRates) taxRates = getTaxConfig();
    const subtotal = nights * pricePerNight;
    const taxableBase = subtotal + cleaningFee;
    const salesTax = (taxableBase * taxRates.mecklenburg_sales) / 100;
    const occupancyTax = (taxableBase * taxRates.mecklenburg_occupancy) / 100;
    const totalTax = salesTax + occupancyTax;
    const total = taxableBase + totalTax;
    return {
      rental_type: "short_stay",
      nights,
      nightly_rate: pricePerNight,
      subtotal: Math.round(subtotal * 100) / 100,
      cleaning_fee: Math.round(cleaningFee * 100) / 100,
      mecklenburg_sales_tax: Math.round(salesTax * 100) / 100,
      mecklenburg_occupancy_tax: Math.round(occupancyTax * 100) / 100,
      total_tax: Math.round(totalTax * 100) / 100,
      total: Math.round(total * 100) / 100,
      tax_rates: {
        mecklenburg_sales: taxRates.mecklenburg_sales,
        mecklenburg_occupancy: taxRates.mecklenburg_occupancy,
      },
    };
  }

  function calculateMonthlyPrice(months, monthlyRate, taxRates = null) {
    if (!taxRates) taxRates = getTaxConfig();
    const subtotal = months * monthlyRate;
    const salesTax = (subtotal * taxRates.mecklenburg_sales) / 100;
    const totalTax = salesTax;
    const total = subtotal + totalTax;
    return {
      rental_type: "monthly",
      months,
      monthly_rate: monthlyRate,
      subtotal: Math.round(subtotal * 100) / 100,
      mecklenburg_sales_tax: Math.round(salesTax * 100) / 100,
      mecklenburg_occupancy_tax: 0,
      total_tax: Math.round(totalTax * 100) / 100,
      total: Math.round(total * 100) / 100,
      tax_rates: {
        mecklenburg_sales: taxRates.mecklenburg_sales,
        mecklenburg_occupancy: taxRates.mecklenburg_occupancy,
      },
    };
  }

  function weeklyDuration(checkIn, checkOut) {
    const validDate = (value) => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(`${value}T00:00:00Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    };
    if (!validDate(checkIn) || !validDate(checkOut)) return null;
    const nights = (new Date(`${checkOut}T00:00:00Z`) - new Date(`${checkIn}T00:00:00Z`)) / 86400000;
    if (nights < 7 || nights > MAX_NIGHTS || nights % 7 !== 0) return null;
    return { nights, weeks: nights / 7 };
  }

  function calculateWeeklyPrice(weeks, weeklyRate, cleaningFee, taxRates) {
    // Use the same fee, tax and rounding policy as short stays, once per stay.
    const { nightly_rate, ...pricing } = calculateTotalPrice(
      weeks, weeklyRate, cleaningFee, taxRates,
    );
    return {
      ...pricing,
      rental_type: "weekly",
      nights: weeks * 7,
      weeks,
      weekly_rate: weeklyRate,
    };
  }

  function getLatestPricingRow() {
    const sql = `
      SELECT nightly_rate, monthly_rate, weekly_rate, cleaning_fee, minimum_nights,
             mecklenburg_sales, mecklenburg_occupancy
      FROM tax_settings
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;
    return db.pricingReady.then(
      () =>
        new Promise((resolve, reject) => {
          db.get(sql, [], (err, row) => (err ? reject(err) : resolve(row)));
        }),
    );
  }

  async function loadRatesFromDB() {
    return normalizePricingRow(await getLatestPricingRow());
  }

  async function loadTaxSettingsFromDB() {
    const rates = await loadRatesFromDB();
    return {
      mecklenburg_sales: rates.mecklenburg_sales,
      mecklenburg_occupancy: rates.mecklenburg_occupancy,
    };
  }

  let pricingUpdateQueue = Promise.resolve();
  function savePricingSettings(updates) {
    const operation = pricingUpdateQueue.then(async () => {
      const pricing = mergePricingSettings(await getLatestPricingRow(), updates);
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO tax_settings (
             nc_state, mecklenburg_local, occupancy,
             nightly_rate, monthly_rate, weekly_rate, cleaning_fee, minimum_nights,
             mecklenburg_sales, mecklenburg_occupancy, updated_at
           ) VALUES (0, 0, 0, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          [
            pricing.nightly_rate,
            pricing.monthly_rate,
            pricing.weekly_rate,
            pricing.cleaning_fee,
            pricing.minimum_nights,
            pricing.mecklenburg_sales,
            pricing.mecklenburg_occupancy,
          ],
          (err) => (err ? reject(err) : resolve()),
        );
      });
      return pricing;
    });
    pricingUpdateQueue = operation.catch(() => {});
    return operation;
  }

  return {
    MAX_NIGHTS,
    validateRequiredTaxUpdate,
    calculateTotalPrice,
    calculateMonthlyPrice,
    calculateWeeklyPrice,
    weeklyDuration,
    loadRatesFromDB,
    loadTaxSettingsFromDB,
    savePricingSettings,
  };
}

module.exports = { createPricingService };
