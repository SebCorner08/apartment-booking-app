// Promise helpers for sqlite3 callbacks.
// Introduced for issue #2 so payment webhooks can await durable persistence
// before acknowledging Stripe events.

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

// Retry only idempotent, single-statement writes. Each attempt still observes
// sqlite3's busy timeout (1 second on the application connection); two short
// backoffs bound the normal maximum wait to about 3.35 seconds. Never wrap a
// Stripe request or a multi-statement transaction in this helper.
async function runWithBusyRetry(db, sql, params = []) {
  const backoffs = [100, 250];
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(db, sql, params);
    } catch (error) {
      if (!["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error.code) || attempt === backoffs.length) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffs[attempt]));
    }
  }
}

module.exports = { run, get, runWithBusyRetry };
