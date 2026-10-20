# Adopt folds existing work into a new workstream

The owner had related work spread over many task worktrees, branches and PRs (Reels, Cyndra SaaS UI, RunAnts) and wanted each group in one workstream, with a new topic and one dev link. Adopt used to group tasks into a topic without merging anything, so each task still went out through its own PR. We decided that Adopt, after the owner approves one card per workstream, makes a new workstream branch and folds each idle crew's saved work into it at once; running crews fold when they finish.

## Considered Options

- **Keep Adopt as grouping only** (ADR 0007's adopted workstreams). Rejected: the owner reviews and ships the same work through many PRs and many dev links.
- **Ask each adopted crew to fold its own work.** Rejected: those crews were briefed before the workstream existed, some have no worktree any more, and some recorded their work under another repository.

## Consequences

- Uncommitted work becomes a backup commit before its fold, so nothing is discarded; scratch files stay behind, and their old worktree is then kept as unsaved work.
- A conflict goes to a new crew in the workstream worktree. Work it cannot merge safely stays a separate task, and the owner is asked once.
- An old worktree is removed by the normal task-worktree cleanup once its work is folded; an adopted crew's branch is never deleted.
- A PR the workstream replaces closes only when the workstream PR holds every one of its commits.
- Workstreams adopted before this keep their old behaviour.
