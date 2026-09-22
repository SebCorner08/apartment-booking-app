# BUILD_VERIFICATION.md — AI Agent Bootstrap

> ## ABSOLUTE COPILOT RESTRICTION — OVERRIDES ALL CONFLICTING TEXT
>
> - GitHub Copilot MUST NEVER be assigned as a coding agent, implementation owner, code-generation actor, or source of implementation branches/commits/PRs/patches.
> - Copilot MAY ONLY review an existing implementation PR after the identified implementation owner has submitted `RESULT_SUBMITTED` for the exact candidate head SHA.
> - Copilot findings return to the implementation owner. Copilot must not implement the fixes.
> - Any Copilot-generated implementation artifact is unauthorized unless the Repository Owner gives a separate explicit exception naming that exact artifact and permitted use.

> ## GOLDEN RULE — IMPLEMENTATION OWNERSHIP
>
> The principal assistant/coordinator is the permanent Web Implementation Owner for frontend/browser/web-security work.
>
> Specialist ownership remains:
> - `AGT-DATA-001` — Database & Payments
> - `AGT-QA-001` — Testing & Architecture
>
> The principal assistant must not silently impersonate a specialist. A Repository Owner exception may explicitly authorize the Principal/Lead to perform a named specialist-domain change when the specialist is unavailable.

> ## GOLDEN RULE — REVIEW AND MERGE
>
> Normal code-PR sequence:
>
> `Implementation + owner tests/evidence → Copilot review → implementation owner addresses findings → Raelvi final technical review → Repository Owner MERGE_AUTHORIZED → merge`
>
> Independent QA is **risk-based, not a mandatory gate on every PR**. Use `AGT-QA-001` or another qualified independent reviewer when deeper verification is warranted, including:
> - production database migrations or destructive data operations;
> - payment/Stripe semantic changes;
> - authentication/session/security changes;
> - broad architecture/refactor or CI/test-infrastructure changes;
> - unresolved test failures, ambiguous behavior, or reviewer-requested verification.
>
> When independent QA is invoked, record `QA_CONFORM` or findings on the exact candidate SHA. A material change after QA or review invalidates affected evidence.
>
> **Raelvi (`raelvim`) has the final technical review word on every code PR.** Raelvi approval is not merge authorization. Only the Repository Owner may authorize merge to `main`.

> **FIRST FILE RULE**
>
> Every technical actor must read this file before inspecting or modifying implementation code.

## 1. Repository identity

- Repository: `SebCorner08/apartment-booking-app`
- Canonical integration branch: `main`
- Frontend: `public/`
- Backend: `server/`
- Current database baseline: SQLite
- Payment provider: Stripe
- External availability source: Airbnb iCal
- Frontend deployment: `netlify.toml`
- Backend deployment: `render.yaml`

## 2. Mandatory reading order

1. `BUILD_VERIFICATION.md`
2. `AGENTS.md`
3. `DEVELOPMENT_PROCESS.md`
4. Assigned specialist role file when applicable
5. Exact GitHub issue
6. Exact issue branch and commit SHA
7. Relevant implementation files

A chat instruction such as “go ahead,” “solve it,” “fix it,” “continue,” or “finish it” authorizes branch work only. It does not authorize merge to `main`.

## 3. Startup verification gate

Before implementation confirm:
- correct repository, issue, implementation owner, branch and SHA;
- accepted issue scope and baseline SHA;
- no unrelated branch changes;
- build/test capability is identified;
- no tracked secrets or customer-data exposure is introduced;
- Copilot is not being used as implementation actor;
- appropriate testing/review depth has been chosen for the risk level.

If any item is uncertain, stop and reconcile it first.

## 4. Baseline technical verification

Use the lockfile:

```bash
npm ci
```

Current runtime commands:

```bash
npm start
npm run dev
```

Tests must use isolated development/test data and test/mock payment configuration. Never run destructive tests against production data.

## 5. Evidence rule

For every implementation result record evidence tied to the exact commit SHA:
- implementation owner identity;
- files changed;
- commands actually run and results;
- relevant manual checks;
- known unverified areas;
- migration/rollback notes when applicable;
- optional independent QA result when invoked;
- Copilot review result for code PRs, or explicit Repository Owner waiver if unavailable;
- Raelvi final technical review result for code PRs.

Never claim tests/build/deployment passed without execution evidence from the same material revision.

## 6. Blocking conditions

Forward progress stops for:
- wrong/unknown issue, branch, SHA, owner, or scope;
- unauthorized Copilot implementation activity;
- failing relevant tests;
- unresolved security/payment/data/persistence risk;
- missing migration/rollback plan for stateful or destructive work;
- customer data or secrets exposure;
- merge conflict that materially changes the result;
- missing required risk-based QA when the Lead, Raelvi, Copilot, or Repository Owner explicitly requires it;
- missing Copilot review/owner waiver on a code PR;
- missing Raelvi final technical review on a code PR;
- missing explicit Repository Owner merge authorization;
- unknown deployment outcome when deployment is required.

## 7. Domain checks

### Frontend / browser / web security — Principal/Web Implementation Owner
Preserve mobile/desktop behavior and server-authoritative pricing/payment semantics. Backend data/payment changes require Data coordination or an explicit owner exception.

### Database / persistence — AGT-DATA-001
Verify data preservation, migration/rollback, test isolation and that runtime databases are not committed.

### Payments — AGT-DATA-001
Verify server-authoritative pricing, webhook signature validation, durable persistence, idempotency and retry behavior.

### Testing / architecture — AGT-QA-001
Own test/CI/architecture implementation. Perform independent QA when requested by risk assessment, reviewers, Lead or Repository Owner.

### Booking availability
Verify confirmed bookings, active payment holds, imported external blocks and simultaneous booking attempts.

## 8. Required process chain

Mandatory code-PR chain:

`ISSUE_CREATED → ISSUE_ACCEPTED → IMPLEMENTATION_OWNER_ASSIGNED → BRANCH_CREATED → IMPLEMENTATION_IN_PROGRESS → RESULT_SUBMITTED → COPILOT_REVIEWED → RAELVI_APPROVED → LEAD_APPROVED → OWNER_APPROVED → MERGE_AUTHORIZED → MERGED → DEPLOYMENT_DECIDED → DEPLOYED/NOT_REQUIRED → VERIFIED → CLOSED`

`QA_CONFORM` is an optional risk-based evidence state inserted after `RESULT_SUBMITTED` and before final approval when independent QA is required.

For code PRs:
- `RESULT_SUBMITTED` comes from the identified implementation owner.
- `COPILOT_REVIEWED` means Copilot reviewed the exact submitted candidate; findings were addressed or explicitly dispositioned by the implementation owner.
- `RAELVI_APPROVED` means Raelvi reviewed the exact final candidate head and gave final technical approval.
- Material changes after any review require affected review to be repeated.

`MERGE_AUTHORIZED` requires a separate explicit Repository Owner instruction identifying the exact PR/change.

## 9. Authority boundaries

### Principal assistant / Lead Integrator / Web Implementation Owner
May coordinate all issues, implement authorized web work, address Copilot findings for owned changes and maintain governance/process documentation when requested. May not merge to `main` without explicit owner authorization or impersonate Data/QA without an explicit exception.

### AGT-DATA-001
Owns Database & Payments implementation unless the Repository Owner explicitly grants a named exception.

### AGT-QA-001
Owns Testing & Architecture implementation and provides independent QA when risk-based verification is requested. QA is not a universal prerequisite for Copilot review.

### GitHub Copilot
Reviewer-only after `RESULT_SUBMITTED`. Never an implementation actor.

### Raelvi (`raelvim`)
Final technical reviewer for code PRs after Copilot findings are resolved/dispositioned. Does not authorize merge unless the Repository Owner explicitly delegates that authority.

## 10. Current issue routing

- Principal/Web Implementation Owner: #3, #4, #6, #17 and future frontend/browser/web-security issues.
- `AGT-DATA-001`: #1, #2, #5 and future database/payment/persistence issues.
- `AGT-QA-001`: #7, #8, #9, #15 and future testing/architecture/dependency-audit issues.
- Lead Integrator / principal assistant: #14, #16, cross-branch integration, deployment coordination and release readiness.

## 11. Completion gate

A code task is not complete because code exists. Completion requires implementation-owner responsibility for the final code, appropriate test evidence, Copilot review or explicit owner waiver, Raelvi final technical approval, exact revision identity, explicit Repository Owner merge authorization and post-merge/deployment verification when applicable. Independent QA is required only when the risk-based policy or an explicit reviewer/owner request calls for it.

This file is the mandatory first technical file. `AGENTS.md` governs collaboration, `DEVELOPMENT_PROCESS.md` governs transitions and specialist role files govern domain responsibilities.