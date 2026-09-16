const fs = require("fs");
const assert = require("assert");
const vm = require("vm");

const adminHtmlPath = process.env.ADMIN_HTML_PATH || "public/admin.html";
const source = fs.readFileSync(adminHtmlPath, "utf8");
const scriptMatch = source.match(/<script>([\s\S]*?)<\/script>/);

assert(scriptMatch, "admin inline script must exist");

function createElement() {
  return {
    innerHTML: "",
    textContent: "",
    className: "",
    value: "",
    style: {},
    dataset: {},
    children: [],
    classList: { contains: () => false },
    addEventListener() {},
    appendChild(child) {
      this.children.push(child);
    },
  };
}

const elements = new Map();
const getElement = (id) => {
  if (!elements.has(id)) elements.set(id, createElement());
  return elements.get(id);
};

let onReady;
const errors = [];
const requestedUrls = [];
const charges = [
  {
    id: 7,
    guest_name: '<img src=x onerror="namePayload">',
    guest_email: "<svg onload='emailPayload'>",
    description: "<script>descriptionPayload</script>&",
    amount: 25,
    status: "pending",
    created_at: "2026-09-15T00:00:00Z",
  },
];

const sandbox = {
  window: { location: { hostname: "localhost", protocol: "http:", href: "" } },
  localStorage: { getItem: () => "test-token", removeItem() {} },
  document: {
    addEventListener(event, callback) {
      if (event === "DOMContentLoaded") onReady = callback;
    },
    getElementById: getElement,
    querySelector: () => createElement(),
    createElement,
  },
  fetch: async (url) => {
    requestedUrls.push(url);
    assert(
      url === "http://localhost:3001/api/admin/bookings" ||
        url === "http://localhost:3001/api/admin/charges",
      `unexpected request: ${url}`,
    );
    return {
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/api/admin/charges")
          ? charges
          : { active: [], completed: [], cancelled: [] },
    };
  },
  WebSocket: class {
    addEventListener() {}
  },
  navigator: { clipboard: { writeText: async () => {} } },
  confirm: () => false,
  setTimeout() {},
  console: {
    log() {},
    error(...args) {
      errors.push(args);
    },
  },
};

async function run() {
  vm.runInNewContext(scriptMatch[1], sandbox, { filename: "public/admin.html" });
  assert(onReady, "DOMContentLoaded handler must be registered");

  assert.doesNotThrow(onReady, "admin initialization must not throw");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(errors, [], "charge rendering must not log an error");
  assert.deepStrictEqual(requestedUrls.sort(), [
    "http://localhost:3001/api/admin/bookings",
    "http://localhost:3001/api/admin/charges",
  ]);

  const renderedRows = getElement("charges-tbody").children;
  assert.strictEqual(renderedRows.length, 1, "one charge row must render");

  const html = renderedRows[0].innerHTML;
  assert(html.includes("&lt;img src=x onerror=&quot;namePayload&quot;&gt;"));
  assert(html.includes("&lt;svg onload=&#39;emailPayload&#39;&gt;"));
  assert(html.includes("&lt;script&gt;descriptionPayload&lt;/script&gt;&amp;"));
  assert(!html.includes("<img"), "guest name must not inject an img element");
  assert(!html.includes("<svg"), "guest email must not inject an svg element");
  assert(!html.includes("<script"), "description must not inject a script element");
  assert(html.includes("$25.00"), "charge amount must still render");
  assert(html.includes("pending"), "charge status must still render");
  assert(html.includes("Mark Paid"), "pending charge action must still render");
  assert(html.includes("Delete"), "delete action must still render");

  console.log("admin charge runtime escaping regression check passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
