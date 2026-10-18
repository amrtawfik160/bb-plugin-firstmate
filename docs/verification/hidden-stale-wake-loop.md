# Hidden stale wakes and empty receipts

## Diagnosis

Read-only inspection of the captain's native status on 18 October 2026 confirmed
that task `2803e0af` has old `done` events followed by newer `waiting` events.
The latest waiting event describes waiting for the owner's TestFlight answer.
`lib/policy.ts`'s `STATUS_VERBS` does not contain `waiting`; `latestStatus` skips
those lines and returns the old `done`. Both `quietCrewVerdict` and
`finishedCrewsWithTrackedPrs` use this reader. This explains the `finished` label:
it describes a recognized status verb, not proof that the task's work is live.
The status classification itself is unchanged by this repair.

The native watcher's `wedge_timer_check` deliberately resets its timer and
increments its escalation count each time it queues a wedge. Removing a queued
row does not end that episode. The BB backend's `fm_backend_bb_agent_state`
reports an idle resumable BB session as `alive`. Native `pause_state_class`
requires a dead agent for an ordinary paused crew's long cadence. Its pause
mechanism therefore cannot safely grant this idle session an indefinite
exemption. Setting a paused status would also overwrite the worker's declaration;
falsifying endpoint liveness could hide a real wedge. No native queue
acknowledgement cancels the watcher's recurring timer.

Use the plan's third option, at the receipt boundary. Native's final guard can
see a replacement row arriving after the drain's presentation boundary. Its
warning has no acknowledgement pair. That warning prevented the receipt
journal from recognizing an unchanged OPEN DECISIONS section as already shown.

## Repair

After the existing bounded retry for a warning-only presentation, remove the
native pending warning from presentations with no acknowledgement pair. Apply
this rule to fresh reads, recovered reads and completion refreshes. Real queue
presentations retain their acknowledgement pair and all their text. Pairless
status reports and changed decisions remain reports. Queued rows are neither
deleted nor acknowledged by this rule; a row that arrives too late for the read
is available to the next read.

## Evidence

Command for the original reproduction:

```sh
node --test --experimental-strip-types --test-name-pattern='six watcher refills' scripts/wake-receipt.test.ts
```

Before: six watcher refills produced six new receipt IDs after the original
decision receipt. After: all six reads returned null receipt IDs, ending with
`No unread reports.` The fixture prunes the previous hidden stale row before
each read and refills the queue after that read, matching the watcher race.

Additional checks in `scripts/wake-receipt.test.ts`:

- `a truly wedged working crew still gets a stale receipt after warning-only reads`:
  actual stale row remains inspectable and unacknowledged, with cutoff 7.
- `a pending-queue warning that never yields a report is read once more without opening an empty receipt`:
  bounded retry remains, with no warning-only receipt.
- `the second read for rows that arrived mid-read is skipped when the budget cannot cover it`:
  the late report remains queued and is delivered on the next receive.
- Existing changed/reopened-decision, crash recovery, pairless status, and
  mixed queue/status tests remain in the full suite.

No live home was modified. No plugin reload, merge or server restart is part
of this repair.

Final validation: type checking passed. The full suite passed 1,791 tests and
skipped 11 tests, with no failures. The receipt-only suite passed 48 tests and
skipped 6 native-fixture tests. The 11 focused timeout/package-discovery tests
passed without skips. The first full run exposed six fixed-chunk-count
assertions; these now permit payload growth while checking one staged execution
and complete cleanup. Its separate package-discovery cleanup race did not
recur in either the focused run or the final full run.
