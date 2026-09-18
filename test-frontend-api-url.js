// Focused regression verification for Issue #17
// Usage: node test-frontend-api-url.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXPECTED_PROD = "https://escapelakenorman-api-l2da.onrender.com";

const files = [
  "public/booking.js",
  "public/login.html",
  "public/admin.html",
  "public/success.html",
  "public/tax-settings.html",
];

const firstPartyAdminFiles = new Set([
  "public/login.html",
  "public/admin.html",
  "public/tax-settings.html",
]);

let failed = 0;

for (const rel of files) {
  const abs = path.join(__dirname, rel);
  const content = fs.readFileSync(abs, "utf8");

  const prodMatch = content.match(
    /const\s+PROD_API_URL\s*=\s*(["'`])([^"'`]+)\1/,
  );
  const currentProdUrl = prodMatch ? prodMatch[2] : null;
  const apiExprMatch = content.match(/const\s+API_URL\s*=\s*([\s\S]*?);/);
  const apiExpr = apiExprMatch ? apiExprMatch[1].trim() : null;
  const renderUrls = [
    ...content.matchAll(/https:\/\/[a-z0-9-]+\.onrender\.com/g),
  ].map((m) => m[0]);
  const usesFirstPartyAdminApi = firstPartyAdminFiles.has(rel);
  const hasExpected = usesFirstPartyAdminApi
    ? currentProdUrl === null
    : currentProdUrl === EXPECTED_PROD;
  const hasUnexpectedRenderUrl = renderUrls.some(
    (url) => url !== EXPECTED_PROD,
  );
  let keepsLocalhost = false;

  if (apiExpr && (usesFirstPartyAdminApi || currentProdUrl)) {
    const resolveApiUrl = (hostname) =>
      vm.runInNewContext(
        `(() => {
          ${currentProdUrl ? `const PROD_API_URL = ${JSON.stringify(currentProdUrl)};` : ""}
          const window = { location: { hostname: ${JSON.stringify(hostname)} } };
          const IS_LOCAL = ["localhost", "127.0.0.1"].includes(window.location.hostname);
          return (${apiExpr});
        })()`,
      );

    keepsLocalhost =
      resolveApiUrl("localhost") === "http://localhost:3001" &&
      resolveApiUrl("127.0.0.1") === "http://127.0.0.1:3001" &&
      resolveApiUrl("example.com") ===
        (usesFirstPartyAdminApi ? "" : EXPECTED_PROD);
  }

  if (!hasExpected || hasUnexpectedRenderUrl || !keepsLocalhost) {
    failed += 1;
    console.log(`❌ ${rel}`);
    if (!hasExpected) {
      console.log(
        usesFirstPartyAdminApi
          ? "   - Admin HTTP must use the first-party production origin"
          : `   - Missing expected URL: ${EXPECTED_PROD}`,
      );
    }
    if (hasUnexpectedRenderUrl)
      console.log(
        `   - Unexpected Render URL(s): ${renderUrls.filter((url) => url !== EXPECTED_PROD).join(", ")}`,
      );
    if (!keepsLocalhost)
      console.log("   - Localhost/development fallback check failed");
  } else {
    console.log(`✅ ${rel}`);
  }
}

if (failed > 0) {
  console.log(`\nFAILED: ${failed} file(s) did not pass URL verification.`);
  process.exit(1);
}

console.log("\nAll active frontend API URL checks passed.");
