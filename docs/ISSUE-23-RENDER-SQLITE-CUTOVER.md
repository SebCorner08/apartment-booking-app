# Issue #23 — Render SQLite persistence cutover

This document is the production safety gate for moving the booking database from Render's ephemeral application filesystem to the persistent disk mounted at `/var/data`.

## Important

Do **not** merge/deploy this change, sync the Blueprint, attach a disk, change `RESERVATIONS_DB_PATH`, or restart/redeploy the production service until the Repository Owner separately authorizes the production step and the current live SQLite database has been inventoried and backed up off-service.

The active service is `escapelakenorman-api` at `https://escapelakenorman-api-l2da.onrender.com`.

## Application behavior

- Outside production, without `RESERVATIONS_DB_PATH`, the app keeps the local-development fallback: `server/reservations.db`. Production requires an explicit path.
- `DATABASE_PATH` is accepted only as a compatibility alias.
- After the cutover, production must use `RESERVATIONS_DB_PATH=/var/data/reservations.db`.
- `RESERVATIONS_DB_PATH` is intentionally omitted from `render.yaml`. It is a manually owned Render environment variable so a future Blueprint sync cannot overwrite the production cutover value.

## Pre-cutover inventory and backup — REQUIRED

Before any action that can restart or redeploy the current service:

1. Record the current production service/deploy SHA and confirm the app is still reading the existing `server/reservations.db`.
2. Inspect the current database with a read-only SQLite connection and record at least:
   - `PRAGMA integrity_check` result;
   - file size and modification time;
   - row counts for `bookings`, `booking_holds`, `external_blocks`, `tax_settings`, and `manual_charges`.
3. Create an **off-service backup** of the current `server/reservations.db`. The backup must not live only on Render's ephemeral filesystem.
4. Verify the backup independently with `PRAGMA integrity_check` and the same row counts.
5. Record a checksum of the backup (for example SHA-256) and keep the backup until the post-restart persistence verification is complete.

If any inventory or backup step fails, stop. Do not deploy or attach/sync the disk.

## Cutover sequence

Only after the pre-cutover backup is verified and the Repository Owner authorizes the production change:

1. Apply/sync the Render service configuration that creates the 1 GB persistent disk at `/var/data`.
2. Restore the verified pre-cutover backup to `/var/data/reservations.db`.
3. Before switching application traffic to it, open `/var/data/reservations.db` read-only and verify:
   - `PRAGMA integrity_check = ok`;
   - row counts match the recorded pre-cutover counts;
   - representative booking/payment identifiers expected to exist are present.
4. In the Render Dashboard, set:
   `RESERVATIONS_DB_PATH=/var/data/reservations.db`
5. Redeploy/restart the service on the reviewed application SHA.
6. Confirm `/health` succeeds and application logs report the resolved database path as `/var/data/reservations.db`.
7. Re-run the read-only integrity/count checks against the persistent file.

## Persistence verification

After the service is healthy on `/var/data/reservations.db`:

1. With explicit owner approval for a controlled production verification, create a reversible sentinel/state record that cannot affect a real guest booking.
2. Confirm the sentinel is present in `/var/data/reservations.db`.
3. Restart/redeploy the service without changing the reviewed application SHA or database path.
4. Confirm the sentinel still exists after restart.
5. Remove the sentinel and confirm normal booking availability/payment behavior is unchanged.

If a production sentinel is not approved, use existing immutable row identities plus file checksum/row-count checks across a restart, and record the limitation in verification evidence.

## Rollback

Keep the verified off-service pre-cutover backup until the persistence verification is complete.

If the persistent database cannot be opened or validation fails:

1. Stop accepting the cutover as successful; do not delete either copy.
2. Choose and record an explicit rollback database path on durable storage. Do not clear `RESERVATIONS_DB_PATH`, because the reviewed application intentionally refuses an implicit production fallback.
3. Restore the verified off-service backup to that rollback location and set `RESERVATIONS_DB_PATH` to its exact path.
4. Restart the service and verify integrity/counts before resuming booking traffic.
5. Do not roll back to an older application revision that ignores `RESERVATIONS_DB_PATH` unless the database location for that revision has also been explicitly restored and verified.

Prefer fixing forward on the reviewed revision when practical, because the previous application revision hard-codes the ephemeral database path.

## Non-goals

This cutover does not perform the broader Issue #1 Git-history/privacy cleanup and does not migrate SQLite to Postgres. It does not change Stripe pricing, webhook semantics, frontend behavior, or production secrets.
