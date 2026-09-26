# Native inbox and supervision verification

Native source: `bb69be62e1f8df465d674a35f7e2ce707b900501`.

## Delivery

`scripts/live-inbox-delivery-check.mjs` installs an isolated temporary plugin
that imports the actual `server.ts`. The SDK, host-terminal transport, native
inbox library and BB queue are real. Only the delivery cleanup service and a
renamed CLI are registered; fleet monitoring and agent tools are excluded.
It uses the caller's active thread and launches no agent.

The live run passed both assertions:

- Two native inbox records survived verbatim while BB queued one notification
  pointer, with neither instruction body duplicated in BB input.
- After simulating the worker's native acknowledgement move and reloading the
  temporary plugin, the actual service removed the queued pointer and preserved
  pre-existing queue entries. The temporary plugin and scratch files were removed.

The receiver's read-and-move step is explicit in the script, not a claim that a
new model followed the notification. The self-targeted proof does not establish
cross-thread sender attribution. Production cleanup separately removed only
legacy copies backed by exact queue-body, transcript-read and handled-file matches.

The integration regressions execute the actual native writer and cover queue
coalescing, acknowledgement ownership, reload, notification retries, preservation
of 206 unread records, failed writes, deferred delivery and missing records.
Before the fixes, the coalescing test failed with two queued messages instead of
one, and the acknowledgement test failed because BB acceptance had already moved
the record. Removing the handled-file requirement makes the missing-record test
fail by deleting an unacknowledged notification.

## Supervision and receipts

Native scratch-home receipt tests cover mixed reports with persistent decisions,
changed decisions and repeated status events. The old mixed-report behavior
produces an unnecessary successor receipt; the new behavior completes once while
leaving the decision open. The renderer regression rejects the competing native
acknowledgement command while preserving report evidence.

The archived-home regression launches a real native watcher. Removing the native
`fm-watch-arm.sh --stop` call makes it fail with a leaked watcher. An installed
runtime check confirmed archived-home watcher cleanup while the active home kept
its supervision. Hung context/compaction regressions verify bounded service abort.

## Checks and limits

- Full suite: 511 passed, zero failed, two opt-in scout checks skipped.
- TypeScript, skill fidelity, whitespace checks and plugin build passed.
- All four overlay patches apply cleanly at the native pin.
- Native mirror checks: 14/14 passed with `FM_MIRROR_CHECK_NO_REAL_PROJECT=1`;
  those checks do not establish actual worker creation.
- Installed plugin reload: all four services running; cumulative handler errors
  unchanged.

These results cover the changed delivery, receipt and lifecycle paths. They do
not establish complete equivalence between every BB and native backend feature,
nor quantify token savings. Existing instruction bodies and crew work are kept.
