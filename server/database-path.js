const fs = require("fs");
const path = require("path");

const DEFAULT_DB_PATH = path.resolve(__dirname, "reservations.db");

function firstConfiguredPath(env) {
  for (const key of ["RESERVATIONS_DB_PATH", "DATABASE_PATH"]) {
    const value = env && env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function resolveDatabasePath(env = process.env) {
  if (
    env &&
    env.NODE_ENV === "production" &&
    !(typeof env.RESERVATIONS_DB_PATH === "string" && env.RESERVATIONS_DB_PATH.trim())
  ) {
    throw new Error(
      "RESERVATIONS_DB_PATH is required in production and must point to persistent storage",
    );
  }

  const configured = firstConfiguredPath(env);
  return configured ? path.resolve(configured) : DEFAULT_DB_PATH;
}

function ensureDatabaseDirectory(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  return databasePath;
}

module.exports = {
  DEFAULT_DB_PATH,
  resolveDatabasePath,
  ensureDatabaseDirectory,
};
