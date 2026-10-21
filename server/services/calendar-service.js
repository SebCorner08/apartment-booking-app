const ical = require("node-ical");
const sqlite3 = require("sqlite3");
const { run } = require("../db-promises");

const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const CALENDAR_UNAVAILABLE = "Availability could not be verified. Please try again shortly.";

function calendarError() {
  const error = new Error(CALENDAR_UNAVAILABLE);
  error.code = "CALENDAR_UNAVAILABLE";
  return error;
}

function openCalendarDatabase(db) {
  // Never put an async transaction on the application connection: unrelated
  // holds/webhooks could otherwise enter, commit or roll back that transaction.
  const filename = db.databasePath || db.filename;
  if (!filename || filename === ":memory:") throw calendarError();
  return new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE, (err) => {
      if (err) return reject(err);
      connection.configure("busyTimeout", 5000);
      resolve(connection);
    });
  });
}

function parseCalendar(text) {
  // node-ical accepts HTML/truncated feeds and fills missing dates. Validate the
  // envelope and required event fields before allowing any destructive cleanup.
  const lines = text.replace(/^\uFEFF/, "").replace(/\r?\n[ \t]/g, "").trim().split(/\r?\n/);
  if (lines[0] !== "BEGIN:VCALENDAR" || lines.at(-1) !== "END:VCALENDAR") {
    throw calendarError();
  }
  const stack = [];
  const rawEvents = [];
  let event = null;
  let calendars = 0;
  let version = null;
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 1) throw calendarError();
    const name = line.slice(0, colon).split(";")[0];
    const value = line.slice(colon + 1);
    if (name === "BEGIN") {
      if (value === "VCALENDAR" && (++calendars !== 1 || stack.length)) throw calendarError();
      if (value === "VEVENT") {
        if (stack.at(-1) !== "VCALENDAR") throw calendarError();
        event = {};
        rawEvents.push(event);
      }
      stack.push(value);
    } else if (name === "END") {
      if (stack.pop() !== value) throw calendarError();
      if (value === "VEVENT") event = null;
    } else if (name === "VERSION" && stack.at(-1) === "VCALENDAR") {
      if (version !== null) throw calendarError();
      version = value;
    } else if (event && stack.at(-1) === "VEVENT") {
      if (["UID", "DTSTART", "DTEND", "STATUS"].includes(name)) {
        if (event[name] !== undefined) throw calendarError();
        event[name] = value;
      }
      // Airbnb exports concrete date blocks. Do not silently under-block a
      // recurrence format this importer does not expand.
      if (["RRULE", "RDATE", "RECURRENCE-ID"].includes(name)) throw calendarError();
    }
  }
  if (stack.length || version !== "2.0") throw calendarError();
  for (const item of rawEvents) {
    if (!item.UID) throw calendarError();
    if (item.STATUS === "CANCELLED") continue;
    for (const name of ["DTSTART", "DTEND"]) {
      const value = item[name];
      if (!value || !/^\d{8}(T\d{6}Z?)?$/.test(value)) throw calendarError();
      const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
      const parsed = new Date(`${date}T00:00:00Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw calendarError();
    }
  }
  const events = Object.values(ical.sync.parseICS(text)).filter((item) => item.type === "VEVENT");
  if (events.length !== rawEvents.length) throw calendarError();
  return events.filter((item) => item.status !== "CANCELLED").map((item) => {
    const dateString = (date) => {
      if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw calendarError();
      // All-day dates are local-midnight Date objects in node-ical. UTC
      // conversion can move them to the previous day east of Greenwich.
      return date.dateOnly
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
        : date.toISOString().slice(0, 10);
    };
    const checkIn = dateString(item.start);
    const checkOut = dateString(item.end);
    if (typeof item.uid !== "string" || !item.uid || checkOut <= checkIn) throw calendarError();
    return { uid: item.uid, checkIn, checkOut };
  });
}

function createCalendarService({
  db,
  airbnbIcalUrl,
  broadcastAdminUpdate,
  fetchCalendar = globalThis.fetch,
  openDatabase = () => openCalendarDatabase(db),
  fetchTimeoutMs = 10000,
  now = Date.now,
  logger = console,
}) {
  let inFlight = null;
  let lastSuccessfulSync = null;
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

  async function importCalendar() {
    const controller = new AbortController();
    let timer;
    let text;
    try {
      text = await Promise.race([
        (async () => {
          const response = await fetchCalendar(airbnbIcalUrl, {
            signal: controller.signal,
            cache: "no-store",
          });
          if (!response.ok) throw calendarError();
          return response.text();
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(calendarError());
          }, fetchTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const events = parseCalendar(text);
    await db.ready;
    const connection = await openDatabase();
    let transaction = false;
    try {
      await run(connection, "BEGIN IMMEDIATE TRANSACTION");
      transaction = true;
      // A temp table avoids SQLite's variable limit for larger feeds and leaves
      // every other source, booking and hold untouched.
      await run(connection, "CREATE TEMP TABLE imported_uids (uid TEXT PRIMARY KEY)");
      for (const event of events) {
        await run(connection,
          `INSERT INTO external_blocks (source, uid, checkIn, checkOut) VALUES ('airbnb', ?, ?, ?)
           ON CONFLICT(source, uid) DO UPDATE SET checkIn = excluded.checkIn, checkOut = excluded.checkOut`,
          [event.uid, event.checkIn, event.checkOut]);
        await run(connection, "INSERT INTO imported_uids (uid) VALUES (?)", [event.uid]);
      }
      await run(connection,
        `DELETE FROM external_blocks WHERE source = 'airbnb'
         AND uid NOT IN (SELECT uid FROM imported_uids)`);
      await run(connection, "COMMIT");
      transaction = false;
    } catch (error) {
      if (transaction) await run(connection, "ROLLBACK");
      throw error;
    } finally {
      await new Promise((resolve, reject) => connection.close((err) => err ? reject(err) : resolve()));
    }
    lastSuccessfulSync = now();
    logger.log(`Airbnb sync: ${events.length} blocked date range(s) committed.`);
    try {
      broadcastAdminUpdate();
    } catch {
      logger.error("Airbnb calendar committed; admin notification failed.");
    }
  }

  function syncAirbnbCalendar() {
    if (!airbnbIcalUrl) return Promise.resolve();
    // Startup, scheduled, availability and checkout requests share one import.
    if (!inFlight) {
      inFlight = importCalendar().catch(() => {
        // Feed URLs contain private tokens; never expose upstream errors/URLs.
        logger.error("Airbnb calendar synchronization failed; availability could not be verified.");
        throw calendarError();
      }).finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  function ensureFreshAirbnbCalendar() {
    if (!airbnbIcalUrl) return Promise.resolve();
    if (inFlight) return inFlight;
    if (lastSuccessfulSync === null || now() - lastSuccessfulSync >= SYNC_INTERVAL_MS) {
      return syncAirbnbCalendar();
    }
    return Promise.resolve();
  }

  function startAutoSync() {
    if (!airbnbIcalUrl) return () => {};
    const refresh = () => { syncAirbnbCalendar().catch(() => {}); };
    refresh();
    const interval = setInterval(refresh, SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }

  return { registerCalendarRoute, syncAirbnbCalendar, ensureFreshAirbnbCalendar, startAutoSync };
}

module.exports = { createCalendarService, SYNC_INTERVAL_MS, CALENDAR_UNAVAILABLE };
