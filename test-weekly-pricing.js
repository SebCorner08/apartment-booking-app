"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const express = require("express");
const { createPricingService } = require("./server/services/pricing-service");
const { createBookingService } = require("./server/services/booking-service");
const { registerPricingRoutes } = require("./server/routes/pricing-routes");
const { registerPaymentRoutes } = require("./server/routes/payment-routes");
const { processStripeEvent } = require("./server/stripe-webhook-persistence");
const { run, get } = require("./server/db-promises");
const { buildDefaultPricing, mergePricingSettings } = require("./server/pricing-settings");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-pricing-"));
const databasePath = path.join(tempRoot, "reservations.db");
const databaseModule = require.resolve("./server/database");
process.env.NODE_ENV = "test";
process.env.RESERVATIONS_DB_PATH = databasePath;
let db;
let server;

function closeDb(database) {
  return new Promise((resolve, reject) => database.close((err) => err ? reject(err) : resolve()));
}

async function bootstrap() {
  delete require.cache[databaseModule];
  const database = require(databaseModule);
  await database.ready;
  return database;
}

function addDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

(async () => {
  try {
    assert.strictEqual(buildDefaultPricing({ WEEKLY_RATE: "1500" }).weekly_rate, 0,
      "weekly pricing must require an owner-saved rate, not an implicit deployment default");
    for (const value of [-1, Infinity, "invalid"]) {
      assert.throws(() => mergePricingSettings(null, { weekly_rate: value }), /weekly_rate/);
    }

    // Start with production-shaped legacy pricing history and a legacy booking.
    // The migration must add only the disabled weekly setting and retain history.
    db = new sqlite3.Database(databasePath);
    await run(db, `CREATE TABLE tax_settings (
      id INTEGER PRIMARY KEY, nc_state REAL NOT NULL, mecklenburg_local REAL NOT NULL,
      occupancy REAL NOT NULL, updated_at TEXT NOT NULL,
      mecklenburg_sales REAL, mecklenburg_occupancy REAL, monthly_rate REAL,
      nightly_rate REAL, cleaning_fee REAL, minimum_nights INTEGER)`);
    await run(db, `INSERT INTO tax_settings VALUES
      (1, 1, 2, 3, '2025-01-01', 7, 6, 3000, 200, 50, 10),
      (2, 4, 5, 6, '2025-02-01', 8.25, 8, 4000, 275, 125, 12)`);
    await run(db, `CREATE TABLE bookings (
      id INTEGER PRIMARY KEY, checkIn TEXT, checkOut TEXT, bookingStatus TEXT,
      stripePaymentId TEXT, rental_type TEXT, guests INTEGER)`);
    await run(db, `INSERT INTO bookings VALUES
      (9, '2025-01-01', '2025-01-13', 'confirmed', 'cs_legacy_weekly_test', 'short_stay', 2)`);
    const legacyRows = await new Promise((resolve, reject) => db.all(
      "SELECT * FROM tax_settings ORDER BY id", (err, rows) => err ? reject(err) : resolve(rows),
    ));
    await closeDb(db);
    db = await bootstrap();
    const migratedRows = await new Promise((resolve, reject) => db.all(
      "SELECT * FROM tax_settings ORDER BY id", (err, rows) => err ? reject(err) : resolve(rows),
    ));
    assert.deepStrictEqual(migratedRows, legacyRows.map((row) => ({ ...row, weekly_rate: 0 })));
    assert.strictEqual((await get(db, "SELECT rental_type FROM bookings WHERE id = 9")).rental_type, "short_stay");

    const pricingService = createPricingService(db);
    const bookingService = createBookingService({ db, holdMinutes: 35 });
    const app = express();
    app.use(express.json());
    registerPricingRoutes(app, {
      pricingService, bookingService, broadcastAdminUpdate() {},
      checkAdminAuth(req, res, next) {
        if (req.headers.authorization !== "test-admin") return res.status(401).json({ error: "Unauthorized" });
        next();
      },
    });
    const stripeCalls = [];
    const stripeSessions = new Map();
    registerPaymentRoutes(app, {
      checkoutLimiter(req, res, next) { next(); }, mockPayments: false,
      stripe: { checkout: { sessions: {
        async create(payload) {
          const session = { id: `cs_weekly_${stripeCalls.length + 1}`,
            url: "https://checkout.example.test/weekly", payment_status: "paid", metadata: payload.metadata };
          stripeCalls.push(payload);
          stripeSessions.set(session.id, session);
          return session;
        },
        async retrieve(id) { return stripeSessions.get(id); },
      } } },
      db, domain: "https://booking.example.test", maxGuests: 6, maxAdvanceMonths: 18,
      pricingService, bookingService, broadcastAdminUpdate() {},
    });
    server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, payload, admin = false) {
      const response = await fetch(`${base}${route}`, {
        method: payload === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...(admin ? { Authorization: "test-admin" } : {}) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      return { status: response.status, body: await response.json() };
    }
    const weekly = { rental_type: "weekly", checkIn: addDays(30), checkOut: addDays(44), guests: 3 };
    assert.deepStrictEqual((await request("/api/weekly-rate")).body, { weekly_rate: 0, available: false });
    for (const route of ["/api/calculate-price", "/api/create-checkout-session"]) {
      assert.strictEqual((await request(route, weekly)).status, 400, "unconfigured weekly rate must fail closed");
    }
    assert.strictEqual(stripeCalls.length, 0);
    const settings = { weekly_rate: 1500, mecklenburg_sales: 8.25, mecklenburg_occupancy: 8 };
    assert.strictEqual((await request("/api/admin/tax-settings", settings)).status, 401);
    for (const weekly_rate of [-2, "bad"]) {
      assert.strictEqual((await request("/api/admin/tax-settings", { ...settings, weekly_rate }, true)).status, 400);
    }
    const saved = await request("/api/admin/tax-settings", settings, true);
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.body.weekly_rate, 1500);
    assert.strictEqual(saved.body.monthly_rate, 4000);
    assert.strictEqual(saved.body.minimum_nights, 12);
    assert.strictEqual((await request("/api/admin/tax-settings", undefined, true)).body.weekly_rate, 1500);
    assert.deepStrictEqual((await request("/api/weekly-rate")).body, { weekly_rate: 1500, available: true });
    await request("/api/admin/monthly-rate", { monthly_rate: 4100 }, true);
    assert.strictEqual((await pricingService.loadRatesFromDB()).weekly_rate, 1500, "legacy monthly save retains weekly rate");

    const tampered = { ...weekly, weeks: 99, weekly_rate: 1, subtotal: 1, total: 1, cleaning_fee: 0 };
    const quote = await request("/api/calculate-price", tampered);
    assert.strictEqual(quote.status, 200);
    assert.deepStrictEqual(quote.body, {
      rental_type: "weekly", nights: 14, weeks: 2, weekly_rate: 1500,
      subtotal: 3000, cleaning_fee: 125, mecklenburg_sales_tax: 257.81,
      mecklenburg_occupancy_tax: 250, total_tax: 507.81, total: 3632.81,
      tax_rates: { mecklenburg_sales: 8.25, mecklenburg_occupancy: 8 },
    });
    const oneWeek = { ...weekly, checkOut: addDays(37) };
    assert.strictEqual((await request("/api/calculate-price", oneWeek)).body.weeks, 1,
      "weekly mode has its own duration policy, independent of the short-stay minimum");
    const boundaryQuote = await request("/api/calculate-price", { ...weekly, checkOut: addDays(394) });
    assert.strictEqual(boundaryQuote.body.weeks, 52);
    for (const invalid of [
      { checkOut: addDays(36) }, { checkOut: addDays(38) }, { checkOut: addDays(401) },
      { checkOut: weekly.checkIn }, { checkIn: "bad" }, { checkOut: undefined },
      { checkIn: "2027-02-30", checkOut: "2027-03-09" },
    ]) {
      for (const route of ["/api/calculate-price", "/api/create-checkout-session"]) {
        assert.strictEqual((await request(route, { ...weekly, ...invalid })).status, 400);
      }
    }
    const nightly = await request("/api/calculate-price", { checkIn: addDays(30), checkOut: addDays(42) });
    assert.strictEqual(nightly.body.subtotal, 3300);
    assert.strictEqual(nightly.body.rental_type, "short_stay");
    assert.strictEqual((await request("/api/calculate-price", { ...oneWeek, rental_type: "short_stay" })).status, 400);
    const monthly = await request("/api/calculate-price", { rental_type: "monthly", months: 2 });
    assert.strictEqual(monthly.body.subtotal, 8200);
    assert.strictEqual(monthly.body.mecklenburg_occupancy_tax, 0);

    const checkout = await request("/api/create-checkout-session", tampered);
    assert.strictEqual(checkout.status, 200);
    assert.deepStrictEqual(checkout.body.pricing, quote.body);
    const stripePayload = stripeCalls[0];
    assert.strictEqual(stripePayload.line_items[0].price_data.unit_amount, 363281);
    assert.strictEqual(stripePayload.metadata.rental_type, "weekly");
    assert.strictEqual(stripePayload.metadata.weeks, "2");
    assert.strictEqual(stripePayload.metadata.nights, "14");
    assert.strictEqual(stripePayload.metadata.guests, "3");
    assert.match(stripePayload.line_items[0].price_data.product_data.name, /Weekly/);
    assert.strictEqual((await get(db, "SELECT rental_type FROM booking_holds WHERE id = ?", [stripePayload.metadata.hold_id])).rental_type, "weekly");
    assert.strictEqual((await request("/api/create-checkout-session", weekly)).status, 409, "active weekly hold blocks overlap");

    const session = stripeSessions.get(checkout.body.id);
    const event = { type: "checkout.session.completed", data: { object: session } };
    let broadcasts = 0;
    const processEvent = (database = db) => processStripeEvent({ event, db: database, broadcastAdminUpdate() { broadcasts++; } });
    const failingDb = {
      run(sql, params, callback) {
        if (sql.includes("INSERT OR IGNORE INTO bookings")) return callback(new Error("test-only persistence failure"));
        return db.run(sql, params, callback);
      },
      get: db.get.bind(db),
    };
    await assert.rejects(processEvent(failingDb), /test-only persistence failure/);
    assert.strictEqual(broadcasts, 0);
    assert.deepStrictEqual(await processEvent(), { handled: true, changed: true });
    assert.deepStrictEqual(await processEvent(), { handled: true, changed: false });
    assert.strictEqual(broadcasts, 1);
    assert.strictEqual((await request("/api/bookings", { sessionId: session.id })).status, 201,
      "browser confirmation after a webhook remains idempotent");
    const booking = await get(db, "SELECT rental_type, guests FROM bookings WHERE stripePaymentId = ?", [session.id]);
    assert.deepStrictEqual(booking, { rental_type: "weekly", guests: 3 });
    assert.strictEqual((await get(db, "SELECT COUNT(*) AS count FROM bookings WHERE stripePaymentId = ?", [session.id])).count, 1);
    assert.strictEqual((await request("/api/create-checkout-session", weekly)).status, 409, "confirmed weekly booking blocks overlap");
    const competing = { ...weekly, checkIn: addDays(60), checkOut: addDays(67) };
    const attempts = await Promise.all([
      request("/api/create-checkout-session", competing), request("/api/create-checkout-session", competing),
    ]);
    assert.deepStrictEqual(attempts.map((attempt) => attempt.status).sort(), [200, 409]);

    await request("/api/admin/tax-settings", { ...settings, weekly_rate: 0 }, true);
    assert.strictEqual((await request("/api/calculate-price", weekly)).status, 400, "owner can disable weekly pricing");
    await request("/api/admin/tax-settings", { ...settings, weekly_rate: 1650.5 }, true);
    await new Promise((resolve) => server.close(resolve));
    server = null;
    await closeDb(db);
    db = await bootstrap();
    const reloaded = await createPricingService(db).loadRatesFromDB();
    assert.strictEqual(reloaded.weekly_rate, 1650.5, "weekly rate persists across database/server reload");
    assert.strictEqual(reloaded.monthly_rate, 4100);
    assert.strictEqual((await get(db, "SELECT rental_type FROM bookings WHERE stripePaymentId = ?", [session.id])).rental_type, "weekly");
    await closeDb(db);
    db = null;
    process.env.RESERVATIONS_DB_PATH = path.join(tempRoot, "fresh.db");
    db = await bootstrap();
    assert.strictEqual((await createPricingService(db).loadRatesFromDB()).weekly_rate, 0,
      "fresh databases also start with weekly rentals disabled");
    console.log("PASS: weekly migration, validation, admin persistence, pricing, Stripe amounts, booking replay and overlap");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await closeDb(db);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
