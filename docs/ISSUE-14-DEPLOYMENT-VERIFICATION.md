# Issue #14 — Render deployment verification gate

Owner/coordinator: AGT-LEAD-001
Repository baseline synchronized: `a7fe73ab7ebe1df2ba3376ae4bb0804f117b493e`

## Repository state

The repository contains the authoritative Render Blueprint at `render.yaml`. Current `main` includes the merged persistence, dependency, CI, authentication/security and pricing work.

The Issue #14 repository branch is synchronized to current `main`. No additional application-code change is required merely to represent the deployment task.

## Required production verification

Issue #14 is complete only after the authoritative Render service is verified against the intended current release candidate:

1. Confirm the Render workspace before any workspace-scoped action.
2. Confirm the authoritative service is `escapelakenorman-api` and is the only active service used by the frontend and Stripe webhook.
3. Confirm the deployed Git SHA matches the release candidate.
4. Confirm build/install completed successfully with the actual Render Node runtime.
5. Confirm startup succeeds and SQLite opens the persistent `/var/data/reservations.db` path.
6. Confirm `/health` returns success.
7. Confirm required production configuration is present, including `AIRBNB_ICAL_URL` when Airbnb synchronization is part of acceptance.
8. Run a non-destructive browser-to-backend booking smoke test using safe/test conditions; do not create a real charge unless separately authorized.

## Known blockers

- The Render connector currently has no confirmed workspace in this session, so no workspace-scoped deploy/log/config action may be assumed.
- Earlier evidence recorded a post-dependency-remediation deployment regression; Issue #15 owns diagnosis of that runtime/build problem.
- Do not redeploy blindly or change production environment variables/secrets without the required Repository Owner authorization.

## Process state

This document is Lead release-coordination evidence. It does not claim deployment success for `a7fe73ab7ebe1df2ba3376ae4bb0804f117b493e`.

Next action: resolve/verify Issue #15, confirm the Render workspace and perform the production verification checklist. No merge, deployment, secret change or production-data mutation is authorized by this document.


## Fresh production state

Render workspace is now confirmed as `tea-dairtdjm8hqs73e23iv0`.

The authoritative service attempted to auto-deploy current `main@a7fe73ab7ebe1df2ba3376ae4bb0804f117b493e` as deploy `dep-dam9k2ss728c73avljo0`. The build succeeded but runtime startup failed due Issue #15's sqlite3 native `GLIBC_2.38` incompatibility.

Render retained the previous live revision `600faf72cafe9500e8da6c92b845f7816eac7919`. Its runtime connects to `/var/data/reservations.db` and starts successfully. Its logs also report `AIRBNB_ICAL_URL` is not configured.

Issue #14 therefore cannot reach `VERIFIED` until Issue #15 is corrected and a reviewed current release revision deploys successfully.
