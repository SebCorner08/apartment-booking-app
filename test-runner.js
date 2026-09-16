const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = __dirname;
let port = null;
let apiUrl = null;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "booking-integration-"));
const databasePath = path.join(tempRoot, "reservations.db");
const developmentDatabasePath = path.join(root, "server", "reservations.db");
const developmentDatabaseHash = fs.existsSync(developmentDatabasePath)
  ? crypto.createHash("sha256").update(fs.readFileSync(developmentDatabasePath)).digest("hex")
  : null;
const env = {
  ...process.env,
  ADMIN_PASSWORD: "test-admin-password",
  JWT_SECRET: "test-jwt-secret-for-ci-only",
  PORT: "0",
  NODE_ENV: "test",
  DOMAIN: "http://127.0.0.1",
  ALLOWED_ORIGINS: "http://127.0.0.1",
  MOCK_PAYMENTS: "true",
  CLEANING_FEE: "0",
  RESERVATIONS_DB_PATH: databasePath,
};

let serverOutput = "";
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});

server.on("message", (message) => {
  if (message && message.type === "server-listening") {
    port = message.port;
    apiUrl = `http://127.0.0.1:${port}`;
    env.TEST_API_URL = apiUrl;
  }
});

server.stdout.on("data", (chunk) => {
  serverOutput += chunk;
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk;
});

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${script} failed (${signal || `exit ${code}`})`));
    });
  });
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`server exited before readiness\n${serverOutput}`);
    }
    try {
      if (port === null) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const response = await fetch(`${apiUrl}/health`);
      if (response.ok) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server readiness timed out\n${serverOutput}`);
}

async function stopServer() {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

(async () => {
  try {
    await waitForServer();
    assert.ok(fs.existsSync(databasePath), "server must create the isolated database");
    await run("test-security.js");
    await run("test-booking-flow.js");
    const hashAfter = fs.existsSync(developmentDatabasePath)
      ? crypto.createHash("sha256").update(fs.readFileSync(developmentDatabasePath)).digest("hex")
      : null;
    assert.strictEqual(
      hashAfter,
      developmentDatabaseHash,
      "integration tests must not create or mutate server/reservations.db",
    );
    console.log(`PASS: integration database isolated at ${databasePath}`);
  } catch (error) {
    console.error(error);
    console.error("\nServer output:\n", serverOutput);
    process.exitCode = 1;
  } finally {
    await stopServer();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})();
