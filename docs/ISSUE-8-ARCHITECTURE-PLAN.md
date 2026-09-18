# Issue #8 — Backend architecture extraction plan

Owner: AGT-QA-001 (Testing & Architecture)
Coordinator: AGT-LEAD-001
Baseline synchronized: `a7fe73ab7ebe1df2ba3376ae4bb0804f117b493e`

## Current branch state

The historical branch-only file `server/middleware/admin-auth.js` predates the current HttpOnly-cookie authentication and authenticated WebSocket ticket flow now present on `main`. It is preserved for branch history only and must not be wired into the application unchanged.

This issue remains a behavior-preserving architecture refactor. It must not change pricing, payment, booking, authentication, WebSocket or persistence semantics as part of extraction.

## Required extraction order

1. Extract current admin authentication/origin middleware from the integrated implementation.
2. Extract authenticated WebSocket ticket issuance, upgrade authorization and admin-update broadcast rules.
3. Extract calendar generation and Airbnb iCal synchronization.
4. Extract pricing repository/service/routes while preserving the server-authoritative pricing module and Issue #5 behavior.
5. Extract booking availability and payment-hold lifecycle.
6. Extract Stripe checkout/webhook handling last, with AGT-DATA-001 review.
7. Reduce `server/index.js` to composition/startup wiring.

## Verification requirements

- Existing endpoint paths, status codes and response contracts stay unchanged.
- Existing cookie/CSP/WebSocket security regressions remain green.
- Pricing, booking, hold, webhook, persistence and data-hygiene tests remain green.
- Test data remains isolated from production/development data.
- Payment/database extraction requires AGT-DATA-001 review.
- Browser/authentication extraction requires Principal/Web review.
- Because AGT-QA-001 is implementation owner, any independent QA evidence must come from another qualified actor.

## Process state

This document is Lead coordination evidence, not AGT-QA-001 `RESULT_SUBMITTED`.

Next action: AGT-QA-001 must inspect/adopt the current branch, replace the obsolete historical auth module with a current-contract extraction and implement the phased refactor with exact-head test evidence. Copilot remains reviewer-only after owner `RESULT_SUBMITTED`; Raelvi reviews the exact final candidate afterward.

No merge to `main` or deployment is authorized by this document.


## Current implementation map for AGT-QA-001

The current monolith is now stable enough to extract in narrow seams:

- bootstrap/config/security shell:
  - environment load, required-secret checks, Helmet/CSP, CORS, static serving and rate limiters;
- admin auth/session:
  - `readCookie`, `adminCookieOptions`, `checkAdminAuth`, login/logout and WebSocket-ticket endpoint;
- authenticated admin WebSocket:
  - ticket lifecycle helpers, protocol parsing, upgrade rejection/authorization and `broadcastAdminUpdate`;
- pricing:
  - `getLatestPricingRow`, `loadRatesFromDB`, `loadTaxSettingsFromDB`, `savePricingSettings`, public calculation routes and admin pricing routes;
- booking availability/holds:
  - `nightsBetween`, `checkAvailability`, expired-hold cleanup, release/confirm helpers and serialized `createHold`;
- payment/booking confirmation:
  - checkout-session creation, `/api/bookings` confirmation fallback and existing `stripe-webhook-persistence` integration;
- admin booking/manual billing:
  - booking list/cancel/delete and manual-charge create/list/pay/delete routes;
- calendar/Airbnb:
  - `/api/calendar.ics`, `syncAirbnbCalendar` and external-block persistence;
- startup/composition:
  - HTTP server creation, WebSocket attachment, periodic hold cleanup, periodic Airbnb sync and `db.ready` startup gate.

Recommended module seams for the first implementation candidate:
- `server/middleware/admin-auth.js`: current cookie/origin auth only, dependency-injected with secrets/environment rather than the obsolete bearer implementation.
- `server/services/admin-websocket.js`: ticket store + upgrade authorization + broadcast interface.
- `server/services/pricing-service.js` and `server/routes/pricing-routes.js`: reuse `pricing-settings.js`; do not change numeric semantics.
- `server/services/booking-service.js`: availability + hold lifecycle only.
- `server/routes/booking-routes.js`: request validation/composition around booking service.
- `server/services/airbnb-calendar.js` and `server/routes/calendar-routes.js`.
- `server/routes/payment-routes.js`: checkout/confirmation/webhook composition, with AGT-DATA-001 review before owner submission.

Each extraction should be independently testable and should land in one final PR only after the whole acceptance criterion is met.
