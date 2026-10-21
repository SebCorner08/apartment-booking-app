const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");

function element(value = "") {
  return { value, disabled: false, required: false, textContent: "", className: "", style: {}, listeners: {},
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener() {}, querySelectorAll: () => [] };
}
function harness() {
  const elements = new Map();
  const ids = ["booking-form", "booking-message", "price-display", "confirm-modal", "confirm-cancel", "confirm-accept", "short-stay-fields", "monthly-fields", "monthly-start", "monthly-duration", "guests", "weekly-stay-help"];
  for (const id of ids) elements.set(id, element());
  const monthly = element(); monthly.dataset = { type: "monthly" };
  const short = element(); short.dataset = { type: "short_stay" };
  const pickers = {};
  const timers = new Map();
  let ready, poll, timerId = 0;
  const state = { response: { ok: true, json: async () => [] }, requests: [], pricingCalls: 0, checkoutCalls: 0 };
  const context = { console, Date, AbortController,
    window: { location: { hostname: "localhost" } }, localStorage: { setItem() {} },
    document: { getElementById: (id) => elements.get(id), querySelectorAll: () => [short, monthly], addEventListener: (_type, fn) => { ready = fn; } },
    setInterval: (fn, ms) => { assert.equal(ms, 30000); poll = fn; },
    setTimeout: (fn, ms) => { assert.equal(ms, 15000); timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id),
    flatpickr: (id, config) => {
      const picker = { config, selectedDates: [], set(key, value) { this.config[key] = value; }, clear() { this.selectedDates = []; } };
      pickers[id] = picker; return picker;
    },
    fetch: async (url, options) => {
      if (url.endsWith("/api/bookings")) {
        state.requests.push(options);
        if (state.response instanceof Error) throw state.response;
        return state.response;
      }
      if (url.endsWith("/api/calculate-price")) state.pricingCalls++;
      if (url.endsWith("/api/create-checkout-session")) state.checkoutCalls++;
      return { ok: false, json: async () => ({ error: "test intentionally stops before confirmation" }) };
    },
  };
  vm.runInNewContext(fs.readFileSync("public/booking.js", "utf8"), context);
  ready();
  return { elements, state, pickers, monthly, poll: () => poll(), timers,
    submit: () => elements.get("booking-form").listeners.submit({ preventDefault() {} }) };
}
const settle = () => new Promise(setImmediate);
const disabled = (h, day) => h.pickers["#checkin"].config.disable[0](new Date(`${day}T00:00:00`));

test("initial loading/failure blocks selection; successful refresh recovers and preserves exclusive end", async () => {
  const h = harness();
  assert.equal(disabled(h, "2027-01-01"), true);
  await settle();
  assert.equal(disabled(h, "2027-01-01"), false);
  h.state.response = { ok: true, json: async () => [{ from: "2027-01-10", to: "2027-01-20" }] };
  await h.poll();
  assert.equal(disabled(h, "2027-01-10"), true);
  assert.equal(disabled(h, "2027-01-20"), false);
  h.state.response = { ok: false };
  assert.equal(await h.poll(), false);
  assert.equal(disabled(h, "2027-02-01"), true);
  assert.match(h.elements.get("booking-message").textContent, /temporarily unavailable/);
  h.state.response = { ok: true, json: async () => [{ from: "2027-01-10", to: "2027-01-20" }] };
  assert.equal(await h.poll(), true);
  assert.equal(disabled(h, "2027-01-10"), true);
  assert.equal(disabled(h, "2027-02-01"), false);
  assert.equal(h.elements.get("booking-message").textContent, "");
});

test("short and monthly submit stop before confirmation/payment on availability failure", async () => {
  const h = harness();
  await settle();
  h.pickers["#checkin"].selectedDates = [new Date("2027-01-01T00:00:00")];
  h.pickers["#checkout"].selectedDates = [new Date("2027-01-11T00:00:00")];
  h.state.response = new Error("offline");
  await h.submit();
  assert.equal(h.state.pricingCalls, 0);
  assert.equal(h.state.checkoutCalls, 0);
  h.monthly.listeners.click();
  h.elements.get("monthly-start").value = "2027-01-01";
  h.elements.get("monthly-duration").value = "1";
  await h.submit();
  assert.equal(h.elements.get("monthly-start").disabled, true);
  assert.equal(h.state.pricingCalls, 0);
  assert.equal(h.state.checkoutCalls, 0);
  h.state.response = { ok: true, json: async () => [{ from: "2027-01-10", to: "2027-01-20" }] };
  await h.poll();
  assert.equal(h.elements.get("monthly-start").disabled, false);
  await h.submit();
  assert.match(h.elements.get("booking-message").textContent, /no longer available/);
  assert.equal(h.state.pricingCalls, 0, "monthly range overlap must stop confirmation");
});

test("pending client response is bounded/coalesced and retry after timeout recovers", async () => {
  const h = harness();
  await settle();
  h.state.response = { ok: true, json: () => new Promise(() => {}) };
  const first = h.poll();
  const second = h.poll();
  assert.equal(first, second);
  await settle();
  const signal = h.state.requests.at(-1).signal;
  assert.equal(h.timers.size, 1);
  [...h.timers.values()][0]();
  assert.equal(await first, false);
  assert.equal(signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(disabled(h, "2027-01-01"), true);
  h.state.response = { ok: true, json: async () => [] };
  await h.poll();
  assert.equal(disabled(h, "2027-01-01"), false);
});

test("malformed success payload fails closed", async () => {
  const h = harness();
  await settle();
  h.state.response = { ok: true, json: async () => ({ error: "maintenance" }) };
  assert.equal(await h.poll(), false);
  assert.equal(disabled(h, "2027-01-01"), true);
});
