# BB

## Boundary

BB is the active Firstmate transport. A crew is a child BB thread, and an isolated ship uses a BB managed worktree. The real scripts run with `FM_BACKEND=bb`; `overlay/bin/backends/bb.sh` translates their endpoint operations to BB.

## Operations

- Start with `firstmate_dispatch`; use `shape=scout` for read-only investigation and `shape=ship` for changes.
- Inspect with `firstmate_crew`, steer with `firstmate_tell`, hard-stop with `firstmate_interrupt`, and wait with `firstmate_watch`.
- Retry the same failed turn with `firstmate_retry`. A provider, model, or reasoning override relaunches a replacement thread in the same worktree.
- Deliver with `firstmate_deliver`; land only through `firstmate_merge`.
- Run an upstream script with `firstmate_fm`, passing the script stem and its original arguments.

The plugin applies the crew marker and task id as thread metadata. Crew threads receive no captain tools or captain skills, which prevents nested dispatch.

## Recovery

Use the recorded `threadId` and `crewId`. The real transport writes both into `state/<id>.meta`; if a hard kill lands between thread creation and that write, the plugin adopts the thread by its stable title suffix or plugin metadata before spawning a replacement.
