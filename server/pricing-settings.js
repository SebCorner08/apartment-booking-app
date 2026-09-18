"use strict";

const MAX_NIGHTS = 365;

const PRICING_FIELDS = [
  "nightly_rate",
  "monthly_rate",
  "cleaning_fee",
  "mecklenburg_sales",
  "mecklenburg_occupancy",
  "minimum_nights",
];

function envNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function validatePricingSettings(pricing) {
  for (const field of PRICING_FIELDS) {
    if (!Number.isFinite(pricing[field]) || pricing[field] < 0) {
      throw new TypeError(`${field} must be a non-negative finite number`);
    }
  }

  if (!Number.isInteger(pricing.minimum_nights) || pricing.minimum_nights < 1) {
    throw new TypeError("minimum_nights must be a positive integer");
  }
  if (pricing.minimum_nights > MAX_NIGHTS) {
    throw new TypeError(
      `minimum_nights must not exceed the ${MAX_NIGHTS}-night maximum stay`,
    );
  }
  if (pricing.nightly_rate <= 0 || pricing.monthly_rate <= 0) {
    throw new TypeError("nightly_rate and monthly_rate must be greater than zero");
  }

  return pricing;
}

function buildDefaultPricing(env = process.env) {
  return Object.freeze(
    validatePricingSettings({
      nightly_rate: envNumber(env, "NIGHTLY_RATE", 150),
      monthly_rate: envNumber(env, "MONTHLY_RATE", 1800),
      cleaning_fee: envNumber(env, "CLEANING_FEE", 0),
      mecklenburg_sales: envNumber(env, "TAX_MECKLENBURG_SALES", 8.25),
      mecklenburg_occupancy: envNumber(
        env,
        "TAX_MECKLENBURG_OCCUPANCY",
        8.0,
      ),
      minimum_nights: envNumber(env, "MINIMUM_NIGHTS", 10),
    }),
  );
}

// Environment values are bootstrap/fallback defaults only. Once a tax_settings
// row exists, the latest row is the runtime source of truth for every field.
// Validate before database.js can seed a row so invalid deployment settings
// fail closed instead of becoming the persisted source of truth.
const DEFAULT_PRICING = buildDefaultPricing();

function normalizePricingRow(row) {
  return validatePricingSettings(
    Object.fromEntries(
      PRICING_FIELDS.map((field) => [
        field,
        row && row[field] != null
          ? Number(row[field])
          : DEFAULT_PRICING[field],
      ]),
    ),
  );
}

function mergePricingSettings(current, updates) {
  const merged = normalizePricingRow(current);

  for (const field of PRICING_FIELDS) {
    if (updates[field] !== undefined && updates[field] !== null) {
      const value = Number(updates[field]);
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`${field} must be a non-negative number`);
      }
      merged[field] = value;
    }
  }

  return validatePricingSettings(merged);
}

function validateRequiredTaxUpdate(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Pricing settings payload must be an object");
  }
  if (
    payload.mecklenburg_sales === undefined ||
    payload.mecklenburg_sales === null ||
    payload.mecklenburg_occupancy === undefined ||
    payload.mecklenburg_occupancy === null
  ) {
    throw new TypeError("Missing tax rates");
  }
  return payload;
}

module.exports = {
  DEFAULT_PRICING,
  MAX_NIGHTS,
  PRICING_FIELDS,
  buildDefaultPricing,
  validatePricingSettings,
  normalizePricingRow,
  mergePricingSettings,
  validateRequiredTaxUpdate,
};
