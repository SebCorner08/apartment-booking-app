// server/index.js - application composition and startup
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const http = require("http");

const db = require("./database");
const { createAdminAuth } = require("./middleware/admin-auth");
const { createAdminWebSocketService } = require("./services/admin-websocket");
const { createPricingService } = require("./services/pricing-service");
const { createBookingService } = require("./services/booking-service");
const { createCalendarService } = require("./services/calendar-service");
const { registerBookingRoutes } = require("./routes/booking-routes");
const { registerPricingRoutes } = require("./routes/pricing-routes");
const {
  registerStripeWebhookRoute,
  registerPaymentRoutes,
} = require("./routes/payment-routes");
const { registerAdminRoutes } = require("./routes/admin-routes");

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
}

const app = express();
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;
const NODE_ENV = process.env.NODE_ENV || "development";
const DOMAIN = process.env.DOMAIN;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const AIRBNB_ICAL_URL = process.env.AIRBNB_ICAL_URL;
const ADMIN_SESSION_MINUTES = 60;
const ADMIN_COOKIE_NAME = "admin_session";
const ADMIN_WS_PATH = "/admin-updates";
const ADMIN_WS_PROTOCOL = "admin-updates";
const ADMIN_WS_TICKET_PREFIX = "admin-ticket.";
const ADMIN_WS_TICKET_TTL_MS = 15 * 1000;
const MAX_GUESTS = 6;
const MAX_ADVANCE_MONTHS = 18;
const HOLD_MINUTES = 35;
const MOCK_PAYMENTS =
  NODE_ENV !== "production" && process.env.MOCK_PAYMENTS === "true";
const mockSessions = new Map();

if (!ADMIN_PASSWORD || !JWT_SECRET) {
  console.error(
    "❌ Faltan ADMIN_PASSWORD y/o JWT_SECRET en server/.env. El servidor no puede iniciar de forma segura.",
  );
  process.exit(1);
}

if (MOCK_PAYMENTS) {
  console.warn(
    "⚠️  MOCK_PAYMENTS activo: los pagos son SIMULADOS, no se llama a Stripe. Solo para pruebas locales, nunca en producción.",
  );
}

app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net",
          "https://unpkg.com",
          "https://fonts.googleapis.com",
        ],
        fontSrc: [
          "'self'",
          "data:",
          "https://cdnjs.cloudflare.com",
          "https://fonts.gstatic.com",
        ],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net",
          "https://unpkg.com",
          "https://elfsightcdn.com",
        ],
        frameSrc: ["'self'", "https://*.elfsight.com"],
        connectSrc: [
          "'self'",
          "https://escapelakenorman-api-l2da.onrender.com",
          "wss://escapelakenorman-api-l2da.onrender.com",
          "https://*.elfsight.com",
        ],
      },
    },
  }),
);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || DOMAIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const adminAuth = createAdminAuth({
  jwtSecret: JWT_SECRET,
  nodeEnv: NODE_ENV,
  allowedOrigins,
  adminCookieName: ADMIN_COOKIE_NAME,
  adminSessionMinutes: ADMIN_SESSION_MINUTES,
});

app.use(
  cors({
    origin(origin, callback) {
      callback(null, adminAuth.isAllowedOrigin(origin));
    },
    credentials: true,
  }),
);

const websocket = createAdminWebSocketService({
  isAllowedOrigin: adminAuth.isAllowedOrigin,
  path: ADMIN_WS_PATH,
  protocol: ADMIN_WS_PROTOCOL,
  ticketPrefix: ADMIN_WS_TICKET_PREFIX,
  ticketTtlMs: ADMIN_WS_TICKET_TTL_MS,
});
const pricingService = createPricingService(db);
const bookingService = createBookingService({ db, holdMinutes: HOLD_MINUTES });
const calendarService = createCalendarService({
  db,
  airbnbIcalUrl: AIRBNB_ICAL_URL,
  broadcastAdminUpdate: websocket.broadcastAdminUpdate,
});

registerStripeWebhookRoute(app, {
  express,
  stripe,
  db,
  webhookSecret: STRIPE_WEBHOOK_SECRET,
  broadcastAdminUpdate: websocket.broadcastAdminUpdate,
});

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "../public")));
app.use(
  "/api/",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
});
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment attempts. Please try again later." },
});

registerBookingRoutes(app, { db });
registerPricingRoutes(app, {
  pricingService,
  bookingService,
  checkAdminAuth: adminAuth.checkAdminAuth,
  broadcastAdminUpdate: websocket.broadcastAdminUpdate,
});
registerPaymentRoutes(app, {
  checkoutLimiter,
  mockPayments: MOCK_PAYMENTS,
  mockSessions,
  stripe,
  db,
  domain: DOMAIN,
  airbnbIcalUrl: AIRBNB_ICAL_URL,
  maxGuests: MAX_GUESTS,
  maxAdvanceMonths: MAX_ADVANCE_MONTHS,
  pricingService,
  bookingService,
  syncAirbnbCalendar: calendarService.syncAirbnbCalendar,
  broadcastAdminUpdate: websocket.broadcastAdminUpdate,
});
registerAdminRoutes(app, {
  loginLimiter,
  adminPassword: ADMIN_PASSWORD,
  jwtSecret: JWT_SECRET,
  adminSessionMinutes: ADMIN_SESSION_MINUTES,
  adminWsTicketTtlMs: ADMIN_WS_TICKET_TTL_MS,
  adminCookieOptions: adminAuth.adminCookieOptions,
  isAllowedOrigin: adminAuth.isAllowedOrigin,
  checkAdminAuth: adminAuth.checkAdminAuth,
  issueAdminWebSocketTicket: websocket.issueTicket,
  db,
  broadcastAdminUpdate: websocket.broadcastAdminUpdate,
  mockPayments: MOCK_PAYMENTS,
  domain: DOMAIN,
  stripe,
});
calendarService.registerCalendarRoute(app);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const server = http.createServer(app);
websocket.attachToServer(server);

function startServer() {
  server.listen(PORT, () => {
    const listeningPort = server.address().port;
    console.log(`\n${"=".repeat(50)}`);
    console.log(`🚀 Server running on port ${listeningPort}`);
    console.log(`📍 Environment: ${NODE_ENV}`);
    console.log(`🌐 Domain: ${DOMAIN}`);
    console.log(`📅 Calendar URL: ${DOMAIN}/api/calendar.ics`);
    console.log(`${"=".repeat(50)}\n`);

    setTimeout(bookingService.cleanupExpiredHolds, 2000);
    setInterval(bookingService.cleanupExpiredHolds, 5 * 60 * 1000);

    if (AIRBNB_ICAL_URL) {
      calendarService.syncAirbnbCalendar();
      setInterval(calendarService.syncAirbnbCalendar, 15 * 60 * 1000);
    } else {
      console.log(
        "ℹ️ AIRBNB_ICAL_URL no configurado: sincronización con Airbnb desactivada.",
      );
    }

    if (typeof process.send === "function") {
      process.send({ type: "server-listening", port: listeningPort });
    }
  });
}

db.ready.then(startServer).catch((err) => {
  console.error(
    "❌ Database bootstrap failed; server will not start:",
    err.message,
  );
  process.exitCode = 1;
  db.close(() => {});
});

module.exports = { app };
