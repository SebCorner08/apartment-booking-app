const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const admin = fs.readFileSync("public/admin.html", "utf8");
const flowStart = admin.indexOf("// --- MANUAL BILLING ---");
const flowEnd = admin.indexOf("// Handle charge action buttons", flowStart);

assert(
  flowStart !== -1 && flowEnd > flowStart,
  "admin must define the manual-charge flow",
);

const flow = admin.slice(flowStart, flowEnd);
const storageKey = "pending-manual-charge-v1";

function createElement(value = "") {
  return {
    value,
    disabled: false,
    textContent: "",
    className: "",
    innerHTML: "",
    style: {},
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    appendChild() {},
  };
}

function createStorage(backing) {
  return {
    getItem(key) {
      return backing.has(key) ? backing.get(key) : null;
    },
    setItem(key, value) {
      backing.set(key, value);
    },
    removeItem(key) {
      backing.delete(key);
    },
  };
}

function createHarness({
  backing,
  fetchWithAuth,
  values = {},
  uuid = "22222222-2222-4222-8222-222222222222",
}) {
  const elements = new Map();
  [
    "billing-message",
    "charges-tbody",
    "no-charges",
    "btn-send-invoice",
    "billing-name",
    "billing-email",
    "billing-desc",
    "billing-amount",
  ].forEach((id) => elements.set(id, createElement(values[id] || "")));

  const context = {
    API_URL: "https://api.example.test",
    Uint8Array,
    console,
    fetchWithAuth,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout() {},
    window: {
      crypto: {
        randomUUID: () => uuid,
        getRandomValues(bytes) {
          bytes.fill(2);
          return bytes;
        },
      },
      sessionStorage: createStorage(backing),
    },
    document: {
      getElementById(id) {
        assert(elements.has(id), `unexpected element ${id}`);
        return elements.get(id);
      },
      createElement() {
        return createElement();
      },
    },
  };

  vm.runInNewContext(flow, context);
  return {
    elements,
    click: elements.get("btn-send-invoice").listeners.click,
  };
}

async function testFieldChangeInvalidatesRecoveredIdentity() {
  const backing = new Map();
  const originalFields = {
    name: "Stored Guest",
    email: "stored@example.test",
    desc: "Original charge",
    amount: 80,
  };
  backing.set(
    storageKey,
    JSON.stringify({
      requestId: "11111111-1111-4111-8111-111111111111",
      signature: JSON.stringify(originalFields),
      recoveryChargeId: 73,
      fields: originalFields,
    }),
  );

  let submittedBody;
  const harness = createHarness({
    backing,
    uuid: "22222222-2222-4222-8222-222222222222",
    fetchWithAuth: async (_url, options) => {
      if (options?.method === "POST") {
        submittedBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            id: 74,
            request_id: submittedBody.request_id,
          }),
        };
      }
      return { ok: true, json: async () => [] };
    },
  });

  assert.strictEqual(
    harness.elements.get("billing-desc").value,
    "Original charge",
    "stored pending request should restore its immutable fields",
  );

  harness.elements.get("billing-desc").value = "Changed charge";
  harness.elements.get("billing-desc").listeners.input();
  assert.strictEqual(
    backing.has(storageKey),
    false,
    "editing a charge-defining field must invalidate the retained recovery identity",
  );

  await harness.click();
  assert.strictEqual(
    submittedBody.request_id,
    "22222222-2222-4222-8222-222222222222",
    "the changed form must start a new logical request identity",
  );
  assert.strictEqual(submittedBody.description, "Changed charge");
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(submittedBody, "recovery_charge_id"),
    false,
    "an invalidated recovery charge ID must not leak into the new logical request",
  );
}

async function testManualReconciliationStopsAutomaticRetry() {
  const backing = new Map();
  let postCount = 0;
  const harness = createHarness({
    backing,
    uuid: "33333333-3333-4333-8333-333333333333",
    values: {
      "billing-name": "Reconcile Guest",
      "billing-email": "reconcile@example.test",
      "billing-desc": "Needs reconciliation",
      "billing-amount": "91.00",
    },
    fetchWithAuth: async (_url, options) => {
      if (options?.method === "POST") {
        postCount += 1;
        return {
          ok: false,
          json: async () => ({
            code: "MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED",
            recovery: { charge_id: 91 },
          }),
        };
      }
      return { ok: true, json: async () => [] };
    },
  });

  await harness.click();

  assert.strictEqual(
    postCount,
    1,
    "manual-reconciliation response must not automatically retry or create another charge",
  );
  const stored = JSON.parse(backing.get(storageKey));
  assert.strictEqual(stored.requestId, "33333333-3333-4333-8333-333333333333");
  assert.strictEqual(
    stored.recoveryChargeId,
    91,
    "manual-reconciliation state must preserve the server-owned charge ID",
  );
  assert.match(
    harness.elements.get("billing-message").textContent,
    /Charge #91 requires manual Stripe reconciliation/,
    "admin must receive an actionable manual-reconciliation message",
  );
  assert.strictEqual(
    harness.elements.get("btn-send-invoice").disabled,
    false,
    "the form must exit its in-flight state after reconciliation response",
  );
}

Promise.resolve()
  .then(testFieldChangeInvalidatesRecoveredIdentity)
  .then(testManualReconciliationStopsAutomaticRetry)
  .then(() =>
    console.log("admin manual-charge retry behavior regression checks passed"),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
