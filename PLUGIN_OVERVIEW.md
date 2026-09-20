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
  writes a complete `state/<id>.meta` (harness/provider/model/effort) and
  scaffolds the authoritative structured brief `data/<id>/brief.md` (Captain's
  intent / Firstmate spec) via the real `fm-brief.sh`, so those scripts see Fleet
  crews. The overlay `bb` backend propagates provider/model/reasoning into the
  spawn, tags children as crews, and lets a completed scout's scratch worktree be
  discarded.
- Real transport (opt-in, `transport=real`): `dispatch` routes end-to-end through
  the real `fm-brief.sh` + `fm-spawn.sh` (backend=bb) so the real scripts create
  the brief, worktree, thread, `state/<id>.meta` and profile
  (harness/provider/model/effort). If the real spawn fails **before** a thread
  exists, dispatch falls back to native BB spawn automatically; it never
  double-spawns (an already-recorded `bb_thread_id` is adopted, not re-spawned).
  Default `transport=native` keeps the current behavior — flip the setting to opt
  in, flip it back to turn it off without a redeploy.
- Watch ownership (opt-in, `watchOwner=fm-watch`): the real `fm-watch` owns
  supervision policy (wedge evidence, steering re-rings, heartbeat); BB idle/
  error/done events still flow as delivery/acceleration but BB no longer pages the
  captain about a stuck crew, so there is no double-paging. Default
  `watchOwner=native` keeps BB's stuck-pass. Falls back to native when real mode
  is off.
- Version-pinned real skills inventory: on init/deck (and when `fmHome` HEAD
  moves) the plugin reads `fmHome/.agents/skills` and stores a version-pinned
  manifest, then injects that inventory into captain sessions so the captain knows
  the real policy skills and reads/runs them through the toolbelt. (BB plugins
  cannot register a dynamic skill root from `configure()`, so the real skill
  *content* is surfaced through the toolbelt rather than falsely re-registered;
  crews still get none.)
- Authoritative real state, rebuildable KV cache: `bb firstmate migrate-state`
  imports the KV crew cache into real `state/<id>.meta` + briefs, idempotently,
  without overwriting active work, and skipping terminal (done/failed) crews so
  the watcher can't resurrect dead work. KV stays a cache that only accelerates.
- Full status protocol: the fold (`working` / `needs-decision` / `blocked` /
  `paused` / `done` / `failed`, with keyed `resolved`/`captain-held` closes) is a
  faithful port of `fm-classify-lib.sh`'s algorithm. `crew` folds the real
  `state/<id>.status` when available (which carries the closes); `bearings` folds
  the crew's chat output (no host read, so no closes) and therefore also drops
  open decisions once the crew's latest status is terminal. An idle crew with an
  open `needs-decision` is a Captain's Call, not review-ready. Answering via
  `tell --resolve-key <key>` writes the closing `resolved` line into real state.
- Captain sessions load the real `fmHome/AGENTS.md` captain contract as dynamic
  instructions (crews still get no captain tools/skills).
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
