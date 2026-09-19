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

Copilot must never create or modify implementation code, branches, commits, PRs, patches or fixes. Copilot may only be explicitly requested to review an existing PR after the implementation owner has posted `RESULT_SUBMITTED` for the exact candidate SHA and an independent reviewer has posted `QA_CONFORM` for that same unchanged SHA. Findings return to the implementation owner.

Any Copilot-generated implementation artifact is unauthorized and must not be adopted, copied, cherry-picked or otherwise used unless the Repository Owner gives a separate explicit exception naming the exact artifact and permitted use.

## Independent QA

Independent QA is **mandatory for every code PR**.

- The reviewer must be independent of the implementation owner.
- `QA_CONFORM` must identify the exact unchanged candidate SHA submitted by the implementation owner.
- `AGT-QA-001` normally provides independent QA when another actor owns implementation.
- If `AGT-QA-001` is the implementation owner, another qualified independent reviewer must provide `QA_CONFORM`; `AGT-QA-001` may not self-certify.
- Copilot cannot be requested until this same-SHA QA gate is complete.
- A material change after QA or Copilot review invalidates affected evidence and requires renewed affected QA plus a fresh Copilot review.

## Final technical review

**Raelvi (`raelvim`) has the final technical review word on every code PR.**

Mandatory sequence:

`Implementation + owner tests/evidence → RESULT_SUBMITTED → independent same-SHA QA_CONFORM → explicitly requested Copilot reviewer-only review → implementation-owner fixes/disposition → renewed affected QA + fresh Copilot review after material changes → Raelvi final technical review → Repository Owner merge authorization → merge`

Raelvi technical approval is not merge authorization.

## Mandatory process

All implementation work follows [`DEVELOPMENT_PROCESS.md`](DEVELOPMENT_PROCESS.md).

Mandatory code-PR chain:

`ISSUE_CREATED → ISSUE_ACCEPTED → IMPLEMENTATION_OWNER_ASSIGNED → BRANCH_CREATED → IMPLEMENTATION_IN_PROGRESS → RESULT_SUBMITTED → QA_CONFORM → COPILOT_REVIEWED → RAELVI_APPROVED → LEAD_APPROVED → OWNER_APPROVED → MERGE_AUTHORIZED → MERGED → DEPLOYMENT_DECIDED → DEPLOYED/NOT_REQUIRED → VERIFIED → CLOSED`

Rules:
1. One issue maps to one primary implementation branch and one primary PR.
2. Evidence belongs to the exact branch/head SHA.
3. Material changes invalidate affected QA/review evidence and require renewed affected QA plus fresh Copilot review.
4. No implementation owner silently expands issue scope.
5. No actor may expose, commit, rotate or replace production secrets without explicit Repository Owner authorization.
6. Production DB changes require migration/rollback planning when applicable.
7. Payment-flow changes preserve idempotency and server-authoritative prices.
8. Refactors preserve visible behavior unless the issue explicitly authorizes a change.
9. `MERGED` requires separate explicit Repository Owner authorization for that exact PR/change.
10. A code PR cannot reach final technical approval without Raelvi reviewing the exact final unchanged head after QA, Copilot and findings disposition are complete.
11. Copilot cannot own implementation or implement review fixes.
12. Independent same-SHA `QA_CONFORM` is mandatory before any Copilot reviewer request on every code PR.
13. Unauthorized Copilot-generated implementation artifacts must not be adopted without an explicit artifact-specific Repository Owner exception.

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

Use GitHub issues, branches, commits, PRs, tests/CI, reviews, merges, deployments and verification evidence as the canonical execution record. Do not create redundant status documents when GitHub evidence is sufficient.