const crypto = require("crypto");
const { runWithBusyRetry } = require("../db-promises");

function createBookingService({ db, holdMinutes }) {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function nightsBetween(checkIn, checkOut) {
    if (!DATE_RE.test(checkIn || "") || !DATE_RE.test(checkOut || "")) {
      return null;
    }
    const start = new Date(`${checkIn}T00:00:00Z`);
    const end = new Date(`${checkOut}T00:00:00Z`);
    if (isNaN(start) || isNaN(end)) return null;
    const nights = Math.round((end - start) / 86400000);
    return nights > 0 ? nights : null;
  }

  function isDateString(value) {
    return DATE_RE.test(value || "");
  }

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
          (row) => checkIn < row.checkOut && checkOut > row.checkIn,
        );
        resolve(!hasOverlap);
      });
    });
  }

  function cleanupExpiredHolds() {
    db.run(
      `DELETE FROM booking_holds WHERE status = 'active' AND expires_at <= datetime('now')`,
      (err) => {
        if (err) console.error("Error limpiando bloqueos expirados:", err.message);
      },
    );
  }

  // Hold writes must share createHold's queue: a callback on this connection
  // alone does not prove durability if it ran inside another hold's transaction.
  let holdQueue = Promise.resolve();
  function queueHoldWrite(operation) {
    const result = holdQueue.then(operation, operation);
    holdQueue = result.catch(() => {});
    return result;
  }

  function linkHoldSession(holdId, sessionId) {
    return queueHoldWrite(async () => {
      if (!holdId || !sessionId) throw new Error("Missing hold or payment session");
      const result = await runWithBusyRetry(db,
        `UPDATE booking_holds SET stripe_session_id = ?
         WHERE id = ? AND (stripe_session_id IS NULL OR stripe_session_id = ?)
         AND ((status = 'active' AND expires_at > datetime('now'))
           OR (status = 'confirmed' AND stripe_session_id = ?))`,
        [sessionId, holdId, sessionId, sessionId]);
      if (result.changes !== 1) throw new Error("Payment hold is no longer active");
    });
  }

  function releaseHold(holdId) {
    if (!holdId) return Promise.resolve();
    return queueHoldWrite(() => runWithBusyRetry(db,
      `UPDATE booking_holds SET status = 'released' WHERE id = ? AND status = 'active'`,
      [holdId]));
  }

  function releaseHoldBySession(sessionId) {
    if (!sessionId) return Promise.resolve();
    return queueHoldWrite(() => runWithBusyRetry(db,
      `UPDATE booking_holds SET status = 'released' WHERE stripe_session_id = ? AND status = 'active'`,
      [sessionId]));
  }

  function recordConfirmedBooking({ checkIn, checkOut, sessionId, rentalType, guests }) {
    // The browser confirmation insert must not be committed/rolled back as part
    // of another customer's createHold transaction on this connection.
    return queueHoldWrite(() => runWithBusyRetry(db,
      `INSERT OR IGNORE INTO bookings
       (checkIn, checkOut, bookingStatus, stripePaymentId, rental_type, guests)
       VALUES (?, ?, 'confirmed', ?, ?, ?)`,
      [checkIn, checkOut, sessionId, rentalType, guests]));
  }

  function confirmHold(holdId, sessionId) {
    if (!holdId) return Promise.resolve();
    return queueHoldWrite(() => runWithBusyRetry(db,
      `UPDATE booking_holds SET status = 'confirmed', stripe_session_id = COALESCE(?, stripe_session_id) WHERE id = ?`,
      [sessionId || null, holdId]));
  }

  function createHold({ checkIn, checkOut, rentalType }) {
    const run = () =>
      new Promise((resolve, reject) => {
        const holdId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + holdMinutes * 60 * 1000)
          .toISOString()
          .slice(0, 19)
          .replace("T", " ");

        function rollback(error, result = null) {
          // Finish our transaction before the next queued hold can start.
          db.run("ROLLBACK", (rollbackErr) => {
            if (error || rollbackErr) return reject(error || rollbackErr);
            resolve(result);
          });
        }

        db.serialize(() => {
          db.run("BEGIN IMMEDIATE TRANSACTION", (beginErr) => {
            // An independent calendar import can hold SQLite's write lock longer
            // than busyTimeout. Never query/rollback a transaction we did not open.
            if (beginErr) return reject(beginErr);
            db.all(
              `SELECT checkIn, checkOut FROM bookings WHERE bookingStatus = 'confirmed'
               UNION ALL
               SELECT checkIn, checkOut FROM external_blocks
               UNION ALL
               SELECT checkIn, checkOut FROM booking_holds
               WHERE status = 'active' AND expires_at > datetime('now')`,
              [],
              (err, rows) => {
                if (err) return rollback(err);
                const hasOverlap = rows.some(
                  (row) => checkIn < row.checkOut && checkOut > row.checkIn,
                );
                if (hasOverlap) return rollback(null);
                db.run(
                  `INSERT INTO booking_holds (id, checkIn, checkOut, rental_type, expires_at) VALUES (?, ?, ?, ?, ?)`,
                  [holdId, checkIn, checkOut, rentalType, expiresAt],
                  (insertErr) => {
                    if (insertErr) return rollback(insertErr);
                    db.run("COMMIT", (commitErr) => {
                      if (commitErr) return rollback(commitErr);
                      resolve(holdId);
                    });
                  },
                );
              },
            );
          });
        });
      });

    return queueHoldWrite(run);
  }

  return {
    nightsBetween,
    isDateString,
    checkAvailability,
    cleanupExpiredHolds,
    linkHoldSession,
    releaseHold,
    releaseHoldBySession,
    confirmHold,
    recordConfirmedBooking,
    createHold,
  };
}

module.exports = { createBookingService };
