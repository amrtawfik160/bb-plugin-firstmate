# Firstmate reliability and cost audit

Target: `thr_4e7xd2z94s` (Captain · Cyndra SaaS). Main-thread history: September 24, 03:23 UTC through September 26, 18:10 UTC. Child outputs and host state were inspected shortly afterward; the fleet continued working during this audit.

## Findings

| Finding | Evidence | Action |
| --- | --- | --- |
| Archived captains retain watcher processes | Live keepers/watchers existed for archived `thr_zxb2bnmg8u` and `thr_v7ehre4ak5`. The home supervisor refreshed every registered home without checking its owner. | Check archive state before refreshing; stop both the keeper and native watcher. Preserve the home and reports. |
| Redundant receipt completion | A mixed report contains new events plus persistent open decisions. Completing it returned the same decisions under another receipt. 28 such successor responses appear in the trace; 21 were immediately followed by an empty completion. | Suppress the previously presented decision suffix only when the native status cursor proves no new event was consumed. New decisions, repeated new events, and acknowledgement failures remain visible. |
| Conflicting completion instructions | Reports exposed both `WAKE_ACK_REQUIRED` commands and `handledWake`. The main agent made 154 calls containing legacy acknowledgement fields and hit two receipt mismatch errors. | Render one receipt completion instruction. Keep the native acknowledgement pair inside the journal and retain legacy input compatibility. |
| Compaction can delay plugin reload | The wake-release service awaited context/compaction SDK calls without its abort signal. Both hung-call regressions failed before the fix. | Bound those awaits and propagate cancellation. Keep the existing model, context budget, and cooldown. |

These changes are in `server.ts`, `lib/wake-receipt.ts`, and `overlay/bin/bb-wake-receipt.py`.

## Main-agent overhead

The captured history contains 10,928 events and 385 completed turns. All 527 recorded input requests selected `claude-opus-5-5[1m]`; requests can join an existing turn, so these are not 527 separate turns.

| Recorded operation | Count |
| --- | ---: |
| Wake calls | 564 |
| Steers | 179 |
| Dispatches | 125 |
| Watch handoffs | 109 |
| Crew inspections | 52 |
| Native merge-tool calls | 13 |

Of the wake results, 119 said `Wake queue empty` and 123 said `No unread reports`. Many are successful completions; **242 empty results do not mean 242 unnecessary turns**. Fifty-five recorded turns with tool activity contained only wake/watch/tool-search calls. These are optimization candidates, not proof that every turn was redundant.

Input classification: 340 core child notifications, 109 plugin internal wakes, 61 user inputs, nine other system inputs, and eight agent inputs. Some plugin wakes were labelled `user` by the transport; the classification above uses their actual internal-wake marker.

The last recorded provider usage counter was 71,006,457 total tokens, including 70,122,093 cache-read tokens and 205,485 output tokens. The counter resets earlier in the history, and providers account for cached input differently. This is **not a lifetime total or an invoice**; no dollar estimate or savings percentage is justified from it.

The latest detailed context snapshot was 92,763 used tokens: 72,715 messages, 9,949 skill descriptions, and the remainder system/tools/agent context. Deferred tool schemas were listed separately and are not counted as loaded tokens here. Automatic compaction is already configured at 200,000 tokens with a 20-minute cooldown; routine plugin batching is already 1.5 seconds.

## Children and quality

Inspected metadata and latest output for all 140 recorded direct children, plus detailed histories for 12 recent author/verifier threads around PRs 1755, 1769, and 1771. This is not an exhaustive security review of every child command or artifact.

At the metadata snapshot, 78 children were unarchived: 71 idle and seven active. Latest outputs included 65 unarchived children beginning `DONE:`. Eighty-two child worktree paths still existed, including four archived ones. Existence alone does not establish a leak: unfinished integration, uncommitted proof, or retention policy can justify keeping a worktree. No crew work or evidence was deleted.

Repeated verification was useful. Examples from the child reports:

- PR 1755, round 8: reproduced a cross-profile saved-result write and deletion outside the claimed transaction.
- PR 1771, round 2: green CI missed unrelated answers being replaced by email-failure text and incompatible production tool-result shapes.
- PR 1769: earlier rounds reported credential leakage through artifacts; round 3 reported successful remediation and independent checks.

Those product defects were reported by the verifiers; this audit did not independently reproduce them. They are a reason to preserve independent review and production-shaped tests.

## Further savings without weakening review

1. **Keep the main model and reasoning setting.** Remove redundant calls before considering a cheaper model. Quality equivalence from a model downgrade has not been established.
2. **Complete a receipt on the final necessary action.** `tell`, `dispatch`, `merge`, and other Firstmate tools accept `handledWake`. Use a separate completion only when no action remains. The renderer now gives this instruction without the competing legacy command.
3. **Reuse the author for fixes to the same PR when available.** The recent fleet often starts a fresh author each round, repeating setup and context reconstruction. Keep independent verification separate, with the current commit and all previous findings supplied explicitly. Restart an author when its context or approach is itself the problem.
4. **Turn recurring verifier findings into reproducible checks.** Require production-shaped fixtures and the accumulated regressions before returning to the verifier. Preserve independent inspection of each changed commit; do not replace it with author assertions or green CI alone.
5. **Retire completed scouts after preserving their reports.** Check each worktree and outstanding integration first. The 65 `DONE` outputs are a review queue, not permission for bulk deletion.
6. **Measure useful outcomes per main-agent turn.** Track empty read-only wakes separately from successful receipt completion, plus standalone acknowledgements, repeated steers, review rounds, and cached/uncached tokens. Compare equivalent workloads after the fixes; this audit cannot promise a percentage reduction.

## Remaining limits

- Core child notifications bypass the plugin's message-dispatch hook. The plugin's 1.5-second batching setting does not batch these inputs. Further consolidation needs a supported core notification mechanism.
- Several in-memory sets/maps retain thread identifiers until reload. Code inspection found no pruning for `liveTerminalHandled` or `captainTurnStartedAt`; this is a small unbounded-retention risk, not a measured large RAM leak.
- The keeper checks owner-heartbeat expiry between blocking watcher runs. A watcher that never returns can delay that backstop. Explicit archived-home cleanup now invokes native `--stop`; owner-death recovery still needs separate hardening.
- A failed lookup of a deleted/unreachable captain now prevents heartbeat refresh, but does not authorize destructive cleanup of its home.
- No blanket claim of no credential leaks is made. Raw audit captures stayed in a private directory outside Git; the report contains only counts and relevant identifiers.

## Validation

Regression tests failed before the fixes and passed afterward. Native scratch-home tests cover mixed receipt completion, newly arriving reports, repeated identical status events, and watcher shutdown without deleting task status. Removing the native `--stop` call makes the real-watcher test fail with `archived home's native watcher leaked`.

- Full suite: 507 passed, zero failed, two existing opt-in scout-cleanup tests skipped (`FM_SCOUT_NATIVE_BIN` unset).
- TypeScript, `git diff --check`, and `bb plugin build .` passed.
- Reloaded installed Firstmate from this checkout. All four services report running. The cumulative handler error count stayed at its pre-reload value of 12.
- Live verification: both archived homes lost their keeper PID, owner heartbeat, and watcher lock; process inspection found no remaining keeper/arm/watcher for either home. The target captain retained its keeper, heartbeat, and watcher lock.
- Current model, reasoning selection, compaction threshold, independent review, and merge requirements were retained. Changes are local and uncommitted.
