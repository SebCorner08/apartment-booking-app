# Permanent Rule — Booking App Collaboration

> **MANDATORY BOOTSTRAP**
>
> Before inspecting or modifying implementation code, read [`BUILD_VERIFICATION.md`](BUILD_VERIFICATION.md) first.
>
> Required startup order: `BUILD_VERIFICATION.md → AGENTS.md → DEVELOPMENT_PROCESS.md → assigned specialist role file when applicable → exact GitHub issue/branch evidence → implementation files`.

> **ABSOLUTE MAIN-BRANCH RULE**
>
> No AI actor may merge, squash, rebase, fast-forward, force-update or directly write implementation code to `main` unless the Repository Owner gives an explicit merge instruction for that specific PR/change. Instructions such as “solve it,” “fix it,” “go ahead,” “continue,” “approve the fix,” or “finish the issue” authorize branch work only.

## Team model

The principal assistant is both:
- `AGT-LEAD-001` — Lead Integrator / coordinator; and
- permanent Web Implementation Owner for frontend, browser and web-security work.

Specialists:
- `AGT-DATA-001` — Database & Payments
- `AGT-QA-001` — Testing & Architecture

The principal assistant may not silently replace a specialist. The Repository Owner may explicitly authorize a named exception for a specific specialist-domain task.

## Implementation ownership

Every implementation PR has one named owner:
- Web/frontend/security: Principal/Web Implementation Owner.
- Database/payment/persistence: `AGT-DATA-001` unless an explicit Repository Owner exception says otherwise.
- Testing/architecture: `AGT-QA-001` when it is the implementation owner.

The implementation owner owns the final branch head, tests/evidence and `RESULT_SUBMITTED`.

## Copilot

GitHub Copilot is **reviewer-only**.

Copilot must never create or modify implementation code, branches, commits, PRs, patches or fixes. It may review an existing PR after `RESULT_SUBMITTED` on the exact candidate SHA. Findings return to the implementation owner.

## Independent QA

Independent QA is **risk-based, not mandatory for every PR**.

Use `AGT-QA-001` or another qualified independent reviewer when:
- a production DB migration or destructive data operation is involved;
- payment/Stripe semantics change;
- authentication/session/security behavior changes materially;
- broad architecture/refactor or CI/test-infrastructure work is involved;
- relevant tests fail or behavior is ambiguous;
- Copilot, Raelvi, the Lead or Repository Owner requests additional verification.

When independent QA is used, it must be independent of the implementation owner and tied to the exact candidate SHA.

## Final technical review

**Raelvi (`raelvim`) has the final technical review word on every code PR.**

Normal sequence:

`Implementation + owner tests/evidence → Copilot review → owner fixes/disposition → optional risk-based QA if required → Raelvi final technical review → Repository Owner merge authorization → merge`

If risk-based QA is required earlier by the Lead or owner, it may run before Copilot. The only strict ordering requirement is that Raelvi final review occurs after Copilot findings and any required QA/fixes are resolved on the exact final head.

Raelvi technical approval is not merge authorization.

## Mandatory process

All implementation work follows [`DEVELOPMENT_PROCESS.md`](DEVELOPMENT_PROCESS.md).

Mandatory chain:

`ISSUE_CREATED → ISSUE_ACCEPTED → IMPLEMENTATION_OWNER_ASSIGNED → BRANCH_CREATED → IMPLEMENTATION_IN_PROGRESS → RESULT_SUBMITTED → COPILOT_REVIEWED → RAELVI_APPROVED → LEAD_APPROVED → OWNER_APPROVED → MERGE_AUTHORIZED → MERGED → DEPLOYMENT_DECIDED → DEPLOYED/NOT_REQUIRED → VERIFIED → CLOSED`

`QA_CONFORM` is optional risk-based evidence inserted when independent QA is required.

Rules:
1. One issue maps to one primary implementation branch and one primary PR.
2. Evidence belongs to the exact branch/head SHA.
3. Material changes invalidate affected review/QA evidence.
4. No implementation owner silently expands issue scope.
5. No actor may expose, commit, rotate or replace production secrets without explicit Repository Owner authorization.
6. Production DB changes require migration/rollback planning when applicable.
7. Payment-flow changes preserve idempotency and server-authoritative prices.
8. Refactors preserve visible behavior unless the issue explicitly authorizes a change.
9. `MERGED` requires separate explicit Repository Owner authorization for that exact PR/change.
10. A code PR cannot reach final technical approval without Raelvi reviewing the exact final head.
11. Copilot cannot own implementation or implement review fixes.
12. Independent QA is invoked by risk or explicit request, not automatically on every PR.

## Agent definitions

- `agents/AGT-LEAD-001-LEAD-INTEGRATOR.md`
- `agents/AGT-DATA-001-DATABASE-PAYMENTS.md`
- `agents/AGT-QA-001-TESTING-ARCHITECTURE.md`

## Current issue ownership

- Principal/Web Implementation Owner: #3, #4, #6, #17 and future frontend/browser/web-security issues.
- `AGT-DATA-001`: #1, #2, #5 and future database/payment/persistence issues.
- `AGT-QA-001`: #7, #8, #9, #15 and future testing/architecture/dependency-audit issues.
- Lead Integrator / principal assistant: #14, #16, cross-branch integration, deployment coordination and release readiness.

## Canonical evidence

Use GitHub issues, branches, commits, PRs, tests/CI, reviews, merge records and deployment evidence as the canonical execution record. Do not create redundant status documents when GitHub evidence is sufficient.