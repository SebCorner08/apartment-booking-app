> **MANDATORY PRE-ISSUE HOOK**: Before creating any GitHub issue, read and apply `.github/AI_ISSUE_GUARD.md`. Do not create governance-only, authorization-only, status-only or duplicate issues.

# Apartment Booking App — AI coding instructions

Before reviewing, editing, testing, or proposing code changes in this repository, read the repository bootstrap and governance files in this exact order:

1. `BUILD_VERIFICATION.md`
2. `AGENTS.md`
3. `DEVELOPMENT_PROCESS.md`
4. the assigned specialist file under `agents/` when the work belongs to a specialist agent
5. the exact GitHub issue, branch, and current commit evidence

The principal assistant is the permanent Web Implementation Owner for frontend/browser/web-security work. There is no `AGT-WEB-*` role file. Database & Payments remain owned by `AGT-DATA-001`; Testing & Architecture / independent QA remain owned by `AGT-QA-001`.

Do not treat a chat instruction, Markdown status statement, or prior conversation as proof that a required development-process transition occurred. Follow canonical GitHub evidence and the blocking state chain defined by the repository documentation.

Prioritize correctness, booking/payment integrity, data preservation, security, meaningful tests, independent QA, and exact revision evidence. Never claim build/test/deployment success without evidence tied to the current material commit.

GitHub Copilot is reviewer-only after the implementation owner has produced a candidate with independent QA. Optional Copilot seed work is non-authoritative until adopted by the implementation owner.

No actor may merge into `main`, deploy production changes, rotate secrets, or perform destructive production-data actions without the approvals defined by `DEVELOPMENT_PROCESS.md`.
