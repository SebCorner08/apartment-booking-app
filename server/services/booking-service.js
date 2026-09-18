const crypto = require("crypto");

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

  function confirmHold(holdId, sessionId) {
    if (!holdId) return;
    db.run(
      `UPDATE booking_holds SET status = 'confirmed', stripe_session_id = COALESCE(?, stripe_session_id) WHERE id = ?`,
      [sessionId || null, holdId],
    );
  }

  let holdQueue = Promise.resolve();
  function createHold({ checkIn, checkOut, rentalType }) {
    const run = () =>
      new Promise((resolve, reject) => {
        const holdId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + holdMinutes * 60 * 1000)
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
                (row) => checkIn < row.checkOut && checkOut > row.checkIn,
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

  return {
    nightsBetween,
    isDateString,
    checkAvailability,
    cleanupExpiredHolds,
    releaseHold,
    releaseHoldBySession,
    confirmHold,
    createHold,
  };
}

module.exports = { createBookingService };
