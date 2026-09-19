const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { registerAdminRoutes } = require("./server/routes/admin-routes");

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const CHARGE = {
  guest_name: "Test Guest",
  guest_email: "guest@example.test",
  description: "Damage deposit",
  amount: 125.5,
  request_id: REQUEST_ID,
};

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
    body: undefined,
    completed: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.completed = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.completed = true;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      this.completed = true;
      return this;
    },
    set() {
      return this;
    },
    cookie() {
      return this;
    },
    clearCookie() {
      return this;
    },
  };
}

function dispatch(handlers, req, res) {
  let index = 0;
  const next = () => {
    const handler = handlers[index++];
    return handler ? handler(req, res, next) : undefined;
  };
  return Promise.resolve(next());
}

function execDb(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function getDb(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

function createManualChargeDb({ delayedUpdates = false, failedUpdates = 0 } = {}) {
  const rows = new Map();
  const pendingUpdates = [];
  let insertCount = 0;
  let updateCount = 0;

  return {
    rows,
    pendingUpdates,
    seedRow(row) {
      rows.set(row.id, { ...row });
    },
    get insertCount() {
      return insertCount;
    },
    get updateCount() {
      return updateCount;
    },
    run(sql, params, callback) {
      if (sql.includes("INSERT INTO manual_charges")) {
        const requestId = params[4];
        const claimed = [...rows.values()].find(
          (row) => row.request_id === requestId,
        );
        if (claimed) {
          callback.call({ lastID: 0, changes: 0 }, null);
          return;
        }

        insertCount += 1;
        const id = rows.size === 0 ? 42 : Math.max(...rows.keys()) + 1;
        rows.set(id, {
          id,
          guest_name: params[0],
          guest_email: params[1],
          description: params[2],
          amount: params[3],
          request_id: requestId,
          status: "pending",
          stripe_session_id: null,
          created_at: new Date().toISOString(),
        });
        callback.call({ lastID: id, changes: 1 }, null);
        return;
      }

      if (
        sql.includes("UPDATE manual_charges") &&
        sql.includes("SET status = 'paid'")
      ) {
        updateCount += 1;
        const chargeId = Number(params[0]);
        const row = rows.get(chargeId);
        const hasAllowedMockSession =
          sql.includes("'mock_charge_' || id") &&
          row?.stripe_session_id === `mock_charge_${chargeId}`;
        if (
          !row ||
          row.status !== "pending" ||
          (row.stripe_session_id != null && !hasAllowedMockSession)
        ) {
          callback.call({ changes: 0 }, null);
          return;
        }
        row.status = "paid";
        row.paid_at = new Date().toISOString();
        callback.call({ changes: 1 }, null);
        return;
      }

      if (
        sql.includes("UPDATE manual_charges") &&
        sql.includes("SET stripe_session_id = ?")
      ) {
        updateCount += 1;
        const [sessionId, chargeId] = params;
        const complete = () => {
          if (failedUpdates > 0) {
            failedUpdates -= 1;
            callback.call({ changes: 0 }, new Error("injected linkage failure"));
            return;
          }
          const row = rows.get(chargeId);
          if (
            !row ||
            row.status !== "pending" ||
            row.stripe_session_id != null
          ) {
            callback.call({ changes: 0 }, null);
            return;
          }
          row.stripe_session_id = sessionId;
          callback.call({ changes: 1 }, null);
        };

        if (delayedUpdates) {
          pendingUpdates.push(complete);
        } else {
          complete();
        }
        return;
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
    get(sql, params, callback) {
      assert(sql.includes("FROM manual_charges"));
      if (sql.includes("WHERE id = ?")) {
        callback(null, rows.get(params[0]));
        return;
      }
      if (sql.includes("WHERE request_id = ?")) {
        callback(
          null,
          [...rows.values()].find((row) => row.request_id === params[0]),
        );
        return;
      }
      assert(
        sql.includes("request_id IS NULL"),
        `unexpected manual-charge lookup: ${sql}`,
      );
      const matches = [...rows.values()]
        .filter(
          (row) =>
            row.request_id == null &&
            row.guest_name === params[0] &&
            row.guest_email === params[1] &&
            row.description === params[2] &&
            Number(row.amount) === Number(params[3]) &&
            row.status === "pending" &&
            row.stripe_session_id == null,
        )
        .sort((left, right) => right.id - left.id);
      callback(null, matches[0]);
    },
    completeNextUpdate() {
      const complete = pendingUpdates.shift();
      assert(complete, "expected a pending linkage update");
      complete();
    },
  };
}

function createFakeStripe({ transformSession = (session) => session } = {}) {
  const sessionsByKey = new Map();
  const sessionsById = new Map();
  const createdSessions = [];
  const createCalls = [];
  const retrieveCalls = [];

  return {
    sessionsByKey,
    createdSessions,
    createCalls,
    retrieveCalls,
    seedRetrievedSession(sessionId, session) {
      sessionsById.set(sessionId, session);
    },
    checkout: {
      sessions: {
        async create(params, options) {
          createCalls.push({ params, options });
          let session = sessionsByKey.get(options.idempotencyKey);
          if (!session) {
            session = transformSession({
              id: `cs_test_${params.metadata.charge_id}`,
              url: `https://checkout.stripe.test/${params.metadata.charge_id}`,
              amount_total: params.line_items[0].price_data.unit_amount,
              currency: params.line_items[0].price_data.currency,
              mode: params.mode,
              metadata: params.metadata,
            });
            sessionsByKey.set(options.idempotencyKey, session);
            sessionsById.set(session.id, session);
            createdSessions.push(session);
          }
          return session;
        },
        async retrieve(sessionId) {
          retrieveCalls.push(sessionId);
          const session = sessionsById.get(sessionId);
          if (!session) throw new Error("unknown test session");
          return session;
        },
      },
    },
    pruneIdempotencyKeys() {
      sessionsByKey.clear();
    },
  };
}

function paidStripeSession({ session = {}, metadata = {} } = {}) {
  return {
    id: "cs_test_42",
    url: "https://checkout.stripe.test/42",
    payment_status: "paid",
    amount_total: Math.round(CHARGE.amount * 100),
    currency: "usd",
    mode: "payment",
    ...session,
    metadata: {
      charge_id: "42",
      request_id: REQUEST_ID,
      guest_name: CHARGE.guest_name,
      guest_email: CHARGE.guest_email,
      ...metadata,
    },
  };
}

function seedProtocolCharge(db, overrides = {}) {
  db.seedRow({
    id: 42,
    ...CHARGE,
    status: "pending",
    stripe_session_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  });
}

function registerManualChargeRoutes({ db, mockPayments, stripe, broadcast }) {
  const { app, routes } = createFakeApp();
  registerAdminRoutes(app, {
    loginLimiter: (_req, _res, next) => next(),
    adminPassword: "test-password",
    jwtSecret: "test-secret",
    adminSessionMinutes: 60,
    adminWsTicketTtlMs: 30000,
    adminCookieOptions: () => ({ httpOnly: true }),
    isAllowedOrigin: () => true,
    checkAdminAuth: (_req, _res, next) => next(),
    issueAdminWebSocketTicket: () => "test-ticket",
    db,
    broadcastAdminUpdate: broadcast,
    mockPayments,
    domain: "https://example.test",
    stripe,
  });
  const create = routes.get("POST /api/admin/charges");
  const markPaid = routes.get("POST /api/admin/charges/:id/pay");
  assert(create, "manual-charge route must be registered");
  assert(markPaid, "manual-charge mark-paid route must be registered");
  return { create, markPaid };
}

function registerManualChargeRoute(options) {
  return registerManualChargeRoutes(options).create;
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for isolated route state");
}

async function testMockSuccessWaitsForPersistence() {
  const db = createManualChargeDb({ delayedUpdates: true });
  let broadcasts = 0;
  const handlers = registerManualChargeRoute({
    db,
    mockPayments: true,
    stripe: null,
    broadcast: () => {
      broadcasts += 1;
    },
  });
  const res = createFakeResponse();
  const request = dispatch(handlers, { body: { ...CHARGE } }, res);

  await waitFor(() => db.pendingUpdates.length === 1);
  assert.strictEqual(res.completed, false, "201 must wait for linkage persistence");
  assert.strictEqual(broadcasts, 0, "broadcast must wait for linkage persistence");

  db.completeNextUpdate();
  await request;
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.stripe_session_id, "mock_charge_42");
  assert.strictEqual(db.rows.get(42).stripe_session_id, "mock_charge_42");
  assert.strictEqual(broadcasts, 1);
}

async function testMockFailureRecoversExistingRow() {
  const db = createManualChargeDb({ failedUpdates: 1 });
  let broadcasts = 0;
  const handlers = registerManualChargeRoute({
    db,
    mockPayments: true,
    stripe: null,
    broadcast: () => {
      broadcasts += 1;
    },
  });
  const failed = createFakeResponse();
  await dispatch(handlers, { body: { ...CHARGE } }, failed);

  assert.strictEqual(failed.statusCode, 503);
  assert.strictEqual(failed.body.code, "MANUAL_CHARGE_RECOVERY_REQUIRED");
  assert.deepStrictEqual(failed.body.recovery, { charge_id: 42 });
  assert.strictEqual(failed.body.stripe_session_id, undefined);
  assert.strictEqual(broadcasts, 0);

  const recovered = createFakeResponse();
  await dispatch(handlers, { body: { ...CHARGE } }, recovered);
  assert.strictEqual(recovered.statusCode, 201);
  assert.strictEqual(recovered.body.stripe_session_id, "mock_charge_42");
  assert.strictEqual(db.insertCount, 1, "recovery must not insert a duplicate row");
  assert.strictEqual(broadcasts, 1);
}

async function testStripeSuccessWaitsForPersistence() {
  const db = createManualChargeDb({ delayedUpdates: true });
  const stripe = createFakeStripe();
  let broadcasts = 0;
  const handlers = registerManualChargeRoute({
    db,
    mockPayments: false,
    stripe,
    broadcast: () => {
      broadcasts += 1;
    },
  });
  const res = createFakeResponse();
  const request = dispatch(handlers, { body: { ...CHARGE } }, res);

  await waitFor(() => db.pendingUpdates.length === 1);
  assert.strictEqual(res.completed, false, "real-Stripe 201 must await persistence");
  assert.strictEqual(broadcasts, 0);
  assert.strictEqual(stripe.createCalls.length, 1);
  assert.strictEqual(
    stripe.createCalls[0].options.idempotencyKey,
    `manual-charge-${REQUEST_ID}`,
  );

  db.completeNextUpdate();
  await request;
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.stripe_session_id, "cs_test_42");
  assert.strictEqual(db.rows.get(42).stripe_session_id, "cs_test_42");
  assert.strictEqual(broadcasts, 1);

  const replay = createFakeResponse();
  const replayRequest = dispatch(
    handlers,
    { body: { ...CHARGE, recovery_charge_id: 42 } },
    replay,
  );
  await waitFor(() => db.pendingUpdates.length === 1);
  assert.strictEqual(stripe.createCalls.length, 1);
  assert.deepStrictEqual(stripe.retrieveCalls, ["cs_test_42"]);
  assert.strictEqual(db.insertCount, 1);
  db.completeNextUpdate();
  await replayRequest;
  assert.strictEqual(replay.statusCode, 201);
  assert.strictEqual(replay.body.stripe_session_id, "cs_test_42");
}

async function testStripeFailureUsesIdempotentRecovery() {
  const db = createManualChargeDb({ failedUpdates: 1 });
  const stripe = createFakeStripe();
  let broadcasts = 0;
  const handlers = registerManualChargeRoute({
    db,
    mockPayments: false,
    stripe,
    broadcast: () => {
      broadcasts += 1;
    },
  });
  const failed = createFakeResponse();
  await dispatch(handlers, { body: { ...CHARGE } }, failed);

  assert.strictEqual(failed.statusCode, 503);
  assert.strictEqual(failed.body.code, "MANUAL_CHARGE_RECOVERY_REQUIRED");
  assert.deepStrictEqual(failed.body.recovery, { charge_id: 42 });
  assert.strictEqual(stripe.sessionsByKey.size, 1);
  assert.strictEqual(broadcasts, 0);

  const recovered = createFakeResponse();
  await dispatch(handlers, { body: { ...CHARGE } }, recovered);

  assert.strictEqual(recovered.statusCode, 201);
  assert.strictEqual(recovered.body.stripe_session_id, "cs_test_42");
  assert.strictEqual(db.insertCount, 1, "recovery must reuse the existing row");
  assert.strictEqual(stripe.createCalls.length, 2);
  assert.strictEqual(
    stripe.createCalls[0].options.idempotencyKey,
    stripe.createCalls[1].options.idempotencyKey,
  );
  assert.strictEqual(
    stripe.sessionsByKey.size,
    1,
    "the repeated create seam must resolve to one Stripe session",
  );
  assert.strictEqual(db.rows.get(42).stripe_session_id, "cs_test_42");
  assert.strictEqual(broadcasts, 1);
}

async function testManualPayAndSessionLinkageAreSerialized() {
  const manualPayFirstDb = createManualChargeDb({ delayedUpdates: true });
  const manualPayFirstStripe = createFakeStripe();
  let manualPayFirstBroadcasts = 0;
  const manualPayFirstRoutes = registerManualChargeRoutes({
    db: manualPayFirstDb,
    mockPayments: false,
    stripe: manualPayFirstStripe,
    broadcast: () => {
      manualPayFirstBroadcasts += 1;
    },
  });
  const createAfterManualPay = createFakeResponse();
  const createAfterManualPayRequest = dispatch(
    manualPayFirstRoutes.create,
    { body: { ...CHARGE } },
    createAfterManualPay,
  );
  await waitFor(() => manualPayFirstDb.pendingUpdates.length === 1);

  const manualPay = createFakeResponse();
  await dispatch(
    manualPayFirstRoutes.markPaid,
    { params: { id: 42 } },
    manualPay,
  );
  assert.strictEqual(manualPay.statusCode, 200);
  assert.deepStrictEqual(manualPay.body, {
    message: "Charge marked as paid",
    changes: 1,
  });
  manualPayFirstDb.completeNextUpdate();
  await createAfterManualPayRequest;

  assert.strictEqual(createAfterManualPay.statusCode, 409);
  assert.strictEqual(
    createAfterManualPay.body.code,
    "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
  );
  assert.strictEqual(createAfterManualPay.body.url, undefined);
  assert.strictEqual(createAfterManualPay.body.stripe_session_id, undefined);
  assert.strictEqual(manualPayFirstDb.rows.get(42).status, "paid");
  assert.strictEqual(manualPayFirstDb.rows.get(42).stripe_session_id, null);
  assert.strictEqual(manualPayFirstStripe.createCalls.length, 1);
  assert.strictEqual(manualPayFirstBroadcasts, 1);

  const linkageFirstDb = createManualChargeDb({ delayedUpdates: true });
  const linkageFirstStripe = createFakeStripe();
  let linkageFirstBroadcasts = 0;
  const linkageFirstRoutes = registerManualChargeRoutes({
    db: linkageFirstDb,
    mockPayments: false,
    stripe: linkageFirstStripe,
    broadcast: () => {
      linkageFirstBroadcasts += 1;
    },
  });
  const createBeforeManualPay = createFakeResponse();
  const createBeforeManualPayRequest = dispatch(
    linkageFirstRoutes.create,
    { body: { ...CHARGE } },
    createBeforeManualPay,
  );
  await waitFor(() => linkageFirstDb.pendingUpdates.length === 1);
  linkageFirstDb.completeNextUpdate();
  await createBeforeManualPayRequest;
  assert.strictEqual(createBeforeManualPay.statusCode, 201);
  assert.strictEqual(
    createBeforeManualPay.body.stripe_session_id,
    "cs_test_42",
  );

  const rejectedManualPay = createFakeResponse();
  await dispatch(
    linkageFirstRoutes.markPaid,
    { params: { id: 42 } },
    rejectedManualPay,
  );
  assert.strictEqual(rejectedManualPay.statusCode, 409);
  assert.strictEqual(
    rejectedManualPay.body.code,
    "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
  );
  assert.strictEqual(linkageFirstDb.rows.get(42).status, "pending");
  assert.strictEqual(
    linkageFirstDb.rows.get(42).stripe_session_id,
    "cs_test_42",
  );
  assert.strictEqual(linkageFirstStripe.createCalls.length, 1);
  assert.strictEqual(linkageFirstBroadcasts, 1);

  const legitimateManualPayDb = createManualChargeDb();
  seedProtocolCharge(legitimateManualPayDb);
  let legitimateManualPayBroadcasts = 0;
  const legitimateManualPayRoutes = registerManualChargeRoutes({
    db: legitimateManualPayDb,
    mockPayments: false,
    stripe: null,
    broadcast: () => {
      legitimateManualPayBroadcasts += 1;
    },
  });
  const legitimateManualPay = createFakeResponse();
  await dispatch(
    legitimateManualPayRoutes.markPaid,
    { params: { id: 42 } },
    legitimateManualPay,
  );
  assert.strictEqual(legitimateManualPay.statusCode, 200);
  assert.strictEqual(legitimateManualPay.body.changes, 1);
  assert.strictEqual(legitimateManualPayDb.rows.get(42).status, "paid");
  assert.strictEqual(
    legitimateManualPayDb.rows.get(42).stripe_session_id,
    null,
  );
  assert.ok(legitimateManualPayDb.rows.get(42).paid_at);
  assert.strictEqual(legitimateManualPayBroadcasts, 1);

  const mockManualPayDb = createManualChargeDb();
  seedProtocolCharge(mockManualPayDb, {
    stripe_session_id: "mock_charge_42",
  });
  let mockManualPayBroadcasts = 0;
  const mockManualPayRoutes = registerManualChargeRoutes({
    db: mockManualPayDb,
    mockPayments: true,
    stripe: null,
    broadcast: () => {
      mockManualPayBroadcasts += 1;
    },
  });
  const mockManualPay = createFakeResponse();
  await dispatch(
    mockManualPayRoutes.markPaid,
    { params: { id: 42 } },
    mockManualPay,
  );
  assert.strictEqual(mockManualPay.statusCode, 200);
  assert.strictEqual(mockManualPay.body.changes, 1);
  assert.strictEqual(mockManualPayDb.rows.get(42).status, "paid");
  assert.strictEqual(
    mockManualPayDb.rows.get(42).stripe_session_id,
    "mock_charge_42",
  );
  assert.strictEqual(mockManualPayBroadcasts, 1);
}

async function testWebhookFirstLinkageStillConverges() {
  const db = createManualChargeDb({ delayedUpdates: true });
  const stripe = createFakeStripe();
  let broadcasts = 0;
  const handlers = registerManualChargeRoute({
    db,
    mockPayments: false,
    stripe,
    broadcast: () => {
      broadcasts += 1;
    },
  });
  const response = createFakeResponse();
  const request = dispatch(handlers, { body: { ...CHARGE } }, response);
  await waitFor(() => db.pendingUpdates.length === 1);

  const row = db.rows.get(42);
  row.status = "paid";
  row.stripe_session_id = "cs_test_42";
  row.paid_at = new Date().toISOString();
  db.completeNextUpdate();
  await request;

  assert.strictEqual(response.statusCode, 201);
  assert.strictEqual(response.body.request_id, REQUEST_ID);
  assert.strictEqual(response.body.stripe_session_id, "cs_test_42");
  assert.strictEqual(row.status, "paid");
  assert.strictEqual(row.stripe_session_id, "cs_test_42");
  assert.strictEqual(stripe.createCalls.length, 1);
  assert.strictEqual(broadcasts, 0);
}

async function testPaidStripeRetryRecoversLinkedSession() {
  const db = createManualChargeDb();
  seedProtocolCharge(db, {
    status: "paid",
    stripe_session_id: "cs_test_42",
  });
  const stripe = createFakeStripe();
  stripe.seedRetrievedSession("cs_test_42", paidStripeSession());
  let broadcasts = 0;
  const handlers = registerManualChargeRoute({
    db,
    mockPayments: false,
    stripe,
    broadcast: () => {
      broadcasts += 1;
    },
  });

  const recovered = createFakeResponse();
  await dispatch(handlers, { body: { ...CHARGE } }, recovered);

  assert.strictEqual(recovered.statusCode, 201);
  assert.strictEqual(recovered.body.id, 42);
  assert.strictEqual(recovered.body.request_id, REQUEST_ID);
  assert.strictEqual(recovered.body.stripe_session_id, "cs_test_42");
  assert.strictEqual(
    recovered.body.url,
    "https://checkout.stripe.test/42",
  );
  assert.deepStrictEqual(stripe.retrieveCalls, ["cs_test_42"]);
  assert.strictEqual(stripe.createCalls.length, 0);
  assert.strictEqual(stripe.createdSessions.length, 0);
  assert.strictEqual(db.insertCount, 0);
  assert.strictEqual(db.updateCount, 0);
  assert.strictEqual(broadcasts, 0);
}

async function testPaidStripeRetryFailsClosed() {
  const cases = [
    {
      name: "paid row without linkage",
      row: { status: "paid", stripe_session_id: null },
      expectedStatus: 409,
      expectedCode: "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
      expectedRetrieves: [],
    },
    {
      name: "retrieved session ID mismatch",
      row: { status: "paid", stripe_session_id: "cs_test_42" },
      retrieved: paidStripeSession({ session: { id: "cs_other_42" } }),
      expectedStatus: 409,
      expectedCode: "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
      expectedRetrieves: ["cs_test_42"],
    },
    {
      name: "retrieved request mismatch",
      row: { status: "paid", stripe_session_id: "cs_test_42" },
      retrieved: paidStripeSession({
        metadata: {
          request_id: "22222222-2222-4222-8222-222222222222",
        },
      }),
      expectedStatus: 409,
      expectedCode: "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
      expectedRetrieves: ["cs_test_42"],
    },
    {
      name: "retrieved session is not paid",
      row: { status: "paid", stripe_session_id: "cs_test_42" },
      retrieved: paidStripeSession({
        session: { payment_status: "unpaid" },
      }),
      expectedStatus: 409,
      expectedCode: "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
      expectedRetrieves: ["cs_test_42"],
    },
    {
      name: "other nonpending state",
      row: { status: "cancelled", stripe_session_id: "cs_test_42" },
      expectedStatus: 409,
      expectedCode: "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
      expectedRetrieves: [],
    },
  ];

  for (const testCase of cases) {
    const db = createManualChargeDb();
    seedProtocolCharge(db, testCase.row);
    const stripe = createFakeStripe();
    if (testCase.retrieved) {
      stripe.seedRetrievedSession("cs_test_42", testCase.retrieved);
    }
    let broadcasts = 0;
    const handlers = registerManualChargeRoute({
      db,
      mockPayments: false,
      stripe,
      broadcast: () => {
        broadcasts += 1;
      },
    });

    const response = createFakeResponse();
    await dispatch(handlers, { body: { ...CHARGE } }, response);

    assert.strictEqual(
      response.statusCode,
      testCase.expectedStatus,
      testCase.name,
    );
    assert.strictEqual(response.body.code, testCase.expectedCode, testCase.name);
    assert.deepStrictEqual(
      response.body.recovery,
      { charge_id: 42 },
      testCase.name,
    );
    assert.deepStrictEqual(
      stripe.retrieveCalls,
      testCase.expectedRetrieves,
      testCase.name,
    );
    assert.strictEqual(stripe.createCalls.length, 0, testCase.name);
    assert.strictEqual(stripe.createdSessions.length, 0, testCase.name);
    assert.strictEqual(db.insertCount, 0, testCase.name);
    assert.strictEqual(db.updateCount, 0, testCase.name);
    assert.strictEqual(broadcasts, 0, testCase.name);
  }
}

async function testPaidMockAndNoProviderBehavior() {
  const mockDb = createManualChargeDb();
  seedProtocolCharge(mockDb, {
    status: "paid",
    stripe_session_id: "mock_charge_42",
  });
  let mockBroadcasts = 0;
  const mockHandlers = registerManualChargeRoute({
    db: mockDb,
    mockPayments: true,
    stripe: null,
    broadcast: () => {
      mockBroadcasts += 1;
    },
  });
  const mockResponse = createFakeResponse();
  await dispatch(mockHandlers, { body: { ...CHARGE } }, mockResponse);
  assert.strictEqual(mockResponse.statusCode, 201);
  assert.strictEqual(mockResponse.body.request_id, REQUEST_ID);
  assert.strictEqual(mockResponse.body.stripe_session_id, "mock_charge_42");
  assert.strictEqual(mockDb.updateCount, 0);
  assert.strictEqual(mockBroadcasts, 0);

  const mismatchedMockDb = createManualChargeDb();
  seedProtocolCharge(mismatchedMockDb, {
    status: "paid",
    stripe_session_id: "mock_charge_other",
  });
  const mismatchedMockHandlers = registerManualChargeRoute({
    db: mismatchedMockDb,
    mockPayments: true,
    stripe: null,
    broadcast: () => {},
  });
  const mismatchedMockResponse = createFakeResponse();
  await dispatch(
    mismatchedMockHandlers,
    { body: { ...CHARGE } },
    mismatchedMockResponse,
  );
  assert.strictEqual(mismatchedMockResponse.statusCode, 409);
  assert.strictEqual(
    mismatchedMockResponse.body.code,
    "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
  );
  assert.strictEqual(mismatchedMockDb.updateCount, 0);

  const unavailableDb = createManualChargeDb();
  seedProtocolCharge(unavailableDb, {
    status: "paid",
    stripe_session_id: "cs_test_42",
  });
  let unavailableBroadcasts = 0;
  const unavailableHandlers = registerManualChargeRoute({
    db: unavailableDb,
    mockPayments: false,
    stripe: null,
    broadcast: () => {
      unavailableBroadcasts += 1;
    },
  });
  const unavailableResponse = createFakeResponse();
  await dispatch(
    unavailableHandlers,
    { body: { ...CHARGE } },
    unavailableResponse,
  );
  assert.strictEqual(unavailableResponse.statusCode, 503);
  assert.strictEqual(
    unavailableResponse.body.code,
    "MANUAL_CHARGE_RECOVERY_REQUIRED",
  );
  assert.strictEqual(unavailableDb.updateCount, 0);
  assert.strictEqual(unavailableBroadcasts, 0);

  const linkedPendingDb = createManualChargeDb();
  seedProtocolCharge(linkedPendingDb, {
    status: "pending",
    stripe_session_id: "cs_linked_42",
  });
  let linkedPendingBroadcasts = 0;
  const linkedPendingHandlers = registerManualChargeRoute({
    db: linkedPendingDb,
    mockPayments: false,
    stripe: null,
    broadcast: () => {
      linkedPendingBroadcasts += 1;
    },
  });
  const linkedPendingResponse = createFakeResponse();
  await dispatch(
    linkedPendingHandlers,
    { body: { ...CHARGE } },
    linkedPendingResponse,
  );
  assert.strictEqual(linkedPendingResponse.statusCode, 503);
  assert.strictEqual(
    linkedPendingResponse.body.code,
    "MANUAL_CHARGE_RECOVERY_REQUIRED",
  );
  assert.deepStrictEqual(linkedPendingResponse.body.recovery, {
    charge_id: 42,
  });
  assert.strictEqual(linkedPendingResponse.body.url, undefined);
  assert.strictEqual(linkedPendingDb.updateCount, 0);
  assert.strictEqual(linkedPendingBroadcasts, 0);

  const pendingDb = createManualChargeDb();
  let pendingBroadcasts = 0;
  const pendingHandlers = registerManualChargeRoute({
    db: pendingDb,
    mockPayments: false,
    stripe: null,
    broadcast: () => {
      pendingBroadcasts += 1;
    },
  });
  const pendingResponse = createFakeResponse();
  await dispatch(pendingHandlers, { body: { ...CHARGE } }, pendingResponse);
  assert.strictEqual(pendingResponse.statusCode, 201);
  assert.strictEqual(pendingResponse.body.request_id, REQUEST_ID);
  assert.strictEqual(pendingResponse.body.stripe_session_id, null);
  assert.strictEqual(pendingDb.insertCount, 1);
  assert.strictEqual(pendingDb.updateCount, 0);
  assert.strictEqual(pendingBroadcasts, 1);
}

async function testStripePrunedKeyRequiresManualReconciliation() {
  const db = createManualChargeDb({ failedUpdates: 1 });
  const stripe = createFakeStripe();
  let broadcasts = 0;
  const handlers = registerManualChargeRoute({
    db,
    mockPayments: false,
    stripe,
    broadcast: () => {
      broadcasts += 1;
    },
  });
  const failed = createFakeResponse();
  await dispatch(handlers, { body: { ...CHARGE } }, failed);
  assert.strictEqual(failed.statusCode, 503);

  db.rows.get(42).created_at = new Date(
    Date.now() - 25 * 60 * 60 * 1000,
  ).toISOString();
  stripe.pruneIdempotencyKeys();

  const retry = createFakeResponse();
  await dispatch(handlers, { body: { ...CHARGE } }, retry);
  assert.strictEqual(retry.statusCode, 409);
  assert.strictEqual(
    retry.body.code,
    "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
  );
  assert.deepStrictEqual(retry.body.recovery, { charge_id: 42 });
  assert.strictEqual(db.insertCount, 1);
  assert.strictEqual(stripe.createCalls.length, 1);
  assert.strictEqual(
    stripe.createdSessions.length,
    1,
    "an expired idempotency boundary must not issue another Stripe create",
  );
  assert.strictEqual(db.rows.get(42).stripe_session_id, null);
  assert.strictEqual(broadcasts, 0);
}

async function testStripeSessionValidationFailsClosed() {
  const cases = [
    ["missing amount", (session) => ({ ...session, amount_total: undefined })],
    ["wrong amount", (session) => ({ ...session, amount_total: 1 })],
    ["missing currency", (session) => ({ ...session, currency: undefined })],
    ["wrong currency", (session) => ({ ...session, currency: "eur" })],
    ["wrong mode", (session) => ({ ...session, mode: "setup" })],
    [
      "missing request metadata",
      (session) => ({
        ...session,
        metadata: { ...session.metadata, request_id: undefined },
      }),
    ],
    [
      "wrong request metadata",
      (session) => ({
        ...session,
        metadata: {
          ...session.metadata,
          request_id: "22222222-2222-4222-8222-222222222222",
        },
      }),
    ],
    [
      "wrong metadata",
      (session) => ({
        ...session,
        metadata: { ...session.metadata, charge_id: "999" },
      }),
    ],
  ];

  for (const [name, transformSession] of cases) {
    const db = createManualChargeDb();
    const stripe = createFakeStripe({ transformSession });
    let broadcasts = 0;
    const handlers = registerManualChargeRoute({
      db,
      mockPayments: false,
      stripe,
      broadcast: () => {
        broadcasts += 1;
      },
    });
    const res = createFakeResponse();
    await dispatch(handlers, { body: { ...CHARGE } }, res);

    assert.strictEqual(res.statusCode, 409, name);
    assert.strictEqual(
      res.body.code,
      "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
      name,
    );
    assert.strictEqual(db.updateCount, 0, name);
    assert.strictEqual(db.rows.get(42).stripe_session_id, null, name);
    assert.strictEqual(broadcasts, 0, name);
  }
}

async function testRequestIdentityContract() {
  const db = createManualChargeDb();
  const handlers = registerManualChargeRoute({
    db,
    mockPayments: true,
    stripe: null,
    broadcast: () => {},
  });

  const missing = createFakeResponse();
  const { request_id: _requestId, ...withoutRequestId } = CHARGE;
  await dispatch(handlers, { body: withoutRequestId }, missing);
  assert.strictEqual(missing.statusCode, 400);
  assert.strictEqual(
    missing.body.code,
    "MANUAL_CHARGE_REQUEST_ID_REQUIRED",
  );

  const invalid = createFakeResponse();
  await dispatch(
    handlers,
    { body: { ...CHARGE, request_id: "not-a-uuid" } },
    invalid,
  );
  assert.strictEqual(invalid.statusCode, 400);
  assert.strictEqual(
    invalid.body.code,
    "MANUAL_CHARGE_REQUEST_ID_INVALID",
  );
  assert.strictEqual(db.insertCount, 0);

  const created = createFakeResponse();
  await dispatch(
    handlers,
    { body: { ...CHARGE, status: "paid", stripe_session_id: "client-value" } },
    created,
  );
  assert.strictEqual(created.statusCode, 201);
  assert.strictEqual(created.body.request_id, REQUEST_ID);
  assert.strictEqual(
    db.rows.get(42).status,
    "pending",
    "client payment status must not change server-owned state",
  );
  assert.strictEqual(
    db.rows.get(42).stripe_session_id,
    "mock_charge_42",
    "client session IDs must be ignored",
  );

  const conflict = createFakeResponse();
  await dispatch(
    handlers,
    { body: { ...CHARGE, amount: CHARGE.amount + 1 } },
    conflict,
  );
  assert.strictEqual(conflict.statusCode, 409);
  assert.strictEqual(
    conflict.body.code,
    "MANUAL_CHARGE_REQUEST_ID_CONFLICT",
  );
  assert.strictEqual(db.insertCount, 1);
}

async function testLegacyUnkeyedChargeRequiresManualReconciliation() {
  const db = createManualChargeDb();
  db.seedRow({
    id: 17,
    guest_name: CHARGE.guest_name,
    guest_email: CHARGE.guest_email,
    description: CHARGE.description,
    amount: CHARGE.amount,
    request_id: null,
    status: "pending",
    stripe_session_id: null,
    created_at: new Date().toISOString(),
  });
  const stripe = createFakeStripe();
  const handlers = registerManualChargeRoute({
    db,
    mockPayments: false,
    stripe,
    broadcast: () => {},
  });

  const automatic = createFakeResponse();
  await dispatch(handlers, { body: { ...CHARGE } }, automatic);
  assert.strictEqual(automatic.statusCode, 409);
  assert.strictEqual(
    automatic.body.code,
    "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
  );
  assert.deepStrictEqual(automatic.body.recovery, { charge_id: 17 });

  const explicit = createFakeResponse();
  await dispatch(
    handlers,
    { body: { ...CHARGE, recovery_charge_id: 17 } },
    explicit,
  );
  assert.strictEqual(explicit.statusCode, 409);
  assert.strictEqual(
    explicit.body.code,
    "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
  );
  assert.strictEqual(db.insertCount, 0);
  assert.strictEqual(stripe.createCalls.length, 0);
}

async function testConcurrentConnectionsAtomicallyClaimOneCharge() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "manual-charge-concurrency-"),
  );
  const databasePath = path.join(tempRoot, "manual-charges.db");
  const schemaDb = new sqlite3.Database(databasePath);
  let dbA;
  let dbB;

  try {
    await execDb(
      schemaDb,
      `CREATE TABLE manual_charges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guest_name TEXT NOT NULL,
        guest_email TEXT NOT NULL,
        description TEXT NOT NULL,
        amount REAL NOT NULL,
        status TEXT DEFAULT 'pending',
        stripe_session_id TEXT,
        request_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        paid_at TEXT
      );
      CREATE UNIQUE INDEX idx_manual_charges_request_id
        ON manual_charges(request_id) WHERE request_id IS NOT NULL;`,
    );
    await closeDb(schemaDb);

    dbA = new sqlite3.Database(databasePath);
    dbB = new sqlite3.Database(databasePath);
    dbA.configure("busyTimeout", 5000);
    dbB.configure("busyTimeout", 5000);

    const stripe = createFakeStripe();
    const handlersA = registerManualChargeRoute({
      db: dbA,
      mockPayments: false,
      stripe,
      broadcast: () => {},
    });
    const handlersB = registerManualChargeRoute({
      db: dbB,
      mockPayments: false,
      stripe,
      broadcast: () => {},
    });
    const responseA = createFakeResponse();
    const responseB = createFakeResponse();

    await Promise.all([
      dispatch(handlersA, { body: { ...CHARGE } }, responseA),
      dispatch(handlersB, { body: { ...CHARGE } }, responseB),
    ]);

    assert.strictEqual(responseA.statusCode, 201);
    assert.strictEqual(responseB.statusCode, 201);
    assert.strictEqual(responseA.body.id, responseB.body.id);
    assert.strictEqual(
      responseA.body.stripe_session_id,
      responseB.body.stripe_session_id,
    );
    const persisted = await getDb(
      dbA,
      `SELECT COUNT(*) AS count,
              COUNT(DISTINCT request_id) AS request_count,
              COUNT(DISTINCT stripe_session_id) AS session_count
       FROM manual_charges`,
    );
    assert.deepStrictEqual(persisted, {
      count: 1,
      request_count: 1,
      session_count: 1,
    });
    assert.strictEqual(stripe.createdSessions.length, 1);
    assert.ok(
      stripe.createCalls.length >= 1 && stripe.createCalls.length <= 2,
      "concurrent requests may create concurrently or retrieve the persisted session",
    );
    assert.deepStrictEqual(
      new Set(stripe.createCalls.map((call) => call.options.idempotencyKey)),
      new Set([`manual-charge-${REQUEST_ID}`]),
    );
  } finally {
    if (dbA) await closeDb(dbA);
    if (dbB) await closeDb(dbB);
    if (schemaDb.open) await closeDb(schemaDb);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await testMockSuccessWaitsForPersistence();
    await testMockFailureRecoversExistingRow();
    await testStripeSuccessWaitsForPersistence();
    await testStripeFailureUsesIdempotentRecovery();
    await testManualPayAndSessionLinkageAreSerialized();
    await testWebhookFirstLinkageStillConverges();
    await testPaidStripeRetryRecoversLinkedSession();
    await testPaidStripeRetryFailsClosed();
    await testPaidMockAndNoProviderBehavior();
    await testStripePrunedKeyRequiresManualReconciliation();
    await testStripeSessionValidationFailsClosed();
    await testRequestIdentityContract();
    await testLegacyUnkeyedChargeRequiresManualReconciliation();
    await testConcurrentConnectionsAtomicallyClaimOneCharge();
  } finally {
    console.error = originalConsoleError;
  }

  console.log(
    "PASS: manual-charge durability, paid retry recovery, manual-pay serialization, atomic request claims, legacy reconciliation, pruning cutoff, and strict Stripe validation",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
