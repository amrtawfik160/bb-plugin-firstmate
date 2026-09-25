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
| agent handoff | `firstmate_watch` → private event-driven durable wakes. |
| CLI wait | `bb firstmate watch` → blocking `threads.wait` for operator use. |
| status protocol | `DONE:` / `BLOCKED:` / `FAILED:` (`WAITING:` = yield on an external run, not a verdict) |
| PR / local merge | `deliver`, `merge` (PR or ff-only local-only) |

No captain thread to open: run `/captain` in any thread. Never spawn a thread
to be captain. A new `/captain` thread is titled and pinned so it stays in
the sidebar (BB will not infer a title from `/captain` alone). Crew threads
must not dispatch nested crews.

Prefer `firstmate_*` tools on a captain thread. CLI works everywhere.

## Commands

`guide`, `toolchain` (read-only native dependency check), `init` (`--real` clones firstmate and overlays `backends/bb.sh`), `scripts`, `fm`
(any `bin/fm-*.sh` with `FM_BACKEND=bb`), `deck`, `session`, `dispatch`, `crews`,
`crew`, `watch`, `tell`, `interrupt`, `stop`, `retry`, `bearings`, `deliver`,
`merge`, `promote`, `queue`, `decide`, `posture`, `memory`, `afk`, `quiet`,
`secondmate`, `supervision`, `forget`.

`scripts` verifies and searches the complete installed `fm-*` surface; `fm` runs any result through `FM_BACKEND=bb`.
All 21 upstream policy skills are registered for captain threads through the shared BB runtime adapter. Native `dispatch`/`tell`/`watch` use the plugin SDK (Fleet UI, pluginMetadata).
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
5. Call `firstmate_watch` once per crew batch to hand supervision to private event-driven durable wakes, then end the turn and never retry or poll.
   The `bb firstmate watch` CLI remains blocking via BB `threads.wait` for operator use, while `bearings` gives instant status.
   Course-correct a running crew with `tell` (steers into its live turn by default; `--queue` for a non-urgent note); `interrupt` is the hard stop.
6. `deliver` (committed + uncommitted + PR URL), then `merge --yes` when green.
   Local-only uses ff-only onto the project checkout.
7. Promote scouts with `promote` (new ship, report attached).
8. `supervision on` for event pings. `forget --stop` retired crews.
9. Queue with `--after` / `--wait-until`. Decisions via `decide` + AskUserQuestion.
10. Domain captains: `secondmate register`. Dispatch to that project routes there.
11. Persist: `memory set-captain` / `add-learning`; `deck` reprints them.

## Rules

- Run `firstmate_toolchain` once per captain session. Native bootstrap owns AXI
  compatibility floors; missing essential tools block the affected workflow.
- Use `gh-axi`, `quota-axi`, and `lavish-axi` for their native
  roles; read current `--help`. Backlog calls go through the home's
  `bin/fm-tasks-axi.sh`. No-mistakes workers own the actual `no-mistakes axi` run.
- Use `/browser` with `browser_script` (or `bb browser script`) for browser work.
  Leave `profileId` unset for the thread-isolated default. This overrides native
  `chrome-devtools-axi` instructions; do not use the AXI browser or its hooks.
  Lavish artifacts use the native process-event listener after opening, with one
  poller per board.
  BB crews must explicitly read the home's `config/lavish-axi-host` for the open
  command; launcher shell exports do not propagate into BB threads. For a board
  the remote captain should see, use `bb connect expose <port>` and append the
  session path to its returned URL. Do not use Lavish's public sharing command
  unless publishing was requested.

- Never run crew work in captain thread; dispatch it.
- Parent permission is ceiling: request `full` only when parent runs full.
- Never poll crew status or guess thread ids; use crew ids from `crews` for targeted actions.
- firstmate home (`init --real`) is a checkout env, never a nested worktree.
- Prefer `firstmate_fm` / `bb firstmate fm` for policy scripts (brief, gate, PR merge, teardown) once a home exists.
- Use `firstmate_wake` for wake presentation and acknowledgment. Generic `firstmate_fm` / `bb firstmate fm wake-drain` also scopes to this captain and uses at least 180 seconds, even when `timeoutSec` / `--timeout` is shorter; allow the existing call to finish.

## Returning from away mode

BB reconciles accepted human returns on captain activity/idle and before native
spawn. It archives only the matching native away record, under its own lock;
internal wakes and worker messages keep away mode active. Held reports remain
available through `firstmate_afk` with `action: "off"` for the return brief.
For an older stuck session, run `bb firstmate afk reconcile-return --captain
<thread-id>`; it requires the same recorded return evidence and never raises the
worker cap or deletes task records.

Wake receipt handling follows [supervision](../captain/references/supervision.md#durable-wake-handling); complete `handledWake` only after handling the whole batch.
