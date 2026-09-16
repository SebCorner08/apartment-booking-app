"use strict";

const assert = require("assert");
const fs = require("fs");

const booking = fs.readFileSync("public/booking.js", "utf8");

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

console.log("booking minimum-night source-of-truth check passed");
