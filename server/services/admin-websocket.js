const crypto = require("crypto");
const WebSocket = require("ws");

function createAdminWebSocketService({
  isAllowedOrigin,
  path,
  protocol,
  ticketPrefix,
  ticketTtlMs,
}) {
  const tickets = new Map();
  const wss = new WebSocket.Server({
    noServer: true,
    handleProtocols(protocols) {
      return protocols.has(protocol) ? protocol : false;
    },
  });

  function purgeExpiredTickets(now = Date.now()) {
    for (const [ticket, record] of tickets) {
      if (record.expiresAt <= now || record.sessionExpiresAt <= now) {
        tickets.delete(ticket);
      }
    }
  }

  function issueTicket(origin, user) {
    const now = Date.now();
    purgeExpiredTickets(now);
    const sessionExpiresAt = Number(user && user.exp) * 1000;
    if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= now) {
      return null;
    }
    const ticket = crypto.randomBytes(32).toString("base64url");
    tickets.set(ticket, {
      origin: origin || null,
      expiresAt: now + ticketTtlMs,
      sessionExpiresAt,
    });
    return ticket;
  }

  function consumeTicket(ticket, origin) {
    const now = Date.now();
    purgeExpiredTickets(now);
    const record = tickets.get(ticket);
    if (!record || record.origin !== (origin || null)) return null;
    tickets.delete(ticket);
    return record;
  }

  function parseProtocols(request) {
    return String(request.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  function rejectUpgrade(socket, statusCode, statusText) {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }

  function attachToServer(server) {
    server.on("upgrade", (request, socket, head) => {
      let requestUrl;
      try {
        requestUrl = new URL(
          request.url,
          `http://${request.headers.host || "localhost"}`,
        );
      } catch {
        return rejectUpgrade(socket, 400, "Bad Request");
      }

      if (requestUrl.pathname !== path) {
        return rejectUpgrade(socket, 404, "Not Found");
      }

      const origin = request.headers.origin;
      if (!isAllowedOrigin(origin)) {
        return rejectUpgrade(socket, 403, "Forbidden");
      }

      const protocols = parseProtocols(request);
      const ticketProtocol = protocols.find((value) =>
        value.startsWith(ticketPrefix),
      );
      if (!protocols.includes(protocol) || !ticketProtocol) {
        return rejectUpgrade(socket, 401, "Unauthorized");
      }

      const ticket = ticketProtocol.slice(ticketPrefix.length);
      const record = consumeTicket(ticket, origin);
      if (!record) return rejectUpgrade(socket, 401, "Unauthorized");

      wss.handleUpgrade(request, socket, head, (client) => {
        client.isAdminAuthenticated = true;
        client.adminSessionExpiresAt = record.sessionExpiresAt;
        const sessionTimer = setTimeout(
          () => client.close(4001, "Admin session expired"),
          Math.max(0, record.sessionExpiresAt - Date.now()),
        );
        client.once("close", () => clearTimeout(sessionTimer));
        wss.emit("connection", client, request);
      });
    });
  }

  function broadcastAdminUpdate() {
    const payload = JSON.stringify({ type: "bookings_updated" });
    wss.clients.forEach((client) => {
      if (
        client.isAdminAuthenticated &&
        client.adminSessionExpiresAt > Date.now() &&
        client.readyState === WebSocket.OPEN
      ) {
        client.send(payload);
      }
    });
  }

  return { issueTicket, attachToServer, broadcastAdminUpdate };
}

module.exports = { createAdminWebSocketService };
