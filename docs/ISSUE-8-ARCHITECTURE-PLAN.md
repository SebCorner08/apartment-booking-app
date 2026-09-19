# Issue #8 — Backend architecture extraction and recovery record

Implementation owner: `AGT-LEAD-001` under the explicit Repository Owner exception recorded for Issue #8
Independent QA: `AGT-QA-001`
Database/payment/persistence reviewer: `AGT-DATA-001`
Recovery baseline: `main@8ce680d8e6e3b61a9a714c144600e2425d397054`

## Current state

The backend extraction was implemented in PR #52 and merged as `c230262e45a2d9f8ca970a5f9d40e349916b34cc`. That merge occurred while the PR still described its pre-#15 candidate as requiring baseline refresh and the required independent review chain had not completed. Issue #8 was therefore reopened for recovery verification.

This file supersedes the earlier planning text that named `AGT-QA-001` as implementation owner. That text was historical planning evidence from before the Repository Owner exception assigned implementation ownership to `AGT-LEAD-001`; it must not be used as the current ownership record.

The recovery remains behavior-preserving. It must not intentionally change pricing, payment, booking, authentication, WebSocket or persistence semantics.

## Extracted module map

The merged implementation separates the former monolith into these focused seams:

- `server/middleware/admin-auth.js`: cookie/origin admin authentication.
- `server/services/admin-websocket.js`: ticket lifecycle, upgrade authorization and admin broadcasts.
- `server/services/pricing-service.js`: server-authoritative pricing persistence and calculations.
- `server/services/booking-service.js`: date validation, availability and hold lifecycle.
- `server/services/calendar-service.js`: calendar export and Airbnb iCal synchronization.
- `server/routes/booking-routes.js`: public availability routes.
- `server/routes/pricing-routes.js`: public/admin pricing routes.
- `server/routes/payment-routes.js`: Stripe webhook, checkout and booking confirmation routes.
- `server/routes/admin-routes.js`: admin session, bookings and manual-charge routes.
- `server/index.js`: composition, middleware ordering, health/startup and scheduling.

## Post-merge findings being recovered

The post-merge reviewer identified four concerns that must be resolved or dispositioned before Issue #8 can be considered complete:

1. `test-admin-session-browser.js` still looked for WebSocket implementation details in `server/index.js` after those details moved into `server/services/admin-websocket.js`.
2. The module-seam regression only proved several factories existed and did not exercise the extracted calendar/Airbnb-sync or manual-charge persistence paths.
3. This architecture record still named `AGT-QA-001` as implementation owner despite the later explicit Lead exception.
4. The PR had already merged while its own pre-merge/final-candidate gates were still recorded as incomplete.

The recovery branch addresses findings 1–3 with focused testability/test/documentation changes. Finding 4 is a process-state issue and is handled by the reopened canonical GitHub issue and the required recovery review chain; it is not solved by rewriting history.

## Verification requirements

- Existing endpoint paths, status codes and response contracts stay unchanged.
- Existing cookie/CSP/WebSocket security regressions remain green and the admin-session regression runs in the default suite.
- Calendar-feed and Airbnb-sync behavior is exercised without external network access through dependency injection of the iCal client.
- Manual-charge route persistence and mock-payment response behavior are exercised with an isolated fake database.
- Pricing, booking, hold, webhook, persistence and data-hygiene tests remain green.
- Test data remains isolated from production/development data.
- `AGT-DATA-001` reviews payment/database/persistence extraction for semantic preservation.
- `AGT-QA-001` independently reviews the exact final recovery SHA; Lead may not self-issue `QA_CONFORM`.

## Required recovery sequence

1. `AGT-LEAD-001` completes the recovery candidate under the recorded Repository Owner exception and posts `RESULT_SUBMITTED` for the exact final SHA only after exact-head CI is green.
2. Independent `AGT-QA-001` records same-SHA `QA_CONFORM` or concrete findings. `AGT-DATA-001` separately reviews the database/payment/persistence boundaries.
3. Only after required independent QA may Copilot be explicitly requested as reviewer-only on the existing recovery PR. Copilot must not implement fixes.
4. Valid reviewer findings return to the implementation owner. Material changes require renewed affected QA and a fresh Copilot review.
5. Raelvi (`raelvim`) performs final technical review on the exact unchanged cleared head.
6. Any merge to `main` requires a separate explicit Repository Owner instruction.

No deployment authorization is created by this document.
