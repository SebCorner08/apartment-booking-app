---
type: booking-development-process
process_id: PROC-DEV-001
status: ACTIVE
owner: Repository Owner
coordinator: AGT-LEAD-001
---

# Booking App — Development and Release Process

## Purpose

GitHub is the canonical execution record for issues, branches, commits, PRs, reviews, merges, deployments and verification.

A chat instruction never silently skips scope, ownership, evidence or merge authorization. Evidence belongs to the exact issue, branch and head SHA being evaluated.

## Non-negotiable ownership rules

1. The principal assistant is Lead Integrator and permanent Web Implementation Owner.
2. `AGT-DATA-001` owns Database & Payments work unless the Repository Owner explicitly grants a named exception.
3. `AGT-QA-001` owns Testing & Architecture implementation and provides independent QA when risk-based verification is requested.
4. GitHub Copilot is reviewer-only and must never generate or modify implementation artifacts.
5. The implementation owner must own the final branch head, tests/evidence and `RESULT_SUBMITTED`.
6. **Raelvi (`raelvim`) gives the final technical review word on every code PR** against the exact final head SHA.
7. **Only the Repository Owner can authorize merge to `main`.**

## Roles

### Repository Owner
Final authority for merge authorization, production deployment authorization, destructive operations, secret changes, irreversible migrations and process exceptions.

### AGT-LEAD-001 / Principal assistant
Coordinates issues, checks scope/branch identity, controls integration readiness and owns frontend/browser/web-security implementation. May act in a specialist domain only under a specific Repository Owner exception.

### AGT-DATA-001 — Database & Payments
Owns database, persistence, migration, payment, Stripe and backend data-integrity implementation.

### AGT-QA-001 — Testing & Architecture
Owns test/CI/architecture implementation and performs independent QA when invoked by risk assessment or explicit request.

### GitHub Copilot
Reviewer-only after `RESULT_SUBMITTED`. Findings return to the implementation owner. Copilot must not implement fixes.

### Raelvi (`raelvim`)
Final technical reviewer for code PRs after Copilot findings and any required independent QA/fixes are resolved.

## Mandatory process chain

For code changes:

`ISSUE_CREATED → ISSUE_ACCEPTED → IMPLEMENTATION_OWNER_ASSIGNED → BRANCH_CREATED → IMPLEMENTATION_IN_PROGRESS → RESULT_SUBMITTED → COPILOT_REVIEWED → RAELVI_APPROVED → LEAD_APPROVED → OWNER_APPROVED → MERGE_AUTHORIZED → MERGED → DEPLOYMENT_DECIDED → DEPLOYED/NOT_REQUIRED → VERIFIED → CLOSED`

`QA_CONFORM` is an **optional risk-based evidence state**, not a mandatory step on every PR.

Independent QA should be invoked for higher-risk work such as:
- production DB migrations or destructive data operations;
- payment/Stripe semantic changes;
- authentication/session/security changes;
- broad architecture/refactor or CI/test-infrastructure changes;
- unresolved failures or ambiguous behavior;
- explicit request from Copilot, Raelvi, Lead or Repository Owner.

When QA is invoked it must be independent of the implementation owner and tied to the exact SHA.

## State rules

### ISSUE_CREATED
Requires a GitHub issue with problem, scope, acceptance criteria and risk/priority when relevant.

### ISSUE_ACCEPTED
Lead confirms the issue is valid, scoped, non-duplicate and testable.

### IMPLEMENTATION_OWNER_ASSIGNED
Lead records one owner. Specialist exceptions must be explicit and recorded.

### BRANCH_CREATED
One accepted issue maps to one primary implementation branch. Record baseline SHA.

### IMPLEMENTATION_IN_PROGRESS
Implementation owner modifies only authorized scope, adds/updates tests and produces evidence.

### RESULT_SUBMITTED
Actor: identified implementation owner.

Required evidence:
- branch and exact head SHA;
- files changed;
- tests/checks actually run and results;
- known limitations;
- migration/rollback notes where applicable.

### QA_CONFORM — optional
Actor: qualified independent reviewer.

Use only when risk-based policy or an explicit reviewer/owner request requires independent QA. Record `QA_CONFORM` or concrete findings on the exact SHA.

### COPILOT_REVIEWED
Copilot reviews the exact submitted candidate as reviewer-only. Findings return to the implementation owner. Material fixes require fresh affected review and any required QA.

### RAELVI_APPROVED
Raelvi reviews the exact final head after Copilot findings and any required QA/fixes are resolved. Any material change afterward requires a new final review.

### LEAD_APPROVED
Lead confirms scope, owner evidence, relevant tests, Copilot disposition, any required QA and Raelvi approval all refer to the same final head.

### OWNER_APPROVED
Repository Owner accepts the technical result for the exact PR/head. This is not merge permission.

### MERGE_AUTHORIZED
Actor: Repository Owner only.

Requires a separate explicit instruction identifying the exact PR/change, for example “Merge PR #33 to main.”

### MERGED
Only after explicit `MERGE_AUTHORIZED`. Confirm expected head SHA and correct base.

### DEPLOYMENT_DECIDED
Record `REQUIRED`, `NOT_REQUIRED` or `BLOCKED`.

### DEPLOYED
When required, record deployed SHA, target environment, result and migration/config result as applicable.

### VERIFIED
Runtime changes are verified against the deployed version. Repository-only changes are verified against merged state and relevant checks.

### CLOSED
Only after acceptance criteria and required verification are complete and follow-ups are tracked or unnecessary.

## Blocking conditions

Forward progress stops for:
- wrong issue/branch/SHA or implementation owner;
- unauthorized Copilot implementation activity;
- relevant test failures;
- unresolved security/payment/data/persistence risk;
- missing migration/rollback plan for stateful/destructive work;
- material code change after review without revalidation;
- unresolved review findings;
- missing risk-based QA when explicitly required;
- missing Copilot review or explicit Repository Owner waiver;
- missing Raelvi final technical approval;
- merge conflicts/dependency conflicts;
- missing explicit Repository Owner merge authorization;
- unknown deployment outcome when deployment is required.

## Review order

Normal code PR:

`Implementation + owner tests/evidence → Copilot review → implementation owner addresses findings → optional risk-based QA if required → Raelvi final technical review → Lead readiness → Owner approval → explicit MERGE_AUTHORIZED`

Risk-based QA may also be run before Copilot if the Lead/owner chooses. The final head must have all required evidence and reviews current at the time of Raelvi approval.

## Recovery

### QA or review failed
Return to `IMPLEMENTATION_IN_PROGRESS`, preserve failed evidence, fix on the issue branch and repeat affected checks/reviews.

### Unauthorized Copilot implementation artifact
Stop. Do not adopt, copy, cherry-pick or merge it without an explicit Repository Owner exception naming the artifact and permitted use.

### Unauthorized merge
Stop immediately. Record the deviation. Do not write directly to `main` to repair it. Prepare a separate rollback/recovery PR and wait for owner disposition.

### Deployment outcome unknown
Do not redeploy blindly. Reconcile the deployment platform first.

## Canonical evidence format

```text
PROCESS_STATE
issue: #<number>
state: <STATE>
actor: <implementation owner | reviewer | owner>
branch: <branch>
head_sha: <sha>
evidence: <tests/reviews/checks>
qa: <NOT_REQUIRED | REQUIRED | QA_CONFORM | findings>
next_action: <action>
```

## Completion

A code task is complete only when the final implementation is owned, relevant tests/evidence are recorded, Copilot review is complete or explicitly waived by the Repository Owner, any required risk-based QA is complete, Raelvi has approved the exact final head, merge was explicitly authorized and post-merge/deployment verification is complete when applicable.