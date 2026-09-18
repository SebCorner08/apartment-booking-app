# Admin session security

Admin authentication uses a signed JWT stored only in the `admin_session`
cookie. The login response never exposes the token to JavaScript and the
browser must send admin requests with `credentials: "include"`.

The session expires after 60 minutes. The cookie is `HttpOnly`, scoped to `/`
and uses `Secure; SameSite=None` in production because the Netlify frontend and
Render API are on different sites. Local development uses `SameSite=Lax`
without `Secure` so HTTP localhost continues to work.

`POST /api/admin/logout` removes the cookie. An expired or invalid session
returns 401/403 and the admin pages redirect to `login.html`. State-changing
admin requests with an `Origin` outside `ALLOWED_ORIGINS` are rejected to
protect the cross-site production cookie from CSRF.
Production also rejects state-changing admin requests without an `Origin`;
non-browser administrative clients are not supported by this cookie flow.

Admin WebSocket connections use a separate, single-purpose ticket because the
production socket connects directly to Render while the session cookie is
first-party on the Netlify site. The browser obtains the ticket from
`POST /api/admin/websocket-ticket` with its HttpOnly cookie, then presents it
as a WebSocket subprotocol on the fixed `/admin-updates` path. Tickets expire
after 15 seconds, are bound to the requesting Origin, are consumed once and do
not contain the admin JWT. The server rejects every upgrade before ticket and
Origin validation and closes accepted sockets when the parent session expires.

Both Helmet and Netlify apply an explicit Content Security Policy. Inline
scripts and styles remain temporarily allowed because the current static pages
depend on them; allowed third-party sources are enumerated instead of allowing
arbitrary script origins.

Rollback: restore the previous bearer-token transport in the API and admin
pages together. No database migration or persistent session state is involved.
Logout removes the browser cookie but does not maintain a server-side denylist;
a separately captured JWT therefore remains cryptographically valid until the
60-minute expiry. Immediate token revocation would require server-side session
state and is outside this issue's migration-free scope.
