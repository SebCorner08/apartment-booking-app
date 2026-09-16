"use strict";

const PRICING_FIELDS = [
  "nightly_rate",
  "monthly_rate",
  "cleaning_fee",
  "mecklenburg_sales",
  "mecklenburg_occupancy",
  "minimum_nights",
];

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

// Environment values are bootstrap/fallback defaults only. Once a tax_settings
// row exists, the latest row is the runtime source of truth for every field.
const DEFAULT_PRICING = Object.freeze({
  nightly_rate: envNumber("NIGHTLY_RATE", 150),
  monthly_rate: envNumber("MONTHLY_RATE", 1800),
  cleaning_fee: envNumber("CLEANING_FEE", 0),
  mecklenburg_sales: envNumber("TAX_MECKLENBURG_SALES", 8.25),
  mecklenburg_occupancy: envNumber("TAX_MECKLENBURG_OCCUPANCY", 8.0),
  minimum_nights: envNumber("MINIMUM_NIGHTS", 10),
});

function normalizePricingRow(row) {
  return Object.fromEntries(
    PRICING_FIELDS.map((field) => [
      field,
      row && row[field] != null ? Number(row[field]) : DEFAULT_PRICING[field],
    ]),
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

  if (!Number.isInteger(merged.minimum_nights) || merged.minimum_nights < 1) {
    throw new TypeError("minimum_nights must be a positive integer");
  }
  if (merged.nightly_rate <= 0 || merged.monthly_rate <= 0) {
    throw new TypeError("nightly_rate and monthly_rate must be greater than zero");
  }

  return merged;
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
  PRICING_FIELDS,
  normalizePricingRow,
  mergePricingSettings,
  validateRequiredTaxUpdate,
};
