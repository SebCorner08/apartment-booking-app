const ical = require("node-ical");

function createCalendarService({ db, airbnbIcalUrl, broadcastAdminUpdate }) {
  function registerCalendarRoute(app) {
    app.get("/api/calendar.ics", (req, res) => {
      const sql =
        "SELECT id, checkIn, checkOut FROM bookings WHERE bookingStatus = 'confirmed' ORDER BY checkIn";

      db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

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
            const formatDate = (date) =>
              date.toISOString().split("T")[0].replace(/-/g, "");

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

        icsContent += "END:VCALENDAR";
        res.set("Content-Type", "text/calendar; charset=utf-8");
        res.set("Content-Disposition", "attachment; filename=calendar.ics");
        res.send(icsContent);
      });
    });
  }

  async function syncAirbnbCalendar() {
    if (!airbnbIcalUrl) return;

    try {
      const events = await ical.async.fromURL(airbnbIcalUrl);
      const parsedEvents = Object.values(events).filter(
        (event) => event.type === "VEVENT" && event.start && event.end && event.uid,
      );

      for (const event of parsedEvents) {
        const checkIn = event.start.toISOString().split("T")[0];
        const checkOut = event.end.toISOString().split("T")[0];
        db.run(
          `INSERT INTO external_blocks (source, uid, checkIn, checkOut) VALUES ('airbnb', ?, ?, ?)
           ON CONFLICT(source, uid) DO UPDATE SET checkIn = excluded.checkIn, checkOut = excluded.checkOut`,
          [event.uid, checkIn, checkOut],
          (err) => {
            if (err) console.error("Error guardando bloqueo de Airbnb:", err.message);
          },
        );
      }

      const currentUids = parsedEvents.map((event) => event.uid);
      if (currentUids.length > 0) {
        const placeholders = currentUids.map(() => "?").join(",");
        db.run(
          `DELETE FROM external_blocks WHERE source = 'airbnb' AND uid NOT IN (${placeholders})`,
          currentUids,
          (err) => {
            if (err) console.error("Error limpiando bloqueos de Airbnb:", err.message);
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

  return { registerCalendarRoute, syncAirbnbCalendar };
}

module.exports = { createCalendarService };
