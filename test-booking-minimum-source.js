"use strict";

const assert = require("assert");
const fs = require("fs");

const booking = fs.readFileSync("public/booking.js", "utf8");
const indexHtml = fs.readFileSync("public/index.html", "utf8");
const taxSettings = fs.readFileSync("public/tax-settings.html", "utf8");

assert(
  !booking.includes("const MIN_NIGHTS"),
  "the browser must not define a competing minimum-night constant",
);
assert(
  !booking.includes("nights < MIN_NIGHTS"),
  "the browser must defer the configurable minimum to the server",
);
assert(
  booking.includes("minCheckout.getDate() + 1"),
  "the date picker should only reject an empty stay locally",
);

assert(
  !indexHtml.includes("Minimum stay: 10 nights"),
  "customer copy must not hard-code the old 10-night minimum",
);
assert(
  !indexHtml.includes("Short stays (10+ nights)"),
  "SEO copy must not publish a competing numeric minimum stay",
);
assert(
  indexHtml.includes("Minimum stay follows current booking rules"),
  "customer copy should defer the minimum stay to current server rules",
);

assert(
  taxSettings.includes('id="minimumNights"'),
  "admin pricing settings must expose the authoritative minimum stay",
);
assert(
  taxSettings.includes("data.minimum_nights"),
  "admin minimum stay must load from the server pricing snapshot",
);
assert(
  taxSettings.includes("minimum_nights: minimumNights"),
  "admin updates must send the edited minimum stay to the server",
);
assert(
  !taxSettings.includes("minimum_nights: 10"),
  "the admin browser must not define a competing minimum-stay fallback",
);
assert(
  taxSettings.includes("let authoritativeMinimumNights = null;"),
  "the admin page must track whether a server minimum was loaded",
);
assert(
  taxSettings.includes(
    'minimumNightsInput.value = authoritativeMinimumNights ?? ""',
  ),
  "Reset and load-failure fallback must preserve the last server minimum and otherwise leave it empty",
);
assert(
  taxSettings.includes(
    "saveButton.disabled = authoritativeMinimumNights == null",
  ),
  "saving must stay disabled until a server minimum is available",
);
assert(
  taxSettings.includes(
    "Cannot save settings until server pricing settings load successfully",
  ),
  "submit must fail closed when no authoritative server snapshot was loaded",
);
assert(
  !taxSettings.includes("minimumNightsInput.value = DEFAULT_RATES.minimum_nights"),
  "Reset must not replace the server minimum with a browser default",
);
assert(
  !taxSettings.includes("minimum_nights: 0"),
  "the admin fallback must not use an invalid minimum stay",
);

const loadStart = taxSettings.indexOf("async function loadSettings()");
const defaultsStart = taxSettings.indexOf("function setDefaultValues()", loadStart);
assert(loadStart >= 0 && defaultsStart > loadStart, "loadSettings source must be extractable");
const loadSource = taxSettings.slice(loadStart, defaultsStart);
assert(
  loadSource.includes("authoritativeMinimumNights = minimumNights"),
  "a successful load must capture the server minimum before enabling save/reset behavior",
);
assert(
  loadSource.includes("setDefaultValues();"),
  "a failed load must route through the guarded fallback path",
);

const submitStart = taxSettings.indexOf('form.addEventListener("submit"');
assert(submitStart > defaultsStart, "submit handler source must be extractable");
const defaultsSource = taxSettings.slice(defaultsStart, submitStart);
assert(
  defaultsSource.includes('minimumNightsInput.value = authoritativeMinimumNights ?? ""'),
  "Reset must preserve the last successfully loaded server minimum",
);
assert(
  defaultsSource.includes("setSaveAvailability();"),
  "Reset/load failure must recompute fail-closed save availability",
);

const resetStart = taxSettings.indexOf('resetBtn.addEventListener("click"', submitStart);
assert(resetStart > submitStart, "reset handler source must be extractable");
const submitSource = taxSettings.slice(submitStart, resetStart);
assert(
  submitSource.includes("if (authoritativeMinimumNights == null)"),
  "submit must reject saves before any authoritative minimum was loaded",
);
assert(
  submitSource.includes("authoritativeMinimumNights = minimumNights"),
  "a successful save must advance the remembered server minimum for later Reset operations",
);

const resetEnd = taxSettings.indexOf(
  'salesInput.addEventListener("input"',
  resetStart,
);
const resetSource = taxSettings.slice(resetStart, resetEnd);
assert(
  resetSource.includes("setDefaultValues();"),
  "Reset must use the guarded default/reset helper",
);

const priceDisplayStart = booking.indexOf("async function updatePriceDisplay()");
const priceDisplayEnd = booking.indexOf(
  "// ============ MODAL DE CONFIRMACIÓN ============",
  priceDisplayStart,
);

assert(priceDisplayStart >= 0, "updatePriceDisplay must exist");
assert(
  priceDisplayEnd > priceDisplayStart,
  "updatePriceDisplay regression scope must be extractable",
);

const priceDisplaySource = booking.slice(priceDisplayStart, priceDisplayEnd);
const rejectedResponseCheck = priceDisplaySource.indexOf("if (!response.ok)");
const pricingRead = priceDisplaySource.indexOf("const pricing = await response.json()");

assert(
  rejectedResponseCheck >= 0,
  "updatePriceDisplay must handle rejected server pricing responses",
);
assert(
  pricingRead > rejectedResponseCheck,
  "rejected pricing must be handled before reading a successful quote",
);
assert(
  priceDisplaySource.includes('priceDisplay.innerHTML = ""'),
  "a rejected or failed quote must clear any previously displayed total",
);
assert(
  priceDisplaySource.includes('error.error || "Failed to calculate price"'),
  "the browser must surface the server's effective minimum-night error",
);
assert(
  priceDisplaySource.includes(
    'bookingMessage.className = "booking-message error"',
  ),
  "a rejected quote must be presented as a visible booking error",
);
assert(
  booking.includes("let priceRequestSequence = 0;"),
  "pricing requests must have a monotonic sequence guard",
);
assert.strictEqual(
  (booking.match(/let priceRequestSequence = 0;/g) || []).length,
  1,
  "short-stay and monthly quotes must share one request sequence",
);
assert(
  priceDisplaySource.includes("const requestSequence = ++priceRequestSequence;"),
  "each pricing refresh must invalidate every older request",
);
assert(
  (priceDisplaySource.match(/requestSequence !== priceRequestSequence/g) || [])
    .length >= 4,
  "stale success, rejection, JSON and network-error paths must not update the UI",
);

const monthlyPriceStart = booking.indexOf(
  "async function updateMonthlyPriceDisplay()",
);
const monthlyPriceEnd = booking.indexOf(
  "// ============ FLATPICKR ============",
  monthlyPriceStart,
);
assert(
  monthlyPriceStart >= 0 && monthlyPriceEnd > monthlyPriceStart,
  "monthly pricing regression scope must be extractable",
);
const monthlyPriceSource = booking.slice(monthlyPriceStart, monthlyPriceEnd);
assert(
  monthlyPriceSource.includes(
    "const requestSequence = ++priceRequestSequence;",
  ),
  "each monthly quote must invalidate every older pricing request",
);
assert(
  (monthlyPriceSource.match(/requestSequence !== priceRequestSequence/g) || [])
    .length >= 3,
  "monthly response, JSON and error paths must ignore stale requests",
);
assert(
  (monthlyPriceSource.match(/currentRentalType !== "monthly"/g) || []).length >=
    3,
  "a monthly response must not overwrite the UI after changing rental type",
);

const initialRentalType = booking.indexOf('setRentalType("short_stay");');
const checkoutPickerDeclaration = booking.indexOf(
  'const checkoutPicker = flatpickr("#checkout"',
);
assert(
  initialRentalType > checkoutPickerDeclaration,
  "the initial quote refresh must run only after both date pickers exist",
);

console.log("booking minimum-night source-of-truth check passed");
