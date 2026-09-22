const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const admin = fs.readFileSync("public/admin.html", "utf8");
const flowStart = admin.indexOf("// --- MANUAL BILLING ---");
const flowEnd = admin.indexOf("// --- INICIALIZAR ---", flowStart);

assert(
  flowStart !== -1 && flowEnd > flowStart,
  "admin must define the manual-charge flow",
);

const flow = admin.slice(flowStart, flowEnd);
const sendStart = flow.indexOf("// Send invoice");
const sendFlow = flow.slice(sendStart);
const actionStart = flow.indexOf("// Handle charge action buttons");
const actionFlow = flow.slice(actionStart);

assert(
  flow.includes("createManualChargeRequestId") &&
    flow.includes("window.crypto.randomUUID") &&
    flow.includes("window.crypto.getRandomValues"),
  "manual charges must use a secure UUID v4 request identity",
);
assert(
  sendFlow.includes("request_id: activeManualChargeRequest.requestId"),
  "manual-charge requests must send the retained request identity",
);
assert(
  sendFlow.includes("requestBody.recovery_charge_id") &&
    sendFlow.includes("result.recovery?.charge_id"),
  "manual-charge retries must retain and resend the recovery charge ID",
);
assert(
  sendFlow.includes("MANUAL_CHARGE_RECOVERY_REQUIRED") &&
    sendFlow.includes("MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED"),
  "manual-charge UI must distinguish retryable and manual reconciliation states",
);
assert(
  flow.includes('input.addEventListener("input", () => {') &&
    flow.includes("clearPendingManualChargeRequest();"),
  "manual-charge request identity must clear after field changes and success",
);
assert(
  sendFlow.includes(
    "result.request_id !== activeManualChargeRequest.requestId",
  ) &&
    sendFlow.includes(
      "pendingManualChargeRequest === activeManualChargeRequest",
    ),
  "manual-charge success must match the retained request identity",
);

assert(
  flow.includes('const manualChargeStorageKey = "pending-manual-charge-v1"') &&
    flow.includes("window.sessionStorage.setItem") &&
    flow.includes("window.sessionStorage.getItem") &&
    flow.includes("window.sessionStorage.removeItem"),
  "pending manual charges must survive a same-tab page reload",
);
assert(
  flow.includes("restorePendingManualChargeRequest();") &&
    flow.includes("pendingManualChargeRequest = stored;") &&
    flow.includes(
      'document.getElementById("billing-name").value = fields.name',
    ) &&
    flow.includes(
      'document.getElementById("billing-email").value = fields.email',
    ) &&
    flow.includes('document.getElementById("billing-desc").value = fields.desc'),
  "reload recovery must restore the immutable request and exact form fields",
);
assert(
  sendFlow.includes("fields: requestFields") &&
    sendFlow.indexOf("persistPendingManualChargeRequest(nextRequest)") <
      sendFlow.indexOf("const response = await fetchWithAuth"),
  "the request identity and fields must be stored before the POST",
);
assert(
  sendFlow.match(/persistPendingManualChargeRequest\(\s*activeManualChargeRequest/) &&
    sendFlow.includes("activeManualChargeRequest.recoveryChargeId"),
  "a returned recovery charge ID must be stored with the active request",
);
assert(
  flow.includes("setManualChargeFormBusy(true);") &&
    flow.includes("setManualChargeFormBusy(false);") &&
    flow.includes("sendInvoiceButton.disabled = isBusy"),
  "the form must not discard the active identity while a request is in flight",
);
assert(
  flow.includes("if (manualChargeStorageError)") &&
    sendFlow.includes('showBillingMessage(manualChargeStorageError, "error")'),
  "storage failure must stop a reload-unsafe submission",
);
assert(
  actionFlow.includes("clearResolvedManualChargeRequest(chargeId)") &&
    actionFlow.includes("if (!response.ok)"),
  "successful settlement or deletion must clear only its recovered request",
);

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

function createStorage(backing, { failWrites = false } = {}) {
  return {
    getItem(key) {
      return backing.has(key) ? backing.get(key) : null;
    },
    setItem(key, value) {
      if (failWrites) throw new Error("storage unavailable");
      backing.set(key, value);
    },
    removeItem(key) {
      backing.delete(key);
    },
  };
}

function createFlowHarness({
  storage,
  fetchWithAuth,
  values = {},
  uuid = "11111111-1111-4111-8111-111111111111",
}) {
  const elements = new Map();
  const ids = [
    "billing-message",
    "charges-tbody",
    "no-charges",
    "btn-send-invoice",
    "billing-name",
    "billing-email",
    "billing-desc",
    "billing-amount",
  ];
  ids.forEach((id) => elements.set(id, createElement(values[id] || "")));

  const context = {
    API_URL: "https://api.example.test",
    Uint8Array,
    console: { log() {}, warn() {}, error() {} },
    fetchWithAuth,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout() {},
    confirm: () => true,
    window: {
      crypto: {
        randomUUID: () => uuid,
        getRandomValues(bytes) {
          bytes.fill(1);
          return bytes;
        },
      },
      sessionStorage: storage,
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
    actionClick: elements.get("charges-tbody").listeners.click,
  };
}

function pendingManualChargeState(recoveryChargeId = 73) {
  const fields = {
    name: "Recovered Guest",
    email: "recovered@example.test",
    desc: "Recovered charge",
    amount: 42,
  };
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    signature: JSON.stringify(fields),
    recoveryChargeId,
    fields,
  };
}

function chargeActionTarget(className, id = "73") {
  return {
    dataset: { id },
    classList: {
      contains(candidate) {
        return candidate === "btn-action" || candidate === className;
      },
    },
  };
}

async function testReloadRecovery() {
  const storageKey = "pending-manual-charge-v1";
  const backing = new Map();
  let rejectPost;
  const pendingPost = new Promise((resolve, reject) => {
    rejectPost = reject;
  });
  const first = createFlowHarness({
    storage: createStorage(backing),
    values: {
      "billing-name": "Reload Guest",
      "billing-email": "reload@example.test",
      "billing-desc": "Reload-safe charge",
      "billing-amount": "125.50",
    },
    fetchWithAuth: async (_url, options) => {
      if (options?.method === "POST") return pendingPost;
      return { json: async () => [] };
    },
  });

  const firstClick = first.click();
  assert.strictEqual(
    first.elements.get("btn-send-invoice").disabled,
    true,
    "the submit button must be disabled while the POST is in flight",
  );
  assert.strictEqual(
    first.elements.get("billing-name").disabled,
    true,
    "charge fields must not discard an in-flight identity",
  );
  rejectPost(new Error("simulated lost response"));
  await firstClick;
  assert.strictEqual(first.elements.get("btn-send-invoice").disabled, false);

  const storedAfterLoss = JSON.parse(backing.get(storageKey));
  assert.strictEqual(
    storedAfterLoss.requestId,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.deepStrictEqual(storedAfterLoss.fields, {
    name: "Reload Guest",
    email: "reload@example.test",
    desc: "Reload-safe charge",
    amount: 125.5,
  });

  let recoveryRequest;
  const restored = createFlowHarness({
    storage: createStorage(backing),
    fetchWithAuth: async (_url, options) => {
      if (options?.method === "POST") {
        recoveryRequest = JSON.parse(options.body);
        return {
          ok: false,
          json: async () => ({
            code: "MANUAL_CHARGE_RECOVERY_REQUIRED",
            recovery: { charge_id: 73 },
          }),
        };
      }
      return { json: async () => [] };
    },
  });

  assert.strictEqual(
    restored.elements.get("billing-name").value,
    "Reload Guest",
  );
  assert.strictEqual(
    restored.elements.get("billing-email").value,
    "reload@example.test",
  );
  assert.strictEqual(
    restored.elements.get("billing-amount").value,
    "125.5",
  );
  restored.elements.get("billing-name").listeners.input();
  assert.strictEqual(
    backing.has(storageKey),
    true,
    "a same-value browser input event must not discard the restored identity",
  );
  await restored.click();
  assert.strictEqual(
    recoveryRequest.request_id,
    storedAfterLoss.requestId,
    "reload retry must reuse the saved UUID",
  );
  assert.strictEqual(
    JSON.parse(backing.get(storageKey)).recoveryChargeId,
    73,
    "the server recovery ID must survive another reload",
  );

  let successRequest;
  const recovered = createFlowHarness({
    storage: createStorage(backing),
    fetchWithAuth: async (_url, options) => {
      if (options?.method === "POST") {
        successRequest = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            id: 73,
            request_id: successRequest.request_id,
            stripe_session_id: "cs_reload_73",
            url: "https://checkout.example.test/73",
          }),
        };
      }
      return { json: async () => [] };
    },
  });
  await recovered.click();
  assert.strictEqual(successRequest.request_id, storedAfterLoss.requestId);
  assert.strictEqual(successRequest.recovery_charge_id, 73);
  assert.strictEqual(backing.has(storageKey), false);
  assert.strictEqual(recovered.elements.get("billing-name").value, "");

  let unsafePostCount = 0;
  const blocked = createFlowHarness({
    storage: createStorage(new Map(), { failWrites: true }),
    values: {
      "billing-name": "Blocked Guest",
      "billing-email": "blocked@example.test",
      "billing-desc": "Unsafe storage",
      "billing-amount": "10",
    },
    fetchWithAuth: async () => {
      unsafePostCount += 1;
      throw new Error("must not post");
    },
  });
  await blocked.click();
  assert.strictEqual(
    unsafePostCount,
    0,
    "storage failure must stop the POST before a reload-unsafe identity exists",
  );
}

async function testResolvedChargeActionsClearStoredRequest() {
  const storageKey = "pending-manual-charge-v1";

  const failedPayBacking = new Map([
    [storageKey, JSON.stringify(pendingManualChargeState())],
  ]);
  const failedPay = createFlowHarness({
    storage: createStorage(failedPayBacking),
    fetchWithAuth: async (_url, options) => {
      if (options?.method === "POST") {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: "Manual payment was rejected" }),
        };
      }
      return { ok: true, json: async () => [] };
    },
  });
  await failedPay.actionClick({
    target: chargeActionTarget("btn-mark-paid"),
  });
  assert.strictEqual(
    failedPayBacking.has(storageKey),
    true,
    "a rejected manual settlement must retain the pending retry identity",
  );

  const successfulPayBacking = new Map([
    [storageKey, JSON.stringify(pendingManualChargeState())],
  ]);
  const successfulPay = createFlowHarness({
    storage: createStorage(successfulPayBacking),
    fetchWithAuth: async (_url, options) => {
      if (options?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, json: async () => [] };
    },
  });
  await successfulPay.actionClick({
    target: chargeActionTarget("btn-mark-paid"),
  });
  assert.strictEqual(
    successfulPayBacking.has(storageKey),
    false,
    "a successful manual settlement must clear its pending retry identity",
  );

  const successfulDeleteBacking = new Map([
    [storageKey, JSON.stringify(pendingManualChargeState())],
  ]);
  const successfulDelete = createFlowHarness({
    storage: createStorage(successfulDeleteBacking),
    fetchWithAuth: async (_url, options) => {
      if (options?.method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, json: async () => [] };
    },
  });
  await successfulDelete.actionClick({
    target: chargeActionTarget("btn-charge-delete"),
  });
  assert.strictEqual(
    successfulDeleteBacking.has(storageKey),
    false,
    "a successful deletion must clear its pending retry identity",
  );

  const differentChargeBacking = new Map([
    [storageKey, JSON.stringify(pendingManualChargeState())],
  ]);
  const differentCharge = createFlowHarness({
    storage: createStorage(differentChargeBacking),
    fetchWithAuth: async (_url, options) => {
      if (options?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, json: async () => [] };
    },
  });
  await differentCharge.actionClick({
    target: chargeActionTarget("btn-mark-paid", "74"),
  });
  assert.strictEqual(
    differentChargeBacking.has(storageKey),
    true,
    "settling another charge must not clear the active retry identity",
  );
}

testReloadRecovery()
  .then(testResolvedChargeActionsClearStoredRequest)
  .then(() =>
    console.log("admin manual-charge retry identity regression check passed"),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
