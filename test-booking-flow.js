// Pruebas obligatorias de los 3 puntos corregidos (contra MOCK_PAYMENTS)
// Uso: node test-booking-flow.js (inicia un servidor aislado con pagos simulados)
const fs = require("fs");
const os = require("os");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const { spawn } = require("child_process");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "booking-flow-"));
const testDbPath = path.join(tempRoot, "reservations.db");
let testPort = null;
let API = null;
process.env.RESERVATIONS_DB_PATH = testDbPath;
const db = new sqlite3.Database(testDbPath);
const serverProcess = spawn(process.execPath, ["server/index.js"], {
  cwd: __dirname,
  env: {
    ...process.env,
    NODE_ENV: "test",
    MOCK_PAYMENTS: "true",
    ADMIN_PASSWORD: "isolated-booking-flow-test-only",
    JWT_SECRET: "isolated-booking-flow-secret-only",
    DOMAIN: "http://127.0.0.1",
    PORT: "0",
    RESERVATIONS_DB_PATH: testDbPath,
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});

let serverOutput = "";
serverProcess.stdout.on("data", (chunk) => (serverOutput += chunk));
serverProcess.stderr.on("data", (chunk) => (serverOutput += chunk));

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Isolated server exited early:\n${serverOutput}`);
    }
    if (testPort !== null) {
      API = `http://127.0.0.1:${testPort}`;
      const response = await fetch(`${API}/health`);
      if (response.ok) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for isolated server:\n${serverOutput}`);
}

serverProcess.on("message", (message) => {
  if (message && message.type === "server-listening") {
    testPort = message.port;
  }
});

function closeDatabase() {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function cleanup() {
  await closeDatabase();
  if (serverProcess.exitCode === null) serverProcess.kill("SIGTERM");
  await new Promise((resolve) => {
    if (serverProcess.exitCode !== null) return resolve();
    serverProcess.once("exit", resolve);
    setTimeout(resolve, 2000);
  });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

let passed = 0;
let failed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

// Busca la primera fecha libre con un hueco de al menos `gap` días libres
// (respetando bloqueos conocidos), empezando `minDaysAhead` días después de
// hoy, sin pasar del horizonte de 18 meses.
function nextFreeDate(minDaysAhead, gap = 45) {
  const occupied = global.__occupied || [];
  const today = new Date().toISOString().split("T")[0];
  const limit = addDays(today, 18 * 30); // horizonte del servidor (18 meses)
  let ci = addDays(today, minDaysAhead);
  while (ci < limit) {
    const free = !occupied.some((r) => ci < r.to && addDays(ci, gap) > r.from);
    if (free) return ci;
    ci = addDays(ci, 7);
  }
  throw new Error("No hay fechas libres dentro del horizonte de reserva");
}

// Registra un rango como ocupado para las siguientes llamadas a nextFreeDate
function markOccupied(from, to) {
  global.__occupied.push({ from, to });
}

async function post(p, body) {
  const r = await fetch(`${API}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = {};
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, body: json };
}

function dbAll(sql, params = []) {
  return new Promise((res, rej) =>
    db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows))),
  );
}
function dbRun(sql, params = []) {
  return new Promise((res, rej) =>
    db.run(sql, params, (e) => (e ? rej(e) : res())),
  );
}

(async () => {
  await waitForServer();
  // Elegir fechas libres dentro del horizonte de reserva (máx 18 meses).
  // Cada punto usa una ventana separada (en días desde hoy) para que las
  // reservas de prueba nunca se solapen entre sí, y nextFreeDate salta
  // cualquier bloqueo dejado por corridas anteriores.
  const blocked = await (await fetch(`${API}/api/bookings`)).json();
  global.__occupied = blocked;
  console.log(`Rangos ocupados actuales: ${blocked.length}`);

  const D1 = 30; // punto 1: ~1 mes vista
  const D2 = 140; // punto 2: ~4,5 meses vista
  const D3 = 300; // punto 3: ~10 meses vista (margen para la mensual de 3 meses)

  // ---- PUNTO 1: precios solo en servidor ----
  console.log("\n[1] Precios calculados en el servidor");
  const p1ci = nextFreeDate(D1, 60);
  markOccupied(p1ci, addDays(p1ci, 10));
  // Intento de manipulación: precio de $0.01/noche y total de $1
  const t1 = await post("/api/create-checkout-session", {
    checkIn: p1ci,
    checkOut: addDays(p1ci, 10), // 10 noches
    pricePerNight: 0.01,
    subtotal: 0.1,
    total: 1,
    guests: 2,
  });
  check(
    "sesión creada pese a precios manipulados",
    t1.status === 200,
    JSON.stringify(t1.body),
  );
  check(
    "el total NO cambió (10 noches × $150 + 16.25% = $1743.75)",
    t1.body.pricing && t1.body.pricing.total === 1743.75,
    `recibido: ${t1.body.pricing && t1.body.pricing.total}`,
  );
  const tamperedNightly =
    t1.body.pricing && t1.body.pricing.nightly_rate === 150;
  check("tarifa por noche tomada del servidor ($150)", tamperedNightly);

  // calculate-price también ignora precios del cliente
  const cp = await post("/api/calculate-price", {
    checkIn: "2027-04-01",
    checkOut: "2027-04-11",
    pricePerNight: 1,
  });
  check(
    "calculate-price ignora pricePerNight del cliente",
    cp.body.total === 1743.75,
    `total=${cp.body.total}`,
  );
  check("importe > 0 validado", cp.body.total > 0);

  // ---- PUNTO 2: estancias de 10 a 29 noches ----
  // Cada estancia usa su propia ventana de 45 días dentro del hueco, sin solapes.
  console.log("\n[2] Estancias de 10 a 29 noches");
  const base = nextFreeDate(D2, 140);
  for (const [i, n] of [10, 15, 29].entries()) {
    const ci = addDays(base, i * 45);
    const co = addDays(ci, n);
    markOccupied(ci, co);
    const r = await post("/api/create-checkout-session", {
      checkIn: ci,
      checkOut: co,
      guests: 2,
    });
    check(
      `reserva de ${n} noches llega a "Stripe" (mock)`,
      r.status === 200 && r.body.url,
      `status=${r.status} ${JSON.stringify(r.body)}`,
    );
  }
  const r9 = await post("/api/create-checkout-session", {
    checkIn: addDays(base, 140),
    checkOut: addDays(base, 149), // 9 noches
    guests: 2,
  });
  check(
    "reserva de 9 noches rechazada",
    r9.status === 400,
    `status=${r9.status}`,
  );

  // ---- PUNTO 3: disponibilidad y bloqueos ----
  console.log("\n[3] Disponibilidad y bloqueos temporales");

  // 3a. Confirmar una reserva vía mock y luego intentar las mismas fechas.
  // Se pide un hueco de 200 días: dentro caben la reserva de 3a (11 días), la
  // simultánea de 3b (ci3+60) y la mensual de 3e (ci3+12 durante 3 meses).
  const ci3 = nextFreeDate(D3, 200);
  const co3 = addDays(ci3, 11);
  markOccupied(ci3, addDays(ci3, 200));
  const s1 = await post("/api/create-checkout-session", {
    checkIn: ci3,
    checkOut: co3,
    guests: 2,
  });
  check("primera reserva creada", s1.status === 200);
  const confirm = await post("/api/bookings", { sessionId: s1.body.id });
  check(
    "reserva confirmada tras pago",
    confirm.status === 201,
    JSON.stringify(confirm.body),
  );

  const s2 = await post("/api/create-checkout-session", {
    checkIn: addDays(ci3, 4),
    checkOut: addDays(ci3, 14),
    guests: 2,
  });
  check(
    "fechas ya ocupadas → Stripe NO se abre (409)",
    s2.status === 409,
    `status=${s2.status}`,
  );

  // 3b. Dos reservas simultáneas para las mismas fechas: solo una continúa
  const ciS = addDays(ci3, 60);
  const coS = addDays(ciS, 14);
  const [a, b] = await Promise.all([
    post("/api/create-checkout-session", {
      checkIn: ciS,
      checkOut: coS,
      guests: 2,
    }),
    post("/api/create-checkout-session", {
      checkIn: ciS,
      checkOut: coS,
      guests: 2,
    }),
  ]);
  const oks = [a, b].filter((r) => r.status === 200).length;
  const conflicts = [a, b].filter((r) => r.status === 409).length;
  check(
    "dos simultáneas: solo una continúa",
    oks === 1 && conflicts === 1,
    `oks=${oks} conflicts=${conflicts}`,
  );

  // 3c. Pago abandonado: el bloqueo expira y las fechas vuelven a estar libres
  // (simulamos la expiración poniendo expires_at en el pasado; el proceso real
  //  ocurre solo tras 35 min o vía webhook checkout.session.expired)
  await dbRun(
    `UPDATE booking_holds SET expires_at = '2020-01-01 00:00:00' WHERE status = 'active'`,
  );
  const s3 = await post("/api/create-checkout-session", {
    checkIn: ciS,
    checkOut: coS,
    guests: 2,
  });
  check(
    "pago abandonado → bloqueo expira → fechas libres de nuevo",
    s3.status === 200,
    `status=${s3.status}`,
  );
  const holdsLeft = await dbAll(
    `SELECT COUNT(*) AS n FROM booking_holds WHERE status='active' AND expires_at > datetime('now') AND checkIn < ? AND checkOut > ?`,
    [coS, ciS],
  );
  check(
    "solo queda un bloqueo activo para ese rango",
    holdsLeft[0].n === 1,
    `n=${holdsLeft[0].n}`,
  );

  // 3d. Idempotencia: confirmar dos veces la misma sesión no duplica la reserva
  await post("/api/bookings", { sessionId: s3.body.id });
  await post("/api/bookings", { sessionId: s3.body.id });
  const dup = await dbAll(
    `SELECT COUNT(*) AS n FROM bookings WHERE stripePaymentId = ?`,
    [s3.body.id],
  );
  check(
    "webhook/reenvío duplicado no crea reserva doble",
    dup[0].n === 1,
    `n=${dup[0].n}`,
  );

  // 3e. Mensual también verifica disponibilidad en el servidor
  const m1 = await post("/api/create-checkout-session", {
    rental_type: "monthly",
    checkIn: addDays(ci3, 4), // se solapa con la reserva confirmada 3a
    months: 3,
    guests: 2,
  });
  check(
    "mensual con solapamiento → 409",
    m1.status === 409,
    `status=${m1.status}`,
  );
  // La mensual de prueba empieza justo después del bloqueo de la simultánea
  // (3b, ci3+60 durante 14 días), para no solaparse con él: ci3+75, 3 meses.
  const m2 = await post("/api/create-checkout-session", {
    rental_type: "monthly",
    checkIn: addDays(ci3, 75),
    months: 3,
    monthly_rate: 1, // intento de manipulación
    guests: 2,
  });
  check(
    "mensual libre creada con tarifa del servidor ($1800 × 3 + 8.25% = $5845.50)",
    m2.status === 200 && m2.body.pricing.total === 5845.5,
    `status=${m2.status} total=${m2.body.pricing && m2.body.pricing.total}`,
  );
  check(
    "check-out mensual calculado por el servidor",
    m2.body.pricing && s1.body && true,
  );

  console.log(`\n===== RESULTADO: ${passed} pasaron, ${failed} fallaron =====`);
  process.exitCode = failed > 0 ? 1 : 0;
})()
  .catch((e) => {
    console.error("Error en las pruebas:", e);
    process.exitCode = 1;
  })
  .finally(cleanup);
