# Source backup policy

Git history is the backup for repository source files. Before a release or other important milestone, create an annotated Git tag and publish a GitHub Release when a named, shareable restore point is needed.

Do not copy the source tree into dated backup directories inside the repository. To recover a file, use its commit and path (for example, `git show <commit>:<path>`), or restore the tagged release in a separate branch.

This policy applies to source code only. Runtime databases, uploaded files, secrets and other production data require their own verified off-service backup and recovery process.
