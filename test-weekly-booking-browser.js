"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const script = new vm.Script(fs.readFileSync("public/booking.js", "utf8"));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

function harness({ available = true } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { value: "", textContent: "", innerHTML: "", style: {}, listeners: {},
        hidden: id === "weekly-rental-btn", disabled: id === "weekly-rental-btn",
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
        addEventListener(type, cb) { this.listeners[type] = cb; },
        removeEventListener(type) { delete this.listeners[type]; },
        querySelectorAll() { return []; },
      });
    }
    return elements.get(id);
  }
  const buttons = ["short_stay", "weekly", "monthly"].map(type => {
    const btn = element(type === "weekly" ? "weekly-rental-btn" : `btn-${type}`);
    btn.dataset = { type }; return btn;
  });
  element("guests").value = "2";
  const pickers = {};
  const requests = [];
  let quoteError = null;
  let networkError = false;
  let quoteWait = null;
  const quote = { rental_type: "weekly", weeks: 2, nights: 14, weekly_rate: 1500,
    subtotal: 3000, cleaning_fee: 100, mecklenburg_sales_tax: 255.75,
    mecklenburg_occupancy_tax: 248, total: 3603.75,
    tax_rates: { mecklenburg_sales: 8.25, mecklenburg_occupancy: 8 } };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => buttons,
      addEventListener(type, cb) { if (type === "DOMContentLoaded") this.ready = cb; } },
    window: { location: { hostname: "example.test", href: "" } },
    localStorage: { setItem() {} }, console: { error() {} }, setInterval() {},
    flatpickr: (id, options) => pickers[id] = { options, selectedDates: [], set() {}, clear() { this.selectedDates = []; } },
    fetch: async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : null;
      requests.push({ url, body });
      if (url.endsWith("/weekly-rate")) return { ok: true, json: async () => ({ available, weekly_rate: available ? 1500 : 0 }) };
      if (url.endsWith("/bookings")) return { ok: true, json: async () => [] };
      if (url.endsWith("/calculate-price")) {
        if (quoteWait) await quoteWait;
        if (networkError) throw new Error("Network unavailable");
        return { ok: !quoteError, json: async () => quoteError ? { error: quoteError } : quote };
      }
      if (url.endsWith("/create-checkout-session")) return { ok: true, json: async () => ({ id: "test-only-session", url: "https://example.test/mock-checkout" }) };
      throw new Error(`Unexpected request ${url}`);
    },
  });
  script.runInContext(context);
  context.document.ready();
  return { element, buttons, requests, pickers, context,
    select: type => buttons.find(btn => btn.dataset.type === type).listeners.click(),
    dates: () => { pickers["#checkin"].selectedDates = [new Date(2027, 0, 4)]; pickers["#checkout"].selectedDates = [new Date(2027, 0, 18)]; },
    rejectQuote: message => quoteError = message,
    failNetwork: () => networkError = true,
    deferQuote: promise => quoteWait = promise,
  };
}

(async () => {
  const disabled = harness({ available: false });
  await flush();
  assert.equal(disabled.element("weekly-rental-btn").hidden, true);
  assert.equal(disabled.element("weekly-rental-btn").disabled, true);

  const h = harness();
  await flush();
  assert.equal(h.element("weekly-rental-btn").hidden, false);
  assert.equal(h.element("weekly-rental-btn").disabled, false);
  h.dates(); h.select("weekly"); await flush();
  assert.equal(h.element("weekly-stay-help").hidden, false);
  assert.match(h.element("price-display").innerHTML, /Weekly rate \$1500.00 × 2 week\(s\)/);
  assert.match(h.element("price-display").innerHTML, /Cleaning fee/);
  const weeklyQuote = h.requests.find(r => r.url.endsWith("/calculate-price"));
  assert.deepEqual(weeklyQuote.body, { checkIn: "2027-01-04", checkOut: "2027-01-18", rental_type: "weekly" });

  const submitting = h.element("booking-form").listeners.submit({ preventDefault() {} });
  await flush();
  assert.equal(h.element("confirm-modal").classList.contains("show"), true);
  assert.equal(h.element("confirm-nights").textContent, "2 week(s) · 14 nights");
  assert.equal(h.element("confirm-cleaning").textContent, "$100.00");
  // A UI mode change while confirmation is open cannot change the quoted contract.
  h.select("monthly");
  h.element("confirm-accept").listeners.click();
  await submitting;
  const checkout = h.requests.find(r => r.url.endsWith("/create-checkout-session"));
  assert.deepEqual(checkout.body, { checkIn: "2027-01-04", checkOut: "2027-01-18", rental_type: "weekly", guests: 2 });
  assert.equal(h.context.window.location.href, "https://example.test/mock-checkout");

  const error = harness(); await flush(); error.dates();
  error.rejectQuote("Weekly stays must be whole weeks"); error.select("weekly"); await flush();
  assert.equal(error.element("price-display").innerHTML, "");
  assert.equal(error.element("booking-message").textContent, "Weekly stays must be whole weeks");
  await error.element("booking-form").listeners.submit({ preventDefault() {} });
  assert.equal(error.requests.some(r => r.url.endsWith("/create-checkout-session")), false);

  const stale = harness(); await flush(); stale.dates();
  let release; stale.deferQuote(new Promise(resolve => release = resolve));
  stale.select("weekly"); await flush(); stale.select("monthly"); release(); await flush();
  assert.equal(stale.element("price-display").innerHTML, "", "stale weekly quote must not overwrite monthly mode");

  for (const failure of ["http", "network"]) {
    const monthly = harness(); await flush();
    monthly.element("monthly-start").value = "2027-01-04";
    monthly.element("monthly-duration").value = "3";
    monthly.select("monthly"); await flush();
    assert.match(monthly.element("price-display").innerHTML, /3 month\(s\)/);
    monthly.element("monthly-duration").value = "6";
    if (failure === "http") monthly.rejectQuote("Pricing configuration unavailable");
    else monthly.failNetwork();
    const refresh = monthly.element("monthly-duration").listeners.change();
    assert.equal(monthly.element("price-display").innerHTML, "", "clear old quote as soon as replacement starts");
    await refresh;
    assert.equal(monthly.element("price-display").innerHTML, "", "failed replacement must not show old monthly quote");
    assert.equal(monthly.element("booking-message").className, "booking-message error");
    assert.ok(monthly.element("booking-message").textContent);
  }
  console.log("PASS: weekly availability, quote, breakdown, confirmation, checkout contract and stale-response protection");
})().catch(error => { console.error(error); process.exitCode = 1; });
