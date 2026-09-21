# Real transport is backlog-first (row before spawn)

When `transport=real`, `firstmate_dispatch` adds a `data/backlog.md` row (via
`fm-tasks-axi.sh`, id = crew id, `--kind ship|scout`) **before** it spawns the
worker, lets native `fm-spawn.sh` move that row to In-flight, and closes it on
land (`done`) or forget (`rm`). Real transport therefore **requires
`queueOwner=real`**; with `queueOwner=kv` there is no row to own, so dispatch logs
a clear message and falls back to native.

This is not an ordering preference — it follows from what native treats the
backlog row *as*. In native firstmate the row is not a to-do item; it is the
**record that OWNS a worker**. `fm-spawn.sh` is backlog-first: it refuses a task
with no backlog row. A crew records at dispatch time that it owns its row, so the
close survives a mid-flight flip of the feature flags.

## Consequences

- Row-before-spawn is mandatory; a spawn without a preceding row is refused by the
  real script, not an optimization we can skip.
- Real transport and the KV queue owner are coupled: enabling one without the
  other degrades to native by design.
- The row is an ownership token. Start/done/rm must target the same id the plugin
  supplied; the plugin never parses `tasks-axi` output to discover the id.
