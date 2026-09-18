// Pruebas de seguridad de la API (contra MOCK_PAYMENTS, servidor en :3001)
// Uso: node test-security.js
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "server", ".env"),
  override: false,
});
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const API = "http://localhost:3001";
const API_URL = process.env.TEST_API_URL || API;

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

async function req(method, p, body, headers = {}) {
  const r = await fetch(`${API_URL}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      // IP simulada propia de esta batería: así no comparte el rate limit de
      // checkout con test-booking-flow.js cuando ambos corren seguidos
      // (el servidor corre con trust proxy, por eso respeta X-Forwarded-For).
      "X-Forwarded-For": "10.99.0.1",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r;
}

function openWebSocket(pathname, protocols, origin) {
  return new Promise((resolve, reject) => {
    const websocketUrl = `${API_URL.replace(/^http/, "ws")}${pathname}`;
    const socket = new WebSocket(websocketUrl, protocols, { origin });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error(`WebSocket timeout for ${pathname}`));
    }, 3000);

    socket.once("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ socket, status: 101 });
    });
    socket.once("unexpected-response", (_request, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const status = response.statusCode;
      response.resume();
      resolve({ socket: null, status });
    });
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

(async () => {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  if (!ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD de test manquant");

  const configuredAdminOrigin = (
    process.env.ALLOWED_ORIGINS ||
    process.env.DOMAIN ||
    ""
  )
    .split(",")
    .map((origin) => origin.trim())
    .find(Boolean);
  if (process.env.NODE_ENV === "production" && !configuredAdminOrigin) {
    throw new Error(
      "ALLOWED_ORIGINS or DOMAIN is required for production security tests",
    );
  }
  const adminMutationHeaders =
    process.env.NODE_ENV === "production"
      ? { Origin: configuredAdminOrigin }
      : {};

  console.log("\n[Autenticación y autorización]");
  let r = await req("GET", "/api/admin/bookings");
  check("admin sans cookie → 401", r.status === 401, `status=${r.status}`);

  r = await req("GET", "/api/admin/bookings", null, {
    Authorization: "Bearer token_falso",
  });
  check("bearer obsolète ignoré → 401", r.status === 401, `status=${r.status}`);

  r = await req("POST", "/api/admin/login", { password: "wrong" });
  check("login incorrecto → 401", r.status === 401, `status=${r.status}`);

  r = await req("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
  const login = await r.json();
  const sessionCookie = r.headers.get("set-cookie");
  check(
    "login correcto → 200 sin exponer JWT",
    r.status === 200 && !login.token,
    `status=${r.status}`,
  );
  check(
    "sesión admin → cookie HttpOnly de 60 minutos",
    !!sessionCookie &&
      /admin_session=/.test(sessionCookie) &&
      /HttpOnly/i.test(sessionCookie) &&
      /Max-Age=3600/i.test(sessionCookie),
    sessionCookie || "sin Set-Cookie",
  );
  check(
    "attributs cookie adaptés à l'environnement",
    process.env.NODE_ENV === "production"
      ? /Secure/i.test(sessionCookie) && /SameSite=None/i.test(sessionCookie)
      : !/Secure/i.test(sessionCookie) && /SameSite=Lax/i.test(sessionCookie),
    sessionCookie || "sin Set-Cookie",
  );

  r = await req("GET", "/api/admin/bookings", null, {
    Cookie: sessionCookie.split(";")[0],
  });
  check("admin con cookie válida → 200", r.status === 200, `status=${r.status}`);

  const websocketOrigin = configuredAdminOrigin || "http://127.0.0.1";
  const websocketPath = "/admin-updates";

  r = await req("POST", "/api/admin/websocket-ticket", null, {
    Origin: websocketOrigin,
  });
  check(
    "ticket WebSocket sans cookie → 401",
    r.status === 401,
    `status=${r.status}`,
  );

  r = await req("POST", "/api/admin/websocket-ticket", null, {
    Cookie: sessionCookie.split(";")[0],
    Origin: "https://attacker.example",
  });
  check(
    "ticket WebSocket avec origine hostile → 403",
    r.status === 403,
    `status=${r.status}`,
  );

  if (process.env.NODE_ENV === "production") {
    r = await req("POST", "/api/admin/websocket-ticket", null, {
      Cookie: sessionCookie.split(";")[0],
    });
    check(
      "ticket WebSocket sans origine en production → 403",
      r.status === 403,
      `status=${r.status}`,
    );
  }

  let websocketAttempt = await openWebSocket(
    websocketPath,
    ["admin-updates"],
    websocketOrigin,
  );
  check(
    "WebSocket sans ticket → 401",
    websocketAttempt.status === 401,
    `status=${websocketAttempt.status}`,
  );

  websocketAttempt = await openWebSocket(
    websocketPath,
    ["admin-updates", "admin-ticket.invalid"],
    websocketOrigin,
  );
  check(
    "ticket WebSocket invalide → 401",
    websocketAttempt.status === 401,
    `status=${websocketAttempt.status}`,
  );

  websocketAttempt = await openWebSocket(
    "/unexpected-admin-path",
    ["admin-updates", "admin-ticket.invalid"],
    websocketOrigin,
  );
  check(
    "chemin WebSocket inattendu → 404",
    websocketAttempt.status === 404,
    `status=${websocketAttempt.status}`,
  );

  r = await req("POST", "/api/admin/websocket-ticket", null, {
    Cookie: sessionCookie.split(";")[0],
    Origin: websocketOrigin,
  });
  const websocketTicketResponse = await r.json();
  const websocketTicket = websocketTicketResponse.ticket;
  check(
    "ticket WebSocket authentifié, bref et non mis en cache",
    r.status === 200 &&
      typeof websocketTicket === "string" &&
      websocketTicket.length >= 32 &&
      websocketTicketResponse.expires_in_seconds <= 30 &&
      /no-store/i.test(r.headers.get("cache-control") || "") &&
      !JSON.stringify(websocketTicketResponse).includes(
        sessionCookie.split(";")[0].split("=")[1],
      ),
    `status=${r.status}; cache=${r.headers.get("cache-control")}`,
  );

  websocketAttempt = await openWebSocket(
    websocketPath,
    ["admin-updates", `admin-ticket.${websocketTicket}`],
    "https://attacker.example",
  );
  check(
    "ticket WebSocket lié à l'origine → 403",
    websocketAttempt.status === 403,
    `status=${websocketAttempt.status}`,
  );

  websocketAttempt = await openWebSocket(
    websocketPath,
    ["admin-updates", `admin-ticket.${websocketTicket}`],
    websocketOrigin,
  );
  check(
    "WebSocket admin avec ticket valide → 101",
    websocketAttempt.status === 101 &&
      websocketAttempt.socket.protocol === "admin-updates",
    `status=${websocketAttempt.status}`,
  );

  const updateMessage = Promise.race([
    new Promise((resolve) =>
      websocketAttempt.socket.once("message", (data) => resolve(String(data))),
    ),
    new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
  ]);
  r = await req("POST", "/api/admin/bookings/0/cancel", null, {
    Cookie: sessionCookie.split(";")[0],
    Origin: websocketOrigin,
  });
  const receivedUpdate = await updateMessage;
  check(
    "seul le socket authentifié reçoit les mises à jour admin",
    r.status === 200 && receivedUpdate === '{"type":"bookings_updated"}',
    `mutation=${r.status}; message=${receivedUpdate}`,
  );
  websocketAttempt.socket.close();

  websocketAttempt = await openWebSocket(
    websocketPath,
    ["admin-updates", `admin-ticket.${websocketTicket}`],
    websocketOrigin,
  );
  check(
    "ticket WebSocket rejoué → 401",
    websocketAttempt.status === 401,
    `status=${websocketAttempt.status}`,
  );

  const expiringSession = jwt.sign(
    { name: "admin", role: "admin" },
    process.env.JWT_SECRET,
    { expiresIn: "2s" },
  );
  r = await req("POST", "/api/admin/websocket-ticket", null, {
    Cookie: `admin_session=${expiringSession}`,
    Origin: websocketOrigin,
  });
  const expiringTicket = (await r.json()).ticket;
  websocketAttempt = await openWebSocket(
    websocketPath,
    ["admin-updates", `admin-ticket.${expiringTicket}`],
    websocketOrigin,
  );
  const sessionCloseCode = await Promise.race([
    new Promise((resolve) =>
      websocketAttempt.socket.once("close", (code) => resolve(code)),
    ),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  check(
    "WebSocket fermé à l'expiration de la session → 4001",
    sessionCloseCode === 4001,
    `code=${sessionCloseCode}`,
  );
  if (websocketAttempt.socket.readyState !== WebSocket.CLOSED) {
    websocketAttempt.socket.terminate();
  }

  r = await req("POST", "/api/admin/logout", null, {
    Cookie: sessionCookie.split(";")[0],
    ...adminMutationHeaders,
  });
  const clearedSessionCookie = r.headers.get("set-cookie") || "";
  const logoutCookieMatchesEnvironment =
    process.env.NODE_ENV === "production"
      ? /Secure/i.test(clearedSessionCookie) &&
        /SameSite=None/i.test(clearedSessionCookie)
      : !/Secure/i.test(clearedSessionCookie) &&
        /SameSite=Lax/i.test(clearedSessionCookie);
  check(
    "logout → 204 y cookie eliminada",
    r.status === 204 &&
      /admin_session=;/i.test(clearedSessionCookie) &&
      /Path=\//i.test(clearedSessionCookie) &&
      /HttpOnly/i.test(clearedSessionCookie) &&
      logoutCookieMatchesEnvironment,
    `status=${r.status}; set-cookie=${clearedSessionCookie || "sin Set-Cookie"}`,
  );

  r = await req("POST", "/api/admin/bookings/0/cancel", null, {
    Cookie: sessionCookie.split(";")[0],
    Origin: "https://attacker.example",
  });
  check("origine admin non autorisée → 403", r.status === 403, `status=${r.status}`);

  r = await req("GET", "/health");
  check(
    "CSP explícite présente",
    /default-src 'self'/.test(r.headers.get("content-security-policy") || ""),
    r.headers.get("content-security-policy") || "sans CSP",
  );

  r = await req("GET", "/index.html");
  check(
    "réponse statique protégée par CSP",
    r.status === 200 &&
      /default-src 'self'/.test(r.headers.get("content-security-policy") || ""),
    `status=${r.status}; csp=${r.headers.get("content-security-policy") || "sans CSP"}`,
  );

  // Rate limit del login: el 6.º intento en 15 min debe ser 429
  let last;
  for (let i = 0; i < 6; i++) {
    last = await req("POST", "/api/admin/login", { password: "x" });
  }
  check(
    "rate limit del login (6.º intento → 429)",
    last.status === 429,
    `status=${last.status}`,
  );

  if (process.env.ADMIN_SECURITY_ONLY === "true") {
    console.log(
      `\n===== RESULTADO ADMIN: ${passed} pasaron, ${failed} fallaron =====`,
    );
    process.exit(failed > 0 ? 1 : 0);
  }

  console.log("\n[Inyección y validación de entrada]");
  r = await req("POST", "/api/create-checkout-session", {
    checkIn: "2027-01-01' OR '1'='1",
    checkOut: "2027-01-15",
  });
  check("SQLi en checkIn → 400", r.status === 400, `status=${r.status}`);

  r = await req("POST", "/api/create-checkout-session", {
    checkIn: "2036-01-05",
    checkOut: "2036-01-20",
    guests: 99,
  });
  check("99 huéspedes → 400", r.status === 400, `status=${r.status}`);

  r = await req("POST", "/api/create-checkout-session", {
    checkIn: "2036-01-05",
    checkOut: "2036-01-20",
    guests: -3,
  });
  check("huéspedes negativos → 400", r.status === 400, `status=${r.status}`);

  r = await req("POST", "/api/create-checkout-session", {
    checkIn: "2020-01-01",
    checkOut: "2020-01-15",
    guests: 2,
  });
  check("check-in en el pasado → 400", r.status === 400, `status=${r.status}`);

  r = await req("POST", "/api/create-checkout-session", {
    checkIn: "2036-01-20",
    checkOut: "2036-01-05",
    guests: 2,
  });
  check(
    "check-out antes del check-in → 400",
    r.status === 400,
    `status=${r.status}`,
  );

  r = await req("POST", "/api/create-checkout-session", {
    rental_type: "monthly",
    checkIn: "2036-01-05",
    months: 99,
  });
  check("99 meses → 400", r.status === 400, `status=${r.status}`);

  r = await req("POST", "/api/create-checkout-session", {
    checkIn: "2035-06-01",
    checkOut: "2035-06-15",
    guests: 2,
  });
  check(
    "reserva a >18 meses vista → 400",
    r.status === 400,
    `status=${r.status}`,
  );

  r = await req("POST", "/api/create-checkout-session", {
    checkIn: "2036-01-05",
    checkOut: "2039-01-05", // ~3 años de estancia
    guests: 2,
  });
  check(
    "estancia de más de 365 noches → 400",
    r.status === 400,
    `status=${r.status}`,
  );

  r = await req("POST", "/api/create-checkout-session", {
    rental_type: "monthly",
    checkIn: "2038-01-05",
    months: 3,
  });
  check(
    "mensual a >18 meses vista → 400",
    r.status === 400,
    `status=${r.status}`,
  );

  console.log("\n[Confirmación de reservas]");
  r = await req("POST", "/api/bookings", { sessionId: "mock_inexistente" });
  check(
    "confirmar con sesión inexistente → 400",
    r.status === 400,
    `status=${r.status}`,
  );

  r = await req("POST", "/api/bookings", {});
  check(
    "confirmar sin sessionId → 400",
    r.status === 400,
    `status=${r.status}`,
  );

  console.log("\n[Límites y webhook]");
  r = await req("POST", "/api/calculate-price", {
    checkIn: "2036-01-05",
    checkOut: "2036-01-20",
    junk: "x".repeat(20000),
  });
  check("body >10kb → 413", r.status === 413, `status=${r.status}`);

  r = await req("POST", "/api/stripe/webhook", {});
  check(
    "webhook sin firma → 400/500",
    r.status === 400 || r.status === 500,
    `status=${r.status}`,
  );

  console.log(`\n===== RESULTADO: ${passed} pasaron, ${failed} fallaron =====`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Error en las pruebas:", e);
  process.exit(1);
});
