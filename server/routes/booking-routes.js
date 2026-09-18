function registerBookingRoutes(app, { db }) {
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
      res.json(rows.map((row) => ({ from: row.checkIn, to: row.checkOut })));
    });
  });
}

module.exports = { registerBookingRoutes };
