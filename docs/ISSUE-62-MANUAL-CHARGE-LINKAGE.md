# Issue #62 — Durable manual-charge Stripe session linkage

Implementation owner: `AGT-DATA-001`
Coordinator: `AGT-LEAD-001`
Baseline: `main@d3f9169deab84f9bd133576dddd593f8e7ef3232`

## Problem

The manual-charge create path can create a Stripe Checkout session and then issue:

`UPDATE manual_charges SET stripe_session_id = ? WHERE id = ?`

without waiting for the persistence operation to complete before broadcasting and returning HTTP 201.

The same behavior predates the Issue #8 refactor, so this is a separate Data-owned durability defect rather than a refactor regression.

## Required implementation behavior

A successful response containing a session ID/URL must not be emitted until the linkage write has completed successfully.

AGT-DATA-001 should:

1. Convert the linkage update into an awaitable persistence operation with explicit error handling.
2. Preserve the existing manual-charge row and API contract where safe.
3. Define real-Stripe failure semantics for the case where Checkout session creation succeeds but the linkage write fails.
4. Avoid silently creating duplicate Checkout sessions on retry.
5. Preserve authentication, server-authoritative amount handling and existing list/pay/delete behavior.
6. Add isolated tests for:
   - mock-payment linkage success;
   - mock linkage persistence failure;
   - real-Stripe seam linkage success;
   - real-Stripe linkage persistence failure;
   - response ordering proving HTTP 201 occurs only after persistence completion;
   - retry/reconciliation behavior that does not create duplicate session/charge records.
7. Use only isolated test data and mocked Stripe behavior.

## Durable request identity contract

`POST /api/admin/charges` now requires `request_id`, a canonical UUID v4. The
caller must create it once per logical manual charge with
`crypto.randomUUID()` and reuse it with the exact same `guest_name`,
`guest_email`, `description` and `amount` fields for every retry. The server
persists the normalized UUID on the manual-charge row and a partial unique
SQLite index atomically arbitrates
concurrent requests from separate connections or app instances. Stripe's
idempotency key is derived from that UUID rather than process memory or a
client-supplied charge/payment status.

The Lead-owned `public/admin.html` caller must retain this immutable pending
request state across ambiguous network/5xx failures. It must clear the state
only after HTTP 201 or an explicit operator decision to start a different
charge. A changed form is a new logical operation and gets a new UUID; an
unchanged retry reuses the pending UUID. `recovery_charge_id` remains an
optional compatibility hint but never replaces `request_id` and must refer to
the row bound to the same UUID.

The explicit error contract is:

- `400 MANUAL_CHARGE_REQUEST_ID_REQUIRED`: no provider call and the caller must
  generate a UUID for this logical operation.
- `400 MANUAL_CHARGE_REQUEST_ID_INVALID`: no provider call and the caller must
  correct its UUID generation/state handling.
- `409 MANUAL_CHARGE_REQUEST_ID_CONFLICT`: the UUID is already bound to a
  different row or immutable field set. Do not automatically generate a new
  UUID and retry.
- `503 MANUAL_CHARGE_RECOVERY_REQUIRED`: retain the UUID and exact fields then
  retry the same logical operation.
- `409 MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED`: do not automatically
  retry. Show the returned `recovery.charge_id` and require Stripe/database
  reconciliation.

## Suggested implementation seam

Keep the change narrow inside the extracted admin/manual-charge route and, if useful, add a small persistence helper under the Data-owned backend layer.

Do not mix this P1 fix with Issue #56's SQLite-driver migration.

## Forward migration / rollback / compatibility

The forward migration adds nullable `manual_charges.request_id` and the partial
unique index `idx_manual_charges_request_id`. It does not backfill existing rows:
inventing an identity could replay a Checkout create whose earlier session ID
was lost. A matching unresolved legacy row or an explicit replay of an unkeyed
row therefore fails closed into manual reconciliation before any Stripe create.

The migration is additive. Rolling the application back leaves the nullable
column and index in place; older revisions ignore the column and can read the
same rows. Before an application rollback, drain create traffic and reconcile
every pending row whose `stripe_session_id` is NULL because the older revision
does not preserve this protocol on retry. A full schema rollback may drop the
index after the application rollback but should retain the nullable column to
avoid a destructive SQLite table rebuild. Re-deploying this revision is
idempotent. The create endpoint's new required `request_id` is a deliberate
fail-closed API change and must ship with the Lead-owned admin caller update.

## Process gates

Required sequence for the code candidate:

`AGT-DATA-001 RESULT_SUBMITTED -> independent same-SHA QA_CONFORM -> explicitly requested Copilot reviewer-only -> Data findings disposition -> renewed affected QA + fresh Copilot after material changes -> Raelvi final technical review -> separate Repository Owner merge/deployment authorization`.

Lead must not implement or self-certify this Data-owned change without a separate explicit Repository Owner exception.
