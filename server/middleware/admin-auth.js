const jwt = require("jsonwebtoken");

function createAdminAuth({
  jwtSecret,
  nodeEnv,
  allowedOrigins,
  adminCookieName,
  adminSessionMinutes,
}) {
  function isAllowedOrigin(origin) {
    if (!origin) return nodeEnv !== "production";
    if (allowedOrigins.includes(origin)) return true;
    return (
      nodeEnv !== "production" &&
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    );
  }

  function readCookie(req, name) {
    const cookieHeader = req.headers.cookie || "";
    for (const pair of cookieHeader.split(";")) {
      const separator = pair.indexOf("=");
      if (separator === -1) continue;
      const key = pair.slice(0, separator).trim();
      if (key === name) {
        try {
          return decodeURIComponent(pair.slice(separator + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  function adminCookieOptions() {
    return {
      httpOnly: true,
      secure: nodeEnv === "production",
      sameSite: nodeEnv === "production" ? "none" : "lax",
      maxAge: adminSessionMinutes * 60 * 1000,
      path: "/",
    };
  }

  function checkAdminAuth(req, res, next) {
    const origin = req.headers.origin;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !isAllowedOrigin(origin)
    ) {
      return res.sendStatus(403);
    }

    const token = readCookie(req, adminCookieName);
    if (!token) return res.sendStatus(401);

    jwt.verify(token, jwtSecret, (err, user) => {
      if (err) return res.sendStatus(403);
      req.user = user;
      next();
    });
  }

  return { isAllowedOrigin, adminCookieOptions, checkAdminAuth };
}

module.exports = { createAdminAuth };
