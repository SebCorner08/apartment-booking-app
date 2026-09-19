const assert = require("assert");
const { registerAdminRoutes } = require("./server/routes/admin-routes");

const CHARGE = {
  guest_name: "Test Guest",
  guest_email: "guest@example.test",
  description: "Damage deposit",
  amount: 125.5,
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

function createManualChargeDb({ delayedUpdates = false, failedUpdates = 0 } = {}) {
  const rows = new Map();
  const pendingUpdates = [];
  let insertCount = 0;
  let updateCount = 0;

  return {
    rows,
    pendingUpdates,
    get insertCount() {
      return insertCount;
    },
    get updateCount() {
      return updateCount;
    },
    run(sql, params, callback) {
      if (sql.includes("INSERT INTO manual_charges")) {
        insertCount += 1;
        const id = 42;
        rows.set(id, {
          id,
          guest_name: params[0],
          guest_email: params[1],
          description: params[2],
          amount: params[3],
          status: "pending",
          stripe_session_id: null,
          created_at: new Date().toISOString(),
        });
        callback.call({ lastID: id, changes: 1 }, null);
        return;
      }

      if (sql.includes("UPDATE manual_charges")) {
        updateCount += 1;
        const [sessionId, chargeId] = params;
        const complete = () => {
          if (failedUpdates > 0) {
            failedUpdates -= 1;
            callback.call({ changes: 0 }, new Error("injected linkage failure"));
            return;
          }
          const row = rows.get(chargeId);
          if (!row || (row.stripe_session_id && row.stripe_session_id !== sessionId)) {
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
      const matches = [...rows.values()]
        .filter(
          (row) =>
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

function registerManualChargeRoute({ db, mockPayments, stripe, broadcast }) {
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
  const handlers = routes.get("POST /api/admin/charges");
  assert(handlers, "manual-charge route must be registered");
  return handlers;
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
    "manual-charge-42",
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

async function main() {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await testMockSuccessWaitsForPersistence();
    await testMockFailureRecoversExistingRow();
    await testStripeSuccessWaitsForPersistence();
    await testStripeFailureUsesIdempotentRecovery();
    await testStripePrunedKeyRequiresManualReconciliation();
    await testStripeSessionValidationFailsClosed();
  } finally {
    console.error = originalConsoleError;
  }

  console.log(
    "PASS: manual-charge ordering, retry recovery, pruning cutoff, and strict Stripe validation",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
