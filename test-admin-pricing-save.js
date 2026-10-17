"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { fork } = require("node:child_process");

const html = fs.readFileSync(path.join(__dirname, "public/tax-settings.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// Compile the entire shipped script: the missing braces must fail this test.
const compiled = new vm.Script(script, { filename: "tax-settings.html" });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "admin-pricing-save-"));
let server;
let api;
let cookie;

async function start() {
  server = fork(path.join(__dirname, "server/index.js"), [], {
    cwd: __dirname,
    env: { ...process.env, NODE_ENV: "test", PORT: "0", MOCK_PAYMENTS: "true",
      AIRBNB_ICAL_URL: "", DOMAIN: "http://127.0.0.1", ADMIN_PASSWORD: "pricing-test-only",
      JWT_SECRET: "pricing-test-secret-only", RESERVATIONS_DB_PATH: path.join(temp, "test.db") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  server.stdout.on("data", chunk => output += chunk);
  server.stderr.on("data", chunk => output += chunk);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Startup timeout: ${output}`)), 15000);
    server.once("error", reject);
    server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}: ${output}`)); });
    server.on("message", message => {
      if (message.type === "server-listening") {
        api = `http://127.0.0.1:${message.port}`;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  const login = await fetch(`${api}/api/admin/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "pricing-test-only" }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
}

async function stop() {
  if (!server || server.exitCode !== null) return;
  await new Promise(resolve => { server.once("exit", resolve); server.kill("SIGTERM"); });
}

async function page({ failLoad = false } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: "", textContent: "", className: "", style: {}, disabled: false, listeners: {},
      addEventListener(type, handler) { this.listeners[type] = handler; },
      querySelector() { return element("save"); },
    });
    return elements.get(id);
  };
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: element }, window: { location: { hostname: "example.test", href: "" } },
    setTimeout() {}, console: { error() {} }, confirm: () => true,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      assert.equal(options.credentials, "include", "page must retain cookie authentication");
      if (failLoad && !options.method) throw new Error("Offline");
      return fetch(`${api}${url}`, { ...options, headers: { ...options.headers, Cookie: cookie } });
    },
  });
  compiled.runInContext(context);
  // Drain the asynchronous initial GET and its DOM updates.
  const deadline = Date.now() + 5000;
  while (element("loading").style.display !== "none") {
    assert.ok(Date.now() < deadline, "initial settings load completed");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return { element, requests, submit: () => element("taxForm").listeners.submit({ preventDefault() {} }) };
}

(async () => {
  try {
    await start();
    const admin = await page();
    assert.equal(admin.element("save").disabled, false);
    admin.element("monthlyRate").value = "4000";
    admin.element("minimumNights").value = "7";
    await admin.submit();
    const posts = admin.requests.filter(r => r.options.method === "POST");
    assert.equal(posts.length, 1, "Save must send an authenticated request");
    assert.equal(JSON.parse(posts[0].options.body).monthly_rate, 4000);
    assert.match(admin.element("message").textContent, /saved successfully/);
    const reloaded = await page();
    assert.equal(Number(reloaded.element("monthlyRate").value), 4000);
    assert.equal(Number(reloaded.element("minimumNights").value), 7);

    admin.element("monthlyRate").value = "-1";
    await admin.submit();
    assert.match(admin.element("message").className, /error/);
    assert.match(admin.element("message").textContent, /monthly_rate/);
    admin.element("minimumNights").value = "0";
    const count = admin.requests.length;
    await admin.submit();
    assert.equal(admin.requests.length, count, "invalid minimum must not POST");
    const offline = await page({ failLoad: true });
    assert.equal(offline.element("save").disabled, true);
    await offline.submit();
    assert.equal(offline.requests.filter(r => r.options.method === "POST").length, 0);

    await stop();
    await start();
    const restarted = await page();
    assert.equal(Number(restarted.element("monthlyRate").value), 4000, "price survives server restart");
    const quote = await fetch(`${api}/api/calculate-price`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rental_type: "monthly", months: 2, monthly_rate: 1 }),
    });
    assert.equal(quote.status, 200);
    assert.equal((await quote.json()).subtotal, 8000, "public quote uses saved authoritative rate");
    console.log("PASS: admin Save, reload/restart persistence, validation, authentication and public quote");
  } finally {
    await stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
