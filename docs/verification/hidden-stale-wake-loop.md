# Hidden stale wakes and empty receipts

## Diagnosis

Read-only inspection of the captain's native status on 18 October 2026 confirmed
that task `2803e0af` has old `done` events followed by newer `waiting` events.
The latest waiting event describes waiting for the owner's TestFlight answer.
`lib/policy.ts`'s `STATUS_VERBS` does not contain `waiting`; `latestStatus` skips
those lines and returns the old `done`. Both `quietCrewVerdict` and
`finishedCrewsWithTrackedPrs` use this reader. This explains the `finished` label:
it describes a recognized status verb, not proof that the task's work is live.
Commit `c2f3bdca` repairs this classifier first: verdicts and grace timestamps
now use the same newest worker event. Newer `waiting` and worker `note` events
prevent retirement. New plugin notes carry `[source=bb-plugin]`; this structured
origin and the legacy `FM_DELIVERY_NOTICE` marker keep annotations separate.
Untagged notes remain worker events. The two
checker API tests reproduced both command and scheduled teardown before the fix;
they keep the crew after the fix.

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

The original pairless-warning fix was insufficient: the receipt helper's second
native read could return a replacement hidden stale row with a valid pair.
The checker reproduced six stale-only receipts across six completions for a
paused crew without a tracked PR.

Pruning the final quiet row can leave a zero-cutoff native recovery receipt.
It is completed only with its recorded pair when this call removed quiet rows
and no report remains. Unchanged decisions use the journal's persisted repeat
flag, so they cannot turn a hidden paired refill into a successor receipt.

The presentation filter now applies the quiet-crew rule to those returned rows,
using fresh BB thread and worker status reads. A receipt containing only hidden
rows is completed through its recorded native acknowledgement pair, without
refreshing directly into another hidden batch. This choice is persisted in the
journal so recovery cannot re-enter that refresh loop. Later rows remain queued;
real status produced by the acknowledgement becomes a successor receipt.
Truncated presentations are never completed automatically.

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

The initial revision passed its full suite, but the checker supplied the paired
API reproduction above that its earlier helper-only fixture did not cover.
The permanent API cases now run against the shipped native bundle for paused,
waiting, working, late-report and open-decision scenarios. The helper tests also
cover hidden acknowledgement recovery and real status returned during that ack.


See [the retirement audit](164-retirement-audit.md) for the copied records of
17 retirements since the base commit, including the six crews whose newest
status cannot be proven. No restoration was performed.
