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
3. `AGT-QA-001` owns Testing & Architecture implementation and normally provides independent QA for code owned by another implementation owner.
4. GitHub Copilot is reviewer-only and must never generate or modify implementation artifacts.
5. The implementation owner must own the final branch head, tests/evidence and `RESULT_SUBMITTED`.
6. Every code PR requires independent same-SHA `QA_CONFORM` after `RESULT_SUBMITTED` and before any Copilot reviewer request.
7. **Raelvi (`raelvim`) gives the final technical review word on every code PR** against the exact final head SHA after QA, Copilot and findings disposition are complete.
8. **Only the Repository Owner can authorize merge to `main`.**

## Roles

### Repository Owner
Final authority for merge authorization, production deployment authorization, destructive operations, secret changes, irreversible migrations and process exceptions.

### AGT-LEAD-001 / Principal assistant
Coordinates issues, checks scope/branch identity, controls integration readiness and owns frontend/browser/web-security implementation. May act in a specialist domain only under a specific Repository Owner exception.

### AGT-DATA-001 — Database & Payments
Owns database, persistence, migration, payment, Stripe and backend data-integrity implementation.

### AGT-QA-001 — Testing & Architecture
Owns test/CI/architecture implementation and normally provides independent QA when another actor owns implementation. If `AGT-QA-001` owns a code change, another qualified independent reviewer must provide `QA_CONFORM`.

### GitHub Copilot
Reviewer-only after implementation-owner `RESULT_SUBMITTED` and independent same-SHA `QA_CONFORM`. Findings return to the implementation owner. Copilot must not implement fixes or produce implementation artifacts for adoption without an explicit artifact-specific Repository Owner exception.

### Raelvi (`raelvim`)
Final technical reviewer for code PRs after independent QA, Copilot findings and any required renewed QA/review are resolved on the exact unchanged head.

## Mandatory process chain

For code changes:

`ISSUE_CREATED → ISSUE_ACCEPTED → IMPLEMENTATION_OWNER_ASSIGNED → BRANCH_CREATED → IMPLEMENTATION_IN_PROGRESS → RESULT_SUBMITTED → QA_CONFORM → COPILOT_REVIEWED → RAELVI_APPROVED → LEAD_APPROVED → OWNER_APPROVED → MERGE_AUTHORIZED → MERGED → DEPLOYMENT_DECIDED → DEPLOYED/NOT_REQUIRED → VERIFIED → CLOSED`

Independent QA is a **mandatory evidence state on every code PR**.

When QA is performed it must be independent of the implementation owner and tied to the exact unchanged SHA. If `AGT-QA-001` is the implementation owner, another qualified independent reviewer must provide the QA result.

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

### QA_CONFORM — mandatory for code PRs
Actor: qualified independent reviewer.

Requirements:
- reviewer is independent of the implementation owner;
- exact candidate SHA matches `RESULT_SUBMITTED`;
- relevant tests/checks and known gaps are recorded;
- the candidate is not modified while being certified.

If findings are found, return to `IMPLEMENTATION_IN_PROGRESS`. After material fixes, the implementation owner must submit a fresh `RESULT_SUBMITTED` for the new head and independent QA must be repeated.

### COPILOT_REVIEWED
Only after same-SHA `QA_CONFORM`, Copilot is explicitly requested to review the existing PR as reviewer-only. Findings return to the implementation owner. Copilot must not implement fixes. Material fixes require fresh `RESULT_SUBMITTED`, renewed affected QA and a fresh Copilot review.

### RAELVI_APPROVED
Raelvi reviews the exact final unchanged head after independent QA, Copilot findings disposition and any required renewed QA/Copilot review are complete. Any material change afterward requires the affected chain to be repeated before final approval.

### LEAD_APPROVED
Lead confirms scope, owner evidence, tests, independent QA, Copilot disposition and Raelvi approval all refer to the same final unchanged head.

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
- missing independent same-SHA `QA_CONFORM` before Copilot on a code PR;
- missing Copilot review or explicit Repository Owner waiver;
- missing renewed affected QA and fresh Copilot review after a material change;
- missing Raelvi final technical approval;
- merge conflicts/dependency conflicts;
- missing explicit Repository Owner merge authorization;
- unknown deployment outcome when deployment is required.

## Review order

Mandatory code PR:

`Implementation + owner tests/evidence → RESULT_SUBMITTED → independent same-SHA QA_CONFORM → explicitly requested Copilot reviewer-only review → implementation owner addresses/dispositions findings → renewed affected QA + fresh Copilot review after material changes → Raelvi final technical review → Lead readiness → Owner approval → explicit MERGE_AUTHORIZED`

The final head must have all required evidence and reviews current at the time of Raelvi approval.

## Recovery

### QA or review failed
Return to `IMPLEMENTATION_IN_PROGRESS`, preserve failed evidence, fix on the issue branch and repeat affected checks/reviews. A material fix requires a fresh implementation-owner `RESULT_SUBMITTED`, renewed affected QA and fresh Copilot review before Raelvi.

### Unauthorized Copilot implementation artifact
Stop. Do not adopt, copy, cherry-pick or merge it without an explicit Repository Owner exception naming the exact artifact and permitted use.

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
qa: <REQUIRED | QA_CONFORM | findings>
next_action: <action>
```

## Completion

A code task is complete only when the final implementation is owned, relevant tests/evidence are recorded, independent same-SHA `QA_CONFORM` is complete, Copilot has reviewed as reviewer-only or the Repository Owner has explicitly waived it, all findings are dispositioned by the implementation owner, any material post-review change has renewed affected QA and fresh Copilot review, Raelvi has approved the exact final unchanged head, merge was explicitly authorized and post-merge/deployment verification is complete when applicable.