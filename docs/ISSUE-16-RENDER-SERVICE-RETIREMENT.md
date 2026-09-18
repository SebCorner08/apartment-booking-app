# Issue #16 — Render duplicate-service retirement gate

Owner/coordinator: AGT-LEAD-001
Repository baseline synchronized: `a7fe73ab7ebe1df2ba3376ae4bb0804f117b493e`

## Authoritative service

Authoritative backend:
- name: `escapelakenorman-api`
- service id: `srv-daj8qnu7bikc73b4q070`
- branch: `main`
- health path: `/health`
- public URL: `https://escapelakenorman-api-l2da.onrender.com`

The repository Blueprint naming has already been reconciled so `render.yaml` targets the authoritative service name.

## Non-authoritative services

Last verified non-authoritative services:
- `srv-dajh43gae00c739v1vr0` — `escapelakenorman-api-l2da`
- `srv-daj05vgae00c7385b8p0` — `apartment-booking-app`

Previous read-only verification found both suspended but still existing with auto-deploy enabled.

## Completion checklist

Before Issue #16 can close:

1. Confirm the Render workspace explicitly.
2. Recheck all three service identities before any destructive action.
3. Confirm the authoritative service remains active and unchanged.
4. Disable auto-deploy for both non-authoritative services.
5. Retire/delete both non-authoritative services only with the already-recorded owner authorization and after rechecking IDs.
6. Re-list services and confirm only the authoritative service remains for this repository.
7. Confirm frontend and Stripe webhook still target only the authoritative URL.

The currently available Render connector does not expose service deletion or auto-deploy update operations. Do not substitute unrelated service mutations or reactivate a suspended service.

## Process state

This document is Lead operational-coordination evidence, not proof that the external Render cleanup is complete.

Next action: perform the retirement steps through an authorized Render control surface after explicit workspace confirmation, then record the final inventory in Issue #16.

No deployment, secret change, database change or service deletion is performed by this document.
