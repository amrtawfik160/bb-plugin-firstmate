---
name: firstmate
description: Run a firstmate-style crew inside BB — captain thread dispatches crewmate child threads via `bb firstmate` or firstmate_* tools. Use when user mentions firstmate, crew, crewmates, captain, or parallel agents.
---

# Firstmate crews in BB

Talk to one agent, ship with a crew. BB mapping:

| firstmate | BB here |
| --- | --- |
| captain (first mate) | this thread after `deck` / `/captain` |
| crewmate / scout | child thread (`dispatch --shape ship\|scout`) |
| tmux windows | BB threads (`backends/bb.sh`) / `bb thread show` |
| treehouse worktree | BB managed-worktree (backend owns it, like Orca) |
| watcher | `thread.idle` / `thread.failed` events + stuck checker |
| wait | `bb firstmate watch` → `threads.wait` (do not poll) |
| status protocol | `DONE:` / `BLOCKED:` / `FAILED:` |
| PR / local merge | `deliver`, `merge` (PR or ff-only local-only) |

No captain thread to open: run `/captain` in any thread. Never spawn a thread
to be captain. A new `/captain` thread is titled and pinned so it stays in
the sidebar (BB will not infer a title from `/captain` alone). Crew threads
must not dispatch nested crews.

Prefer `firstmate_*` tools on a captain thread. CLI works everywhere.

## Commands

`guide`, `init` (`--real` clones firstmate and overlays `backends/bb.sh`), `fm`
(any `bin/fm-*.sh` with `FM_BACKEND=bb`), `deck`, `session`, `dispatch`, `crews`,
`crew`, `watch`, `tell`, `interrupt`, `stop`, `retry`, `bearings`, `deliver`,
`merge`, `promote`, `queue`, `decide`, `posture`, `memory`, `afk`, `quiet`,
`secondmate`, `supervision`, `forget`.

Native `dispatch`/`tell`/`watch` use the plugin SDK (Fleet UI, pluginMetadata).
Crews spawn visible so they nest under the captain in the BB sidebar (`--hidden` to hide).
When `fmHome` is set, `dispatch` also writes `state/<id>.meta` so peek/send/teardown
see Fleet crews. `fm` is the real toolbelt. Both talk to BB threads.

Run `bb firstmate --help` for flags. `--json` when output drives code.

## Procedure

1. `deck` once per captain session, then dispatch — never do crew work here.
2. `--shape scout` for read-only research (never a PR). `--shape ship` (default)
   implements in its own worktree. Audit/review/diagnose → scout.
3. Ship isolation is default. Never two ship crews on one checkout.
4. Fan out with repeat `--task` (max 10). Brief = Captain's intent + spec.
5. Supervise with `watch` or `bearings`. Course-correct a running crew with `tell` (steers into its live turn by default; `--queue` for a non-urgent note); `interrupt` is the hard stop.
6. `deliver` (committed + uncommitted + PR URL), then `merge --yes` when green.
   Local-only uses ff-only onto the project checkout.
7. Promote scouts with `promote` (new ship, report attached).
8. `supervision on` for event pings. `forget --stop` retired crews.
9. Queue with `--after` / `--wait-until`. Decisions via `decide` + AskUserQuestion.
10. Domain captains: `secondmate register`. Dispatch to that project routes there.
11. Persist: `memory set-captain` / `add-learning`; `deck` reprints them.

## Rules

- Never run crew work in captain thread; dispatch it.
- Parent permission is ceiling: request `full` only when parent runs full.
- Poll with crew id from `crews`, never guess thread ids. Waiting = `watch`.
- firstmate home (`init --real`) is a checkout env, never a nested worktree.
- Prefer `firstmate_fm` / `bb firstmate fm` for policy scripts (brief, gate, PR merge, teardown) once a home exists.
