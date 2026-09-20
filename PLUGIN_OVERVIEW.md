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
  double-spawns. Ordering contract: `fm-spawn.sh` sets `BB_ABORT_CLEANUP` for the
  whole window between `bb thread spawn` and the `state/<id>.meta` write, so a
  graceful failure cleans up its own thread; only a hard-kill (SIGKILL / host
  death) can orphan one. For that window the plugin reconciles before falling
  back: it adopts an already-created thread (matched by the `fm-<id>` title or the
  `crewId` recorded by `mark-crew --task`) instead of spawning a second. Default
  `transport=native` keeps the current behavior — flip the setting to opt in, flip
  it back to turn it off without a redeploy.
- Watch ownership (opt-in, `watchOwner=fm-watch`): a plugin-managed background
  service (`fm-watch-supervisor`) launches and keeps the **real `fm-watch`** alive
  against `fmHome` (via `fm-watch-arm.sh`, backend=bb), relays its wake reasons to
  the captain, and reads its liveness beacon (`state/.last-watcher-beat`). BB only
  suppresses its own stuck-page **while that beat is live** (fresher than
  `watchHeartbeatSec`, default 90s); if the watcher is stale/absent BB pages as
  before, so there is never a silent supervision gap — and no double-paging while
  both are live. Default `watchOwner=native` keeps BB's stuck-pass; falls back to
  native when real mode is off. Hardened for multi-host fleets: the supervisor
  runs and beats **one fm-watch per crew host** (per-host beacon keys), and BB's
  stuck-suppression is decided **per crew's own host** — a live watcher on host A
  never silences a stuck crew on host B. Relaunch uses exponential backoff (60s →
  30m cap) so a crash-looping watcher is not re-spawned every cycle. Wake-reason
  relay is scoped: only actionable `signal:`/`stale:` lines go to the **owning
  captain** (the crew named in the line), deduped with volatile counters/times
  normalized out; routine `check:`/`heartbeat:` trace is never relayed.
- Read-through (opt-in, `readThrough=true`): real `state/<id>.meta` is the source
  of truth for crew existence. On each crews/bearings/deliver read, one batched
  host read reconciles the KV cache and drops crews the real plane no longer
  tracks (torn down). One `ls`-style read per call, never per-crew round trips; a
  failed read never drops a crew, and a crew whose **dispatch-time meta write is
  known to have failed** (`metaWritten=false`, e.g. the host was briefly down) is
  never reaped — its current absence is not proof of teardown; `migrate-state`
  backfills the meta and clears the flag. Default off = KV cache only.
- Version-pinned real skills inventory: on init/deck (and when `fmHome` HEAD
  moves) the plugin reads `fmHome/.agents/skills` and stores a version-pinned
  manifest, then injects that inventory into captain sessions so the captain knows
  the real policy skills and reads/runs them through the toolbelt. (BB plugins
  cannot register a dynamic skill root from `configure()`, so the real skill
  *content* is surfaced through the toolbelt rather than falsely re-registered;
  crews still get none.) Caveat: the inventory refreshes on init/deck (and only
  re-persists when `fmHome` HEAD moved) — if HEAD moves without a re-deck, the
  injected list is stale until the next deck.
- Authoritative real state, rebuildable KV cache: `bb firstmate migrate-state`
  imports the KV crew cache into real `state/<id>.meta` + briefs, idempotently,
  without overwriting active work, and skipping terminal (done/failed) crews so
  the watcher can't resurrect dead work. KV stays a cache that only accelerates.
- Real-plane owners (opt-in, one flag each; default `kv` = today's behavior).
  Each `firstmate_*` tool/CLI keeps its signature; when its owner is `real` the op
  routes through the native owner and is written through to the KV cache. Any
  host/read failure degrades to the KV path with a clear log:
  - `queueOwner=real` — the backlog routes through `fm-tasks-axi.sh` /
    `data/backlog.md`. `add` records the real row id (parsed only from an
    unambiguous `id:`/`#`/bare-token form; ambiguous output quarantines the row so
    it is never re-added or transitioned against a guessed id); `dispatch`/`done`/
    `drop` drive the paired `start`/`done`/`rm` transition only when an id was
    positively parsed. Needs `tasks-axi` on the host; if it is missing (exit 2) the
    KV backlog still works, without a row id.
  - `decisionsOwner=real` — a decision is an ordinary **captain-held backlog task**
    (`fm-captain-hold.sh hold`); `answer` closes the held row
    (`fm-captain-hold.sh answer --decision-file`) and writes the `resolved [key=…]`
    close onto the linked crew's real `state/<id>.status` via the existing
    `appendResolvedStatus`. `defer` uses `hold --until`; `drop` uses `tasks-axi rm`.
  - `afkOwner=real` — AFK on proposes+confirms the durable `state/.afk-contract`
    (`fm-afk-contract.sh`) and sets the `state/.afk` flag, so real `fm-merge`/
    `fm-watch` (via `fm-merge-authority-lib`) see the same away authority and merge
    grants (CLI `--grant <task-id>`). `off` archives the contract; `status` reads
    `validate`/`grants`. KV still owns held-ping delivery for the return brief.
  - `quietOwner=real` — quiet writes the native `state/.afk` flag with first line
    `quiet` (the afk-skill quiet mode). When both `afkOwner` and `quietOwner` are
    `real` they share the one native flag (as in native firstmate); the flag is
    always recomputed from both KV states (away outranks quiet) so toggling one
    never clobbers the other.
  - `memoryOwner=real` — captain prefs and learnings live in the tiered stow files
    `data/captain.md` (pinned) and `data/learnings.md` (aging; each line carries a
    `<!--a:YYYY-MM-DD-->` reinforced-date marker). `show` reads the real files.
  Free text is written to host files as a base64 payload decoded on the host (never
  interpolated into the shell command), so no line of user/agent text can inject a
  command or truncate a file; the read-modify-write of the learnings file is
  serialized in-process against concurrent tool calls.
  `bb firstmate migrate-owners` idempotently projects existing KV queue/decisions/
  afk/quiet/memory into the real files for the owners set to `real` (re-runnable:
  rows already projected are skipped, file writes are overwrites).
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
