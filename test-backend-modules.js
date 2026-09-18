const assert = require("assert");
const { createAdminAuth } = require("./server/middleware/admin-auth");
const { createAdminWebSocketService } = require("./server/services/admin-websocket");
const { createPricingService } = require("./server/services/pricing-service");
const { createBookingService } = require("./server/services/booking-service");
const { createCalendarService } = require("./server/services/calendar-service");
const { registerBookingRoutes } = require("./server/routes/booking-routes");
const { registerPricingRoutes } = require("./server/routes/pricing-routes");
const {
  registerStripeWebhookRoute,
  registerPaymentRoutes,
} = require("./server/routes/payment-routes");
const { registerAdminRoutes } = require("./server/routes/admin-routes");

const auth = createAdminAuth({
  jwtSecret: "test-secret",
  nodeEnv: "production",
  allowedOrigins: ["https://example.test"],
  adminCookieName: "admin_session",
  adminSessionMinutes: 60,
});
assert.strictEqual(auth.isAllowedOrigin("https://example.test"), true);
assert.strictEqual(auth.isAllowedOrigin("https://attacker.test"), false);
assert.deepStrictEqual(auth.adminCookieOptions(), {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  maxAge: 3600000,
  path: "/",
});

const booking = createBookingService({ db: {}, holdMinutes: 35 });
assert.strictEqual(booking.nightsBetween("2027-01-01", "2027-01-11"), 10);
assert.strictEqual(booking.nightsBetween("bad", "2027-01-11"), null);
assert.strictEqual(booking.isDateString("2027-01-01"), true);

const pricing = createPricingService({ pricingReady: Promise.resolve() });
const shortStay = pricing.calculateTotalPrice(2, 100, 0, {
  mecklenburg_sales: 8.25,
  mecklenburg_occupancy: 8,
});
assert.strictEqual(shortStay.total, 232.5);

assert.strictEqual(typeof createAdminWebSocketService, "function");
assert.strictEqual(typeof createCalendarService, "function");
assert.strictEqual(typeof registerBookingRoutes, "function");
assert.strictEqual(typeof registerPricingRoutes, "function");
assert.strictEqual(typeof registerStripeWebhookRoute, "function");
assert.strictEqual(typeof registerPaymentRoutes, "function");
assert.strictEqual(typeof registerAdminRoutes, "function");

console.log("PASS: backend module seams load and preserve core helper behavior");
