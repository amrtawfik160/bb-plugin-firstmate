# Safi captain recovery loop

Thread: `thr_yr4ppi2r3i`. Inspected 2026-09-29.

The Claude transcript records 11 `check: rearm-resurface` Stop-hook wakes
between 22:05 and 23:42 UTC. Late handling turns repeatedly returned
`No unread reports.` and still printed a user-facing update. Removing old crews,
closing old backlog tasks, and holding the future decision did not stop those
wakes. Calling them harmless was incorrect: they invoked the model.

Six turns from 23:06 through 23:42 processed 3,735,927 reported tokens:
3,097,838 cache reads, 632,635 cache writes, 5,380 output tokens, and 74 other
input tokens. This is provider-reported processing, not a dollar estimate.
Some turns performed useful cleanup, so the entire total is not attributable
to empty replies.

The watcher lifecycle ledger shows repeated `arm-interrupted`/SIGTERM closes,
followed by recovery wakes. The source of those SIGTERMs was not established.
The plugin's keeper and Claude's native async Stop autoarm were both running
for this home. The keeper declares its re-arms handling successors; the native
hook can independently restart and announce downtime recovery.

The BB captain hook now defers autoarm to the keeper only when its PID names
the exact keeper command, its plugin owner timestamp is within 600 seconds,
and its watcher beacon is within 300 seconds. Missing, stale, malformed,
future-dated, dead, or unrelated keeper evidence leaves native autoarm enabled.
The synchronous unread-wake and receipt guards remain active. Native hook
calls also receive the same `FM_SUPERVISION_MODEL=autoarm` binding as plugin
calls, so they use the BB supervision model.

The installed user-level hook was replaced with a backed-up copy. The idle
Safi captain runtime was stopped to cancel the existing async hook without
deleting its thread or changing its backlog. A live invocation of the new
autoarm hook exited silently with status 0 while BB's keeper remained healthy.

Regression coverage exercises delegation, native fallback, keeper identity,
beacon freshness, owner freshness, payload preservation, and unread-work
protection. All four focused captain-hook tests passed. The full `npm test`
suite passed: 568 passed, two skipped, zero failed. Shell syntax and
`git diff --check` also passed.
