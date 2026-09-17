// server/index.js - Backend funcional sin dependencias problemáticas
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");
const ical = require("node-ical");

const db = require("./database.js");
const {
  DEFAULT_PRICING,
  MAX_NIGHTS,
  normalizePricingRow,
  mergePricingSettings,
  validateRequiredTaxUpdate,
} = require("./pricing-settings.js");

// Stripe se inicializa solo si hay clave real; en modo mock no se necesita.
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

// Reglas tarifarias activas (los importes monetarios reales se leen de la DB)
const MAX_GUESTS = 6;
const MAX_ADVANCE_MONTHS = 18; // nadie puede reservar a más de 18 meses vista
const HOLD_MINUTES = 35; // un poco más que la expiración de la sesión de Stripe (30 min)

// Modo de prueba sin Stripe real: nunca se activa en producción, aunque la variable quede puesta por error.
const MOCK_PAYMENTS =
  NODE_ENV !== "production" && process.env.MOCK_PAYMENTS === "true";
const mockSessions = new Map(); // sesiones falsas en memoria, solo para MOCK_PAYMENTS

// Servir archivos estáticos desde public/
app.use(express.static(path.join(__dirname, "..", "public")));

// No arrancar sin secretos configurados: evita contraseñas/JWT por defecto inseguros
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
// El sitio usa scripts inline y varios CDNs (Font Awesome, Google Fonts, Swiper),
// así que se desactiva la CSP por defecto de helmet para no romper la página;
// las demás cabeceras de seguridad (X-Frame-Options, etc.) se mantienen.
app.use(helmet({ contentSecurityPolicy: false }));

// Restringe qué orígenes pueden llamar a la API (evita que otros sitios usen tokens robados)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || DOMAIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  }),
);

// El webhook de Stripe necesita el cuerpo sin parsear para verificar la firma,
// por eso se registra ANTES de express.json().
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  handleStripeWebhook,
);

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "../public")));

// Limita solicitudes generales a la API para mitigar abuso/DoS
app.use(
  "/api/",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Límite estricto para el login de admin (protege contra fuerza bruta)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
});

// Límite para crear sesiones de pago: cada una crea un bloqueo temporal de
// fechas, así que sin límite específico un atacante podría bloquear el
// calendario entero creando bloques de 35 min una y otra vez.
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment attempts. Please try again later." },
});

// ============ AUTENTICACIÓN ============
const checkAdminAuth = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// ============ FUNCIONES AUXILIARES ============

/**
 * Obtiene la configuración de impuestos Mecklenburg.
 * Ventas: 8.25% + Ocupación: 8.00% = 16.25% sobre alojamiento + limpieza.
 * Airbnb cobra y remite automáticamente estos impuestos.
 */
function getTaxConfig() {
  return {
    mecklenburg_sales: DEFAULT_PRICING.mecklenburg_sales,
    mecklenburg_occupancy: DEFAULT_PRICING.mecklenburg_occupancy,
  };
}

/**
 * Calcula el precio total con impuestos Mecklenburg para estancia corta.
 * Total: 16.25% (Ventas 8.25% + Ocupación 8.00%) sobre alojamiento + limpieza.
 */
function calculateTotalPrice(
  nights,
  pricePerNight,
  cleaningFee = DEFAULT_PRICING.cleaning_fee,
  taxRates = null,
) {
  if (!taxRates) taxRates = getTaxConfig();

  const subtotal = nights * pricePerNight;
  const taxableBase = subtotal + cleaningFee;

  // Impuestos Mecklenburg sobre alojamiento + limpieza
  const salesTax = (taxableBase * taxRates.mecklenburg_sales) / 100;
  const occupancyTax = (taxableBase * taxRates.mecklenburg_occupancy) / 100;

  const totalTax = salesTax + occupancyTax;
  const total = taxableBase + totalTax;

  return {
    rental_type: "short_stay",
    nights,
    nightly_rate: pricePerNight,
    subtotal: Math.round(subtotal * 100) / 100,
    cleaning_fee: Math.round(cleaningFee * 100) / 100,
    mecklenburg_sales_tax: Math.round(salesTax * 100) / 100,
    mecklenburg_occupancy_tax: Math.round(occupancyTax * 100) / 100,
    total_tax: Math.round(totalTax * 100) / 100,
    total: Math.round(total * 100) / 100,
    tax_rates: {
      mecklenburg_sales: taxRates.mecklenburg_sales,
      mecklenburg_occupancy: taxRates.mecklenburg_occupancy,
    },
  };
}

/**
 * Calcula el precio para arriendo mensual.
 * Solo impuesto de ventas (8.25%), sin impuesto de ocupación.
 * El arriendo mensual no aplica occupancy tax de Airbnb.
 */
function calculateMonthlyPrice(months, monthlyRate, taxRates = null) {
  if (!taxRates) taxRates = getTaxConfig();

  const subtotal = months * monthlyRate;

  // Solo impuesto de ventas para arriendo mensual (sin occupancy tax)
  const salesTax = (subtotal * taxRates.mecklenburg_sales) / 100;

  const totalTax = salesTax;
  const total = subtotal + totalTax;

  return {
    rental_type: "monthly",
    months,
    monthly_rate: monthlyRate,
    subtotal: Math.round(subtotal * 100) / 100,
    mecklenburg_sales_tax: Math.round(salesTax * 100) / 100,
    mecklenburg_occupancy_tax: 0,
    total_tax: Math.round(totalTax * 100) / 100,
    total: Math.round(total * 100) / 100,
    tax_rates: {
      mecklenburg_sales: taxRates.mecklenburg_sales,
      mecklenburg_occupancy: taxRates.mecklenburg_occupancy,
    },
  };
}

/**
 * Carga la configuración de impuestos Mecklenburg desde la base de datos.
 * Intenta usar las nuevas columnas mecklenburg_sales/mecklenburg_occupancy;
 * si no existen (base de datos antigua), cae a los defaults.
 */
function getLatestPricingRow() {
  const sql = `
    SELECT nightly_rate, monthly_rate, cleaning_fee, minimum_nights,
           mecklenburg_sales, mecklenburg_occupancy
    FROM tax_settings
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `;
  return db.pricingReady.then(
    () =>
      new Promise((resolve, reject) => {
        db.get(sql, [], (err, row) => (err ? reject(err) : resolve(row)));
      }),
  );
}

/**
 * Carga tarifas e impuestos desde la base de datos del servidor.
 * Esta es la ÚNICA fuente de precios: nunca se usan valores enviados por el navegador.
 * Database errors propagate so checkout fails closed instead of charging defaults.
 */
async function loadRatesFromDB() {
  return normalizePricingRow(await getLatestPricingRow());
}

async function loadTaxSettingsFromDB() {
  const rates = await loadRatesFromDB();
  return {
    mecklenburg_sales: rates.mecklenburg_sales,
    mecklenburg_occupancy: rates.mecklenburg_occupancy,
  };
}

let pricingUpdateQueue = Promise.resolve();

function savePricingSettings(updates) {
  const operation = pricingUpdateQueue.then(async () => {
    const pricing = mergePricingSettings(await getLatestPricingRow(), updates);
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO tax_settings (
           nc_state, mecklenburg_local, occupancy,
           nightly_rate, monthly_rate, cleaning_fee, minimum_nights,
           mecklenburg_sales, mecklenburg_occupancy, updated_at
         ) VALUES (0, 0, 0, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          pricing.nightly_rate,
          pricing.monthly_rate,
          pricing.cleaning_fee,
          pricing.minimum_nights,
          pricing.mecklenburg_sales,
          pricing.mecklenburg_occupancy,
        ],
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return pricing;
  });

  // Keep the queue usable after a rejected validation or database operation.
  pricingUpdateQueue = operation.catch(() => {});
  return operation;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calcula las noches entre dos fechas YYYY-MM-DD.
 * Devuelve null si las fechas son inválidas o checkOut <= checkIn.
 */
function nightsBetween(checkIn, checkOut) {
  if (!DATE_RE.test(checkIn || "") || !DATE_RE.test(checkOut || ""))
    return null;
  const start = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  if (isNaN(start) || isNaN(end)) return null;
  const nights = Math.round((end - start) / 86400000);
  return nights > 0 ? nights : null;
}

/**
 * Comprueba si un rango de fechas está libre, combinando reservas confirmadas,
 * bloqueos importados de calendarios externos (ej. Airbnb) y bloqueos
 * temporales activos de pagos en curso.
 */
function checkAvailability(checkIn, checkOut) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT checkIn, checkOut FROM bookings WHERE bookingStatus = 'confirmed'
      UNION ALL
      SELECT checkIn, checkOut FROM external_blocks
      UNION ALL
      SELECT checkIn, checkOut FROM booking_holds
      WHERE status = 'active' AND expires_at > datetime('now')
    `;
    db.all(sql, [], (err, rows) => {
      if (err) return reject(err);
      const hasOverlap = rows.some(
        (r) => checkIn < r.checkOut && checkOut > r.checkIn,
      );
      resolve(!hasOverlap);
    });
  });
}

// ============ BLOQUEOS TEMPORALES (HOLDS) ============

/** Elimina bloqueos temporales cuyo pago nunca se completó. */
function cleanupExpiredHolds() {
  db.run(
    `DELETE FROM booking_holds WHERE status = 'active' AND expires_at <= datetime('now')`,
    (err) => {
      if (err)
        console.error("Error limpiando bloqueos expirados:", err.message);
    },
  );
}

/** Libera un bloqueo temporal (pago fallido, expirado o error creando la sesión). */
function releaseHold(holdId) {
  if (!holdId) return;
  db.run(
    `UPDATE booking_holds SET status = 'released' WHERE id = ? AND status = 'active'`,
    [holdId],
  );
}

function releaseHoldBySession(sessionId) {
  if (!sessionId) return;
  db.run(
    `UPDATE booking_holds SET status = 'released' WHERE stripe_session_id = ? AND status = 'active'`,
    [sessionId],
  );
}

/** Marca el bloqueo como confirmado cuando el pago se completa. */
function confirmHold(holdId, sessionId) {
  if (!holdId) return;
  db.run(
    `UPDATE booking_holds SET status = 'confirmed', stripe_session_id = COALESCE(?, stripe_session_id) WHERE id = ?`,
    [sessionId || null, holdId],
  );
}

// Cola para serializar la creación de bloqueos: SQLite no permite dos
// transacciones concurrentes en la misma conexión, así que las encadenamos.
// Así, de dos reservas simultáneas para las mismas fechas solo una obtiene
// el bloqueo; la otra recibe 409.
let holdQueue = Promise.resolve();

/**
 * Crea un bloqueo temporal verificando la disponibilidad DENTRO de una
 * transacción (BEGIN IMMEDIATE), de modo que dos reservas simultáneas para
 * las mismas fechas no puedan pasar ambas: solo la primera obtiene el bloqueo.
 * Devuelve el id del bloqueo, o null si las fechas están ocupadas.
 */
function createHold({ checkIn, checkOut, rentalType }) {
  const run = () =>
    new Promise((resolve, reject) => {
      const holdId = crypto.randomUUID();
      // Mismo formato que datetime('now') de SQLite (UTC) para comparar expiración
      const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");

      db.serialize(() => {
        db.run("BEGIN IMMEDIATE TRANSACTION");
        db.all(
          `SELECT checkIn, checkOut FROM bookings WHERE bookingStatus = 'confirmed'
           UNION ALL
           SELECT checkIn, checkOut FROM external_blocks
           UNION ALL
           SELECT checkIn, checkOut FROM booking_holds
           WHERE status = 'active' AND expires_at > datetime('now')`,
          [],
          (err, rows) => {
            if (err) {
              db.run("ROLLBACK");
              return reject(err);
            }
            const hasOverlap = rows.some(
              (r) => checkIn < r.checkOut && checkOut > r.checkIn,
            );
            if (hasOverlap) {
              db.run("ROLLBACK");
              return resolve(null);
            }
            db.run(
              `INSERT INTO booking_holds (id, checkIn, checkOut, rental_type, expires_at) VALUES (?, ?, ?, ?, ?)`,
              [holdId, checkIn, checkOut, rentalType, expiresAt],
              (insertErr) => {
                if (insertErr) {
                  db.run("ROLLBACK");
                  return reject(insertErr);
                }
                db.run("COMMIT", (commitErr) => {
                  if (commitErr) return reject(commitErr);
                  resolve(holdId);
                });
              },
            );
          },
        );
      });
    });

  const result = holdQueue.then(run, run);
  holdQueue = result.catch(() => {});
  return result;
}

// ============ API ENDPOINTS ============

// Endpoint público para obtener fechas reservadas (propias + Airbnb)
app.get("/api/bookings", (req, res) => {
  const sql = `
    SELECT checkIn, checkOut FROM bookings WHERE bookingStatus = 'confirmed'
    UNION ALL
    SELECT checkIn, checkOut FROM external_blocks
  `;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("Error fetching bookings:", err);
      return res.status(500).json({ error: err.message });
    }
    const disabledRanges = rows.map((row) => ({
      from: row.checkIn,
      to: row.checkOut,
    }));
    res.json(disabledRanges);
  });
});

// Endpoint para obtener tasas de impuestos actuales
app.get("/api/tax-rates", async (req, res) => {
  try {
    res.json(await loadTaxSettingsFromDB());
  } catch (err) {
    console.error("Error loading tax settings:", err);
    res.status(503).json({ error: "Pricing configuration unavailable" });
  }
});

// Endpoint para calcular precio total (con impuestos).
// Las tarifas se leen SIEMPRE de la base de datos del servidor; cualquier
// pricePerNight/monthly_rate/subtotal/total enviado por el navegador se ignora.
app.post("/api/calculate-price", async (req, res) => {
  const { checkIn, checkOut, rental_type, months } = req.body;

  try {
    const rates = await loadRatesFromDB();
    // Arriendo mensual
    if (rental_type === "monthly") {
      const monthsInt = parseInt(months, 10);
      if (!Number.isInteger(monthsInt) || monthsInt < 1 || monthsInt > 12) {
        return res.status(400).json({ error: "Invalid number of months" });
      }
      return res.json(
        calculateMonthlyPrice(monthsInt, rates.monthly_rate, rates),
      );
    }

    // Estancia corta: las noches las calcula el servidor a partir de las fechas
    const nights = nightsBetween(checkIn, checkOut);
    if (!nights) {
      return res
        .status(400)
        .json({ error: "Missing or invalid check-in/check-out dates" });
    }
    if (nights < rates.minimum_nights) {
      return res
        .status(400)
        .json({ error: `Minimum stay is ${rates.minimum_nights} nights` });
    }
    res.json(
      calculateTotalPrice(nights, rates.nightly_rate, rates.cleaning_fee, rates),
    );
  } catch (err) {
    console.error("Error loading rates:", err);
    res.status(503).json({ error: "Pricing configuration unavailable" });
  }
});

// Endpoint para crear sesión de pago Stripe.
// SEGURIDAD: el precio se calcula exclusivamente en el servidor con las
// tarifas de la base de datos. El navegador solo envía fechas, huéspedes y
// tipo de reserva; cualquier precio/subtotal/impuesto/total enviado se ignora.
app.post("/api/create-checkout-session", checkoutLimiter, async (req, res) => {
  const { checkIn, checkOut, rental_type, months, guests } = req.body;

  // Si no hay Stripe ni modo simulado, no se puede cobrar: error claro
  if (!MOCK_PAYMENTS && !stripe) {
    return res
      .status(503)
      .json({ error: "Payments are not configured on the server" });
  }

  // Huéspedes: opcional, validado en el servidor
  const guestsInt = guests === undefined ? 2 : parseInt(guests, 10);
  if (!Number.isInteger(guestsInt) || guestsInt < 1 || guestsInt > MAX_GUESTS) {
    return res
      .status(400)
      .json({ error: `Guests must be between 1 and ${MAX_GUESTS}` });
  }

  const todayStr = new Date().toISOString().split("T")[0];
  // Horizonte máximo de reserva: evita bloqueos de fechas a años vista
  const maxAdvanceDate = new Date();
  maxAdvanceDate.setUTCMonth(maxAdvanceDate.getUTCMonth() + MAX_ADVANCE_MONTHS);
  const maxAdvanceStr = maxAdvanceDate.toISOString().split("T")[0];

  let finalCheckIn = checkIn;
  let finalCheckOut = checkOut;
  let nights = null;
  let monthsInt = null;

  if (rental_type === "monthly") {
    // Arriendo mensual: el servidor calcula el check-out (inicio + meses)
    monthsInt = parseInt(months, 10);
    if (!Number.isInteger(monthsInt) || monthsInt < 1 || monthsInt > 12) {
      return res.status(400).json({ error: "Invalid number of months" });
    }
    if (!DATE_RE.test(checkIn || "") || checkIn < todayStr) {
      return res.status(400).json({ error: "Missing or invalid start date" });
    }
    if (checkIn > maxAdvanceStr) {
      return res.status(400).json({
        error: `Bookings can only be made up to ${MAX_ADVANCE_MONTHS} months in advance`,
      });
    }
    const end = new Date(`${checkIn}T00:00:00Z`);
    end.setUTCMonth(end.getUTCMonth() + monthsInt);
    finalCheckOut = end.toISOString().split("T")[0];
  } else {
    // Estancia corta: las noches las calcula el servidor a partir de las fechas
    nights = nightsBetween(checkIn, checkOut);
    if (!nights) {
      return res
        .status(400)
        .json({ error: "Missing or invalid check-in/check-out dates" });
    }
    if (checkIn < todayStr) {
      return res
        .status(400)
        .json({ error: "Check-in date cannot be in the past" });
    }
    if (checkIn > maxAdvanceStr) {
      return res.status(400).json({
        error: `Bookings can only be made up to ${MAX_ADVANCE_MONTHS} months in advance`,
      });
    }
    // The effective minimum is checked after loading the authoritative DB row.
    if (nights > MAX_NIGHTS) {
      return res
        .status(400)
        .json({ error: `Maximum stay is ${MAX_NIGHTS} nights` });
    }
  }

  let holdId = null;
  try {
    // Tarifas e impuestos desde la base de datos del servidor
    const rates = await loadRatesFromDB();
    if (rental_type !== "monthly" && nights < rates.minimum_nights) {
      return res
        .status(400)
        .json({ error: `Minimum stay is ${rates.minimum_nights} nights` });
    }
    const pricing =
      rental_type === "monthly"
        ? calculateMonthlyPrice(monthsInt, rates.monthly_rate, rates)
        : calculateTotalPrice(
            nights,
            rates.nightly_rate,
            rates.cleaning_fee,
            rates,
          );

    // Validar que el importe final sea válido y mayor que cero
    if (!pricing.total || pricing.total <= 0) {
      return res.status(400).json({ error: "Invalid booking amount" });
    }

    // Refrescar el calendario de Airbnb justo antes de comprobar disponibilidad
    // (syncAirbnbCalendar ya maneja sus propios errores; nunca lanza)
    if (AIRBNB_ICAL_URL) {
      await syncAirbnbCalendar();
    }

    // Disponibilidad + bloqueo temporal en una sola transacción:
    // si las fechas están ocupadas NO se crea la sesión de Stripe,
    // y dos reservas simultáneas no pueden pasar a la vez.
    cleanupExpiredHolds();
    holdId = await createHold({
      checkIn: finalCheckIn,
      checkOut: finalCheckOut,
      rentalType: rental_type === "monthly" ? "monthly" : "short_stay",
    });
    if (!holdId) {
      return res
        .status(409)
        .json({ error: "Selected dates are no longer available" });
    }

    const metadata = {
      hold_id: holdId,
      checkIn: finalCheckIn,
      checkOut: finalCheckOut,
      rental_type: rental_type === "monthly" ? "monthly" : "short_stay",
      guests: String(guestsInt),
    };
    let productName;
    let productDescription;
    if (rental_type === "monthly") {
      metadata.months = String(monthsInt);
      productName = "Lakeside Serenity - Monthly Rental";
      productDescription = `${monthsInt} month(s): ${finalCheckIn} to ${finalCheckOut}`;
    } else {
      metadata.nights = String(nights);
      productName = "Lakeside Serenity - Apartment Stay";
      productDescription = `${nights} night(s): ${finalCheckIn} to ${finalCheckOut}`;
    }

    // Modo simulado: no llama a Stripe, genera una "sesión" falsa para probar el flujo completo
    if (MOCK_PAYMENTS) {
      const mockId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      mockSessions.set(mockId, {
        payment_status: "paid",
        metadata,
      });
      db.run(`UPDATE booking_holds SET stripe_session_id = ? WHERE id = ?`, [
        mockId,
        holdId,
      ]);
      return res.json({
        id: mockId,
        url: `${DOMAIN}/success.html?session_id=${mockId}`,
        pricing,
      });
    }

    // Crear sesión en Stripe con el total calculado por el servidor
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: productName,
              description: productDescription,
            },
            unit_amount: Math.round(pricing.total * 100), // Total con impuestos en centavos
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      // La sesión expira a los 30 min; si no se paga, el bloqueo se libera
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      success_url: `${process.env.DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.DOMAIN}/cancel.html`,
      metadata,
    });

    db.run(`UPDATE booking_holds SET stripe_session_id = ? WHERE id = ?`, [
      session.id,
      holdId,
    ]);

    res.json({
      id: session.id,
      url: session.url,
      pricing: pricing,
    });
  } catch (error) {
    // Si algo falló después de crear el bloqueo, liberarlo
    if (holdId) releaseHold(holdId);
    console.error("Stripe error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para confirmar pago y crear reserva (respaldo por si el webhook no ha llegado aún)
app.post("/api/bookings", async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Verificar sesión: en modo simulado se lee de memoria, si no, se consulta a Stripe
    let session;
    if (MOCK_PAYMENTS && sessionId.startsWith("mock_")) {
      const mock = mockSessions.get(sessionId);
      if (!mock) {
        return res.status(400).json({ error: "Mock session not found" });
      }
      session = { id: sessionId, ...mock };
    } else {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    }

    if (session.payment_status !== "paid") {
      return res.status(400).json({ error: "Payment not confirmed" });
    }

    // Las fechas de la reserva se toman de la metadata de la sesión pagada
    // (lo que realmente pagó el cliente), nunca del cuerpo de la petición.
    const meta = session.metadata || {};
    const checkIn = meta.checkIn;
    const checkOut = meta.checkOut;
    if (!checkIn || !checkOut) {
      return res.status(400).json({ error: "Session has no booking metadata" });
    }
    const rentalType = meta.rental_type || "short_stay";
    const guests = parseInt(meta.guests, 10) || 2;

    // INSERT OR IGNORE: si el webhook ya guardó esta reserva (mismo stripePaymentId), no se duplica
    const sql = `INSERT OR IGNORE INTO bookings (checkIn, checkOut, bookingStatus, stripePaymentId, rental_type, guests) VALUES (?, ?, ?, ?, ?, ?)`;
    const params = [
      checkIn,
      checkOut,
      "confirmed",
      session.id,
      rentalType,
      guests,
    ];

    db.run(sql, params, function (err) {
      if (err) {
        console.error("Database error:", err);
        return res.status(500).json({ error: err.message });
      }

      if (this.changes > 0) {
        broadcastAdminUpdate();
      }
      confirmHold(meta.hold_id, session.id);
      res.status(201).json({
        message: "Booking created successfully",
        bookingId: this.lastID,
        checkIn,
        checkOut,
      });
    });
  } catch (error) {
    console.error("Booking creation error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Maneja los eventos de Stripe verificando la firma del webhook.
 * Esta es la vía confiable para confirmar reservas (no depende del navegador del cliente).
 * Issue #2: delega la persistencia a un handler awaitable para no devolver 2xx
 * hasta que las escrituras requeridas hayan terminado correctamente.
 */
async function handleStripeWebhook(req, res) {
  const {
    handleStripeWebhookRequest,
  } = require("./stripe-webhook-persistence");
  return handleStripeWebhookRequest({
    req,
    res,
    stripe,
    db,
    webhookSecret: STRIPE_WEBHOOK_SECRET,
    broadcastAdminUpdate,
  });
}

// ============ ADMIN ENDPOINTS ============

// Login de admin
app.post("/api/admin/login", loginLimiter, (req, res) => {
  const { password } = req.body;

  if (password === ADMIN_PASSWORD) {
    const user = { name: "admin", role: "admin" };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: "24h" });
    res.json({ token, user });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

// Obtener todas las reservas (requiere autenticación)
app.get("/api/admin/bookings", checkAdminAuth, (req, res) => {
  const sql = "SELECT * FROM bookings ORDER BY checkIn DESC";
  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    const nowStr = new Date().toISOString().split("T")[0];
    const bookings = {
      active: rows.filter(
        (r) => r.bookingStatus === "confirmed" && r.checkOut > nowStr,
      ),
      completed: rows.filter(
        (r) => r.bookingStatus === "confirmed" && r.checkOut <= nowStr,
      ),
      cancelled: rows.filter((r) => r.bookingStatus === "cancelled"),
    };

    res.json(bookings);
  });
});

// Cancelar una reserva
app.post("/api/admin/bookings/:id/cancel", checkAdminAuth, (req, res) => {
  const sql = `UPDATE bookings SET bookingStatus = 'cancelled' WHERE id = ?`;
  db.run(sql, [req.params.id], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    broadcastAdminUpdate();
    res.json({ message: "Booking cancelled", changes: this.changes });
  });
});

// Eliminar una reserva permanentemente
app.delete("/api/admin/bookings/:id", checkAdminAuth, (req, res) => {
  const sql = `DELETE FROM bookings WHERE id = ?`;
  db.run(sql, [req.params.id], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    broadcastAdminUpdate();
    res.json({ message: "Booking deleted", changes: this.changes });
  });
});

// ============ MONTHLY RATE ENDPOINTS ============

// Compatibility endpoints backed by the same complete pricing snapshot.
app.get("/api/monthly-rate", async (req, res) => {
  try {
    const rates = await loadRatesFromDB();
    res.json({ monthly_rate: rates.monthly_rate });
  } catch (err) {
    console.error("Error loading monthly rate:", err);
    res.status(503).json({ error: "Pricing configuration unavailable" });
  }
});

app.get("/api/admin/monthly-rate", checkAdminAuth, async (req, res) => {
  try {
    const rates = await loadRatesFromDB();
    res.json({ monthly_rate: rates.monthly_rate });
  } catch (err) {
    console.error("Error loading monthly rate:", err);
    res.status(503).json({ error: "Pricing configuration unavailable" });
  }
});

app.post("/api/admin/monthly-rate", checkAdminAuth, async (req, res) => {
  const { monthly_rate } = req.body;
  if (monthly_rate === undefined || monthly_rate === null) {
    return res.status(400).json({ error: "Invalid monthly rate" });
  }
  try {
    const pricing = await savePricingSettings({ monthly_rate });
    broadcastAdminUpdate();
    res.json({
      message: "Monthly rate updated",
      monthly_rate: pricing.monthly_rate,
    });
  } catch (err) {
    if (err instanceof TypeError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Error saving monthly rate:", err);
    res.status(500).json({ error: "Unable to save pricing configuration" });
  }
});

// ============ TAX SETTINGS ENDPOINTS ============

// Obtener configuración de impuestos Mecklenburg
app.get("/api/admin/tax-settings", checkAdminAuth, async (req, res) => {
  try {
    res.json(await loadRatesFromDB());
  } catch (err) {
    console.error("Error loading admin pricing settings:", err);
    res.status(503).json({ error: "Pricing configuration unavailable" });
  }
});

// Actualizar la configuración tarifaria completa. Los campos omitidos se
// conservan desde la última fila para que un cambio de impuestos nunca
// restablezca silenciosamente la tarifa nocturna.
app.post("/api/admin/tax-settings", checkAdminAuth, async (req, res) => {
  try {
    const updates = validateRequiredTaxUpdate(req.body);
    const pricing = await savePricingSettings(updates);
    broadcastAdminUpdate();
    res.json({ message: "Pricing settings updated", ...pricing });
  } catch (err) {
    if (err instanceof TypeError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Error saving pricing settings:", err);
    res.status(500).json({ error: "Unable to save pricing configuration" });
  }
});

// ============ MANUAL BILLING ENDPOINTS ============

// Crear un cobro manual (envía enlace de pago al cliente)
app.post("/api/admin/charges", checkAdminAuth, async (req, res) => {
  const { guest_name, guest_email, description, amount } = req.body;

  if (!guest_name || !guest_email || !description || !amount) {
    return res.status(400).json({
      error:
        "Missing required fields: guest_name, guest_email, description, amount",
    });
  }

  if (amount <= 0) {
    return res.status(400).json({ error: "Amount must be greater than 0" });
  }

  const sql = `
    INSERT INTO manual_charges (guest_name, guest_email, description, amount)
    VALUES (?, ?, ?, ?)
  `;

  db.run(
    sql,
    [guest_name, guest_email, description, amount],
    async function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const chargeId = this.lastID;

      // Crear sesión de pago en Stripe (o mock)
      let sessionId = null;
      let sessionUrl = null;

      if (MOCK_PAYMENTS) {
        sessionId = `mock_charge_${Date.now()}`;
        sessionUrl = `${DOMAIN}/success.html?charge_id=${chargeId}`;
        db.run(`UPDATE manual_charges SET stripe_session_id = ? WHERE id = ?`, [
          sessionId,
          chargeId,
        ]);
      } else if (stripe) {
        try {
          const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            customer_email: guest_email,
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  product_data: {
                    name: description,
                    description: `Manual charge for ${guest_name}`,
                  },
                  unit_amount: Math.round(amount * 100),
                },
                quantity: 1,
              },
            ],
            mode: "payment",
            success_url: `${DOMAIN}/success.html?charge_id=${chargeId}`,
            cancel_url: `${DOMAIN}/cancel.html`,
            metadata: {
              charge_id: String(chargeId),
              guest_name,
              guest_email,
            },
          });
          sessionId = session.id;
          sessionUrl = session.url;
          db.run(
            `UPDATE manual_charges SET stripe_session_id = ? WHERE id = ?`,
            [sessionId, chargeId],
          );
        } catch (stripeErr) {
          console.error("Stripe error creating manual charge:", stripeErr);
          // El cobro se guarda de todas formas; el admin puede reintentar después
        }
      }

      broadcastAdminUpdate();
      res.status(201).json({
        message: "Charge created",
        id: chargeId,
        stripe_session_id: sessionId,
        url: sessionUrl,
      });
    },
  );
});

// Listar cobros manuales
app.get("/api/admin/charges", checkAdminAuth, (req, res) => {
  const sql = `SELECT * FROM manual_charges ORDER BY created_at DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Actualizar estado de un cobro (marcar como pagado)
app.post("/api/admin/charges/:id/pay", checkAdminAuth, (req, res) => {
  const sql = `UPDATE manual_charges SET status = 'paid', paid_at = datetime('now') WHERE id = ?`;
  db.run(sql, [req.params.id], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    broadcastAdminUpdate();
    res.json({ message: "Charge marked as paid", changes: this.changes });
  });
});

// Eliminar un cobro manual
app.delete("/api/admin/charges/:id", checkAdminAuth, (req, res) => {
  const sql = `DELETE FROM manual_charges WHERE id = ?`;
  db.run(sql, [req.params.id], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    broadcastAdminUpdate();
    res.json({ message: "Charge deleted", changes: this.changes });
  });
});

// ============ AIRBNB CALENDAR SYNC ============

// Obtener calendario en formato iCal
app.get("/api/calendar.ics", (req, res) => {
  const sql =
    "SELECT id, checkIn, checkOut FROM bookings WHERE bookingStatus = 'confirmed' ORDER BY checkIn";

  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    let icsContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Lakeside Serenity//Booking Calendar//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:Lakeside Serenity - Bookings
X-WR-TIMEZONE:America/Chicago
X-WR-CALDESC:Unavailable dates for Lakeside Serenity apartment
`;

    if (rows && rows.length > 0) {
      rows.forEach((booking) => {
        const checkInDate = new Date(booking.checkIn);
        const checkOutDate = new Date(booking.checkOut);

        const formatDate = (date) => {
          return date.toISOString().split("T")[0].replace(/-/g, "");
        };

        icsContent += `BEGIN:VEVENT
UID:booking-${booking.id}@lakeside-serenity
DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z
DTSTART;VALUE=DATE:${formatDate(checkInDate)}
DTEND;VALUE=DATE:${formatDate(checkOutDate)}
SUMMARY:UNAVAILABLE - Booking #${booking.id}
DESCRIPTION:Booking ID: ${booking.id}
STATUS:CONFIRMED
END:VEVENT
`;
      });
    }

    icsContent += `END:VCALENDAR`;

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", "attachment; filename=calendar.ics");
    res.send(icsContent);
  });
});

// ============ HEALTH CHECK ============
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============ AIRBNB ICAL IMPORT ============

/**
 * Descarga el calendario iCal exportado por Airbnb y bloquea esas fechas
 * en la web, para evitar reservas dobles entre plataformas.
 */
async function syncAirbnbCalendar() {
  if (!AIRBNB_ICAL_URL) return;

  try {
    const events = await ical.async.fromURL(AIRBNB_ICAL_URL);
    const parsedEvents = Object.values(events).filter(
      (e) => e.type === "VEVENT" && e.start && e.end && e.uid,
    );

    for (const event of parsedEvents) {
      const checkIn = event.start.toISOString().split("T")[0];
      const checkOut = event.end.toISOString().split("T")[0];

      db.run(
        `INSERT INTO external_blocks (source, uid, checkIn, checkOut) VALUES ('airbnb', ?, ?, ?)
         ON CONFLICT(source, uid) DO UPDATE SET checkIn = excluded.checkIn, checkOut = excluded.checkOut`,
        [event.uid, checkIn, checkOut],
        (err) => {
          if (err)
            console.error("Error guardando bloqueo de Airbnb:", err.message);
        },
      );
    }

    // Quita bloqueos de reservas de Airbnb que ya no están en el feed (canceladas)
    const currentUids = parsedEvents.map((e) => e.uid);
    if (currentUids.length > 0) {
      const placeholders = currentUids.map(() => "?").join(",");
      db.run(
        `DELETE FROM external_blocks WHERE source = 'airbnb' AND uid NOT IN (${placeholders})`,
        currentUids,
        (err) => {
          if (err)
            console.error("Error limpiando bloqueos de Airbnb:", err.message);
        },
      );
    } else {
      db.run(`DELETE FROM external_blocks WHERE source = 'airbnb'`);
    }

    console.log(
      `📅 Airbnb sync: ${parsedEvents.length} fecha(s) bloqueada(s) importada(s).`,
    );
    broadcastAdminUpdate();
  } catch (err) {
    console.error("Error sincronizando calendario de Airbnb:", err.message);
  }
}

// ============ SERVER ============
const server = http.createServer(app);

// WebSocket para notificar al panel admin en tiempo real (nuevas reservas, cancelaciones, sync)
const wss = new WebSocket.Server({ server });

function broadcastAdminUpdate() {
  const payload = JSON.stringify({ type: "bookings_updated" });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function startServer() {
  server.listen(PORT, () => {
    const listeningPort = server.address().port;
    console.log(`\n${"=".repeat(50)}`);
    console.log(`🚀 Server running on port ${listeningPort}`);
    console.log(`📍 Environment: ${NODE_ENV}`);
    console.log(`🌐 Domain: ${DOMAIN}`);
    console.log(`📅 Calendar URL: ${DOMAIN}/api/calendar.ics`);
    console.log(`${"=".repeat(50)}\n`);

    // Limpieza periódica de bloqueos temporales de pagos abandonados.
    // La primera ejecución espera un poco para que database.js termine de crear las tablas.
    setTimeout(cleanupExpiredHolds, 2000);
    setInterval(cleanupExpiredHolds, 5 * 60 * 1000);

    if (AIRBNB_ICAL_URL) {
      syncAirbnbCalendar();
      setInterval(syncAirbnbCalendar, 15 * 60 * 1000); // cada hora
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
