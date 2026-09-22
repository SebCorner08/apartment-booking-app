const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn, spawnSync } = require("child_process");
const {
  DEFAULT_DB_PATH,
  resolveDatabasePath,
  ensureDatabaseDirectory,
} = require("./server/database-path");

function runNode(script, env) {
  return execFileSync(process.execPath, ["-e", script], {
    cwd: __dirname,
    env,
    encoding: "utf8",
  }).trim();
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "booking-db-path-"));
const configuredPath = path.join(tempRoot, "nested", "reservations.db");
const legacyPath = path.join(tempRoot, "legacy", "reservations.db");
const bootstrapPath = path.join(tempRoot, "bootstrap", "reservations.db");
const populatedLegacyPath = path.join(
  tempRoot,
  "populated-legacy",
  "reservations.db",
);

try {
  assert.strictEqual(
    resolveDatabasePath({}),
    DEFAULT_DB_PATH,
    "local fallback must remain server/reservations.db",
  );

  assert.throws(
    () => resolveDatabasePath({ NODE_ENV: "production" }),
    /RESERVATIONS_DB_PATH is required in production/,
    "production must fail fast without an explicit persistent database path",
  );

  assert.strictEqual(
    resolveDatabasePath({
      NODE_ENV: "production",
      RESERVATIONS_DB_PATH: configuredPath,
    }),
    path.resolve(configuredPath),
    "production must honor an explicit persistent database path",
  );

  assert.strictEqual(
    resolveDatabasePath({ RESERVATIONS_DB_PATH: configuredPath }),
    path.resolve(configuredPath),
    "RESERVATIONS_DB_PATH must control the SQLite location",
  );

  assert.strictEqual(
    resolveDatabasePath({ DATABASE_PATH: legacyPath }),
    path.resolve(legacyPath),
    "DATABASE_PATH remains a compatibility alias",
  );

  ensureDatabaseDirectory(configuredPath);
  assert.ok(
    fs.existsSync(path.dirname(configuredPath)),
    "configured database directory must be created",
  );

  const env = {
    ...process.env,
    RESERVATIONS_DB_PATH: configuredPath,
  };
  delete env.DATABASE_PATH;

  const resolver = JSON.stringify(
    path.join(__dirname, "server", "database-path.js"),
  );

  runNode(
    `
      const sqlite3 = require("sqlite3").verbose();
      const { resolveDatabasePath, ensureDatabaseDirectory } = require(${resolver});
      const dbPath = ensureDatabaseDirectory(resolveDatabasePath());
      const db = new sqlite3.Database(dbPath);
      db.serialize(() => {
        db.run("CREATE TABLE IF NOT EXISTS persistence_probe (value TEXT NOT NULL)");
        db.run("DELETE FROM persistence_probe");
        db.run("INSERT INTO persistence_probe(value) VALUES (?)", ["survives-restart"]);
      });
      db.close((err) => {
        if (err) { console.error(err); process.exit(1); }
      });
    `,
    env,
  );

  const persistedValue = runNode(
    `
      const sqlite3 = require("sqlite3").verbose();
      const { resolveDatabasePath } = require(${resolver});
      const db = new sqlite3.Database(resolveDatabasePath(), sqlite3.OPEN_READONLY);
      db.get("SELECT value FROM persistence_probe LIMIT 1", (err, row) => {
        if (err) { console.error(err); process.exit(1); }
        process.stdout.write(row ? row.value : "");
        db.close();
      });
    `,
    env,
  );

  assert.strictEqual(
    persistedValue,
    "survives-restart",
    "configured SQLite file must retain data across separate Node processes",
  );

  const bootstrapEnv = {
    ...process.env,
    RESERVATIONS_DB_PATH: bootstrapPath,
    TAX_MECKLENBURG_SALES: "7.125",
    TAX_MECKLENBURG_OCCUPANCY: "3.5",
  };
  delete bootstrapEnv.DATABASE_PATH;

  const databaseModule = JSON.stringify(
    path.join(__dirname, "server", "database.js"),
  );

  const fallbackBeforeProductionFailure = fs.existsSync(DEFAULT_DB_PATH)
    ? {
        size: fs.statSync(DEFAULT_DB_PATH).size,
        mtimeMs: fs.statSync(DEFAULT_DB_PATH).mtimeMs,
      }
    : null;
  const missingProductionPath = spawnSync(
    process.execPath,
    ["-e", `require(${databaseModule})`],
    {
      cwd: __dirname,
      env: {
        ...process.env,
        NODE_ENV: "production",
        RESERVATIONS_DB_PATH: "",
        DATABASE_PATH: "",
      },
      encoding: "utf8",
    },
  );
  const fallbackAfterProductionFailure = fs.existsSync(DEFAULT_DB_PATH)
    ? {
        size: fs.statSync(DEFAULT_DB_PATH).size,
        mtimeMs: fs.statSync(DEFAULT_DB_PATH).mtimeMs,
      }
    : null;
  assert.notStrictEqual(
    missingProductionPath.status,
    0,
    "database bootstrap must refuse production without RESERVATIONS_DB_PATH",
  );
  assert.match(
    `${missingProductionPath.stdout}${missingProductionPath.stderr}`,
    /RESERVATIONS_DB_PATH is required in production/,
    "production failure must explain the required persistent path",
  );
  assert.strictEqual(
    JSON.stringify(fallbackAfterProductionFailure),
    JSON.stringify(fallbackBeforeProductionFailure),
    "failed production startup must leave the local fallback database unchanged",
  );

  const invalidOpenPath = path.join(tempRoot, "database-is-a-directory");
  fs.mkdirSync(invalidOpenPath);
  const invalidOpen = spawnSync(
    process.execPath,
    [
      "-e",
      `require(${databaseModule}).ready.catch((err) => { console.error(err.message); process.exit(1); })`,
    ],
    {
      cwd: __dirname,
      env: {
        ...process.env,
        NODE_ENV: "production",
        RESERVATIONS_DB_PATH: invalidOpenPath,
      },
      encoding: "utf8",
    },
  );
  assert.notStrictEqual(
    invalidOpen.status,
    0,
    "an invalid database path must fail bootstrap",
  );
  assert.match(
    `${invalidOpen.stdout}${invalidOpen.stderr}`,
    /SQLITE_CANTOPEN|unable to open database file/,
  );
  const invalidServer = spawnSync(process.execPath, ["server/index.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: "0",
      ADMIN_PASSWORD: "isolated-invalid-db-test-only",
      JWT_SECRET: "isolated-invalid-db-secret-only",
      RESERVATIONS_DB_PATH: invalidOpenPath,
    },
    encoding: "utf8",
    timeout: 5000,
  });
  const invalidServerOutput = `${invalidServer.stdout}${invalidServer.stderr}`;
  assert.notStrictEqual(
    invalidServer.status,
    0,
    "server startup must fail when SQLite cannot open",
  );
  assert.doesNotMatch(
    invalidServerOutput,
    /Server running on port/,
    "server must not listen or expose healthy readiness after database failure",
  );
  assert.match(
    invalidServerOutput,
    /Database bootstrap failed|SQLITE_CANTOPEN/,
  );

  const incompatiblePath = path.join(
    tempRoot,
    "incompatible",
    "reservations.db",
  );
  fs.mkdirSync(path.dirname(incompatiblePath), { recursive: true });
  const incompatibleEnv = {
    ...process.env,
    RESERVATIONS_DB_PATH: incompatiblePath,
  };
  runNode(
    `
      const sqlite3 = require("sqlite3").verbose();
      const db = new sqlite3.Database(process.env.RESERVATIONS_DB_PATH);
      db.run("CREATE VIEW bookings AS SELECT 1 AS id", (err) => {
        if (err) { console.error(err); process.exit(1); }
        db.close();
      });
    `,
    incompatibleEnv,
  );
  const incompatibleBootstrap = spawnSync(
    process.execPath,
    [
      "-e",
      `require(${databaseModule}).ready.catch((err) => { console.error(err.message); process.exit(1); })`,
    ],
    { cwd: __dirname, env: incompatibleEnv, encoding: "utf8" },
  );
  assert.notStrictEqual(
    incompatibleBootstrap.status,
    0,
    "unexpected schema errors must fail bootstrap",
  );
  assert.match(
    `${incompatibleBootstrap.stdout}${incompatibleBootstrap.stderr}`,
    /bookings|views may not be indexed|view .* already exists/i,
  );

  const readOnlyPath = path.join(tempRoot, "read-only", "reservations.db");
  fs.mkdirSync(path.dirname(readOnlyPath), { recursive: true });
  const readOnlyEnv = { ...process.env, RESERVATIONS_DB_PATH: readOnlyPath };
  runNode(
    `
      const db = require(${databaseModule});
      db.ready.then(() => {
        db.run("ALTER TABLE bookings DROP COLUMN guests", (err) => {
          if (err) { console.error(err); process.exit(1); }
          db.close();
        });
      });
    `,
    readOnlyEnv,
  );
  const readOnlyOptions = {
    cwd: __dirname,
    env: {
      ...readOnlyEnv,
      NODE_ENV: "test",
      SQLITE_OPEN_READONLY_TEST_ONLY: "true",
    },
    encoding: "utf8",
  };
  const readOnlyBootstrap = spawnSync(
    process.execPath,
    [
      "-e",
      `require(${databaseModule}).ready.catch((err) => { console.error(err.message); process.exit(1); })`,
    ],
    readOnlyOptions,
  );
  assert.notStrictEqual(
    readOnlyBootstrap.status,
    0,
    "a read-only database must fail bootstrap",
  );
  assert.match(
    `${readOnlyBootstrap.stdout}${readOnlyBootstrap.stderr}`,
    /readonly|READONLY/i,
  );

  const lockedPath = path.join(tempRoot, "locked", "reservations.db");
  const lockReadyPath = path.join(tempRoot, "locked", "ready");
  fs.mkdirSync(path.dirname(lockedPath), { recursive: true });
  const lockHolder = spawn(
    process.execPath,
    [
      "-e",
      `
        const fs = require("fs");
        const sqlite3 = require("sqlite3").verbose();
        const db = new sqlite3.Database(process.env.RESERVATIONS_DB_PATH);
        db.run("BEGIN EXCLUSIVE", (err) => {
          if (err) { console.error(err); process.exit(1); }
          fs.writeFileSync(process.env.LOCK_READY_PATH, "ready");
        });
        const keepAlive = setInterval(() => {}, 1000);
        process.on("SIGTERM", () => {
          clearInterval(keepAlive);
          db.run("ROLLBACK", () => db.close(() => process.exit(0)));
        });
      `,
    ],
    {
      cwd: __dirname,
      env: {
        ...process.env,
        RESERVATIONS_DB_PATH: lockedPath,
        LOCK_READY_PATH: lockReadyPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const lockDeadline = Date.now() + 5000;
  while (!fs.existsSync(lockReadyPath) && Date.now() < lockDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.ok(
    fs.existsSync(lockReadyPath),
    "exclusive-lock fixture must become ready",
  );
  let lockedBootstrap;
  try {
    lockedBootstrap = spawnSync(
      process.execPath,
      [
        "-e",
        `const db=require(${databaseModule}); db.configure("busyTimeout", 50); db.ready.catch((err) => { console.error(err.message); process.exit(1); })`,
      ],
      {
        cwd: __dirname,
        env: { ...process.env, RESERVATIONS_DB_PATH: lockedPath },
        encoding: "utf8",
        timeout: 3000,
      },
    );
  } finally {
    lockHolder.kill("SIGTERM");
  }
  assert.notStrictEqual(
    lockedBootstrap.status,
    0,
    "an exclusively locked database must fail bootstrap",
  );
  assert.match(
    `${lockedBootstrap.stdout}${lockedBootstrap.stderr}`,
    /locked|SQLITE_BUSY/i,
  );

  runNode(
    `
      const db = require(${databaseModule});
      const requiredColumns = [
        "id",
        "checkIn",
        "checkOut",
        "bookingStatus",
        "stripePaymentId",
        "rental_type",
        "guests",
      ];

      db.all("PRAGMA table_info(bookings)", (err, rows) => {
        if (err) {
          console.error(err);
          process.exit(1);
        }

        const columns = new Set(rows.map((row) => row.name));
        for (const column of requiredColumns) {
          if (!columns.has(column)) {
            console.error("Missing bookings column: " + column);
            process.exit(1);
          }
        }

        db.get(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_bookings_stripe_payment_id'",
          (indexErr, indexRow) => {
            if (indexErr) {
              console.error(indexErr);
              process.exit(1);
            }
            if (!indexRow) {
              console.error("Missing idx_bookings_stripe_payment_id");
              process.exit(1);
            }

            db.get(
              "SELECT mecklenburg_sales, mecklenburg_occupancy FROM tax_settings ORDER BY updated_at DESC, id DESC LIMIT 1",
              (taxErr, taxRow) => {
                if (taxErr) {
                  console.error(taxErr);
                  process.exit(1);
                }
                if (
                  !taxRow ||
                  taxRow.mecklenburg_sales !== 7.125 ||
                  taxRow.mecklenburg_occupancy !== 3.5
                ) {
                  console.error("Fresh tax_settings seed ignored configured tax rates");
                  process.exit(1);
                }

                db.run(
                  "UPDATE tax_settings SET monthly_rate = ? WHERE id = (SELECT id FROM tax_settings ORDER BY updated_at DESC LIMIT 1)",
                  [1900],
                  function (rateErr) {
                    if (rateErr) {
                      console.error(rateErr);
                      process.exit(1);
                    }
                    if (this.changes !== 1) {
                      console.error("Fresh tax_settings row was not seeded");
                      process.exit(1);
                    }

                    db.get(
                      "SELECT monthly_rate FROM tax_settings ORDER BY updated_at DESC LIMIT 1",
                      (readRateErr, rateRow) => {
                        if (readRateErr) {
                          console.error(readRateErr);
                          process.exit(1);
                        }
                        if (!rateRow || rateRow.monthly_rate !== 1900) {
                          console.error("Monthly rate did not persist on a fresh database");
                          process.exit(1);
                        }

                        db.run(
                          "INSERT INTO bookings (checkIn, checkOut, bookingStatus, stripePaymentId, rental_type, guests) VALUES (?, ?, ?, ?, ?, ?)",
                          [
                            "2030-01-01",
                            "2030-01-02",
                            "confirmed",
                            "pi_bootstrap_test",
                            "short_stay",
                            2,
                          ],
                          (insertErr) => {
                            if (insertErr) {
                              console.error(insertErr);
                              process.exit(1);
                            }
                            db.close((closeErr) => {
                              if (closeErr) {
                                console.error(closeErr);
                                process.exit(1);
                              }
                            });
                          },
                        );
                      },
                    );
                  },
                );
              },
            );
          },
        );
      });
    `,
    bootstrapEnv,
  );

  const legacyEnv = {
    ...process.env,
    RESERVATIONS_DB_PATH: populatedLegacyPath,
    TAX_MECKLENBURG_SALES: "9.9",
    TAX_MECKLENBURG_OCCUPANCY: "8.8",
  };
  delete legacyEnv.DATABASE_PATH;

  fs.mkdirSync(path.dirname(populatedLegacyPath), { recursive: true });
  runNode(
    `
      const sqlite3 = require("sqlite3").verbose();
      const db = new sqlite3.Database(process.env.RESERVATIONS_DB_PATH);
      db.serialize(() => {
        db.run(\`CREATE TABLE bookings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          checkIn TEXT NOT NULL,
          checkOut TEXT NOT NULL,
          bookingStatus TEXT,
          stripePaymentId TEXT
        )\`);
        db.run(
          "INSERT INTO bookings (id, checkIn, checkOut, bookingStatus, stripePaymentId) VALUES (?, ?, ?, ?, ?)",
          [41, "2031-06-10", "2031-06-20", "confirmed", "pi_legacy_sentinel"]
        );
        db.run(\`CREATE TABLE tax_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nc_state REAL NOT NULL,
          mecklenburg_local REAL NOT NULL,
          occupancy REAL NOT NULL,
          updated_at TEXT NOT NULL
        )\`);
        db.run(
          "INSERT INTO tax_settings (id, nc_state, mecklenburg_local, occupancy, updated_at) VALUES (?, ?, ?, ?, ?)",
          [17, 4.75, 2.25, 6.5, "2024-01-02 03:04:05"]
        );
      });
      db.close((err) => {
        if (err) { console.error(err); process.exit(1); }
      });
    `,
    legacyEnv,
  );

  const verifyLegacyMigration = () =>
    runNode(
      `
        const db = require(${databaseModule});
        db.serialize(() => {
          db.all("SELECT * FROM bookings", (bookingErr, bookings) => {
            if (bookingErr) throw bookingErr;
            if (bookings.length !== 1) {
              throw new Error("Legacy booking row count changed during migration");
            }
            const booking = bookings[0];
            if (!booking || booking.checkIn !== "2031-06-10" ||
                booking.checkOut !== "2031-06-20" ||
                booking.bookingStatus !== "confirmed" ||
                booking.stripePaymentId !== "pi_legacy_sentinel") {
              throw new Error("Legacy booking values were not preserved");
            }
            if (booking.rental_type !== "short_stay" || booking.guests !== 2) {
              throw new Error("Legacy booking compatibility columns were not added");
            }
            db.all("SELECT * FROM tax_settings", (taxErr, rows) => {
              if (taxErr) throw taxErr;
              if (rows.length !== 1) throw new Error("Legacy tax settings row was duplicated");
              const tax = rows[0];
              if (tax.id !== 17 || tax.nc_state !== 4.75 ||
                  tax.mecklenburg_local !== 2.25 || tax.occupancy !== 6.5 ||
                  tax.updated_at !== "2024-01-02 03:04:05") {
                throw new Error("Legacy tax settings values were not preserved");
              }
              if (tax.mecklenburg_sales !== 8.25 ||
                  tax.mecklenburg_occupancy !== 8 ||
                  tax.monthly_rate !== 1800 || tax.nightly_rate !== 150) {
                throw new Error("Legacy tax compatibility columns were not added");
              }
              db.get(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_bookings_stripe_payment_id'",
                (indexErr, indexRow) => {
                  if (indexErr) throw indexErr;
                  if (!indexRow) throw new Error("Legacy database unique index was not created");
                  db.close((closeErr) => {
                    if (closeErr) throw closeErr;
                  });
                },
              );
            });
          });
        });
      `,
      legacyEnv,
    );

  verifyLegacyMigration();
  verifyLegacyMigration();

  console.log("PASS: default DB path remains local");
  console.log("PASS: configured DB path is honored");
  console.log("PASS: configured DB directory is created");
  console.log(
    "PASS: data survives a process restart on the configured SQLite file",
  );
  console.log(
    "PASS: fresh database bootstrap creates the current bookings schema",
  );
  console.log("PASS: fresh database bootstrap honors configured tax rates");
  console.log("PASS: fresh database bootstrap seeds writable tax settings");
  console.log("PASS: production fails fast without RESERVATIONS_DB_PATH");
  console.log("PASS: invalid SQLite open path fails bootstrap");
  console.log("PASS: unexpected schema errors fail bootstrap");
  console.log("PASS: read-only SQLite database fails bootstrap");
  console.log("PASS: exclusively locked SQLite database fails bootstrap");
  console.log(
    "PASS: populated legacy data survives idempotent bootstrap migration",
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
