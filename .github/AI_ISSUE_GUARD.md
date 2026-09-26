# AI Issue-Creation Guard

This file is a mandatory pre-issue hook for every AI actor working in this repository.

Before calling any GitHub issue-creation action, classify the proposed issue.

## BLOCK — do not create an issue

Do not create a GitHub issue when the proposed issue exists only to:
- obtain authorization already supplied by the Repository Owner;
- record an internal governance/process concern;
- ask permission to create a branch, implement, review, test or prepare a PR;
- duplicate an existing issue/story or work already covered by an accepted issue;
- record status, handoff, review sequencing or agent coordination that can live on the existing issue/PR;
- manufacture an issue solely because a process document says an issue/state is required.

Repository Owner instructions such as “fix it”, “solve it”, “implement it”, “go ahead” or equivalent authorize normal branch work within an existing technical story. They do not authorize merge to main.

## ALLOW — create a technical/product story

A new issue may be created only when all are true:
1. It describes distinct actionable technical/product work with an observable outcome.
2. No open issue already covers that scope.
3. The issue is useful independently of AI governance/authorization mechanics.
4. Creating it improves technical traceability rather than merely satisfying a process state.

When uncertain, reuse/comment on the existing issue instead of creating a new one.

This guard does not weaken branch isolation, testing, review, Raelvi final technical review or explicit Repository Owner merge authorization.
