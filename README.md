# bb-plugin-firstmate

Run firstmate-style agent crews inside [BB](https://github.com/get-bb/bb): one captain thread dispatches crewmate child threads, supervises them, and brings back finished work.

The plugin implements the [firstmate](https://github.com/kunchenguid/firstmate) captain/crew protocol on BB primitives. A BB thread is the captain. Crews are child BB threads with their own managed worktrees. Status reports use the upstream protocol (`DONE:` / `BLOCKED:` / `FAILED:`), the real watcher runs through the BB backend, and merges are BB PR merges or ff-only local lands.

## Reliable launch and PR follow-up

Launches reserve capacity before creation. Dispatch, backlog dispatch, promotion and replacement share admission. A stable `--task-id` identifies a retry; backlog requests reuse their item ID. `bb firstmate launches list --json` shows reserved, creating, provisioning, running, failed and uncertain attempts. Promotion requires a finished successful scout and a readable complete report. Compatibility reports live in a scoped SQLite artifact, read with `bb firstmate scout-report <id>`; native promotion references the original file. An uncertain attempt retains its slot and reconciles exact creation metadata before reuse. Bounded absence is never proof that creation failed.

The native adapter calls the internal `bb firstmate create-worker` bridge after native admission guards. It seeds role, task, home and generation through SDK creation metadata. Parent permissions remain the ceiling. Provisioning timeout retains the worker; it does not stop a slow worker. SDK 0.4.104 has no pre-turn hold or creation cancellation API: native post-creation isolation cannot be claimed complete before its checks finish.

Project checkout and environment selection use the selected host together. Missing matching source refuses launch. Native ships require managed isolation; `sharedEnv` is refused. Visibility is forwarded. Omitted execution choices use project defaults, and resolved settings are recorded when available. Advertised provider reasoning levels are validated, including `ultra`, `none` and `ultracode`. `sendAt` is unsupported and refused before reservation. Backlog `waitUntil` is an eligibility gate; the manager must explicitly dispatch due work.

PR delivery lives in a SQLite register independent of worker records, wake receipts and conversation history. Discovery uses owned environment/branch identity or explicit ship registration, never arbitrary report URLs. GitHub records preserve head SHA, contract, owner, workers, blocker, next action, observation freshness and notification identity. A new head invalidates readiness; forge approval must name that head. Forge failures preserve stale last-known state. Closed unmerged PRs require explicit disposition.

The background follow-up schedule reads bounded batches each minute with error backoff. Unchanged waiting PRs do not start model turns. Actionable transitions and overdue actions notify the owning manager through existing wake delivery. Notification acceptance is persisted and ambiguous sends are reconciled before retry. Hidden notifications alone do not imply token savings.

`bb firstmate deliveries list --json` lists unresolved work; `inspect`, `register`, `reconcile`, `assign`, `abandon` and `verify` share the `firstmate_deliveries` tool. List accepts bounded `--limit` and `--offset`; `--all` is a read-only project view. Fleet, bearings and session show owner, blocker, next action and PR link. Worker teardown/forget preserves records. Explicit handoff transfers ownership, including records whose worker was forgotten. Lost managers leave visible owner-needed records; assignment requires naming the previous manager.

The dispatch contract `--delivery-requirement pr|merged|merged-and-verified` defaults to `merged`. PR-only tasks finish when a non-draft PR exists. Required verification needs the freshly observed merged commit and recorded evidence (`verify <id> --commit <sha> --reason "<evidence>"`). Deployment is not implied. Abandonment requires explicit authority and a reason. Follow-up never grants merge authority or merges directly; managers retain independent review and use native guarded merge. Approval-required PRs remain visible.

The native pin includes `wait-no-turns`, watcher continuity, bounded mergeability-unknown retry and completion inventory checks. Native `config/wait-no-turns` remains opt-in. BB does not copy home-local preferences or add a competing native-worker waiting loop. See [implementation evidence](docs/verification/launch-pr-lifecycle-progress.md) for limits and validation.

## Install

```sh
bb plugin install git:https://github.com/amrtawfik160/bb-plugin-firstmate
```

Or from a local checkout:

```sh
bb plugin install path:/path/to/bb-plugin-firstmate --yes
```

Requires `bb >= 0.43` and `bbPluginSdk >= 0.4.87` (see `package.json` engines).

Update the plugin itself with `bb plugin update firstmate`. Re-running `/captain` (or `bb firstmate init --real`) fast-forwards a clean `fmHome` clone to the plugin’s audited upstream commit, keeping scripts and skills on the same revision.

## Quick start

Run `/captain` in any thread to take the deck, then work in plain language or with the CLI:

```sh
bb firstmate dispatch --project <project-id> -- "fix the flaky login test"
bb firstmate watch                      # blocks until crews go idle (no polling)
bb firstmate deliver <crew-id>          # committed + uncommitted diff, PR URL
bb firstmate merge <crew-id> --yes      # merge green PR, or ff-only local land
# Attended-only, exact-check waivers: --allow-red <check> / --allow-missing <check>
```

Crews end every task with a status verdict. `deliver` shows what they committed. You decide what lands.

`/captain` initializes or reuses the real Firstmate checkout and activates its full BB profile: real dispatch, watcher, backlog, decisions, AFK/quiet, tiered memory, durable bidirectional messaging, state read-through, and event-driven crew wakes. Existing plugin state is migrated once without overwriting non-empty real files.

## What you get

| Command | What it does |
| --- | --- |
| `deck` / `session` | Mark the thread as captain, print the fleet digest |
| `contract` | Read the complete current native supervisor contract and BB adaptations |
| `dispatch` | Spawn a ship (isolated worktree) or scout (read-only) crew |
| `tell` / `interrupt` / `stop` / `retry` | Live steer, hard stop, or re-run a crew |
| `watch` / `bearings` | Wait on crews, or print the 5-section fleet digest |
| `deliver` / `merge` / `promote` | Collect diffs, land work, promote a scout to a ship |
| `queue` | Backlog with dependencies (`--after`) and time gates (`--wait-until`) |
| `decide` | Durable captain decisions surfaced as NEEDS DECISION pings |
| `posture` | Per-project delivery mode: `direct-PR`, `no-mistakes`, `local-only`, plus yolo merge authority |
| `memory` | Captain preferences and dated fleet learnings, reprinted on deck |
| `afk` / `quiet` | Away mode (holds routine pings, keeps failures) and ping batching |
| `secondmate` | Register domain-captain threads; dispatches to that project route there |
| `scripts` / `fm` | Discover, verify, and run every installed upstream `fm-*` script through the BB backend |
| `forget` | Drop a crew record, optionally archiving its thread |

Ships get their own managed worktree by default, so two ships never share a checkout. Scouts are read-only. Crew threads cannot dispatch nested crews. Parent permission is the ceiling for everything a crew can do.

Crew records are retained until retirement; supervision rotates through bounded batches.
For ships, `forget --stop` refuses unreadable Git state, uncommitted changes, or commits absent from the base and local remote-tracking refs.
An existing PR does not bypass that check.
Native scouts use teardown's durable report and inventory gates, including when BB records `worktree: false`.
Failed cleanup keeps the crew available for retry; `--force` explicitly permits discarding local work.

Crew thread names lead with the work and keep the command id at the end: `Ship · Fix flaky login · abc12def` or `Scout · Audit auth flow · abc12def`.

The Fleet panel (sidebar navigation) lists every crew with live status. In a captain thread, its header chip and `@crew` mentions show that captain's fleet only.

Captain threads follow upstream firstmate's section 9 visibility contract. Crew doorbells are agent-only triggers, so raw `🔔 crew …` status lines never render in captain chat. The manager re-reads current crew state, handles recoverable issues, batches simultaneous wakes, and reports only material outcomes or decisions. A frontend timeline filter also removes routine tool, command, waiting, reasoning, and legacy visible wake rows. Native Firstmate tools are mandatory when available.

## Supervision that cannot miss a report

Three layers:

1. **Thread events.** `thread.idle`, `thread.failed`, `turn.failed`, and `interaction.pending` ping the captain the moment a crew finishes, fails, or blocks on input.
2. **Protocol nudge.** When a crew goes idle without a `DONE:` / `BLOCKED:` / `FAILED:` verdict, the plugin doorbells it with the upstream turnend-guard banner and asks for a restated outcome. Bounded: `nudgeMaxPerCrew` (default 3) nudges per task, `nudgeCooldownSeconds` (default 60) apart. Exhausted nudges surface one `NEEDS DECISION`. Manual stops and interrupts are never nudged.
3. **Event-driven watch handoff.** Under `/captain`, `firstmate_watch` returns immediately after handing supervision to private agent-only crew events backed by the durable wake queue.
   The manager calls it once per crew batch, ends the turn, and resumes only when a crew event arrives.
   The `bb firstmate watch` CLI remains blocking for operator use.

BB core's ACP dynamic-tool bridge can reject a long-lived tool call at its timeout boundary before the plugin can observe or catch the transport failure.
The agent tool therefore never opens that blocking path.
If the bridge still reports `dynamic tool request failed` around the short handoff, the manager does not retry; private crew events and the durable queue continue independently.

Confirmed live crew reports stay durable during the captain turn and are acknowledged through Firstmate's native wake drain when that turn completes. The optional turn-end re-ring remains available, but `/captain` leaves it off so the manager starts only for a new crew event.

## The real firstmate toolbelt

Run `bb firstmate toolchain` (or `firstmate_toolchain`) to check the native AXI
dependencies and Lavish compatibility without changing fleet state. Captain
and crew instructions use `/browser` (`browser_script`) for browser work, with
thread-isolated profiles. Other AXI tools, including Lavish, retain their roles. See the
[toolchain requirements and verification](docs/axi-toolchain.md).

The native tools cover the liaison loop. For the full bash policy engine (brief, gate, inbox, watch, merge, teardown, afk, bearings, backlog), the plugin drives upstream firstmate's `bin/` scripts with BB as the session backend:

```sh
bb firstmate init --real        # clone upstream firstmate, overlay backends/bb.sh, set config/backend=bb
bb firstmate scripts [query]    # verify 194 callable scripts + 22 helpers/adapters, then search entrypoints
bb firstmate fm <script> ...    # run any bin/fm-<script>.sh with FM_BACKEND=bb
```

`overlay/bin/backends/bb.sh` adapts firstmate's backend operations to BB: spawn becomes `bb thread spawn` into a managed worktree, capture becomes `bb thread output`, send becomes `bb thread tell`, kill becomes `bb thread stop`. Native dispatch writes the same `state/<id>.meta` ledger the scripts do, so `fm-peek`, `fm-send`, and the plugin's tools see one fleet.

BB-specific behavior in this fork:

- **Event-push watcher.** `backend=bb` reports push-capable. `fm-watch` blocks on `bb thread wait --status idle` instead of sleeping through its poll budget. A pending interaction surfaces as the blocked edge; the first window to finish wins the multi-window wait.
- **Refusal-safe teardown.** `remove_worktree` inspects the crew worktree first and refuses dirty trees with the changed-file list, so `fm-teardown` aborts and keeps records instead of letting a later force-removal eat uncommitted work. Discarding is an explicit `forget --force`.
- **Secondmates support both routing and native seeded homes.** `secondmate register --scope "<what it owns>" --projects a,b` registers an existing domain captain. Native `fm-secondmate-add.sh` creates an independent home through native identity, inheritance and isolation guards. Its BB captain role and home metadata are seeded before its first turn. The creation bridge installs the BB backend in that child home. Routing an existing captain does not create a new seeded home.

## Configuration

`bb plugin config firstmate` (or the plugin settings UI):

| Key | Default | Purpose |
| --- | --- | --- |
| `fullParityOnDeck` | on | `/captain` activates every real Firstmate owner and safely migrates prior plugin state |
| `firstmateRepo` | upstream repo URL | Repo cloned by `init --real` |
| `fmHome` | empty | Firstmate home on the host; set by `init --real` |
| `defaultProvider` | blank | Crew provider id (blank = BB resolves) |
| `defaultPermissionMode` | `resolve` | Crew permission mode (`resolve` = inherit from the captain) |
| `supervisionEnabled` | off | Captain pings on done/fail/stuck; `deck`/`dispatch` turn it on automatically |
| `supervisionIntervalMin` | 5 | Stuck-check sweep interval |
| `supervisionStuckMin` | 30 | Minutes without output change before a stuck alert |
| `nudgeEnabled` | on | Doorbell idle crews that missed the status protocol |
| `nudgeMaxPerCrew` | 3 | Nudges per crew task before NEEDS DECISION |
| `nudgeCooldownSeconds` | 60 | Minimum gap between nudges for one crew |

## Skills

The plugin registers 28 upstream `.agents/skills`, plus `/captain`, `/firstmate`, `/calm`, and `/catch-up`. The upstream `firstmate-calm` entry is a terminal module rather than a portable skill; BB uses its existing timeline filter and the `/calm` reporting skill instead. Imported policy text is pinned to upstream commit `1f3e7696`; one shared runtime contract translates script paths, workers, approvals, and alternate harness mechanics to `firstmate_fm` and BB threads. Crew threads still receive no captain skills.

Calm reporting is the default in captain threads. Routine supervision stays silent; requested outcomes, review-ready work, decisions, exhausted blockers, and needed logins still reach you. This changes reporting only and leaves supervision and AFK/quiet settings unchanged. Ask for detail whenever needed.

After updating the plugin, existing captain sessions can run `/calm` to load the reporting rules immediately. New captain sessions receive the default through their startup instructions.

Run `/catch-up` after a long conversation or switching tasks. It summarizes important results, decisions needing you, blockers, in-progress work, and next steps from current records and the available conversation. It keeps unresolved items visible, flags missing evidence, and does not approve or start work. Its default scope is this captain's work; request all captains explicitly for a wider view. `/bearings` remains the full fleet snapshot and board workflow.

`/captain` is a BB bootstrap: it binds this thread's home and reads the complete upstream `AGENTS.md` verbatim through `firstmate_contract`. Section arguments remain available for later lookup. Upstream owns intake, authority, delivery, and supervision policy; BB instructions only map paths, threads, browser access, and durable wake receipts. The fidelity check covers both entry skills and every registered upstream skill, and requires byte-for-byte preservation for verbatim skill copies.

Native startup must run beneath the agent harness to acquire its session lock. `firstmate_fm` returns an agent-shell command for `session-start`, `sessionstart-run`, and `sessionstart-nudge` instead of attempting startup through BB's detached host-terminal RPC. SessionStart hooks use the same `bin-bb` mirror and explicit native home. A genuine native lock refusal retains read-only behavior; startup transport is repaired without bypassing the refusal.


## Crew message delivery

With `tellOwner=real`, Firstmate uses the upstream inbox writer and constant
notification text. Only the worker's move into `handled/` acknowledges a message.
BB queues notification pointers, coalesces them per crew, and removes owned
notifications once the inbox is consumed. Unread records are never pruned.
Notification failures retain the record and retry; failed writes do not fall back
to a second message transport. `queue=true` defers the notification and disables
native re-rings for that record; ordinary tells retain native recovery behavior.

## Automatic compaction

Firstmate compacts idle captain and crew threads only when measured usage reaches
90% of the model's context window and the `captainCompactAtTokens` minimum.
Estimated usage, unknown capacity, and totals larger than the context window do
not trigger it. When the provider reports its own automatic compaction threshold,
Firstmate leaves compaction to that provider.

The minimum interval remains 20 minutes per thread. An unchanged reading cannot
trigger another attempt after that interval or a plugin reload; usage that falls
below 90% clears that reading so future growth can qualify again. Concurrent
checks share one attempt, and thread status is checked again before compaction.
Set `captainCompactAtTokens` to `0` to disable Firstmate's automatic compaction.
Manual compaction and the provider's own compaction remain available.

## Development

```sh
npm test                       # node --test over lib/ and server.test.ts
npx tsc --noEmit               # typecheck
bb plugin build                # compile dist/
bb plugin reload firstmate     # reload the running plugin
```

The overlay **never edits tracked firstmate files**. `overlay/install-bb-backend.py` builds a parallel "mirror bin" at `<home>/bin-bb` (native entries symlinked; the no-seam dispatch scripts are patched copies generated from the `overlay/*.patch` files; `bb.sh` added), registers it in `<home>/.git/info/exclude`, and the plugin routes `bin` → `bin-bb` (`$FM_BINDIR`) when the `config/bb-overlay` marker is present. This keeps `git status --porcelain` empty so the fetch + ff-only auto-update actually fast-forwards. See `overlay/docs/bb-backend.md` ("Installation architecture", the upstream-seam proposal, and the migration procedure). The patches must keep applying to pristine upstream firstmate; when changing dispatchers, run the installer against a fresh clone before committing (the `installer leaves a real firstmate clone's tracked tree clean` test guards this).

## Credits

The captain/crew protocol, status grammar, and `bin/` toolbelt come from [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate). This plugin maps that surface onto BB threads, worktrees, events, and diffs rather than porting the scripts.

Native policy ownership, isolated homes and remaining BB runtime limits: [native parity](docs/native-parity.md).

## License

[MIT](LICENSE)
