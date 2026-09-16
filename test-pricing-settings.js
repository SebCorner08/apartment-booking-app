"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  DEFAULT_PRICING,
  buildDefaultPricing,
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
  () => buildDefaultPricing({ MINIMUM_NIGHTS: "2.5" }),
  /positive integer/,
);
assert.throws(
  () => buildDefaultPricing({ NIGHTLY_RATE: "0" }),
  /greater than zero/,
);
assert.throws(
  () => buildDefaultPricing({ MONTHLY_RATE: "not-a-number" }),
  /MONTHLY_RATE must be a finite number/,
);
assert.throws(
  () => buildDefaultPricing({ CLEANING_FEE: "-1" }),
  /cleaning_fee must be a non-negative finite number/,
);
assert.throws(
  () => buildDefaultPricing({ TAX_MECKLENBURG_SALES: "-0.1" }),
  /mecklenburg_sales must be a non-negative finite number/,
);

// database.js must reject invalid bootstrap configuration before SQLite can
// create or seed the configured runtime file.
const invalidBootstrapDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "pricing-bootstrap-invalid-"),
);
const invalidBootstrapDb = path.join(invalidBootstrapDir, "reservations.db");
const invalidBootstrap = spawnSync(
  process.execPath,
  ["-e", "require('./server/database')"],
  {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: "test",
      RESERVATIONS_DB_PATH: invalidBootstrapDb,
      MINIMUM_NIGHTS: "0",
    },
    encoding: "utf8",
  },
);
assert.notStrictEqual(
  invalidBootstrap.status,
  0,
  "invalid bootstrap pricing must stop database initialization",
);
assert.match(
  `${invalidBootstrap.stdout}\n${invalidBootstrap.stderr}`,
  /minimum_nights must be a positive integer/,
);
assert.strictEqual(
  fs.existsSync(invalidBootstrapDb),
  false,
  "invalid bootstrap pricing must fail before creating the database file",
);
fs.rmSync(invalidBootstrapDir, { recursive: true, force: true });

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
