# Durable wake queueing is best-effort because BB cannot gate turn-end

Native firstmate blocks a captain's turn-end through harness Stop hooks that
exit non-zero (exit 2), forcing the agent to keep going until durable wakes are
drained. BB exposes no equivalent: it emits only post-idle void events (a turn has
*already* ended). So a durable wake queue in BB has **no forcing function** — we
cannot hold a turn open until the queue is drained. Queueing is therefore
best-effort.

The only backstop is `turnEndGuard=re-ring` (a `turnEndGuard` setting, **off by
default**): when enabled it injects one budget-limited `steer` re-ring at a
captain who goes idle with undrained wakes. It is a post-idle backstop, not a
gate — the blind window between idle and the re-ring remains, and with the default
`off` there is no re-ring at all.

## Consequences

- The wake path is a doorbell + pointer, not a blocking gate: content lives in the
  status file, the wake row is only a pointer, and drain collapses rows per key.
- The re-ring backstop is opt-in and off by default; when on it is budgeted and
  resets when the queue empties, so a permanently ignored wake cannot loop forever
  — but it is never a hard guarantee even when enabled.
- Do not design any feature that *requires* a captain to drain before turn-end;
  BB cannot enforce it.
