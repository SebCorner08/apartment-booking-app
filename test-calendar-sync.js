const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sqlite3 = require("sqlite3");
const { run, get } = require("./server/db-promises");
const { createCalendarService, SYNC_INTERVAL_MS, CALENDAR_UNAVAILABLE } = require("./server/services/calendar-service");
const { createBookingService } = require("./server/services/booking-service");
const { registerBookingRoutes } = require("./server/routes/booking-routes");
const { registerPaymentRoutes } = require("./server/routes/payment-routes");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function open(filename) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, (err) => err ? reject(err) : resolve(db));
  });
}
function close(db) { return new Promise((resolve, reject) => db.close((err) => err ? reject(err) : resolve())); }
function all(db, sql) { return new Promise((resolve, reject) => db.all(sql, (err, rows) => err ? reject(err) : resolve(rows))); }
function feed(...events) { return ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n"); }
function event(uid, start = "20270110", end = "20270120", extra = "") {
  return `BEGIN:VEVENT\nUID:${uid}\nDTSTART;VALUE=DATE:${start}\nDTEND;VALUE=DATE:${end}\n${extra ? `${extra}\n` : ""}END:VEVENT`;
}
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-sync-"));
  const db = await open(path.join(dir, "test.sqlite"));
  db.serialize();
  db.databasePath = path.join(dir, "test.sqlite");
  db.ready = Promise.resolve();
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE external_blocks (id INTEGER PRIMARY KEY, source TEXT NOT NULL, uid TEXT NOT NULL, checkIn TEXT NOT NULL, checkOut TEXT NOT NULL, UNIQUE(source, uid));
    CREATE TABLE bookings (id INTEGER PRIMARY KEY, checkIn TEXT, checkOut TEXT, bookingStatus TEXT);
    CREATE TABLE booking_holds (id TEXT PRIMARY KEY, checkIn TEXT, checkOut TEXT, rental_type TEXT, status TEXT DEFAULT 'active', expires_at TEXT);
    INSERT INTO external_blocks (source, uid, checkIn, checkOut) VALUES ('airbnb', 'old', '2027-01-01', '2027-01-04'), ('vrbo', 'other', '2027-02-01', '2027-02-02');
    INSERT INTO bookings VALUES (1, '2027-03-01', '2027-03-04', 'confirmed');
  `, (err) => err ? reject(err) : resolve()));
  t.after(async () => { await close(db); await fs.rm(dir, { recursive: true, force: true }); });
  const state = { text: feed(event("new")), calls: 0, broadcasts: 0, successes: 0, errors: 0 };
  const service = createCalendarService({
    db, airbnbIcalUrl: "https://calendar.invalid/private-token",
    fetchCalendar: async () => { state.calls++; return { ok: true, text: async () => state.text }; },
    broadcastAdminUpdate: () => { state.broadcasts++; },
    logger: { log: () => { state.successes++; }, error: () => { state.errors++; } },
    ...options,
  });
  return { db, state, service };
}
function pausedDatabase(db, match) {
  const entered = deferred();
  const release = deferred();
  return {
    entered: entered.promise, release: release.resolve,
    openDatabase: async () => {
      const connection = await open(db.databasePath);
      const original = connection.run.bind(connection);
      connection.run = (sql, params, callback) => {
        if (match.test(sql)) {
          entered.resolve();
          release.promise.then(() => original(sql, params, callback));
          return connection;
        }
        return original(sql, params, callback);
      };
      return connection;
    },
  };
}
const snapshot = (db) => all(db, "SELECT source, uid, checkIn, checkOut FROM external_blocks ORDER BY source, uid");

for (const stage of [/INSERT INTO external_blocks/, /^COMMIT$/]) {
  test(`sync awaits durable completion at ${stage}`, async (t) => {
    const { db } = await fixture(t);
    const pause = pausedDatabase(db, stage);
    const { service, state } = await fixture(t, { db, openDatabase: pause.openDatabase });
    let finished = false;
    const pending = service.syncAirbnbCalendar().then(() => { finished = true; });
    await pause.entered;
    assert.equal(finished, false);
    assert.equal(state.broadcasts, 0);
    assert.equal(state.successes, 0);
    assert.equal((await snapshot(db))[0].uid, "old", "other connections cannot see partial feed");
    pause.release();
    await pending;
    assert.deepEqual((await snapshot(db)).map((row) => row.uid), ["new", "other"]);
    assert.equal(state.broadcasts, 1);
    assert.equal(state.successes, 1);
  });
}

for (const stage of ["upsert", "delete", "empty-delete"]) {
  test(`${stage} failure rolls back the whole feed without affecting other data`, async (t) => {
    const { db, service, state } = await fixture(t);
    const before = await snapshot(db);
    if (stage === "upsert") {
      state.text = feed(event("first"), event("fail"));
      await run(db, "CREATE TRIGGER fail_import BEFORE INSERT ON external_blocks WHEN NEW.uid = 'fail' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
    } else {
      state.text = stage === "empty-delete" ? feed() : feed(event("first"));
      await run(db, "CREATE TRIGGER fail_import BEFORE DELETE ON external_blocks WHEN OLD.source = 'airbnb' BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END");
    }
    await assert.rejects(service.syncAirbnbCalendar(), { code: "CALENDAR_UNAVAILABLE", message: CALENDAR_UNAVAILABLE });
    assert.deepEqual(await snapshot(db), before);
    assert.equal((await get(db, "SELECT COUNT(*) AS count FROM bookings")).count, 1);
    assert.equal(state.broadcasts, 0);
    assert.equal(state.successes, 0);
    await run(db, "DROP TRIGGER fail_import");
    await service.syncAirbnbCalendar();
    assert.equal(state.broadcasts, 1, "failed import releases connection and allows retry");
  });
}

test("empty feed and cancellation remove only Airbnb blocks; all-day dates preserve local days", async (t) => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "Pacific/Auckland";
  t.after(() => { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; });
  const { db, service, state } = await fixture(t);
  state.text = feed(event("new"), event("old", "20270101", "20270104", "STATUS:CANCELLED"));
  await service.syncAirbnbCalendar();
  assert.deepEqual((await snapshot(db))[0], { source: "airbnb", uid: "new", checkIn: "2027-01-10", checkOut: "2027-01-20" });
  state.text = feed();
  await service.syncAirbnbCalendar();
  assert.deepEqual((await snapshot(db)).map((row) => row.source), ["vrbo"]);
  assert.equal((await get(db, "SELECT COUNT(*) AS count FROM bookings")).count, 1);
});

test("invalid and partial feeds preserve last successful blocks", async (t) => {
  const { db, service, state } = await fixture(t);
  await service.syncAirbnbCalendar();
  const before = await snapshot(db);
  for (const invalid of ["<html>maintenance</html>", "", "BEGIN:VCALENDAR\nEND:VCALENDAR", feed(event("x")).replace("END:VCALENDAR", ""),
    feed(event("x").replace("DTEND;VALUE=DATE:20270120\n", "")), feed(event("x", "20270230")),
    feed(event("x", "20270120", "20270110")), feed(event("x", "20270110", "20270110")),
    feed(event("x"), event("x")), feed(event("x", "20270110", "20270120", "RRULE:FREQ=DAILY")),
    feed(event("x").replace("UID:x\n", ""))]) {
    state.text = invalid;
    await assert.rejects(service.syncAirbnbCalendar(), { code: "CALENDAR_UNAVAILABLE" });
    assert.deepEqual(await snapshot(db), before);
  }
  assert.equal(state.broadcasts, 1);
});

test("overlapping callers coalesce and freshness advances only on success", async (t) => {
  let clock = 1000;
  const { service, state } = await fixture(t, { now: () => clock });
  const first = service.syncAirbnbCalendar();
  assert.equal(service.syncAirbnbCalendar(), first);
  assert.equal(service.ensureFreshAirbnbCalendar(), first);
  await first;
  assert.equal(state.calls, 1);
  clock += SYNC_INTERVAL_MS - 1;
  await service.ensureFreshAirbnbCalendar();
  assert.equal(state.calls, 1);
  clock++;
  state.text = "invalid";
  await assert.rejects(service.ensureFreshAirbnbCalendar());
  state.text = feed(event("retry"));
  await service.ensureFreshAirbnbCalendar();
  assert.equal(state.calls, 3);
});

test("network/body timeout aborts fetch, preserves blocks, and is retryable", async (t) => {
  let signal;
  let attempts = 0;
  const { db, service, state } = await fixture(t, {
    fetchTimeoutMs: 10,
    fetchCalendar: async (_url, options) => {
      signal = options.signal;
      attempts++;
      if (attempts === 1) return { ok: true, text: () => new Promise(() => {}) };
      return { ok: true, text: async () => feed() };
    },
  });
  const before = await snapshot(db);
  await assert.rejects(service.syncAirbnbCalendar(), { code: "CALENDAR_UNAVAILABLE" });
  assert.equal(signal.aborted, true);
  assert.deepEqual(await snapshot(db), before);
  assert.equal(state.broadcasts, 0);
  await service.syncAirbnbCalendar();
  assert.equal(state.broadcasts, 1);
});

test("import rollback cannot roll back concurrent application writes", async (t) => {
  const { db } = await fixture(t);
  const pause = pausedDatabase(db, /^DELETE FROM external_blocks/);
  const { service } = await fixture(t, { db, openDatabase: pause.openDatabase });
  await run(db, "CREATE TRIGGER fail_delete BEFORE DELETE ON external_blocks BEGIN SELECT RAISE(ABORT, 'injected'); END");
  const rejected = assert.rejects(service.syncAirbnbCalendar());
  await pause.entered;
  const concurrentWrite = run(db, "INSERT INTO bookings VALUES (2, '2027-05-01', '2027-05-03', 'confirmed')");
  pause.release();
  await rejected;
  await concurrentWrite;
  assert.equal((await get(db, "SELECT COUNT(*) AS count FROM bookings")).count, 2);
  assert.equal((await snapshot(db))[0].uid, "old");
});

function routes() {
  const handlers = {};
  return { handlers, get: (url, handler) => { handlers[`GET ${url}`] = handler; }, post: (url, ...middleware) => { handlers[`POST ${url}`] = middleware.at(-1); } };
}
function response() {
  const done = deferred();
  return { statusCode: 200, headers: {}, done: done.promise,
    set(key, value) { this.headers[key] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; done.resolve(); return this; } };
}

test("availability GET refreshes stale data, returns 503 on failure, and retains success shape", async (t) => {
  let clock = 0;
  const { db, service, state } = await fixture(t, { now: () => clock });
  const app = routes();
  registerBookingRoutes(app, { db, ensureFreshAirbnbCalendar: service.ensureFreshAirbnbCalendar });
  const invoke = async () => { const res = response(); await app.handlers["GET /api/bookings"]({}, res); await res.done; return res; };
  const success = await invoke();
  assert.equal(success.statusCode, 200);
  assert.equal(success.headers["Cache-Control"], "no-store");
  assert.ok(success.body.some((row) => row.from === "2027-01-10" && row.to === "2027-01-20"));
  assert.deepEqual(Object.keys(success.body[0]).sort(), ["from", "to"]);
  clock += SYNC_INTERVAL_MS;
  state.text = "invalid";
  const failure = await invoke();
  assert.equal(failure.statusCode, 503);
  assert.deepEqual(failure.body, { error: CALENDAR_UNAVAILABLE, code: "CALENDAR_UNAVAILABLE" });
});

test("checkout never creates holds or Stripe sessions before successful committed import", async (t) => {
  const { db, service, state } = await fixture(t);
  const app = routes();
  let holdAttempts = 0;
  let stripeAttempts = 0;
  const booking = createBookingService({ db, holdMinutes: 35 });
  registerPaymentRoutes(app, {
    checkoutLimiter: () => {}, mockPayments: false, stripe: { checkout: { sessions: { create: async () => { stripeAttempts++; return {}; } } } },
    db, airbnbIcalUrl: "configured", maxGuests: 6, maxAdvanceMonths: 18,
    pricingService: { MAX_NIGHTS: 30, loadRatesFromDB: async () => ({ minimum_nights: 1 }), calculateTotalPrice: () => ({ total: 100 }) },
    bookingService: { ...booking, createHold: async (args) => { holdAttempts++; return booking.createHold(args); } },
    syncAirbnbCalendar: service.syncAirbnbCalendar,
  });
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 20);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 5);
  const checkIn = start.toISOString().slice(0, 10), checkOut = end.toISOString().slice(0, 10);
  const req = { body: { checkIn, checkOut } };
  state.text = feed(event("blocked", checkIn.replaceAll("-", ""), checkOut.replaceAll("-", "")));
  await run(db, "CREATE TRIGGER fail_import BEFORE INSERT ON external_blocks BEGIN SELECT RAISE(ABORT, 'injected'); END");
  const failed = response();
  await app.handlers["POST /api/create-checkout-session"](req, failed);
  assert.equal(failed.statusCode, 503);
  assert.equal(holdAttempts, 0);
  assert.equal(stripeAttempts, 0);
  assert.equal((await get(db, "SELECT COUNT(*) AS count FROM booking_holds")).count, 0);
  await run(db, "DROP TRIGGER fail_import");
  const unavailable = response();
  await app.handlers["POST /api/create-checkout-session"](req, unavailable);
  assert.equal(unavailable.statusCode, 409, "new Airbnb block must be visible to hold availability check");
  assert.equal(holdAttempts, 1);
  assert.equal(stripeAttempts, 0);
});

test("startup and scheduled errors are handled, and disabled sync does not fetch", async (t) => {
  const intervals = [];
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setInterval = (callback, ms) => { intervals.push({ callback, ms }); return 1; };
  global.clearInterval = () => {};
  t.after(() => { global.setInterval = originalSetInterval; global.clearInterval = originalClearInterval; });
  const { service, state } = await fixture(t, { fetchCalendar: async () => { throw new Error("private URL must not escape"); } });
  const stop = service.startAutoSync();
  await new Promise(setImmediate);
  assert.equal(state.errors, 1);
  assert.equal(intervals[0].ms, SYNC_INTERVAL_MS);
  intervals[0].callback();
  await new Promise(setImmediate);
  assert.equal(state.errors, 2);
  stop();
  const disabled = createCalendarService({ db: {}, airbnbIcalUrl: undefined, fetchCalendar: () => { throw new Error("must not fetch"); } });
  await disabled.syncAirbnbCalendar();
  await disabled.ensureFreshAirbnbCalendar();
  disabled.startAutoSync()();
});
