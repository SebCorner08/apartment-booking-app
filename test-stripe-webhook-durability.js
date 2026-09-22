const assert = require("assert");
const sqlite3 = require("sqlite3").verbose();
const {
  handleStripeWebhookRequest,
} = require("./server/stripe-webhook-persistence");

function exec(db, sql) {
  return new Promise((resolve, reject) =>
    db.exec(sql, (err) => (err ? reject(err) : resolve())),
  );
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    }),
  );
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))),
  );
}

function close(db) {
  return new Promise((resolve, reject) =>
    db.close((err) => (err ? reject(err) : resolve())),
  );
}

async function createTestDb() {
  const db = new sqlite3.Database(":memory:");
  await exec(
    db,
    `CREATE TABLE bookings (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       checkIn TEXT NOT NULL,
       checkOut TEXT NOT NULL,
       bookingStatus TEXT,
       stripePaymentId TEXT,
       rental_type TEXT DEFAULT 'short_stay',
       guests INTEGER DEFAULT 2
     );
     CREATE UNIQUE INDEX idx_bookings_stripe_payment_id
       ON bookings(stripePaymentId) WHERE stripePaymentId IS NOT NULL;
     CREATE TABLE booking_holds (
       id TEXT PRIMARY KEY,
       stripe_session_id TEXT,
       status TEXT DEFAULT 'active'
     );
     CREATE TABLE manual_charges (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       status TEXT DEFAULT 'pending',
       stripe_session_id TEXT,
       paid_at TEXT
     );`,
  );
  return db;
}

function fakeStripe(eventOrError) {
  return {
    webhooks: {
      constructEvent() {
        if (eventOrError instanceof Error) throw eventOrError;
        return eventOrError;
      },
    },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

function requestForWebhook() {
  return {
    body: Buffer.from("signed-payload"),
    headers: { "stripe-signature": "test-signature" },
  };
}

async function invoke({ db, event, broadcastAdminUpdate = () => {}, stripe }) {
  const res = fakeResponse();
  await handleStripeWebhookRequest({
    req: requestForWebhook(),
    res,
    stripe: stripe || fakeStripe(event),
    db,
    webhookSecret: "whsec_test",
    broadcastAdminUpdate,
    logger: { error() {} },
  });
  return res;
}

async function testBookingSuccessAndDuplicateIdempotency() {
  const db = await createTestDb();
  await run(
    db,
    `INSERT INTO booking_holds (id, stripe_session_id, status)
     VALUES (?, ?, 'active')`,
    ["hold-1", "cs_booking_1"],
  );

  let broadcasts = 0;
  const event = {
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_booking_1",
        payment_status: "paid",
        metadata: {
          hold_id: "hold-1",
          checkIn: "2027-01-10",
          checkOut: "2027-01-20",
          rental_type: "short_stay",
          guests: "4",
        },
      },
    },
  };

  const first = await invoke({
    db,
    event,
    broadcastAdminUpdate: () => broadcasts++,
  });
  assert.strictEqual(first.statusCode, 200);
  assert.deepStrictEqual(first.body, { received: true });

  const booking = await get(
    db,
    `SELECT checkIn, checkOut, bookingStatus, stripePaymentId, rental_type, guests
     FROM bookings WHERE stripePaymentId = ?`,
    ["cs_booking_1"],
  );
  assert.deepStrictEqual(booking, {
    checkIn: "2027-01-10",
    checkOut: "2027-01-20",
    bookingStatus: "confirmed",
    stripePaymentId: "cs_booking_1",
    rental_type: "short_stay",
    guests: 4,
  });
  const hold = await get(
    db,
    `SELECT status, stripe_session_id FROM booking_holds WHERE id = ?`,
    ["hold-1"],
  );
  assert.strictEqual(hold.status, "confirmed");
  assert.strictEqual(hold.stripe_session_id, "cs_booking_1");
  assert.strictEqual(broadcasts, 1);

  const duplicate = await invoke({
    db,
    event,
    broadcastAdminUpdate: () => broadcasts++,
  });
  assert.strictEqual(duplicate.statusCode, 200);
  const count = await get(
    db,
    `SELECT COUNT(*) AS n FROM bookings WHERE stripePaymentId = ?`,
    ["cs_booking_1"],
  );
  assert.strictEqual(count.n, 1, "duplicate webhook created a second booking");
  assert.strictEqual(broadcasts, 1, "duplicate webhook should not rebroadcast");

  await close(db);
}

async function testManualChargeSuccessAndDuplicateIdempotency() {
  const db = await createTestDb();
  await run(
    db,
    `INSERT INTO manual_charges (id, status) VALUES (?, 'pending')`,
    [42],
  );

  let broadcasts = 0;
  const event = {
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_charge_42",
        payment_status: "paid",
        metadata: { charge_id: "42" },
      },
    },
  };

  const first = await invoke({
    db,
    event,
    broadcastAdminUpdate: () => broadcasts++,
  });
  assert.strictEqual(first.statusCode, 200);

  const charge = await get(
    db,
    `SELECT status, stripe_session_id, paid_at FROM manual_charges WHERE id = ?`,
    [42],
  );
  assert.strictEqual(charge.status, "paid");
  assert.strictEqual(charge.stripe_session_id, "cs_charge_42");
  assert.ok(charge.paid_at, "paid_at was not durably written");
  assert.strictEqual(broadcasts, 1);

  const duplicate = await invoke({
    db,
    event,
    broadcastAdminUpdate: () => broadcasts++,
  });
  assert.strictEqual(duplicate.statusCode, 200);
  assert.strictEqual(broadcasts, 1, "duplicate charge webhook rebroadcasted");

  await close(db);
}

async function testPersistenceFailureReturns5xx() {
  const failingDb = {
    run(sql, params, callback) {
      setImmediate(() => callback.call({}, new Error("simulated disk failure")));
    },
    get() {
      throw new Error("get should not be reached after failed write");
    },
  };
  const event = {
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_failure",
        payment_status: "paid",
        metadata: {
          checkIn: "2027-02-01",
          checkOut: "2027-02-11",
          rental_type: "short_stay",
          guests: "2",
        },
      },
    },
  };

  const res = await invoke({ db: failingDb, event });
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { error: "Webhook persistence failed" });
}

async function testInvalidSignatureReturns400() {
  const db = await createTestDb();
  const res = await invoke({
    db,
    event: null,
    stripe: fakeStripe(new Error("bad signature")),
  });
  assert.strictEqual(res.statusCode, 400);
  assert.match(String(res.body), /Webhook Error/);
  await close(db);
}

async function testExpiredSessionAwaitsHoldRelease() {
  const db = await createTestDb();
  await run(
    db,
    `INSERT INTO booking_holds (id, stripe_session_id, status)
     VALUES (?, ?, 'active')`,
    ["hold-expired", "cs_expired"],
  );

  const event = {
    type: "checkout.session.expired",
    data: {
      object: {
        id: "cs_expired",
        metadata: { hold_id: "hold-expired" },
      },
    },
  };
  const res = await invoke({ db, event });
  assert.strictEqual(res.statusCode, 200);
  const hold = await get(
    db,
    `SELECT status FROM booking_holds WHERE id = ?`,
    ["hold-expired"],
  );
  assert.strictEqual(hold.status, "released");
  await close(db);
}

(async () => {
  const tests = [
    ["booking success + duplicate idempotency", testBookingSuccessAndDuplicateIdempotency],
    ["manual charge success + duplicate idempotency", testManualChargeSuccessAndDuplicateIdempotency],
    ["persistence failure returns 5xx", testPersistenceFailureReturns5xx],
    ["invalid signature returns 400", testInvalidSignatureReturns400],
    ["expired session awaits hold release", testExpiredSessionAwaitsHoldRelease],
  ];

  let passed = 0;
  for (const [name, test] of tests) {
    try {
      await test();
      passed++;
      console.log(`✅ ${name}`);
    } catch (err) {
      console.error(`❌ ${name}`);
      console.error(err);
      process.exitCode = 1;
      break;
    }
  }

  if (!process.exitCode) {
    console.log(`\n${passed}/${tests.length} webhook durability tests passed.`);
  }
})();
