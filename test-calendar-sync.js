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
const { handleStripeWebhookRequest } = require("./server/stripe-webhook-persistence");

function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
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
    CREATE TABLE bookings (id INTEGER PRIMARY KEY, checkIn TEXT, checkOut TEXT, bookingStatus TEXT, stripePaymentId TEXT UNIQUE, rental_type TEXT, guests INTEGER);
    CREATE TABLE booking_holds (id TEXT PRIMARY KEY, checkIn TEXT, checkOut TEXT, rental_type TEXT, stripe_session_id TEXT, status TEXT DEFAULT 'active', expires_at TEXT);
    INSERT INTO external_blocks (source, uid, checkIn, checkOut) VALUES ('airbnb', 'old', '2027-01-01', '2027-01-04'), ('vrbo', 'other', '2027-02-01', '2027-02-02');
    INSERT INTO bookings (id, checkIn, checkOut, bookingStatus) VALUES (1, '2027-03-01', '2027-03-04', 'confirmed');
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
  const concurrentWrite = run(db, "INSERT INTO bookings (id, checkIn, checkOut, bookingStatus) VALUES (2, '2027-05-01', '2027-05-03', 'confirmed')");
  pause.release();
  await rejected;
  await concurrentWrite;
  assert.equal((await get(db, "SELECT COUNT(*) AS count FROM bookings")).count, 2);
  assert.equal((await snapshot(db))[0].uid, "old");
});

test("a long import lock rejects a concurrent hold safely, then retry sees committed blocks", async (t) => {
  const { db } = await fixture(t);
  const pause = pausedDatabase(db, /^CREATE TEMP TABLE/);
  const { service } = await fixture(t, { db, openDatabase: pause.openDatabase });
  const booking = createBookingService({ db, holdMinutes: 35 });
  const syncing = service.syncAirbnbCalendar();
  await pause.entered;
  const args = { checkIn: "2027-01-10", checkOut: "2027-01-15", rentalType: "short_stay" };
  // Keep the import write lock until the application's default busy timeout
  // actually fires (>1 second). An unchecked BEGIN emits an unhandled Statement
  // error and terminates this process instead of rejecting this promise.
  await assert.rejects(booking.createHold(args), { code: "SQLITE_BUSY" });
  assert.equal((await get(db, "SELECT COUNT(*) AS count FROM booking_holds")).count, 0);
  const webhook = async () => {
    const res = response();
    await handleStripeWebhookRequest({
      db, res, req: { body: Buffer.from("fixture"), headers: { "stripe-signature": "fixture" } },
      stripe: { webhooks: { constructEvent: () => ({ type: "checkout.session.completed", data: { object: {
        id: "cs_lock_retry", payment_status: "paid", metadata: { checkIn: "2027-06-01", checkOut: "2027-06-04" },
      } } }) } },
      webhookSecret: "fixture", broadcastAdminUpdate: () => {}, logger: { error() {} },
    });
    return res;
  };
  assert.equal((await webhook()).statusCode, 500, "locked webhook must request retry, not acknowledge lost payment");
  pause.release();
  await syncing;
  assert.equal((await webhook()).statusCode, 200);
  assert.equal((await webhook()).statusCode, 200);
  assert.equal((await get(db, "SELECT COUNT(*) AS count FROM bookings WHERE stripePaymentId = 'cs_lock_retry'")).count, 1);
  assert.equal(await booking.createHold(args), null);
  const free = await booking.createHold({ ...args, checkIn: "2027-04-01", checkOut: "2027-04-05" });
  assert.ok(free, "hold queue must recover after failed BEGIN and overlap rollback");
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

function checkoutContext(db, overrides = {}) {
  const app = routes();
  const started = deferred();
  const completion = deferred();
  const booking = createBookingService({ db, holdMinutes: 35 });
  const mockSessions = new Map();
  const state = { creates: 0 };
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 20);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 5);
  const req = { body: { checkIn: start.toISOString().slice(0, 10), checkOut: end.toISOString().slice(0, 10) } };
  registerPaymentRoutes(app, {
    checkoutLimiter: () => {}, mockPayments: false, mockSessions, db,
    domain: "https://booking.invalid", airbnbIcalUrl: "configured", maxGuests: 6, maxAdvanceMonths: 18,
    pricingService: { MAX_NIGHTS: 30, loadRatesFromDB: async () => ({ minimum_nights: 1 }), calculateTotalPrice: () => ({ total: 100 }) },
    bookingService: booking, syncAirbnbCalendar: async () => {}, broadcastAdminUpdate: () => {},
    stripe: { checkout: { sessions: { create: async (args) => {
      state.creates++; state.createArgs = args; started.resolve(); return completion.promise;
    } } } },
    ...overrides,
  });
  const res = response();
  return { app, req, res, booking, mockSessions, state, started: started.promise, completion,
    start: () => app.handlers["POST /api/create-checkout-session"](req, res) };
}
function pausedImporter(db) {
  const pause = pausedDatabase(db, /^CREATE TEMP TABLE/);
  const service = createCalendarService({
    db, airbnbIcalUrl: "https://calendar.invalid/fixture", openDatabase: pause.openDatabase,
    fetchCalendar: async () => ({ ok: true, text: async () => feed() }),
    broadcastAdminUpdate: () => {}, logger: { log() {}, error() {} },
  });
  return { pause, sync: service.syncAirbnbCalendar };
}
function observeLinkWrites(db) {
  const firstBusy = deferred();
  const state = { attempts: 0, firstBusy: firstBusy.promise };
  const original = db.run.bind(db);
  db.run = (sql, params, callback) => {
    if (/^UPDATE booking_holds SET stripe_session_id/.test(sql)) {
      state.attempts++;
      assert.equal(typeof callback, "function", "session-link writes must have an error callback");
      return original(sql, params, function (err) {
        if (err?.code === "SQLITE_BUSY") firstBusy.resolve();
        callback.call(this, err);
      });
    }
    return callback === undefined ? original(sql, params) : original(sql, params, callback);
  };
  return state;
}

test("pending Stripe success during a long import lock waits/retries before returning a durable URL", async (t) => {
  const { db } = await fixture(t);
  const ctx = checkoutContext(db);
  const request = ctx.start();
  await ctx.started;
  const writes = observeLinkWrites(db);
  const { pause, sync } = pausedImporter(db);
  const importing = sync();
  await pause.entered;
  ctx.completion.resolve({ id: "cs_durable", url: "https://checkout.invalid/session" });
  await writes.firstBusy;
  assert.equal(ctx.res.body, undefined, "must not return checkout URL on the first failed linkage attempt");
  pause.release();
  await importing;
  await request;
  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.state.creates, 1, "never retry Stripe creation while retrying SQLite");
  assert.equal(writes.attempts, 2);
  const row = await get(db, "SELECT * FROM booking_holds WHERE id = ?", [ctx.state.createArgs.metadata.hold_id]);
  assert.equal(row.stripe_session_id, "cs_durable");
  assert.equal(row.status, "active");
  assert.ok(ctx.state.createArgs.expires_at * 1000 < Date.parse(`${row.expires_at.replace(" ", "T")}Z`));
});

test("pending Stripe rejection under an import lock retains inventory without an unsafe release", async (t) => {
  const { db } = await fixture(t);
  const ctx = checkoutContext(db);
  const request = ctx.start();
  await ctx.started;
  const { pause, sync } = pausedImporter(db);
  const importing = sync();
  await pause.entered;
  ctx.completion.reject(new Error("ambiguous network failure after session create"));
  await request;
  assert.equal(ctx.res.statusCode, 503);
  assert.equal(ctx.res.body.url, undefined);
  assert.equal(ctx.state.creates, 1);
  const hold = await get(db, "SELECT status FROM booking_holds WHERE id = ?", [ctx.state.createArgs.metadata.hold_id]);
  assert.equal(hold.status, "active");
  assert.equal(await ctx.booking.checkAvailability(ctx.req.body.checkIn, ctx.req.body.checkOut), false);
  pause.release();
  await importing;
  assert.equal((await get(db, "SELECT status FROM booking_holds WHERE id = ?", [ctx.state.createArgs.metadata.hold_id])).status, "active");
});

test("session linkage retry exhaustion returns no URL and retains the potentially payable hold", async (t) => {
  const { db } = await fixture(t);
  const ctx = checkoutContext(db);
  const request = ctx.start();
  await ctx.started;
  db.configure("busyTimeout", 20);
  const writes = observeLinkWrites(db);
  const { pause, sync } = pausedImporter(db);
  const importing = sync();
  await pause.entered;
  ctx.completion.resolve({ id: "cs_still_payable", url: "https://checkout.invalid/session" });
  await request;
  assert.equal(writes.attempts, 3, "bounded SQL retry attempts must stop even if the lock remains");
  assert.equal(ctx.res.statusCode, 503);
  assert.equal(ctx.res.body.url, undefined);
  assert.equal(ctx.state.creates, 1);
  pause.release();
  await importing;
  const hold = await get(db, "SELECT status, stripe_session_id FROM booking_holds WHERE id = ?", [ctx.state.createArgs.metadata.hold_id]);
  assert.deepEqual(hold, { status: "active", stripe_session_id: null });
  assert.equal(await ctx.booking.createHold({ ...ctx.req.body, rentalType: "short_stay" }), null);
});

test("hard session linkage error is not retried and cannot release a successful Stripe session", async (t) => {
  const { db } = await fixture(t);
  const ctx = checkoutContext(db);
  const request = ctx.start();
  await ctx.started;
  await run(db, "CREATE TRIGGER fail_link BEFORE UPDATE OF stripe_session_id ON booking_holds BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
  const writes = observeLinkWrites(db);
  ctx.completion.resolve({ id: "cs_success", url: "https://checkout.invalid/session" });
  await request;
  assert.equal(writes.attempts, 1);
  assert.equal(ctx.res.statusCode, 503);
  assert.equal(ctx.res.body.url, undefined);
  assert.equal((await get(db, "SELECT status FROM booking_holds WHERE id = ?", [ctx.state.createArgs.metadata.hold_id])).status, "active");
});

for (const state of ["missing", "expired", "released", "conflicting", "confirmed"]) {
  test(`checkout ${state} hold is checked before returning the session URL`, async (t) => {
    const { db } = await fixture(t);
    const ctx = checkoutContext(db);
    const request = ctx.start();
    await ctx.started;
    const holdId = ctx.state.createArgs.metadata.hold_id;
    if (state === "missing") await run(db, "DELETE FROM booking_holds WHERE id = ?", [holdId]);
    if (state === "expired") await run(db, "UPDATE booking_holds SET expires_at = datetime('now', '-1 minute') WHERE id = ?", [holdId]);
    if (state === "released") await run(db, "UPDATE booking_holds SET status = 'released' WHERE id = ?", [holdId]);
    if (state === "conflicting") await run(db, "UPDATE booking_holds SET stripe_session_id = 'cs_other' WHERE id = ?", [holdId]);
    if (state === "confirmed") await ctx.booking.confirmHold(holdId, "cs_result");
    ctx.completion.resolve({ id: "cs_result", url: "https://checkout.invalid/session" });
    await request;
    assert.equal(ctx.res.statusCode, state === "confirmed" ? 200 : 503);
    assert.equal(Boolean(ctx.res.body.url), state === "confirmed");
    if (state === "conflicting") assert.equal((await get(db, "SELECT stripe_session_id FROM booking_holds WHERE id = ?", [holdId])).stripe_session_id, "cs_other");
    if (state === "confirmed") assert.equal((await get(db, "SELECT status FROM booking_holds WHERE id = ?", [holdId])).status, "confirmed");
  });
}

for (const method of ["releaseHold", "releaseHoldBySession", "confirmHold"]) {
  test(`${method} reports lock exhaustion safely and succeeds when retried after import`, async (t) => {
    const { db } = await fixture(t);
    db.configure("busyTimeout", 20);
    const booking = createBookingService({ db, holdMinutes: 35 });
    const holdId = await booking.createHold({ checkIn: "2027-07-01", checkOut: "2027-07-05", rentalType: "short_stay" });
    await booking.linkHoldSession(holdId, "cs_hold");
    const { pause, sync } = pausedImporter(db);
    const importing = sync();
    await pause.entered;
    const update = () => method === "releaseHoldBySession" ? booking[method]("cs_hold") : booking[method](holdId, "cs_hold");
    await assert.rejects(update(), { code: "SQLITE_BUSY" });
    assert.equal((await get(db, "SELECT status FROM booking_holds WHERE id = ?", [holdId])).status, "active");
    pause.release();
    await importing;
    await update();
    assert.equal((await get(db, "SELECT status FROM booking_holds WHERE id = ?", [holdId])).status, method === "confirmHold" ? "confirmed" : "released");
  });
}

test("mock checkout awaits linkage and catches a failed release without publishing a mock session", async (t) => {
  const { db } = await fixture(t);
  await run(db, "CREATE TRIGGER fail_updates BEFORE UPDATE ON booking_holds BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
  const ctx = checkoutContext(db, { mockPayments: true });
  await ctx.start();
  assert.equal(ctx.res.statusCode, 503);
  assert.equal(ctx.res.body.url, undefined);
  assert.equal(ctx.mockSessions.size, 0);
  assert.equal((await get(db, "SELECT status FROM booking_holds")).status, "active");
});

test("booking confirmation waits for hold persistence, fails visibly, and remains idempotent on retry", async (t) => {
  const { db } = await fixture(t);
  const ctx = checkoutContext(db, { mockPayments: true });
  await ctx.start();
  const sessionId = ctx.res.body.id;
  assert.ok(sessionId, "mock checkout must link durably before exposing its session");
  await run(db, "CREATE TRIGGER fail_confirm BEFORE UPDATE OF status ON booking_holds BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
  const first = response();
  await ctx.app.handlers["POST /api/bookings"]({ body: { sessionId } }, first);
  assert.equal(first.statusCode, 500);
  assert.equal((await get(db, "SELECT status FROM booking_holds WHERE stripe_session_id = ?", [sessionId])).status, "active");
  await run(db, "DROP TRIGGER fail_confirm");
  const retry = response();
  await ctx.app.handlers["POST /api/bookings"]({ body: { sessionId } }, retry);
  assert.equal(retry.statusCode, 201);
  assert.equal((await get(db, "SELECT status FROM booking_holds WHERE stripe_session_id = ?", [sessionId])).status, "confirmed");
  assert.equal((await get(db, "SELECT COUNT(*) AS count FROM bookings WHERE stripePaymentId = ?", [sessionId])).count, 1);
});

test("session linkage and confirmed booking insert cannot join another hold's rolled-back transaction", async (t) => {
  const { db } = await fixture(t);
  const booking = createBookingService({ db, holdMinutes: 35 });
  const first = await booking.createHold({ checkIn: "2027-07-01", checkOut: "2027-07-05", rentalType: "short_stay" });
  const entered = deferred(), release = deferred();
  const original = db.run.bind(db);
  let failCommit = true;
  db.run = (sql, params, callback) => {
    if (sql === "COMMIT" && failCommit) {
      failCommit = false;
      entered.resolve();
      release.promise.then(() => (typeof params === "function" ? params : callback)(new Error("injected commit failure")));
      return db;
    }
    return callback === undefined ? original(sql, params) : original(sql, params, callback);
  };
  const other = assert.rejects(booking.createHold({ checkIn: "2027-08-01", checkOut: "2027-08-05", rentalType: "short_stay" }));
  await entered.promise;
  let linked = false, recorded = false;
  const linking = booking.linkHoldSession(first, "cs_queued").then(() => { linked = true; });
  const recording = booking.recordConfirmedBooking({ checkIn: "2027-09-01", checkOut: "2027-09-05", sessionId: "cs_booking", rentalType: "short_stay", guests: 2 }).then(() => { recorded = true; });
  await new Promise(setImmediate);
  assert.equal(linked, false);
  assert.equal(recorded, false);
  release.resolve();
  await other;
  await linking;
  await recording;
  assert.equal((await get(db, "SELECT stripe_session_id FROM booking_holds WHERE id = ?", [first])).stripe_session_id, "cs_queued");
  assert.equal((await get(db, "SELECT COUNT(*) AS count FROM bookings WHERE stripePaymentId = 'cs_booking'")).count, 1);
  assert.equal((await get(db, "SELECT COUNT(*) AS count FROM booking_holds WHERE checkIn = '2027-08-01'")).count, 0);
});
