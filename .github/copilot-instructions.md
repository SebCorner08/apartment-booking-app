# Apartment Booking App — AI coding instructions

Before reviewing, editing, testing or proposing code changes in this repository, read the repository bootstrap and governance files in this exact order:

1. `BUILD_VERIFICATION.md`
2. `AGENTS.md`
3. `DEVELOPMENT_PROCESS.md`
4. the assigned specialist file under `agents/` when the work belongs to a specialist agent
5. the exact GitHub issue, branch and current commit evidence

The principal assistant is the permanent Web Implementation Owner for frontend/browser/web-security work. There is no `AGT-WEB-*` role file. Database & Payments remain owned by `AGT-DATA-001`; Testing & Architecture remain owned by `AGT-QA-001`, which normally provides independent QA when another actor owns implementation.

Do not treat a chat instruction, Markdown status statement or prior conversation as proof that a required development-process transition occurred. Follow canonical GitHub evidence and the blocking state chain defined by the repository documentation.

Prioritize correctness, booking/payment integrity, data preservation, security, meaningful tests, mandatory independent same-SHA QA and exact revision evidence. Never claim build/test/deployment success without evidence tied to the current material commit.

## ABSOLUTE COPILOT RESTRICTION

GitHub Copilot is reviewer-only. It must never be assigned as a coding/implementation agent or create/modify implementation code, branches, commits, PRs, patches or fixes.

For every code PR, Copilot may only be explicitly requested to review an existing PR after:
1. the designated implementation owner has posted `RESULT_SUBMITTED` for the exact final candidate SHA; and
2. an independent reviewer has posted `QA_CONFORM` for that same unchanged SHA.

Copilot findings return to the implementation owner. Copilot must not implement fixes. A material change after QA or Copilot review requires renewed affected QA and a fresh Copilot review before Raelvi final technical review.

Any Copilot-generated implementation artifact is unauthorized and must not be adopted, copied, cherry-picked or otherwise used unless the Repository Owner gives a separate explicit exception naming the exact artifact and permitted use.

No actor may merge into `main`, deploy production changes, rotate secrets or perform destructive production-data actions without the approvals defined by `DEVELOPMENT_PROCESS.md`.
