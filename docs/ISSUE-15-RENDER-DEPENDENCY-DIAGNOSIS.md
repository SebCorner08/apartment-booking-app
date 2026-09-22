# Issue #15 — Dependency remediation, Render diagnosis and recovery record

Implementation owner: `AGT-LEAD-001` under the explicit Repository Owner exception authorizing Lead implementation of Issue #15
Independent QA: `AGT-QA-001` required on the exact final candidate; Lead may not self-issue `QA_CONFORM`
Database/persistence reviewer: `AGT-DATA-001`
Recovery baseline: `main@8ce680d8e6e3b61a9a714c144600e2425d397054`

## Root cause established

The dependency vulnerability remediation upgraded the runtime dependency tree to `sqlite3@6.0.1`. GitHub CI could install and execute that dependency, but Render production startup failed when the downloaded native sqlite3 artifact required `GLIBC_2.38`.

Authoritative Render service: `srv-daj8qnu7bikc73b4q070`
Authoritative URL: `https://escapelakenorman-api-l2da.onrender.com`
Persistent database path: `/var/data/reservations.db`

Last known live production revision remains `600faf72cafe9500e8da6c92b845f7816eac7919`.

The earlier failed remediation path also allowed Render to resolve an unbounded Node engine to Node 26.9.0. PR #54 attempted to narrow the engine and to compile sqlite3 from source with:

`npm ci && npm rebuild sqlite3 --build-from-source`

The source-rebuild path is still the intended solution to the GLIBC mismatch.

## Post-merge process and deployment state

PR #54 merged as `8ce680d8e6e3b61a9a714c144600e2425d397054` while its canonical state still recorded `RESULT_SUBMITTED / AWAITING_INDEPENDENT_QA`. The required same-SHA independent QA and Raelvi final review had not completed before that merge.

Render automatically attempted the merged revision. The attempt selected Node 22.23.2 but used the prior deployment snapshot's `npm install` command instead of the newly synchronized Blueprint build command. Startup therefore still loaded an incompatible sqlite3 prebuilt and failed with `GLIBC_2.38 not found`. The authoritative service metadata now shows the intended source-build command, but no further production deployment is authorized by this recovery work.

A later reviewer-only Copilot review arrived after the merge and identified an additional valid consistency finding: `package.json` declared `engines.node` as `>=22.9.0 <23` while the root metadata in `package-lock.json` still declared `>=22.9.0`.

## Recovery strategy

The recovery resolves the reviewer finding without hand-editing dependency resolution data and makes the runtime pin explicit in a source Render reads with higher precedence than `package.json` engines:

1. `.node-version` pins the supported runtime to exact Node `22.23.2`, the Node 22 version observed in the latest Render attempt.
2. `package.json` restores `engines.node` to `>=22.9.0`, matching the root `package-lock.json` metadata exactly. The package engine remains compatibility metadata rather than the deployment-version selector.
3. GitHub Actions reads the same `.node-version` file so CI and Render resolve the identical Node runtime.
4. CI explicitly fails if `package.json` and `package-lock.json` root `engines.node` values diverge again.
5. `render.yaml` keeps `npm ci && npm rebuild sqlite3 --build-from-source`; no production deploy is performed by this PR.

Render's documented Node-version precedence is `NODE_VERSION` environment variable, then `.node-version`, then `.nvmrc`, then `package.json` `engines.node`. The recovery intentionally uses `.node-version` so the exact Node 22 runtime is deterministic while manifest and lockfile metadata remain internally consistent.

## Exact-head evidence requirement

For the final recovery candidate, required evidence is:

- runtime metadata consistency check;
- exact Node version sourced from `.node-version` in CI;
- clean `npm ci`;
- sqlite3 source rebuild;
- `node -e 'require("sqlite3")'` native-load verification;
- `npm audit --audit-level=high`;
- full isolated regression tests;
- independent same-SHA `QA_CONFORM` before any Copilot reviewer request;
- `AGT-DATA-001` review of persistence-sensitive implications;
- fresh Copilot reviewer-only review after QA;
- Raelvi final technical review on the exact unchanged cleared head.

No production deployment is part of this recovery PR. Runtime verification on Render belongs to Issue #14 only after the complete review chain, separate Repository Owner merge authorization and separate production deployment authorization.

## Residual maintenance risk

Upstream `node-sqlite3` and its `prebuild-install` mechanism remain deprecated/unmaintained. This recovery intentionally does not broaden into a database-driver migration. The longer-term migration remains Issue #56 / PR #57 with `AGT-DATA-001` as implementation owner and is blocked until Issue #14 establishes a verified production baseline.
