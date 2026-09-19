Run a firstmate-style agent crew without leaving BB.
Install, then run `/captain` in any thread — that calls `deck` and is the setup.
`deck` titles an untitled thread `Captain · <project>` and pins it so a new
`/captain` row does not vanish from the sidebar.

## What you get

- `/captain` plus `/afk` `/ahoy` `/bearings` `/quiet` `/stow` skills.
- `bb firstmate` + `firstmate_*` tools (full CLI surface, including queue,
  memory, secondmate, quiet, forget). `tell` is a doorbell (`queue-if-active`);
  `interrupt` hard-stops. `watch` uses `threads.wait`.
- Event supervision: `thread.idle` / `thread.failed` / `turn.failed` /
  `interaction.pending`. Stuck checker still samples output. Crews get no
  dispatch tools.
- Real firstmate `bin/` is the default: `/captain` (deck) auto-clones + overlays
  the full toolbelt on first run (or prints one command, `bb firstmate init
  --real`, if the host can't), fast-forwards (ff-only, clean tree) a reused
  clone, and records the actual script/skill counts. Then `bb firstmate fm
  <script>` runs the real policy scripts. BB is the runtime backend
  (`FM_BACKEND=bb`); scripts are not rewritten in TypeScript. Native `dispatch`
  writes `state/<id>.meta` so those scripts see Fleet crews. The overlay `bb`
  backend propagates provider/model/reasoning into the spawn, tags children as
  crews, and lets a completed scout's scratch worktree be discarded.
- On deck the digest shows real `fm-bearings-snapshot` output (authoritative)
  next to the native BB KV digest (labelled cache/fallback).
- `dispatch` and `retry` take `--reasoning-level low|medium|high|xhigh|max`
  (applied from turn 1). `retry` with a `--model`/`--provider`/`--reasoning-level`
  override relaunches a fresh thread in the same worktree instead of resubmitting.
- Fleet sidebar board + thread-header chip + `@crew` mentions.

Parent permission is a ceiling. Ship crews default to an isolated worktree.
Merge needs the captain's word (`--yes` / yolo). Checks: green passes, zero
checks (`no_checks`) counts as no failing checks, and `--allow-red <check-name>`
waives one exact failing check while every other check must stay green — never
silently, and separate from `--yes`. `deck`/`bearings` retire crews whose PR was
merged or closed outside BB.
