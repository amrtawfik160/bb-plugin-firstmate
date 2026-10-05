# bb-plugin-firstmate

Run firstmate-style agent crews inside [BB](https://github.com/get-bb/bb): one captain thread dispatches crewmate child threads, supervises them, and brings back finished work.

The plugin implements the [firstmate](https://github.com/kunchenguid/firstmate) captain/crew protocol on BB primitives. A BB thread is the captain. Crews are child BB threads with their own managed worktrees. Status reports use the upstream protocol (`DONE:` / `BLOCKED:` / `FAILED:`), the real watcher runs through the BB backend, and merges are BB PR merges or ff-only local lands.

## Reliable launch and PR follow-up

Launches reserve capacity before creation. Dispatch, backlog dispatch, promotion and replacement share admission. A stable `--task-id` identifies a retry; backlog requests reuse their item ID. `bb firstmate launches list --json` shows reserved, creating, provisioning, running, failed, uncertain and deleted attempts. An exact BB deletion event releases that worker's reservation and preserves its contract/history; the deleted attempt cannot be resumed. Promotion requires a finished successful scout and a readable complete report. Compatibility reports live in a scoped SQLite artifact, read with `bb firstmate scout-report <id>`; native promotion references the original file. An uncertain attempt retains its slot and reconciles exact creation metadata before reuse. Bounded absence is never proof that creation failed.

The native adapter calls the internal `bb firstmate create-worker` bridge after native admission guards. It seeds role, task, home and generation through SDK creation metadata. Parent permissions remain the ceiling. Provisioning timeout retains the worker; it does not stop a slow worker. SDK 0.4.104 has no pre-turn hold or creation cancellation API: native post-creation isolation cannot be claimed complete before its checks finish.

Project checkout and environment selection use the selected host together. Missing matching source refuses launch. Native ships require managed isolation; `sharedEnv` is refused. Visibility is forwarded. Omitted execution choices use project defaults, and resolved settings are recorded when available. Advertised provider reasoning levels are validated, including `ultra`, `none` and `ultracode`. `sendAt` is unsupported and refused before reservation. Backlog `waitUntil` is an eligibility gate; the manager must explicitly dispatch due work.

PR delivery lives in a SQLite register independent of worker records, wake receipts and conversation history. Discovery uses owned environment/branch identity or explicit ship registration, never arbitrary report URLs. GitHub records preserve head SHA, contract, owner, workers, blocker, next action, observation freshness and notification identity. A new head invalidates readiness; forge approval must name that head. Forge failures preserve stale last-known state. Closed unmerged PRs require explicit disposition.

For an old worker whose environment became ready after native registration failed,
the owning captain can run `bb firstmate launches adopt <task-id> --thread <id>
--check --json`, then repeat without `--check`. This restores exact validated
registration without starting a turn, changing work or granting merge authority.
Missing provenance, conflicting identities and retired tasks refuse. See the
[repair procedure and limits](docs/verification/legacy-launch-adoption.md).

PR follow-up requires host `gh`, `bash` and `python3`. Structured forge reads capture stdout separately from stderr and terminal progress. Missing tools, failed commands and malformed JSON leave records stale for retry.

The background follow-up schedule reads bounded batches each minute with error backoff. Unchanged waiting PRs do not start model turns. Actionable transitions and overdue actions notify the owning manager through existing wake delivery. Notification acceptance is persisted and ambiguous sends are reconciled before retry. Hidden notifications alone do not imply token savings.

`bb firstmate deliveries list --json` lists unresolved work; `inspect`, `register`, `reconcile`, `assign`, `abandon` and `verify` share the `firstmate_deliveries` tool. List accepts bounded `--limit` and `--offset`; `--all` is a read-only project view. Fleet, bearings and session show owner, blocker, next action and PR link. Worker forget preserves records and a scoped continuation snapshot. Outstanding work retains native task authority and its environment; destructive `forget --stop` refuses until delivery completes or is explicitly abandoned. Explicit handoff transfers ownership, including records whose worker was forgotten. Lost managers leave visible owner-needed records; assignment requires naming the previous manager.

The dispatch contract `--delivery-requirement branch|pr|merged|merged-and-verified` defaults to `branch` for local-only ships and `merged` for PR modes. Branch delivery requires native ready-in-branch completion, with no push, PR or merge required. Conflicting mode/contracts refuse before launch; existing contracts remain unchanged. PR-only tasks finish when a non-draft PR exists. Required verification needs the freshly observed merged commit and recorded evidence (`verify <id> --commit <sha> --reason "<evidence>"`). Deployment is not implied. Abandonment requires explicit authority and a reason. Follow-up never grants merge authority or merges directly; managers preserve the agreed native review and validation path and use native guarded merge. Required repository reviews remain pending. Unknown review evidence is labeled unresolved; it permits already-authorized native continuation, without inventing a mandatory external GitHub approval. Approval-required PRs remain visible.

Native startup uses the workspace already bound by SDK creation. Its cwd assertion still runs; startup `cd` does not become a second model prompt. Explicit worker instructions still use normal delivery.

The native pin includes `wait-no-turns`, watcher continuity, bounded mergeability-unknown retry and completion inventory checks. Native `config/wait-no-turns` remains opt-in. BB does not copy home-local preferences or add a competing native-worker waiting loop. See [implementation evidence](docs/verification/launch-pr-lifecycle-progress.md) for limits and validation.

## Install

```sh
bb plugin install git:https://github.com/amrtawfik160/bb-plugin-firstmate
```

Or from a local checkout:

```sh
bb plugin install path:/path/to/bb-plugin-firstmate --yes
```

Requires `bb >= 0.43` and `bbPluginSdk >= 0.4.104` (see `package.json` engines).

A clean installation bundles pinned native Firstmate plus its matching BB adapter. No separately installed Firstmate repository is required. Git, BB, Python, Bash, forge credentials and the native tool prerequisites remain host dependencies; see [runtime installation and upgrades](docs/self-contained-runtime.md).

Update with `bb plugin update firstmate`. Updates never fetch native upstream during startup or automatically switch an existing captain's runtime. `bb firstmate runtime status --json` reports the plugin version, bundled upstream commit and adapter revision, installed releases, and the exact selected home runtime. Existing external homes keep their paths and version until an explicit guarded migration.

## Quick start

Run `/captain` in any thread to take the deck, then work in plain language or with the CLI:

```sh
bb firstmate dispatch --project <project-id> -- "fix the flaky login test"
bb firstmate watch                      # blocks until crews go idle (no polling)
bb firstmate deliver <crew-id>          # committed + uncommitted diff, PR URL
bb firstmate merge <crew-id> --yes      # merge green PR, or ff-only local land
# Attended-only, exact-check waivers: --allow-red <check> / --allow-missing <check>
```

Crews end every task with a status verdict. `deliver` shows what they committed. Native task contracts and recorded captain authority govern landing.

`/captain` first calls `firstmate_deck` (ACP/CLI: `bb firstmate deck --json`) to bind this thread's exact native home and return the agent-shell startup command. Binding has a 60-second deadline and reports `ready: false`: execute the returned command beneath the agent harness and require the complete native digest, successful lock and prerequisites before dispatch. Read the complete contract with `firstmate_contract` or `bb firstmate contract`; never guess a shared home or search plugin internals. Failed or truncated startup stays unresolved: inspect the named prerequisite before retry.

Bare `deck` defers fleet inventory to native startup. Request `deck --digest`, `deck --all`, or `session` for a separate fleet view. A verified bound adapter reuses its skills inventory and hooks; changed or stale adapters refresh under the same setup deadline. Legacy plugin records remain durable and are imported explicitly with `migrate-state` / `migrate-owners`, without overwriting native files.

## What you get

| Command | What it does |
| --- | --- |
| `deck` / `session` | Bind the exact home and return pending startup / print the fleet digest |
| `contract` / `skill` | Read the complete supervisor contract / policy skill from the selected native runtime |
| `runtime` | Inspect installed/selected code; explicitly install, check, select, migrate or roll back a quiescent home |
| `dispatch` | Spawn a ship (isolated worktree) or scout (read-only) crew |
| `tell` / `interrupt` / `stop` / `retry` | Live steer, hard stop, or re-run a crew |
| `watch` / `bearings` | Wait on crews, or print the 5-section fleet digest |
| `deliver` / `merge` / `promote` | Collect diffs, land work, promote a scout to a ship |
| `queue` | Backlog with dependencies (`--after`) and time gates (`--wait-until`) |
| `decide` | Durable captain decisions surfaced as NEEDS DECISION pings |
| `posture` | Inspect native registry, BB override and standing authority provenance; explicitly record current user-directed posture |
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
An owning captain can make an explicitly user-directed execution change with
`bb firstmate retry <crew-id> --intent execution-change --reason '<user request>' --provider <id> --model <id> --reasoning-level <level>`.
The current public SDK catalog must confirm an actual change. It preserves the
same environment and native task contract and does not consume failure recovery
allowance. Missing intent retains the existing recovery limit. See
[execution-change evidence and preconditions](docs/verification/explicit-model-change.md).

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
bb firstmate init --real        # install/select the pinned bundle for this owning thread
bb firstmate runtime status --json # installed releases versus selected per-home code
bb firstmate scripts [query]    # inspect installed entries and explicit bundled exclusions
bb firstmate fm <script> ...    # run supported bin/fm-<script>.sh with FM_BACKEND=bb
```

`overlay/bin/backends/bb.sh` adapts firstmate's backend operations to BB: spawn uses the internal creation bridge and public SDK to seed identity before the first turn in a managed worktree, capture becomes `bb thread output`, send becomes `bb thread tell`, kill becomes `bb thread stop`. Native dispatch writes the same `state/<id>.meta` ledger the scripts do, so `fm-peek`, `fm-send`, and the plugin's tools see one fleet.

BB-specific behavior in this fork:

- **Event-push watcher.** `backend=bb` reports push-capable. `fm-watch` blocks on `bb thread wait --status idle` instead of sleeping through its poll budget. A pending interaction surfaces as the blocked edge; the first window to finish wins the multi-window wait.
- **Refusal-safe teardown.** `remove_worktree` inspects the crew worktree first and refuses dirty trees with the changed-file list, so `fm-teardown` aborts and keeps records instead of letting a later force-removal eat uncommitted work. Discarding is an explicit `forget --force`.
- **Secondmates support both routing and native seeded homes.** `secondmate register --scope "<what it owns>" --projects a,b` registers an existing domain captain. Native `fm-secondmate-add.sh` creates an independent home through native identity, inheritance and isolation guards. Its BB captain role and home metadata are seeded before its first turn. The creation bridge installs the BB backend in that child home. Routing an existing captain does not create a new seeded home.

## Configuration

`bb plugin config firstmate` (or the plugin settings UI):

| Key | Default | Purpose |
| --- | --- | --- |
| `fullParityOnDeck` | on | `/captain` binds a scoped native home and configures native owners; native startup and explicit legacy migration remain separate |
| `firstmateRepo` | upstream repo URL | Legacy attribution; bundled startup does not clone/fetch it |
| `fmHome` | empty | Blank selects bundled runtime for new captains; a configured external source stays external |
| `defaultProvider` | blank | Crew provider id (blank = BB resolves) |
| `defaultPermissionMode` | `resolve` | Crew permission mode (`resolve` = inherit from the captain) |
| `supervisionEnabled` | off | Captain pings on done/fail/stuck; successful deck binding or `dispatch` enables supervision |
| `supervisionIntervalMin` | 5 | Stuck-check sweep interval |
| `supervisionStuckMin` | 30 | Minutes without output change before a stuck alert |
| `nudgeEnabled` | on | Doorbell idle crews that missed the status protocol |
| `nudgeMaxPerCrew` | 3 | Nudges per crew task before NEEDS DECISION |
| `nudgeCooldownSeconds` | 60 | Minimum gap between nudges for one crew |

## Skills

The plugin registers `/captain` and `/firstmate` as startup and transport instructions. Native `AGENTS.md` owns policy, including section 9 reporting. Captain and crew configuration no longer loads BB method or presentation skills. The source directories `captain-methods`, `worker-methods`, `calm` and `catch-up` remain unregistered: SDK 0.4.104 has no verified user-only opt-in selection surface, so these files are not automatic instructions.

The plugin registers only the `entry-skills/` parent directory, containing the captain and firstmate entry skills. Native policy and optional method sources under `skills/` remain unregistered. The required `firstmate_contract` / `bb firstmate contract --paged` read includes every tracked native skill’s complete frontmatter from the selected runtime, preserving multiline trigger descriptions without loading skill bodies. Read it before orchestration and again after compaction when it is no longer in context. Read native policy skills and their relative references with `firstmate_skill` or `bb firstmate skill <name> [relative-reference] [--source <selected-root source-file>]`. This reads the exact selected native runtime, checks its audited identity and original bytes, and refuses unknown versions, escaping references, symlinks or changed policy. Native `..` and fragment links resolve from the skill file; nested links need their exact selected-root source file. A fragment identifies the link, and the reader returns the entire document through the file API, verifying transferred bytes against Git. The complete-read limit is 2 MiB per file. The two supported revisions are `2d833ff147cd26a5c461e914e06854e0eb2707ce` and `1f3e769616fdf9f31f85f4c3e6a9f71606634238`. Static copied skills cannot follow a per-home selection in this SDK; they remain fidelity-checked source material, not registered policy. The pinned runtime retains its complete native skill inventory.

`/captain` binds this thread's home, returns the exact agent-shell startup command, and reads complete upstream `AGENTS.md` through `firstmate_contract`. The agent tool returns bounded UTF-8 pages below the observed ACP preview limit; follow every returned cursor until the end marker before orchestration. The cursor pins the verified text, selected runtime and captain/home; changed bytes or another captain refuse continuation. Restart/reload can resume the same cursor without acknowledging reports or changing native state. The default operator CLI still returns the complete source; use `--paged` then `--cursor <cursor>` for ACP shell previews. Native policy bytes are never shortened to fit an instruction field. Section arguments remain available for later lookup. BB adaptations map paths, threads, browser access and durable wake receipts; native intake, authority, review and completion gates remain authoritative.

The deck tool has conditional native role usage instructions even in the ordinary cold-entry session: after captain binding, they retain the supervisor role on later turns without hot-mutating provider instructions. The excerpt is byte-identical across both audited native versions and preserves native exceptions; workers select neither that tool nor captain skills. A model requested for a project task applies to worker intake; supervisor selection changes only when explicitly requested for that thread. After parent integration, reconstruct an existing captain's provider session through the supported BB lifecycle boundary and read every contract page again. Metadata binding alone does not replace live-session instructions. Do not migrate its runtime, rewrite task briefs, restart workers or remove old assets merely to refresh instructions. Existing conversation text cannot be erased by a configuration refresh; use the current complete native contract when recovering context. Text checks prove instruction composition, not identical model behavior.

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

## Intake, authority and PR health

Use registered help rather than reading plugin implementation: `bb firstmate dispatch --help`, `bb firstmate queue --help`, and `bb firstmate help`. Dispatch and queue help are rendered from the same supported option schema, including project, execution selection, shape, mode, delivery requirement and gates. Unsupported scheduling and native shared-worktree choices are stated explicitly.

Managed dispatch owns native brief creation → immediate `fm-dispatch-resolve` → exact backlog registration → guarded native spawn. Native script help is `bb firstmate fm brief -- --help` (the separator forwards help), or `firstmate_fm` with `script=brief, args=["--help"]`. Worker provider/model/reasoning do not change the captain. Native posture reports mode/yolo/branch prefix and authority context; `--branch-prefix` passes the intake-selected prefix identically to brief and spawn. No task-level yolo flag grants new authority.

The native resolver remains opt-in. Off preserves existing execution intake. Enabled results are retained under the task's artifacts and require explicit validated BB provider/model plus `--dispatch-profile-reason` recording the native intake decision before launch. Native CLI harness/account profiles cannot be inferred from a BB provider ID. Configuration/usage errors refuse. Reuse the returned task ID after completing intake; do not manually create a matching brief or separately spawn. See [dispatch mapping evidence](docs/verification/native-dispatch-mapping.md).

`bb firstmate posture --project <project> --json` reports actual native registry context and any BB override. Native's unregistered default is `no-mistakes` with yolo off. The registry is mechanical intake context; current user and project instructions choose the task mode. Explicit task modes do not rewrite the registry. A registered mode change needs the current user override/reason. Existing tasks keep their recorded delivery mode and requirement even if the project posture later changes.

Captain-approved yolo is standing authority for green, in-scope work under native guards. A fresh per-PR request is unnecessary. Only an actual user hold changes that authority; supervisor-authored caution is not a user hold. Legacy yolo without provenance is preserved and shown as unverified. Missing provenance does not prove absent approval. Resolve it from recorded user approval; then record that existing standing instruction through `bb firstmate posture set --project <project> --yolo on --reason '<existing approval evidence>'`. This does not invent approval. New explicit posture changes record the captain, time and reason in the existing posture record. Native merge checks and explicit owner scope still apply.

A PR-only contract is satisfied by its non-draft PR artifact. The durable record then stays `pr-delivered` and observes check health until the PR has a disposition. A later red check does not undo artifact delivery or create a merge requirement. Each failing check keeps its identity, link, author and follow-up accounting in CLI/tools and Fleet. A second independent failure remains visible while a baseline fix is active. Healthy observations do not create repeated model turns.

Reuse the recorded author for branch-specific fixes. For a proved baseline failure, link an existing authorized follow-up task separately with `bb firstmate deliveries account <id> --failure <failure-id> --scope baseline --follow-up-task <task-id> --reason '<baseline evidence>' --authorized`. Use `--scope author` for the original branch author. Accounting does not mark a check passing, start a worker or grant merge authority. Worker retirement and wake acknowledgement keep the outstanding record and author continuation.
