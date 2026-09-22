// server/database.js

const sqlite3 = require("sqlite3").verbose();
const {
  resolveDatabasePath,
  ensureDatabaseDirectory,
} = require("./database-path");

const dbPath = ensureDatabaseDirectory(resolveDatabasePath());
const defaultMecklenburgSales =
  parseFloat(process.env.TAX_MECKLENBURG_SALES) || 8.25;
const defaultMecklenburgOccupancy =
  parseFloat(process.env.TAX_MECKLENBURG_OCCUPANCY) || 8.0;

let openError = null;
let bootstrapError = null;
let settleReady;

// Consumers may queue work immediately, but the HTTP server waits for this
// promise before listening. All bootstrap statements are queued synchronously in
// serialized order and the final probe settles readiness only after they finish.
const databaseOpenMode =
  process.env.NODE_ENV === "test" &&
  process.env.SQLITE_OPEN_READONLY_TEST_ONLY === "true"
    ? sqlite3.OPEN_READONLY
    : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
const db = new sqlite3.Database(dbPath, databaseOpenMode, (err) => {
  if (err) {
    openError = err;
    console.error("Error al abrir la base de datos", err.message);
    if (settleReady) settleReady.reject(err);
  } else {
    console.log(`Conectado a la base de datos SQLite: ${dbPath}`);
  }
});

db.serialize();

db.ready = new Promise((resolve, reject) => {
  settleReady = { resolve, reject };
});

function recordBootstrapError(context, err) {
  if (!err || bootstrapError) return;
  bootstrapError = new Error(`${context}: ${err.message}`);
  bootstrapError.cause = err;
  console.error(bootstrapError.message);
}

function requiredStep(context) {
  return (err) => recordBootstrapError(context, err);
}

function compatibilityColumn(table, column) {
  return (err) => {
    if (!err) return;
    const duplicatePattern = new RegExp(
      `^SQLITE_ERROR: duplicate column name: ${column}$`,
      "i",
    );
    if (!duplicatePattern.test(err.message)) {
      recordBootstrapError(`Error al migrar ${table}.${column}`, err);
    }
  };
}

// Current bookings schema for a brand-new database. The ALTER statements below
// remain as compatibility migrations for databases created by older versions.
db.run(
  `CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkIn TEXT NOT NULL,
    checkOut TEXT NOT NULL,
    bookingStatus TEXT,
    stripePaymentId TEXT,
    rental_type TEXT DEFAULT 'short_stay',
    guests INTEGER DEFAULT 2
)`,
  requiredStep("Error al crear la tabla bookings"),
);

// Evita reservas duplicadas si el webhook y el navegador confirman el mismo pago
db.run(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_stripe_payment_id
   ON bookings(stripePaymentId) WHERE stripePaymentId IS NOT NULL`,
  requiredStep("Error al crear el índice único"),
);

// Fechas bloqueadas importadas desde calendarios externos (ej. Airbnb)
db.run(
  `CREATE TABLE IF NOT EXISTS external_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    uid TEXT NOT NULL,
    checkIn TEXT NOT NULL,
    checkOut TEXT NOT NULL,
    UNIQUE(source, uid)
)`,
  requiredStep("Error al crear la tabla external_blocks"),
);

// Current tax schema for a brand-new database. Compatibility ALTER migrations
// below preserve existing databases created before these columns existed.
db.run(
  `CREATE TABLE IF NOT EXISTS tax_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nc_state REAL NOT NULL,
    mecklenburg_local REAL NOT NULL,
    occupancy REAL NOT NULL,
    updated_at TEXT NOT NULL,
    mecklenburg_sales REAL DEFAULT 8.25,
    mecklenburg_occupancy REAL DEFAULT 8.00,
    monthly_rate REAL DEFAULT 1800,
    nightly_rate REAL DEFAULT 150
)`,
  requiredStep("Error al crear la tabla tax_settings"),
);

// Migración: agregar columnas de impuestos Mecklenburg actualizados
// Ventas: 8.25%, Ocupación: 8.00%
db.run(
  `ALTER TABLE tax_settings ADD COLUMN mecklenburg_sales REAL DEFAULT 8.25`,
  compatibilityColumn("tax_settings", "mecklenburg_sales"),
);
db.run(
  `ALTER TABLE tax_settings ADD COLUMN mecklenburg_occupancy REAL DEFAULT 8.00`,
  compatibilityColumn("tax_settings", "mecklenburg_occupancy"),
);

// Migración: agregar columna de tipo de reserva (short_stay / monthly)
db.run(
  `ALTER TABLE bookings ADD COLUMN rental_type TEXT DEFAULT 'short_stay'`,
  compatibilityColumn("bookings", "rental_type"),
);

// Migración: agregar columna de tarifa mensual en tax_settings
db.run(
  `ALTER TABLE tax_settings ADD COLUMN monthly_rate REAL DEFAULT 1800`,
  compatibilityColumn("tax_settings", "monthly_rate"),
);

// Migración: agregar columna de tarifa por noche en tax_settings
db.run(
  `ALTER TABLE tax_settings ADD COLUMN nightly_rate REAL DEFAULT 150`,
  compatibilityColumn("tax_settings", "nightly_rate"),
);

// Migración: número de huéspedes por reserva
db.run(
  `ALTER TABLE bookings ADD COLUMN guests INTEGER DEFAULT 2`,
  compatibilityColumn("bookings", "guests"),
);

// A fresh or otherwise empty database needs one settings row because the admin
// monthly-rate endpoint updates the latest row. SQLite considers an UPDATE that
// matches zero rows successful, so without this seed the first save could report
// success without persisting anything. Existing settings rows are never changed.
// Keep the seeded tax values aligned with the same environment-backed defaults
// used by the runtime pricing fallback rather than hard-coding a conflicting row.
db.run(
  `INSERT INTO tax_settings (
    nc_state,
    mecklenburg_local,
    occupancy,
    updated_at,
    mecklenburg_sales,
    mecklenburg_occupancy,
    monthly_rate,
    nightly_rate
  )
  SELECT 0, 0, 0, datetime('now'), ?, ?, 1800, 150
  WHERE NOT EXISTS (SELECT 1 FROM tax_settings)`,
  [defaultMecklenburgSales, defaultMecklenburgOccupancy],
  requiredStep("Error al inicializar tax_settings"),
);

// Bloqueos temporales de fechas mientras el pago está en curso.
// Evitan reservas dobles simultáneas: si el pago se completa, el webhook
// convierte el bloqueo en reserva; si expira o falla, se libera.
db.run(
  `CREATE TABLE IF NOT EXISTS booking_holds (
    id TEXT PRIMARY KEY,
    checkIn TEXT NOT NULL,
    checkOut TEXT NOT NULL,
    rental_type TEXT DEFAULT 'short_stay',
    stripe_session_id TEXT,
    status TEXT DEFAULT 'active',
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
)`,
  requiredStep("Error al crear la tabla booking_holds"),
);

// Cobros manuales (facturas enviadas a clientes)
db.run(
  `CREATE TABLE IF NOT EXISTS manual_charges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_name TEXT NOT NULL,
    guest_email TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    stripe_session_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    paid_at TEXT
)`,
  requiredStep("Error al crear la tabla manual_charges"),
);

// This probe is last in the serialized queue. Readiness is successful only when
// opening the file and every required schema/index/seed operation succeeded.
db.get("SELECT 1 AS ready", (probeError) => {
  const failure = openError || bootstrapError || probeError;
  if (failure) {
    settleReady.reject(failure);
  } else {
    settleReady.resolve();
  }
});

// Expose the resolved path for diagnostics/tests without changing DB semantics.
db.databasePath = dbPath;

module.exports = db;
