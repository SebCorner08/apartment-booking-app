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

  // Serialize hold-related writes so their order stays deterministic. Hold
  // creation is a single atomic statement; no transaction is left open here.
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
    // The overlap check and the insert are ONE SQLite statement, so they are
    // atomic without opening a transaction on the shared connection. A
    // BEGIN/ROLLBACK here could interleave with a Stripe webhook write on the
    // same connection and roll back an already-acknowledged paid booking.
    return queueHoldWrite(async () => {
      const holdId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + holdMinutes * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
      const result = await runWithBusyRetry(
        db,
        `INSERT INTO booking_holds (id, checkIn, checkOut, rental_type, expires_at)
         SELECT ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM bookings
           WHERE bookingStatus = 'confirmed' AND ? < checkOut AND ? > checkIn
         ) AND NOT EXISTS (
           SELECT 1 FROM external_blocks WHERE ? < checkOut AND ? > checkIn
         ) AND NOT EXISTS (
           SELECT 1 FROM booking_holds
           WHERE status = 'active' AND expires_at > datetime('now')
             AND ? < checkOut AND ? > checkIn
         )`,
        [
          holdId, checkIn, checkOut, rentalType, expiresAt,
          checkIn, checkOut, checkIn, checkOut, checkIn, checkOut,
        ],
      );
      return result.changes === 1 ? holdId : null;
    });
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
