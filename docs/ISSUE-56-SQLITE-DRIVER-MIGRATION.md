# Issue #56 — SQLite driver migration decision record

Implementation owner: `AGT-DATA-001`
Coordinator: `AGT-LEAD-001`
Dependency: Issue #15 must establish a stable deployable baseline first.

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

Tradeoff:
- its native API is synchronous, unlike the current callback-style node-sqlite3 API.

Recommended approach:
- introduce `server/sqlite-adapter.js` that exposes the small callback-compatible surface already consumed by this repository;
- keep existing routes/services unchanged initially;
- implement `run/get/all/serialize/close` compatibility plus `changes/lastID` callback context;
- preserve explicit SQL transaction statements and current bootstrap ordering.

Upstream:
- https://github.com/WiseLibs/better-sqlite3
- https://github.com/WiseLibs/better-sqlite3/releases

### 2. Node built-in node:sqlite — monitor, not preferred for this migration yet

Node provides `node:sqlite` without a third-party package. It removes a third-party native packaging dependency, but the current Node documentation still marks SQLite as release-candidate stability rather than stable. Its API is also synchronous and would need the same adapter work.

Because Issue #15 intentionally aligns production to Node 22.x, adopting `node:sqlite` now would couple this persistence migration to a still-evolving runtime API. Re-evaluate when Node's SQLite API reaches stable status on the production Node line.

Upstream:
- https://nodejs.org/api/sqlite.html

## Proposed migration design

1. Wait for Issue #15 to complete and establish the deployable baseline.
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
- full current `npm test` suite.

## Process state

This is a planning/decision record only. `AGT-DATA-001` remains the implementation owner.

After Issue #15 is complete, Data should validate the preferred driver against current upstream/runtime constraints, implement the adapter on this branch and post exact-head `RESULT_SUBMITTED` with migration/rollback evidence. Independent same-SHA `QA_CONFORM` remains required before any Copilot reviewer request. Raelvi final technical review remains last before Repository Owner merge authorization.
