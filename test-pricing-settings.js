"use strict";

const assert = require("assert");
const {
  DEFAULT_PRICING,
  normalizePricingRow,
  mergePricingSettings,
  validateRequiredTaxUpdate,
} = require("./server/pricing-settings");

const current = {
  nightly_rate: 275,
  monthly_rate: 2400,
  cleaning_fee: 125,
  mecklenburg_sales: 8.25,
  mecklenburg_occupancy: 8,
  minimum_nights: 12,
};

const taxOnlyUpdate = mergePricingSettings(current, {
  mecklenburg_sales: 7.5,
  mecklenburg_occupancy: 6,
});

assert.strictEqual(
  taxOnlyUpdate.nightly_rate,
  275,
  "a tax-only update must preserve nightly_rate",
);
assert.strictEqual(taxOnlyUpdate.monthly_rate, 2400);
assert.strictEqual(taxOnlyUpdate.cleaning_fee, 125);
assert.strictEqual(taxOnlyUpdate.minimum_nights, 12);
assert.strictEqual(taxOnlyUpdate.mecklenburg_sales, 7.5);
assert.strictEqual(taxOnlyUpdate.mecklenburg_occupancy, 6);

const emptyDatabase = normalizePricingRow(null);
assert.deepStrictEqual(emptyDatabase, DEFAULT_PRICING);

assert.throws(
  () => mergePricingSettings(current, { minimum_nights: 2.5 }),
  /positive integer/,
);
assert.throws(
  () => mergePricingSettings(current, { nightly_rate: 0 }),
  /greater than zero/,
);

assert.throws(
  () =>
    validateRequiredTaxUpdate({
      mecklenburg_sales: null,
      mecklenburg_occupancy: 5,
    }),
  /Missing tax rates/,
);
assert.throws(
  () =>
    validateRequiredTaxUpdate({
      mecklenburg_sales: 7.5,
      mecklenburg_occupancy: null,
    }),
  /Missing tax rates/,
);
assert.throws(() => validateRequiredTaxUpdate(null), /payload must be an object/);
assert.deepStrictEqual(
  validateRequiredTaxUpdate({
    mecklenburg_sales: 7.5,
    mecklenburg_occupancy: 5,
  }),
  { mecklenburg_sales: 7.5, mecklenburg_occupancy: 5 },
);

console.log("Pricing configuration tests passed");
