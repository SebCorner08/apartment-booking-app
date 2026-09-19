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

function createFakeApp() {
  const routes = new Map();
  const app = {};
  for (const method of ["get", "post", "delete"]) {
    app[method] = (path, ...handlers) => {
      routes.set(`${method.toUpperCase()} ${path}`, handlers);
    };
  }
  return { app, routes };
}

function createFakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      this.body = undefined;
      return this;
    },
  };
}

function runHandlers(handlers, req, res) {
  let index = 0;
  const next = () => {
    const handler = handlers[index++];
    if (!handler) return undefined;
    return handler(req, res, next);
  };
  return next();
}

async function main() {
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
  assert.strictEqual(typeof registerBookingRoutes, "function");
  assert.strictEqual(typeof registerPricingRoutes, "function");
  assert.strictEqual(typeof registerStripeWebhookRoute, "function");
  assert.strictEqual(typeof registerPaymentRoutes, "function");

  const calendarApp = createFakeApp();
  const calendarRuns = [];
  let calendarBroadcasts = 0;
  const calendarDb = {
    all(sql, params, callback) {
      assert(sql.includes("FROM bookings"));
      assert.deepStrictEqual(params, []);
      callback(null, [
        { id: 7, checkIn: "2027-01-10", checkOut: "2027-01-12" },
      ]);
    },
    run(sql, params, callback) {
      if (typeof params === "function") {
        callback = params;
        params = [];
      }
      calendarRuns.push({ sql, params: params || [] });
      if (callback) callback(null);
    },
  };
  const fakeIcalClient = {
    async: {
      async fromURL(url) {
        assert.strictEqual(url, "https://calendar.example.test/airbnb.ics");
        return {
          reservation: {
            type: "VEVENT",
            uid: "airbnb-reservation-1",
            start: new Date("2027-02-01T00:00:00.000Z"),
            end: new Date("2027-02-04T00:00:00.000Z"),
          },
          ignored: { type: "VTODO" },
        };
      },
    },
  };
  const calendar = createCalendarService({
    db: calendarDb,
    airbnbIcalUrl: "https://calendar.example.test/airbnb.ics",
    broadcastAdminUpdate: () => {
      calendarBroadcasts += 1;
    },
    icalClient: fakeIcalClient,
  });
  calendar.registerCalendarRoute(calendarApp.app);

  const calendarHandlers = calendarApp.routes.get("GET /api/calendar.ics");
  assert(calendarHandlers, "calendar route must be registered");
  const calendarResponse = createFakeResponse();
  await runHandlers(calendarHandlers, {}, calendarResponse);
  assert.strictEqual(
    calendarResponse.headers["Content-Type"],
    "text/calendar; charset=utf-8",
  );
  assert(calendarResponse.body.includes("UID:booking-7@lakeside-serenity"));
  assert(calendarResponse.body.includes("DTSTART;VALUE=DATE:20270110"));
  assert(calendarResponse.body.includes("DTEND;VALUE=DATE:20270112"));

  await calendar.syncAirbnbCalendar();
  assert.strictEqual(calendarBroadcasts, 1);
  assert.strictEqual(calendarRuns.length, 2);
  assert(calendarRuns[0].sql.includes("INSERT INTO external_blocks"));
  assert.deepStrictEqual(calendarRuns[0].params, [
    "airbnb-reservation-1",
    "2027-02-01",
    "2027-02-04",
  ]);
  assert(calendarRuns[1].sql.includes("DELETE FROM external_blocks"));
  assert.deepStrictEqual(calendarRuns[1].params, ["airbnb-reservation-1"]);

  const adminApp = createFakeApp();
  const manualChargeRuns = [];
  let adminBroadcasts = 0;
  const manualChargeDb = {
    run(sql, params, callback) {
      manualChargeRuns.push({ sql, params: params || [] });
      if (sql.includes("INSERT INTO manual_charges")) {
        callback.call({ lastID: 42 }, null);
      } else if (callback) {
        callback.call({ changes: 1 }, null);
      }
    },
    all(_sql, _params, callback) {
      callback(null, []);
    },
  };
  registerAdminRoutes(adminApp.app, {
    loginLimiter: (_req, _res, next) => next(),
    adminPassword: "test-password",
    jwtSecret: "test-secret",
    adminSessionMinutes: 60,
    adminWsTicketTtlMs: 30000,
    adminCookieOptions: () => ({ httpOnly: true }),
    isAllowedOrigin: () => true,
    checkAdminAuth: (_req, _res, next) => next(),
    issueAdminWebSocketTicket: () => "test-ticket",
    db: manualChargeDb,
    broadcastAdminUpdate: () => {
      adminBroadcasts += 1;
    },
    mockPayments: true,
    domain: "https://example.test",
    stripe: null,
  });

  const manualChargeHandlers = adminApp.routes.get("POST /api/admin/charges");
  assert(manualChargeHandlers, "manual-charge route must be registered");
  const manualChargeResponse = createFakeResponse();
  await runHandlers(
    manualChargeHandlers,
    {
      body: {
        guest_name: "Test Guest",
        guest_email: "guest@example.test",
        description: "Damage deposit",
        amount: 125.5,
      },
    },
    manualChargeResponse,
  );
  assert.strictEqual(manualChargeResponse.statusCode, 201);
  assert.strictEqual(manualChargeResponse.body.id, 42);
  assert(
    manualChargeResponse.body.stripe_session_id.startsWith("mock_charge_"),
  );
  assert.strictEqual(
    manualChargeResponse.body.url,
    "https://example.test/success.html?charge_id=42",
  );
  assert.strictEqual(adminBroadcasts, 1);
  assert.strictEqual(manualChargeRuns.length, 2);
  assert(manualChargeRuns[0].sql.includes("INSERT INTO manual_charges"));
  assert.deepStrictEqual(manualChargeRuns[0].params, [
    "Test Guest",
    "guest@example.test",
    "Damage deposit",
    125.5,
  ]);
  assert(manualChargeRuns[1].sql.includes("UPDATE manual_charges"));

  console.log(
    "PASS: backend module seams exercise auth, pricing, calendar sync, and manual-charge persistence",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
