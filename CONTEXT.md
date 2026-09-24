# bb-plugin-firstmate

Glossary for this project. It maps the upstream [firstmate](https://github.com/kunchenguid/firstmate)
captain/crew protocol onto BB primitives. Terms only — no implementation detail;
for decisions see [docs/adr/](docs/adr/). Where a term means something different
here than in native firstmate, that difference is called out.

## Language

### Roles

**Captain**:
The human giving orders. A BB thread running `/captain` becomes their point of
contact; the thread itself is the first mate, never a separate thread.
_Avoid_: user (when the role is what matters).

**Crewmate** / **Crew**:
An autonomous worker agent dispatched to do one task and report back. In this
plugin a crew is a child BB thread with its own managed worktree.
_Avoid_: subagent, worker thread.

**Secondmate**:
A persistent domain captain in another project, registered as a routing target.
_In this plugin_ it is only a routing target (thread + scope + clone list), not a
fully seeded independent firstmate home — BB's backend spawns only non-nesting
leaf crews.
_Avoid_: sub-captain.

### Work

**Ship**:
A crew whose deliverable is a code change via PR/branch. The default shape.

**Scout**:
A crew whose deliverable is a knowledge report, never a PR.
_Avoid_: research crew (when the shape distinction matters).

**Brief**:
The task packet handed to a crew: **Captain's intent** plus **Firstmate spec**.

**Captain's intent**:
The verbatim ask plus acceptance criteria, never widened. A bare
`Captain's intent:` operator-address label at the top of the body is refused by
the native gate and must be normalized away before spawn.

**Backlog row**:
The record in `data/backlog.md` that **OWNS a worker** — ownership, not a to-do
item. Native spawn is backlog-first: it refuses a task with no row. A crew records
that it owns its row at dispatch.
_Avoid_: task list entry, todo.

### Signalling

**Wake**:
A pointer enqueued to tell the captain a status file has news. The content lives
in the status file, not the wake payload.

**Doorbell**:
A cheap, fire-and-forget ring to a crew or captain (`queue-if-active`). It may be
dropped without losing content, because the content lives elsewhere.
_Avoid_: notification, ping.

**Steer**:
A captain→crew course correction. By default a plain `tell` delivers with BB
`mode:"steer"`, which LANDS inside the crew's running turn (and starts a turn when
the crew is idle) — so a captain can correct a crew mid-work instead of waiting for
it to finish. It is framed "not a stop; keep working and fold this in", so the crew
continues its task. `tell` with `queue:true` opts out to a **doorbell**
(`queue-if-active`) for a non-urgent note read only when the crew next drains its
queue. `interrupt`/`stop` are hard steers (`mode:"steer"` + stop framing), never the
inbox. Under `tellOwner=real` a plain tell also writes a durable fire-and-forget
**inbox record** as an audit trail; that owner is off by default and slated for
deletion (see **Owner flag**), so do not assume steers are durably recorded.

**BB child ping**:
BB core's own "[bb system] @thread:<crew> completed/failed" message to a crew's
parent thread at every crew turn end. No plugin hook can hold or drop it, so for a
turn-end outcome with a durable wake it is the one captain wake and no doorbell rings.

**Waiting yield**:
A crew turn that ends with `WAITING:` because an external run (pipeline, CI) has not
finished. Not a verdict: it is not nagged, does not ring the captain, and the crew is
resumed later.
_Avoid_: "DONE: not done yet".

**Held wake**:
A captain wake kept back while the captain cannot take a turn (provider limit, thread
in error) and released as one consolidated wake when it can.

**Inbox record**:
A durable message file in a crew's inbox. The crew acknowledges by moving the file
to `handled/` — the move IS the acknowledgement.

### Supervision

**Beacon**:
The liveness signal fm-watch publishes for a crew host (per-host key). A fresh
beacon means the crew's host is being watched.

**Owner beat**:
Distinct from the beacon. The heartbeat the plugin (the keeper's owner) refreshes
each supervisor tick; when it goes stale the keeper self-exits, so a keeper whose
owner is gone tears itself down.

**Keeper**:
A durable on-host script that re-arms fm-watch (which exits on every actionable
wake) so the watch beat stays live between wakes. One keeper per crew host.

**Supervision model**:
How a home judges liveness. **autoarm** = a fresh beacon with no live lock-holder
is healthy (the watcher only runs between wakes); this is the bb-backed home's
model. **persistent** = demands a live lock-holder and declares downtime while the
beacon is fresh. A bb home declares `autoarm` so a between-wakes gap is not a false
alarm.

**Partition** / **cap-\<captain\>**:
The per-captain scoping of the durable **wake plane only**. Each captain gets its
own state subdir (`state/cap-<captain-thread-id>/`) so one captain's drain/ack
never touches another's wake queue rows or notes. A missing captain id falls back
to the shared global state dir. This does **not** cover the crew register: that is
a single shared KV list with no owner filtering on the read plane — `listCrews`
sweeps every firstmate-origin thread host-wide, and it is capped at 50 (`MAX_CREWS`),
so one captain's dispatches can EVICT another captain's records. Partitioning is a
wake-plane property, not a crew-register property. Captain-facing crew views show
the captain's own crews plus, read-only, the crews of other live captains on the
same project (never other projects); another captain's crew or PR is refused on
merge/forget/dispatch without an explicit owner override.

### Planes

**Real mode** vs **Native mode**:
**Real** = behaviour routed through the upstream `bin/fm-*.sh` scripts on the host
(authoritative). **Native** = the plugin's BB-only path using KV state (the
fallback/cache). Real state is authoritative; KV is a rebuildable cache.

**Owner flag**:
A per-concern setting (`queueOwner`, `decisionsOwner`, `afkOwner`, `quietOwner`,
`memoryOwner`, `notifyOwner`, plus `transport`, `watchOwner`) choosing `real` or
`kv`/`native` for that concern. Every owner flag defaults to the `kv`/`native`
side; a real owner writes through to the KV cache and degrades to KV on host
failure. Note: `readThrough` and `tellOwner` are off by default and, per the
captain's decision, are slated to be **deleted** rather than finished — do not
treat them as supported owners; `turnEndGuard` is likewise off by default (see
ADR 0002).

**fmHome**:
The firstmate home on the host — a reused, overlaid clone of the upstream repo,
fast-forwarded ff-only against a clean tree. Set by `init --real`.
