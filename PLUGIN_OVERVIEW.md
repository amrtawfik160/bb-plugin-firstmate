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
  command or truncate a file. The write is atomic: the payload is decoded to a
  sibling temp file and `mv -f`'d over the target, so a failed or interrupted write
  never truncates the existing file. The read-modify-write of the learnings file is
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

## Native-firstmate parity (divergence table)

Status of each divergence from the root-cause audit, re-run item by item.
CLOSED = behaves like native firstmate (or routes through it); PARTIAL = the
feasible subset is implemented and gaps are named; OPEN = not implemented on BB
and why.

| # | Divergence | Status | Evidence / note |
|---|------------|--------|-----------------|
| 1 | Two independent policy/state planes | PARTIAL | Real `state/`/backlog/contract/memory own policy behind the owner flags; KV is the projection/cache. Full single-ledger migration of pre-existing KV is `migrate-owners` (opt-in), not automatic. |
| 2 | Dispatch loses brief/profile + reasoning effort | CLOSED | `transport=real` runs real `fm-brief.sh`+`fm-spawn.sh`; `dispatch --reasoning-level` applies from turn 1. |
| 3 | Duplicated PR/merge state → stale reports | CLOSED | `deck`/`bearings` reconcile live thread/PR and retire crews merged/closed outside BB; merge retires both planes. |
| 4 | Real skills/hooks/contract not loaded; crew isolation | CLOSED | Captain loads real `AGENTS.md` + version-pinned skills inventory; real-script crews tagged crew (no captain tools). |
| 5 | Reduced status/supervision protocol | PARTIAL | `watchOwner=fm-watch` hands supervision to the real watcher (heartbeat-gated); full durable keyed status folding is projected, native watcher owns the ladder. |
| 6 | Merge gating (zero-checks, waiver) | CLOSED | Zero checks = no failing checks; `--allow-red <check>` waives one exact check, separate from `--yes`. |
| 7 | Scout delivery/retirement semantics | PARTIAL | Ships default to isolated worktrees; scout durable external `report.md` and completed-scout scratch discard remain native-owned via real teardown. |
| 8 | Retry = resubmission, not recovery relaunch | CLOSED | `retry` with `--model`/`--provider`/`--reasoning-level` relaunches a fresh thread in the same worktree. |
| 9 | Queue/decisions/memory/AFK/quiet lookalikes | CLOSED | Each routes through its native owner behind a flag (`queueOwner`/`decisionsOwner`/`afkOwner`/`quietOwner`/`memoryOwner`); Phase 5 hardened queue (caller-owns-id) and memory (atomic chunked host writes + cap/rotate). |
| 10 | Secondmate is a different feature | PARTIAL | Routing now honors natural-language `scope` + a non-exclusive project clone list (`pickSecondmate`); multiple mates supported. OPEN: seeded isolated `FM_HOME`, backlog handoff, config/memory inheritance, and an independently-supervising child firstmate — BB's backend `create_task` only spawns non-nesting leaf crews and native refuses `--secondmate` on backend=bb, so a real secondmate home cannot be stood up without a secondmate-capable bb backend. |
| 11 | Deck never renders real bearings | CLOSED | Deck runs real `fm-bearings-snapshot` (authoritative) beside the KV digest (labelled cache). |
| 12 | Real-mode version not the referenced checkout | CLOSED | Reused clones fast-forward (ff-only, clean tree) on init; script/skill counts read from the actual clone. |

### Phase 5 specifics

- **Memory (item 9):** host file writes (`writeHostFile` → `writeHostBytes`) append
  the base64 payload to a temp file in bounded `printf` chunks (each under
  `HOST_COMMAND_MAX`), then decode + atomically rename over the target. This removed
  a live-host failure: the earlier design fed the payload through terminal stdin, but
  the BB host terminal is a PTY in canonical mode, so un-newlined input is buffered +
  echoed and never delivered to the reading process — every write (even 10 bytes)
  hung until the 15 s timeout, and `base64 -d > path` had already truncated the
  target to 0 bytes. The chunked path has no size ceiling and no stdin dependency.
  All `runOnHost` stdin now stages through the same writer (a temp file redirected
  with `< file`), so `installBbBackend` and `runAfkContract` are covered too.
  `learnings.md` is capped at ~64 KB with the oldest lines rotated to
  `data/learnings.archive.md`. If the archive write fails, the live file is left
  untrimmed (keeps the full body) so overflow learnings are never dropped — the cap
  re-applies on the next successful add. Tested with a >10 KB write, a >64 KB
  rotation, an archive-write-failure (no loss), and a forced-failure that leaves the
  previous file intact. Prove it against a live host with
  `node scripts/live-host-transport-check.mjs --host <id>` (skipped in CI).
- **Queue (item 9):** the plugin supplies its own backlog row id
  (`add <id> <title> --kind <shape>`, native convention) and never parses
  `tasks-axi` output — so real backlog rows work regardless of the external tool's
  output format. `init --real` verifies `tasks-axi` presence **and** version
  (>=0.2.4, compared numerically); absent or below-min prints the install/upgrade
  command (`npm install -g tasks-axi`) and queue degrades to the KV cache until
  it is satisfied. (`tasks-axi` is not bundled and was absent on the reference
  host.)
- **Watch (item 5):** the fm-watch supervisor was proven deterministically in a
  scratch home — a stale/absent beacon triggers relaunch, a fresh beacon suppresses
  it (watcher live), and relaunch backoff (60 s → 30 min cap) with an in-backoff
  no-spawn guard prevents flooding; BB resumes paging whenever the beat goes stale
  (no supervision gap). A full live-thread e2e was intentionally not run to avoid
  touching live fleet state; run it in a dedicated sandbox before enabling live.
- **Secondmate (item 10):** feasible subset only (scope + clone-list routing). A
  dead/archived mate thread never loses the task — if the routing send throws,
  dispatch logs and falls back to a normal native spawn. Full native
  home/handoff/inheritance/child-supervision remains OPEN as above.
