const { CALENDAR_UNAVAILABLE } = require("../services/calendar-service");

function registerBookingRoutes(app, { db, ensureFreshAirbnbCalendar }) {
  app.get("/api/bookings", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await ensureFreshAirbnbCalendar();
    } catch {
      return res.status(503).json({ error: CALENDAR_UNAVAILABLE, code: "CALENDAR_UNAVAILABLE" });
    }
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
      res.json(rows.map((row) => ({ from: row.checkIn, to: row.checkOut })));
    });
  });
}

module.exports = { registerBookingRoutes };
