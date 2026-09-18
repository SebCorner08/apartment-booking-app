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
