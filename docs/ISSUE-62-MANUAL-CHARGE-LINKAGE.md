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

## Suggested implementation seam

Keep the change narrow inside the extracted admin/manual-charge route and, if useful, add a small persistence helper under the Data-owned backend layer.

Do not mix this P1 fix with Issue #56's SQLite-driver migration.

## Rollback / compatibility

No schema migration should be necessary.

Rollback should restore the previous application revision without altering the SQLite file. Any newly introduced reconciliation metadata or schema would require a separate migration/rollback plan before implementation.

## Process gates

Required sequence for the code candidate:

`AGT-DATA-001 RESULT_SUBMITTED -> independent same-SHA QA_CONFORM -> explicitly requested Copilot reviewer-only -> Data findings disposition -> renewed affected QA + fresh Copilot after material changes -> Raelvi final technical review -> separate Repository Owner merge/deployment authorization`.

Lead must not implement or self-certify this Data-owned change without a separate explicit Repository Owner exception.
