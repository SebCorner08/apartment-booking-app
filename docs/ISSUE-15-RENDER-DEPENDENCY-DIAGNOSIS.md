# Issue #15 — Dependency remediation and Render runtime diagnosis

Implementation owner: `AGT-LEAD-001` under the explicit Repository Owner exception authorizing Lead implementation of Issue #15
Independent QA: `AGT-QA-001` required on the exact final candidate; Lead may not self-issue `QA_CONFORM`
Coordinator: `AGT-LEAD-001`
Baseline synchronized: `a7fe73ab7ebe1df2ba3376ae4bb0804f117b493e`

## Completed dependency-remediation context

The dependency vulnerability remediation was previously integrated into `main`, including the sqlite3 upgrade and CI coverage. GitHub CI demonstrated successful install/test execution on its configured Node 22 environment, while Render production startup regressed after the sqlite3 upgrade.

Issue #15 remains open because the production runtime path must be made deterministic and compatible without restoring the known high/critical dependency findings.

## Exact Render failure established

Workspace: `tea-dairtdjm8hqs73e23iv0`
Authoritative service: `srv-daj8qnu7bikc73b4q070`

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
- Node `26.9.0` selected from the previously unbounded `engines.node >=22.9.0` range;
- install succeeded and audit reported 0 vulnerabilities;
- runtime failed loading `sqlite3/build/Release/node_sqlite3.node` with `GLIBC_2.38 not found` / `ERR_DLOPEN_FAILED`.

Latest current-main deploy reproduces the same failure:
- commit `a7fe73ab7ebe1df2ba3376ae4bb0804f117b493e`;
- deploy `dep-dam9k2ss728c73avljo0`;
- build successful, 0 vulnerabilities;
- identical `GLIBC_2.38 not found` sqlite3 startup failure;
- Render retained the previous working revision.

Therefore the production regression is tied to the sqlite3 6.0.1 native artifact path introduced by the dependency remediation. Later authentication/pricing changes are not the root cause.

## Submitted remediation

The submitted implementation keeps `sqlite3@6.0.1` and the remediated dependency set while making the production build path deterministic:

1. `package.json` bounds Node to `>=22.9.0 <23`, matching the Node 22 major validated by CI and preventing unbounded major-version drift.
2. `render.yaml` uses:

   `npm ci && npm rebuild sqlite3 --build-from-source`

   This preserves a lockfile-clean install and then replaces the incompatible sqlite3 prebuilt with a native source build against the Render build environment.
3. `.github/workflows/test.yml` runs the same sqlite3 source rebuild, verifies `require("sqlite3")`, enforces `npm audit --audit-level=high` and runs the full regression suite.

A package-specific install-time source-build form (`npm_config_build_from_source=sqlite3 npm ci`) was also investigated because `prebuild-install@7.1.3` recognizes the package name in `npm_config_build_from_source`. The submitted candidate instead uses the explicit post-install `npm rebuild sqlite3 --build-from-source` sequence because that exact path is exercised by CI and is easy to verify independently.

## Exact-head evidence requirement

For the exact final candidate, required evidence is:
- clean `npm ci`;
- sqlite3 source rebuild;
- `node -e 'require("sqlite3")'` native-load verification;
- `npm audit --audit-level=high`;
- full isolated regression tests;
- independent same-SHA `QA_CONFORM` before any Copilot reviewer request.

No production deployment is part of this PR. Runtime verification on Render belongs to Issue #14 only after the required review chain, separate Repository Owner merge authorization and separate production deployment authorization.

## Process state

`AGT-LEAD-001`, acting under the explicit Repository Owner exception for Issue #15, owns the implementation and must post `RESULT_SUBMITTED` for the exact final candidate.

`AGT-QA-001` is the required independent QA actor for this Lead-owned candidate and must post `QA_CONFORM` or concrete findings on the same SHA. `AGT-DATA-001` should separately inspect the persistence-sensitive runtime change for database/persistence semantic preservation but does not own implementation or fixes.

Only after implementation-owner `RESULT_SUBMITTED` plus independent same-SHA `QA_CONFORM` may Copilot be explicitly requested as reviewer-only. Copilot findings return to the implementation owner and Copilot must not implement fixes. Material changes require renewed affected QA and a fresh Copilot review. Raelvi (`raelvim`) performs final technical review on the exact unchanged cleared head after Copilot disposition.

No merge, production deployment, secret/environment change, destructive migration or production-data mutation is authorized by this document.

## Residual maintenance risk

Upstream `node-sqlite3` and its `prebuild-install` mechanism are currently deprecated/unmaintained. The immediate Issue #15 repair intentionally does not broaden into a database-driver migration. That longer-term maintenance and supply-chain risk is tracked separately in Issue #56 / PR #57 with `AGT-DATA-001` as implementation owner.
