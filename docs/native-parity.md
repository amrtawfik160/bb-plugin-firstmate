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
A failed routed send is an uncertain handoff and refuses; it never starts another
worker as fallback.

## Notification recovery

Identical crew events are coalesced across plugin reloads. A new active turn
starts a new delivery episode. Durable reports remain in the wake queue until
explicit acknowledgement. If the optional turn-end backstop is enabled, unchanged
queue contents get at most its configured number of re-rings. New queue contents
reset that budget. The normal native profile leaves this backstop off.

## Runtime limits

BB SDK 0.4.104 has no blocking turn-end hook, no silent suppression for only
core child-completion messages, and no native harness-process identity for a
host-terminal invocation of `fm-session-start`. A plugin cannot honestly claim
those guarantees. Native session startup remains callable, but a refused process
lock is not treated as verified session ownership. Dedicated homes and native
watchers isolate supervision without forging a harness PID.

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
