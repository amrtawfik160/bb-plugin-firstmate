# Native policy wiring

The BB adapter invokes native policy scripts. It does not provide complete
runtime equivalence to a native harness.

| Operation | Owner |
| --- | --- |
| PR merge | `fm-pr-merge.sh`: live head, checks, captain hold, away authority, and forge outcome |
| Local landing | `fm-merge-local.sh`: native lock/hold/clean-default/fast-forward checks; the BB overlay resolves the managed branch from the recorded worktree and verifies repository identity |
| Landed cleanup | `fm-teardown.sh`: native safety checks and backlog close before BB retires its cached crew |
| Decisions | Native captain hold before cache update or worker delivery; a linked decision holds the crew's actual task and releases it when answered |
| Backlog, memory, quiet | Failed native mutations return errors; BB does not acknowledge a cache-only replacement |
| Away return | `fm-afk-return.sh begin` produces the retained catch-up gate and return brief; ordinary spawn/merge checks the gate before proceeding |
| Secondmate lifecycle | Native `home-seed`, `spawn --secondmate`, handoff, and recovery scripts; BB launches the seeded home as a captain and records its home binding |

## Captain homes

An attended `deck` provisions `<base-home>-bb-homes/<thread-id>` once and binds
that captain's tools and CLI calls to it. Each home has independent native state,
backlog, memory, away authority, watcher and heartbeat. Secondmates launched by
native scripts bind to the home native seeded for them.

Existing crews, queue rows and decisions remain pinned to their original home.
Records are not moved underneath running workers. A captain with an active legacy
away mandate must return before provisioning a new home. Legacy fleet state is
retained, not bulk-retired. Run `deck` in existing captains to activate their home.
The base installation remains the compatibility home for callers without a
captain binding. An explicit CLI `fm --home` still addresses that requested home.

`secondmate register` registers a routing target that already exists; it does not
seed or launch a native secondmate. Use native `fm-home-seed.sh` followed by
`fm-spawn.sh <id> <home> --secondmate --backend bb --harness bb` for that lifecycle.
Project membership alone is not responsibility: scope must share meaningful task words; no fit stays with the primary. Local-only work remains with the primary. This conservative lexical approximation does not reproduce native natural-language judgment.
A failed routed send is an uncertain handoff and refuses; it never starts another
worker as fallback.

## Notification recovery

Identical crew events are coalesced across plugin reloads. A new active turn
starts a new delivery episode. Durable reports remain in the wake queue until
explicit handling completion. `firstmate_wake` retains a receipt and saved report before native presentation advances read cursors. Pass `handledWake` on the final successful action after handling the whole batch, or on `firstmate_wake` when no action remains. `ack=true` is now only a compatibility read; it never consumes unseen reports. A transport failure replays the receipt. Successful actions are journaled before native acknowledgement; retry acknowledgement without repeating those actions. External action and journal commits cannot be atomic, so recovery remains at least once.

If the optional turn-end backstop is enabled, unchanged
queue contents get at most its configured number of re-rings. New queue contents
reset that budget. The normal native profile leaves this backstop off.

## Runtime limits and how the plugin closes them

BB SDK 0.4.104 has no blocking turn-end hook, no silent suppression for only
core child-completion messages, and no native harness-process identity for a
host-terminal command. The plugin closes each as far as the SDK allows:

| Native guarantee | BB mechanism | Remaining gap |
| --- | --- | --- |
| Turn-end wake guard (`fm-turnend-guard.sh`) | `deck` installs user-level Claude/Codex `Stop` hooks (`overlay/bin/bb-captain-hook.sh`), gated on `~/.bb-firstmate/captains/<thread>`. A captain with unacknowledged wakes is blocked once per turn (exit 2; `stop_hook_active` allows the next stop). Other threads exit 0. | Queued-wake or pending-receipt predicate; watcher health stays with the plugin's supervisor. Codex asks to trust new hook entries once before it runs them. |
| Session lock owned by the harness | The same hooks run `fm-sessionstart-run.sh` from `SessionStart`, inside the harness process tree, for a captain with its own home. | Legacy captains on the shared base home do not take its lock; run `deck` to move them to their own home. |
| Wakes delivered at turn boundaries | Plugin-owned routine durable wakes are grouped for 1.5 seconds, persisted before delivery, and recovered after reload. Decisions/failures bypass that delay. Redundant plugin completion pings are skipped when BB core owns the outcome. | BB core child completion bypasses `message.dispatch`; the hook cannot batch or silently suppress that path. Hidden UI rows still cost model tokens. |
| Root wake queue drained by its session | Captains drain their own partition. The fm-watch supervisor acknowledges shared base-home root rows older than 10 minutes, after the relay forwarded them. | Skipped when a captain is bound to the base home itself. |

Native `no-mistakes` use remains worker-owned, as upstream specifies. Native's PR
merge script verifies forge state; it does not independently attest a successful
`no-mistakes` run.

## Verification

Regression tests run real native scripts in disposable homes for isolated
backlog/authority/memory, refused decision writes, bounded wakes, local merge
holds, landing and teardown, and secondmate seed/spawn. BB transport and forge
writes are substituted in those tests. They do not prove an autonomous model's
full implementation/review cycle or a live production merge.

See [contributor verification requirements](../CONTRIBUTING.md), [`server.test.ts`](../server.test.ts), and the [current validation record](verification/plugin-runtime.md).
The live overlay entry point is [`scripts/live-mirror-check.mjs`](../scripts/live-mirror-check.mjs).
Scout cleanup delegates report and inventory validation to native teardown, retaining the crew when native refuses.
Worker CLI home routing remains a known limitation under separate investigation; use an explicit `fm --home` when addressing native scripts from a worker.

## SDK requests

The adapter can fix activity and plugin-owned batching using public SDK calls today.
Full parity still needs BB APIs for: (1) notification ownership and silent suppression
of core child completions; (2) stable supervisor event/turn/generation and origin
identifiers across every provider; (3) a supported blocking lifecycle gate or durable
continuation equivalent; (4) consistent provider usage and activity telemetry.
No installed BB core files are patched here.
