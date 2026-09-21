# Durable wake queueing is best-effort because BB cannot gate turn-end

Native firstmate blocks a captain's turn-end through harness Stop hooks that
exit non-zero (exit 2), forcing the agent to keep going until durable wakes are
drained. BB exposes no equivalent: it emits only post-idle void events (a turn has
*already* ended). So a durable wake queue in BB has **no forcing function** — we
cannot hold a turn open until the queue is drained. Queueing is therefore
best-effort: the plugin re-rings an idle captain with undrained wakes (a `steer`
injection, budget-limited), but it cannot guarantee the captain acts before going
idle.

## Consequences

- The wake path is a doorbell + pointer, not a blocking gate: content lives in the
  status file, the wake row is only a pointer, and drain collapses rows per key.
- The re-ring is budgeted and resets when the queue empties, so a permanently
  ignored wake cannot loop forever — at the cost of not being a hard guarantee.
- Do not design any feature that *requires* a captain to drain before turn-end;
  BB cannot enforce it.
