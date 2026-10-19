# Owner approval GitHub check

Owner request, 19 October 2026: each merge or production live needs the owner's
approval, unless the owner already told the agent to merge after it finishes or
to deploy to production.

## GitHub status

Firstmate posts a commit status named `Owner approval` on the PR head.

- `success` only after the owner taps Approve on a card that names that PR at
  that head, or a recorded pre-approval still covers the task.
- `pending` for a missing card, a No, a captain cancel, a new author commit, or
  ancestry Firstmate cannot prove.
- A base-only merge of an already approved head keeps `success`.
- The captain resolving an approval card cancels it. That path cannot post
  `success`.

GitHub itself refuses `gh pr merge` only after the install step adds this check
as required on the default branch. Until then, Firstmate still posts the status
and still refuses `firstmate_merge` and Ship without an owner Approve.

## Pre-approval

An owner message that tells the agent to merge after it finishes, or to deploy
to production, is judged by the Decisions model. There is no word list.

The record stores the owner message, a quote of the words, the task, the
project, and whether it allows merge, deploy, or both. It covers PRs of that
task only, and it expires when the task closes. Telegram gets a progress note
that quotes the words.

## Crew check

Crews run `bb firstmate prod-check <project> <merge|deploy>` with the task or
PR before a production merge or deploy. It exits non-zero without an owner
Approve or a live pre-approval.

Firstmate also records deploys it can see (a live pass, a release read-back)
and alerts the repair thread when one has no approval.

## What this cannot prevent

- Every agent on this host runs as root, so deploy credentials cannot be hidden
  from them by file mode.
- A crew that skips `prod-check` can still run Convex deploy, Expo publish, or
  Coolify from a shell.
- Every agent uses the owner's GitHub account, so GitHub cannot tell an agent
  from the owner. Shared GitHub credentials can still post a forged
  `Owner approval` success status, or remove branch protection.
- The merge backstop is the required status check, and only after the install
  step is applied on repos that support required checks.
- The owner stays on the GitHub free plan. These four repos are not enforced
  by GitHub: `amrtawfik160/dr.woo`, `amrtawfik160/safi`,
  `amrtawfik160/areliaa`, `amrtawfik160/bb-plugin-telegram`. There the
  Firstmate merge and Ship gate is the only check.

## Install step

`scripts/install-owner-approval.ts` reports, per repository, whether a required
check can be enforced. `--dry-run` is the default and prints the exact change
and an undo command. `--apply` is for the repair thread after the owner
approves. This change never runs `--apply`.

The installer skips those four free-plan repos cleanly: no GitHub call, no PUT,
no retry, and no error. Firstmate merge and Ship remain the gate there.

## Evidence

- `success status only after an owner Approve naming the PR at its head`
- `a new author commit after owner Approve posts pending`
- `captain firstmate_resolve_ask on an approval card cancels it (a7ro6jg)`
- `prod-check refuses without approval and succeeds after an owner Approve`
- `a seeded pre-approval covers only that task and expires when the task closes`
- `plain gh pr merge is refused while Owner approval is a required check that is not success`
- `the install script dry-run keeps every existing protection rule`
- `the install script --apply PUTs Owner approval and keeps every existing rule`
- `the install script --apply does not PUT when required checks cannot be enforced`
- `the install script skips GitHub free-plan repos with no gh call, no PUT, and no error`
