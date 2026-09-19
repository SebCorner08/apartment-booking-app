# Issue #56 — SQLite driver migration decision record

Implementation owner: `AGT-DATA-001`
Coordinator: `AGT-LEAD-001`
Dependency: Issue #14 must verify the merged Issue #15 runtime fix in production before implementation begins.

## Current compatibility contract

The application currently depends on `sqlite3` through `server/database.js` and expects:

- the existing SQLite file at the resolved `RESERVATIONS_DB_PATH` (production: `/var/data/reservations.db`);
- callback-style `run`, `get`, `all`, `serialize` and `close`;
- `run` callbacks with `this.changes` and `this.lastID`;
- read-only vs read-write/create open modes for tests/runtime;
- ordered schema bootstrap/migrations before `db.ready` and `db.pricingReady` resolve;
- parameterized SQL;
- explicit `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` semantics for booking holds;
- no data-format conversion during ordinary application startup.

Any replacement should preserve this contract or provide a narrow adapter so booking/payment/pricing code does not have to be rewritten at the same time.

## Candidate options

### 1. better-sqlite3 — preferred implementation candidate

Why it is the leading candidate:
- actively maintained with current releases in 2026;
- supports current Node LTS/current majors and publishes prebuilt binaries;
- uses the same SQLite database file format, so the existing `/var/data/reservations.db` can remain in place;
- supports prepared statements and explicit transactions.

Fresh upstream verification on 2026-09-18:
- latest upstream release is `v13.0.3`, published 2026-08-05;
- that exact release declares `engines.node: >=22`, which is compatible with the Node 22 production target currently proposed by Issue #15;
- its published package includes platform-specific exports/prebuild content for Linux x64/arm64, Linux musl, macOS and Windows;
- because Issue #15 exposed a real native-binary/glibc incompatibility, Data must still verify the exact `better-sqlite3` Linux x64 artifact on the Render runtime before treating prebuilt availability as sufficient evidence.

Tradeoff:
- its native API is synchronous, unlike the current callback-style node-sqlite3 API.

Recommended approach:
- introduce `server/sqlite-adapter.js` that exposes the small callback-compatible surface already consumed by this repository;
- keep existing routes/services unchanged initially;
- implement `run/get/all/serialize/close` compatibility plus `changes/lastID` callback context;
- preserve explicit SQL transaction statements and current bootstrap ordering;
- make a clean-install/native-load check on the exact Render-compatible Node/runtime part of the Data-owner validation matrix before implementation is submitted.

Upstream:
- https://github.com/WiseLibs/better-sqlite3
- https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3
- https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/package.json

### 2. Node built-in node:sqlite — monitor, not preferred for this migration yet

Node provides `node:sqlite` without a third-party package. It removes a third-party native packaging dependency, but the current Node documentation still marks SQLite as release-candidate stability rather than stable. Its API is also synchronous and would need the same adapter work.

Fresh runtime verification on 2026-09-18:
- Node 22 and Node 24 are both currently LTS lines;
- Node 26 is the current line;
- `node:sqlite` is still Stability `1.2` (Release candidate) in current Node documentation, including Node 26.9.0-era docs, so moving to a newer runtime does not yet eliminate the API-stability concern.

Because Issue #15 intentionally aligns production to Node 22.x, adopting `node:sqlite` now would couple this persistence migration to a still-evolving runtime API. Re-evaluate when Node's SQLite API reaches stable status on the production Node line.

Upstream:
- https://nodejs.org/api/sqlite.html
- https://nodejs.org/en/about/previous-releases

## Proposed migration design

1. Wait for Issue #14 to verify a successful production deploy of the merged Issue #15 runtime fix.
2. Refresh this branch from that exact main revision.
3. Add `better-sqlite3` and remove `sqlite3` only on this dedicated branch.
4. Add a callback-compatibility adapter and route `server/database.js` through it.
5. Keep the existing SQLite file path and schema unchanged.
6. Run bootstrap/schema compatibility against a copy of an existing database.
7. Run full booking/payment/persistence regressions before any migration candidate is submitted.
8. Do not delete or transform the production database file.

## Data compatibility and rollback

Data migration should be unnecessary because both drivers operate on the same SQLite file format.

Before production deployment:
- take a file-level backup of `/var/data/reservations.db`;
- record checksum/size and verify SQLite can open the backup;
- deploy only after exact-head review gates complete.

Rollback:
- restore the previous application revision/dependency;
- keep the same SQLite database file if no schema change occurred;
- if a later implementation requires any schema change, that change must receive a separate forward/rollback migration plan before merge.

## Required test matrix

- fresh empty-database bootstrap;
- existing database bootstrap with compatibility ALTER statements;
- read-only test mode;
- `run` changes/lastID callback compatibility;
- parameterized `get/all/run`;
- pricing readiness ordering;
- duplicate Stripe webhook/session idempotency;
- overlapping booking/hold transaction behavior;
- hold release/confirm behavior;
- persistent database path behavior;
- clean install plus native-driver load on the exact production-target Node/runtime environment;
- full current `npm test` suite.

## Process state

This is a planning/decision record only. `AGT-DATA-001` remains the implementation owner.

After Issue #15 is complete, Data should validate the preferred driver against current upstream/runtime constraints, implement the adapter on this branch and post exact-head `RESULT_SUBMITTED` with migration/rollback evidence. Independent same-SHA `QA_CONFORM` remains required before any Copilot reviewer request. Raelvi final technical review remains last before Repository Owner merge authorization.


## Post-merge sequencing — 2026-09-18

Issue #15 has merged into `main@8ce680d8e6e3b61a9a714c144600e2425d397054`, but its production compatibility fix has not yet been proven by a successful Render deployment. Issue #14 now owns that verification gate.

Accordingly:
- this branch is synchronized to the merged application baseline;
- Data implementation remains blocked until #14 confirms the current SQLite driver/runtime path actually deploys successfully;
- after #14 reaches `VERIFIED`, AGT-DATA-001 may implement the maintained-driver migration on this same branch using the documented compatibility adapter, migration/rollback plan and test matrix;
- do not use Issue #56 as a workaround for the still-unverified production release.


## Production baseline verified — 2026-09-19

The immediate runtime/deployment dependency is now satisfied.

Render evidence on authoritative service `srv-daj8qnu7bikc73b4q070`:
- `main@7bd3db74d83dfa5d3a07b67d5b00c0efbbff8fa7` deployed `live`;
- current `main@d3f9169deab84f9bd133576dddd593f8e7ef3232` also deployed `live`;
- Render used Node `22.23.2`;
- actual build command was `npm ci && npm rebuild sqlite3 --build-from-source`;
- npm audit reported 0 vulnerabilities;
- source rebuild completed successfully;
- startup connected to `/var/data/reservations.db` and the service became live.

Therefore Issue #56 is no longer blocked on proving the existing sqlite3 runtime path.

New sequencing constraint:
- Data-owned P1 Issue #62 (manual-charge Stripe-session durability) takes priority over this P2 driver migration because it affects payment/persistence correctness.
- After #62 reaches a stable reviewed state, AGT-DATA-001 may proceed with this migration on the same branch.
