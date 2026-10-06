# Queued messages remain after native inbox acknowledgement

## Confirmed result

Crew `0c7bf858`, BB thread `thr_4rvskt9mvf`, had 14 BB queued messages,
all waiting on `thread-busy`. Its captain is `thr_4e7xd2z94s`.
The oldest queued message was created at 10:03 UTC on 2026-09-26.
The captured crew history contained one started turn and no completed turn.

All 14 queued bodies exactly matched both a completed command's output in the
crew transcript and a native inbox file in `handled/`. None remained pending
in the native inbox. These are duplicate deliveries awaiting dispatch, not 14
unread tasks. Reading and acknowledging instructions does not establish that
all requested work has finished.

## Cause

`server.ts`'s `sendViaInbox` writes a native inbox record and sends the full
message through BB with `mode: "queue-if-active"` when `queue: true`.
The captain explicitly selected `queue: true` for every affected message.
The worker read the native records during its active turn and moved them into
`handled/`. The plugin has no reconciliation that removes the corresponding BB
queue rows. Consequently the UI still counts them and BB can deliver them again
after the turn ends, including instructions superseded by later messages.

The queue rows also identify the initiator as `user` with no sender thread.
Attribution to the captain was established by exact message matches in its
completed `firstmate_tell` calls, rather than trusting that queue attribution.

## Evidence mapping

| BB queue row | Native handled record | Crew read event sequence |
| --- | --- | --- |
| qmsg_ve4v4es322 | 001.msg | 569 |
| qmsg_sw9mfm5589 | 002.msg | 569 |
| qmsg_5shxjaqvjt | 004.msg | 755 |
| qmsg_zd57e2ub9j | 005.msg | 857 |
| qmsg_fj9rx2xwuy | 006.msg | 1022 |
| qmsg_x2muhepekn | 012.msg | 2319 |
| qmsg_yjqmpaxug6 | 013.msg | 2367 |
| qmsg_z5suug2ucj | 014.msg | 2638 |
| qmsg_kmju4y8se2 | 017.msg | 3133 |
| qmsg_izjq882rsr | 019.msg | 3372 |
| qmsg_686pewzsvb | 020.msg | 3504 |
| qmsg_fxkv27sea3 | 022.msg | 3686 |
| qmsg_qyh9rhkgmm | 023.msg | 3731 |
| qmsg_4bs9f9infn | 024.msg | 3848 |

Read-only commands: `bb thread queue list thr_4rvskt9mvf --json`,
`bb thread log thr_4rvskt9mvf --all --json`, and the captain's full JSON log.
Exact-body matching against transcript command outputs and native `handled/`
files confirmed all 14 rows. Private snapshots are under
`/tmp/firstmate-queue-audit` (directory mode 0700).

## Recommended correction

Track the BB queued-message ID alongside its native inbox record. Reconcile
acknowledgements so a message consumed through either route cannot later replay
through the other. Preserve pending messages, sender provenance and failed-send
recovery. Test the real sequence: queue while active, read and acknowledge the
native record, then finish the turn; the body must not be delivered again.
Critical policy changes should use an immediate steer instead of `queue: true`.

This inspection did not delete queued messages, message either agent, interrupt
the deployment worker, or change plugin delivery behavior.

## Correction implemented

Real-mode tells now call the native inbox writer and native doorbell renderer.
The body is never also queued as BB input. The worker owns acknowledgement;
producer-side acknowledgement and unread-record pruning were removed. Queued
notifications are coalesced and tracked durably for reconciliation after reload.
Only owned queue IDs whose text still matches the native notification are removed;
unrelated or edited rows remain. Host errors preserve records and notifications.
A failed notification retries from its stored pointer, without rewriting the body.
BB-deferred steers are reported as queued, and sends carry the captain thread ID.

The plugin still uses BB-specific thread transport and its optional deferred
notification mode. This establishes native parity for the inbox lifecycle, not
proof that every BB adapter behavior is identical to every upstream backend.

## Live cleanup and validation

Removed 15 legacy full-body queue copies after checking each live queue ID and
unchanged body against both a native handled record and its transcript read.
Fourteen belonged to `thr_4rvskt9mvf`, one to `thr_xgdx4k6ti9`; both queues ended
empty. The other 64 queued messages in the cross-thread snapshot were retained.
Private backups and the per-ID cleanup results remain in the evidence directory.

Regression tests reproduce the original duplicate queue and premature
acknowledgement failures before the fix. They cover coalescing, actual native
writes, worker acknowledgement, plugin reload, failed-send retry, preservation of
206 unread records, honest deferred-send reporting, and refusal to bypass failed
native writes. A further regression proves that a missing record is not an
acknowledgement: removal requires the recorded names to exist in `handled/`.
Directory listing errors also preserve queued notifications.

Final checks: 511 tests passed, zero failed, two opt-in scout tests skipped;
TypeScript, skill fidelity and plugin build passed. Reloaded the installed plugin;
all four services reported running, cumulative handler errors stayed at the
pre-existing 12, and the reported crew's queue remained empty. Changes are local
and uncommitted, alongside the preceding audit and upstream update.
