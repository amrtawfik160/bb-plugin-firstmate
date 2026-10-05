# BB

## Boundary

BB is the active Firstmate transport. A crew is a child BB thread, and an isolated ship uses a BB managed worktree. The real scripts run with `FM_BACKEND=bb`; `overlay/bin/backends/bb.sh` translates their endpoint operations to BB.

## Operations

- Start with `firstmate_dispatch`; use `shape=scout` for read-only investigation and `shape=ship` for changes.
- Inspect with `firstmate_crew`, steer with `firstmate_tell`, and hard-stop with `firstmate_interrupt`.
- Call `firstmate_watch` once per crew batch to hand supervision to private event-driven durable wakes, then end the turn and never retry or poll.
- The `bb firstmate watch` CLI remains blocking via BB `threads.wait` for operator use.
- Retry the same failed turn with `firstmate_retry`. A provider, model, or reasoning override relaunches a replacement thread in the same worktree.
- Deliver with `firstmate_deliver`; land only through `firstmate_merge`.
- Run an upstream script with `firstmate_fm`, passing the script stem and its original arguments.

The plugin applies the crew marker and task id as thread metadata. Crew threads receive no captain tools or captain skills, which prevents nested dispatch.

## Recovery

Use the recorded `threadId` and `crewId`. The real transport writes both into `state/<id>.meta`; if a hard kill lands between thread creation and that write, the plugin reconciles exact seeded launch metadata before any replacement; legacy unmarked threads require explicit guarded `bb firstmate launches adopt <task> --thread <thread> --check` provenance validation.

Wake receipt handling follows [supervision](../../../captain/references/supervision.md#durable-wake-handling); complete `handledWake` only after handling the whole batch.

## Bundled runtime (BB transport adaptation)

A clean `firstmate_deck` / `bb firstmate deck --json` stages the plugin's pinned native bundle on this thread's execution host and returns its exact durable home. Execute the returned startup command beneath the agent harness; installation alone does not establish native lock/readiness. Native scripts still own policy and prerequisites.

Run `bb firstmate runtime status --json` (or `firstmate_runtime action=status`) to distinguish the plugin bundle, installed releases and the selected per-home runtime. On a plugin update, `bb firstmate runtime install` stages the current bundle without changing selection. For an owning quiescent captain, run `runtime select <exact-release> --check`, then `runtime select <exact-release>` for an explicitly authorized upgrade. Existing external homes instead require `runtime migrate <exact-release> --check` and explicit `runtime migrate <exact-release>`; retained native task identities, locks, watchers and launch reservations refuse selection. Nothing moves under existing worker paths, and no execution settings or task briefs change.

`runtime rollback <previous-release> --check` / `runtime rollback <previous-release>` restore only a compatible recorded previous selection. After external migration the recorded previous target is `external`. Do not delete locks or task records to force selection. If interrupted, inspect `runtime status --json`, then retry the same exact operation if still needed; an unknown target or damaged bytes refuse. See the plugin README runtime procedure for operator detail; startup does not require reading that source file.
