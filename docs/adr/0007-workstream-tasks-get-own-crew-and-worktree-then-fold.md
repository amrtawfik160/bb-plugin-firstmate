# Workstream tasks get their own crew and worktree, then fold

The owner works on big features in a workstream: one Telegram topic, one workstream branch and one dev link, with many tasks running at once on different models. Before this, every task crew edited the one shared workstream worktree, so only one editing crew could run at a time and new messages were often steered into the running crew. We decided that each task gets a new crew in its own worktree, cut from the workstream branch, and folds its work back into the workstream branch when its own tests pass; the dev link runs the workstream branch and Ship merges only what has folded.

## Considered Options

- **All crews edit the shared workstream worktree at once.** Rejected: crews overwrite each other's files, break each other's test runs, and a commit by one crew can capture another crew's half-done files.
- **Steer every new message into the running crew.** Rejected: it serialises unrelated work and ties every task to one model.

## Consequences

- Fold conflicts are fixed by the crew that made the change, which updates from the workstream branch, retests and folds again.
- A task has one BB-managed checkout, in the repository its dispatch names; BB cannot create a managed worktree for another repository. Its fold is saved before any Git change, so a restart completes or undoes it in every repository.
- Folds wait while a Ship checks and merges, so Ship checks exactly what it merges.
- A folded task's worktree is removed at once; only the workstream branch keeps its work.
- Adopted workstreams, whose tasks have their own branches, keep the old behaviour.
