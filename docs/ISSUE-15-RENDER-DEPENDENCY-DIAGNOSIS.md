# Issue #15 — Dependency remediation and Render runtime diagnosis

Implementation owner: AGT-QA-001
Coordinator: AGT-LEAD-001
Baseline synchronized: `a7fe73ab7ebe1df2ba3376ae4bb0804f117b493e`

## Completed dependency-remediation context

The dependency vulnerability remediation was previously integrated into `main`, including the sqlite3 upgrade and CI coverage. GitHub CI has demonstrated successful install/test execution on its configured Node 22 environment.

Issue #15 remains open because earlier Render deploys after that remediation were recorded as failed and the exact Render failure phase/runtime was not captured in GitHub status metadata.

## Required evidence before another dependency/runtime change

AGT-QA-001 must obtain or reproduce the actual failure rather than changing dependencies from hypothesis:

1. Confirm the intended Render workspace before querying workspace-scoped logs.
2. Record the exact failed deploy and selected Node runtime.
3. Identify the failing phase: dependency install, sqlite3 native load, server startup or health check.
4. Reproduce with isolated data:
   - `npm ci` or the exact Render build command;
   - `node -e 'require("sqlite3")'`;
   - isolated `node server/index.js` startup with non-production secrets and temporary SQLite data.
5. Compare the Render-selected runtime with the CI Node 22 runtime.
6. Preserve the vulnerability-remediation objective; do not downgrade sqlite3 or weaken audit posture solely to make deployment pass.
7. If a runtime pin/bound is required, make the smallest evidence-backed change and align CI with the intended production runtime.
8. Run `npm audit`, the complete relevant test suite and startup verification on the exact successor SHA.

## Process state

This file is Lead diagnosis coordination only. It is not AGT-QA-001 `RESULT_SUBMITTED`.

Next action: AGT-QA-001 must inspect/adopt this branch and produce the evidence-backed successor candidate. Per Repository Owner instruction, exact-head independent `QA_CONFORM` is required before any Copilot reviewer request. Raelvi final technical review follows on the unchanged cleared head.

No Copilot implementation, production deployment, secret change or production-data mutation is authorized by this document.


## Exact Render failure established

Workspace: `tea-dairtdjm8hqs73e23iv0`
Authoritative service: `srv-daj8qnu7bikc73b4q070`

The diagnosis is no longer waiting on Render logs.

Last successful production deploy:
- commit `600faf72cafe9500e8da6c92b845f7816eac7919`;
- deploy `dep-dalgdf9srm7s73cu32b0`;
- Node `24.14.1`;
- `sqlite3@5.1.7` dependency tree;
- runtime connected to `/var/data/reservations.db` and became live;
- npm audit output at build time: 7 vulnerabilities.

First failed remediation deploy:
- commit `9d4ab64f853afa8575e0a1df4bc8aef68d444a59`;
- deploy `dep-dali3lvqj5pc73e051k0`;
- Node `26.9.0`;
- install succeeded and audit reported 0 vulnerabilities;
- runtime failed loading `sqlite3/build/Release/node_sqlite3.node`:
  `GLIBC_2.38 not found` / `ERR_DLOPEN_FAILED`.

Latest current-main deploy reproduces the same failure:
- commit `a7fe73ab7ebe1df2ba3376ae4bb0804f117b493e`;
- deploy `dep-dam9k2ss728c73avljo0`;
- build successful, 0 vulnerabilities;
- identical `GLIBC_2.38 not found` runtime failure.

Therefore later authentication/pricing changes are not the root cause. The regression begins with the sqlite3 6.0.1 remediation revision.

## Smallest remediation experiment

Render documents that its native runtimes use Debian 12 and include the native compiler toolchain during builds and runtime. sqlite3 documents a supported source-build path.

AGT-QA-001 should test the narrow production build correction:

`npm install --build-from-source=sqlite3`

This should compile sqlite3 6.0.1 against Render's native Debian environment instead of consuming the incompatible upstream Linux prebuilt, while preserving the zero-audit-vulnerability dependency set.

Separately, bound `engines.node` to the CI-tested Node 22 major (for example `>=22.9.0 <23`) to eliminate unbounded Node-major drift. The Node bound is reproducibility hardening; it is not by itself the GLIBC fix.

Required exact-head evidence remains: audit, install, `require("sqlite3")`, isolated startup, full tests and then owner `RESULT_SUBMITTED`.
