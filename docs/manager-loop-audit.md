# Manager loop audit — 2026-09-23

The recorded manager behavior supports the reported problem. Updating upstream
alone does not make this plugin equivalent to Firstmate.

## Updated

- Plugin checkout: `a0abcd4`, already current with `origin/main`.
- Upstream `/root/firstmate`: fast-forwarded `6f0f1399` → `8c47279f`.
- Rebuilt and verified the BB backend overlay against the new upstream. Upstream
  tracked files remain clean. Bundled skills/snapshots still pin `6f0f1399`;
  pulling the runtime does not update those copies or existing agent instructions.

## Recorded behavior

Inspected manager `thr_attjy46zk4` (Cyndra), September 21–23, through BB's event log:

| Operation | Recorded calls |
| --- | ---: |
| `firstmate_crew` | 1,253 |
| `firstmate_tell` | 583 |
| `firstmate_watch` | 461 |
| `firstmate_dispatch` | 50 |
| `firstmate_deliver` | 44 |
| `firstmate_merge` | 0 |
| `firstmate_wake` | 0 |

Crew `e90b0f93` received 120 steers. Many messages repeated holds, test-slot
coordination, or requests for another checkpoint. These counts demonstrate
coordination churn; zero merge-tool calls alone does not prove no useful code
was produced or no changes landed by another route.

## Confirmed defects and gaps

1. **False review alerts.** Of 102 plugin review-ready notifications, 31 carried
   a `BLOCKED:` verdict. `notifyCaptain` promoted any idle crew with a PR to
   review-ready before considering its verdict.
2. **Stopped work produces completion wakes.** `handleCrewIdle` skipped protocol
   nudges after interruption but still notified the manager as completed work.
   This can invite recovery after a stop. A regression reproduced the unwanted
   manager steer.
3. **Two notification sources.** The transcript includes 351 BB
   `child-completed` inputs and 151 plugin internal wakes. Adjacent entries
   30763/30764 reported the same crew result through both sources. Removing one
   path requires preserving durable recovery and immediate delivery.
4. **Incomplete supervisor contract.** `refreshCaptainContract` retains only
   the first 3,400 characters of upstream `AGENTS.md`. Its supervision and
   delivery sections are later in the document. The BB captain skill supplies
   separate guidance, but this is not full upstream contract injection.
5. **Runtime failures remain.** Installed-plugin logs showed wake-drain timeouts,
   real decision operations failing, and real dispatch falling back to native
   BB spawning. Their individual causes were not reproduced in this audit.

Recent plugin commits changed `firstmate_watch` to a short event handoff. This
history spans that change; 461 calls are not evidence that the current watch
implementation still blocks or polls.

## Local fix and validation

- Require `DONE:` before a PR can produce a review-ready notification.
- Preserve blocked/failed notifications in quiet and away modes.
- Suppress plugin completion wakes for interrupted turns; BB retains its own
  interruption notification.

The new regressions failed before the fixes. The PR-verdict test executes real
upstream wake scripts in a scratch home and checks both the manager notification
and durable status content. BB SDK delivery is simulated; this is not a live
agent delivery/merge acceptance run.

Validation: 301 tests passed, TypeScript passed, plugin build passed. Independently
reverting the review-verdict gate, stop suppression, or posture classification
made its corresponding regression fail; restoring the fixes passed all four
focused cases.

Remaining work: select one owner for outcome notifications; preserve the complete
upstream supervision contract with explicit BB adaptations; reproduce the real
dispatch/drain failures; then validate a bounded task through delivery and an
authorized merge. These local alert fixes do not establish full parity or prove
the wider steering loop resolved.

## Follow-up: native behavior comparison

The additional checks used current native `8c47279f` scripts in scratch homes,
with BB delivery simulated. No worker agents were launched and no PR was merged.

| Path | Reproduced difference | Change |
| --- | --- | --- |
| Real dispatch | Native's away cap refused a worker; plugin fell back to a direct BB spawn | Propagate refusal, retain queued row, preserve existing-worker/orphan adoption |
| Wake acknowledgement | A successful steer plus unrelated captain idle consumed unhandled reports | Require explicit native generation-bound acknowledgement after handling |
| Away entry | Plugin invoked retired `propose` / `confirm`, then kept KV away despite failure | Use `enter`, commit KV after native success, preserve mandate on empty refresh, reject retired grants |
| Captain instructions | Only a short prefix of an 86,955-byte contract could reach the captain | `firstmate_contract` / `bb firstmate contract` returns the full current file; retain memory and skills within the SDK's 4,096-character instruction window |
| Captain decisions | Plugin-generated hold reasons contained parentheses, which native rejects | Use accepted hold/defer reasons; test real hold and answer records |
| Dependency | Installed tasks-axi 0.2.5; current native requires 0.2.6; plugin advertised 0.2.4 | Upgrade host to 0.2.6 and align the advertised minimum |
| Wake drain | A scratch copy of this captain's 49 status files completed in 31.8 seconds; plugin cut off at 30 seconds | Use the existing native-script timeout budget of 180 seconds |
| Bundled instructions | AFK still required a second go and described removed grants; recovery lacked landed-work cleanup | Update five changed skills and their snapshots to 8c47279f, including duplicate-event handling in fmx-respond |

The drain measurement used copied state, no pre-existing locks, and fresh native
bin links. This establishes an overly short plugin timeout, not a general native
performance fix. The prior traced run exceeded 35 seconds while scanning status
presentation cursors. Native scan cost still grows with fleet history.

### What still differs

- BB core child-completion input and plugin durable doorbells can both reach the
  captain. No supported silent suppression of only core notifications was found.
  Reconciliation and acknowledgement are still necessary; duplicate-delivery
  elimination is not complete.
- Multiple captains share one native FM_HOME, AFK record, worker cap, and backlog.
  Wake queues and BB notification posture are scoped separately. This is not
  equivalent to independent native homes. Existing live state was not migrated,
  cleared, or acknowledged by this audit.
- BB does not expose native's blocking turn-end hook. Background supervision and
  the captain instructions adapt that lifecycle; reading the complete contract
  cannot itself prove the manager obeyed it.
- AFK return still uses the BB digest and a policy instruction for catch-up, not
  the complete enforced native return gate. Several real-owner operations still
  degrade to KV after failures; dispatch and AFK transitions now preserve refusal.
- Native status protocol and secondmate lifecycle are richer than the plugin's
  DONE/BLOCKED/FAILED summary and secondmate router. Those are not certified as
  equivalent by these checks.

A live bounded task through dispatch, delivery, review, and authorized landing
has not been exercised here. Passing script regressions establishes these fixes,
not exact parity or proof that the wider manager loop is gone.

### Follow-up validation

- 305 tests passed, zero skipped; TypeScript and plugin build passed.
- All five new behavioral regressions failed against the original `server.ts`:
  native spend refusal, explicit wake acknowledgement, current AFK entry,
  complete contract access, and native captain-hold persistence. Restoring the
  fixes passed the suite.
- Skill fidelity passed against declared upstream pins; BB overlay verification
  passed and `/root/firstmate` tracked state remained clean.
- Reloaded the installed path plugin. Both supervision services reported running.
- Live `bb firstmate contract` returned all 86,955 native bytes unchanged,
  followed by the BB adaptations (89,793 bytes total).
- Changes are active locally and remain uncommitted. Existing untracked
  `marketplace-assets/` was left untouched.

## Follow-up: explicit 15-second generic wake-drain

The reported `firstmate_fm(script: wake-drain, timeoutSec: 15)` bypassed the
previous fix to the dedicated `firstmate_wake` path. The generic script budget
still accepted 15 seconds. Both agent-tool and CLI regressions reproduced the
exact `Timed out waiting for host command.` error while simulating the measured
32-second native scan.

- Generic wake-drain now has the same 180-second minimum, including explicit
  shorter budgets. Longer explicit budgets remain supported; unrelated scripts
  retain their requested short timeout.
- Generic wake-drain scopes its native state to the calling captain and rewrites
  acknowledgement instructions to `bb firstmate wake`, matching the dedicated
  wake tool. Existing explicit internal scope overrides are retained.
- No retry loop was added. The same command completes, or its terminal is closed
  at the effective timeout.
- Eight tool/CLI regressions cover short budgets, longer overrides, the upper
  execution boundary, unrelated scripts, and terminal cleanup. All 313 tests
  passed; TypeScript, skill fidelity, and build passed. Reloaded the installed
  path plugin; both supervision services reported running.
- Live BB verification against a scratch copy of the manager's 49 status files:
  `bb firstmate fm --home <scratch> --timeout 15 wake-drain` completed successfully
  in 48.9 seconds, with no timeout. Live fleet records were not changed.

## Follow-up: dispatch blocked by a stale away record

The reported task `c77974a9` was correctly refused by native's away cap, but the
away session should already have ended. Its owning manager received accepted
human messages after entering away mode, including a new merge/development-test
instruction. The plugin had no automatic return transition.

Read-only inventory found 189 ordinary records across 12 captains and five
projects: 100 archived BB threads, 88 idle, one active. Idle is not proof of
finished work. No records were deleted and the cap was not raised.

The plugin now reconciles a return on thread activity/idle and before native
spawn. It requires a unique matching BB posture (exact mandate and entry time),
an accepted human request newer than the native record and the latest BB entry,
and excludes worker/system input, internal wake markers, and `/afk` refreshes.
A refresh also updates the BB entry boundary so an earlier human message cannot
end a renewed away session. Entry, explicit exit, and reconciliation serialize.

Archiving uses native's record lock and archive function, checking the original
record digest under the lock. A concurrent replacement is preserved. Held
reports stay available for the ordinary return brief; the accepted request and
archive reference are retained as evidence. Operator recovery uses
`bb firstmate afk reconcile-return --captain <thread-id>` and the same checks.
This command does not dispatch or message a crew.

This fixes the stale-away refusal after a verified return. It does not isolate
all native homes or retire old task records; a genuinely away shared home still
uses native's fleet-wide cap. Full native AFK return/catch-up remains a separate
parity gap described above.

During live repair the native record had already been archived by another
operation, while this manager's BB AFK cache remained on. Recovery also handles
that partial return: it requires a uniquely matching native archive near the
legacy KV entry timestamp and the same accepted human-return proof. It preserves
any newly entered live record under the native lock. An archive alone is not
proof of a return.

Final validation: 327 tests passed, zero skipped; TypeScript, skill fidelity and
plugin build passed. Live BB exposed its 100-event query limit (not expressed in
the SDK's string type); the regression now enforces that limit. Reloaded the
plugin. Automatic recovery recorded accepted human request sequence 44159 for
`thr_attjy46zk4`; subsequent live checks showed BB away=false and native
away=false. The reported task `c77974a9` remains in the native backlog. No worker
was launched by this repair and no task records or worktrees were deleted.

## Follow-up: crew retention, recovery, and cleanup

The next audit reproduced additional lifecycle failures:

- Reads and writes truncated the shared crew register to 50 entries. Concurrent
  read/modify/write operations also lost changes or restored a forgotten crew.
  The register now retains all valid entries and serializes mutations. The
  supervisor still inspects at most 50 per pass using its existing rotation.
- Recovery searched only the newest 50 threads and inspected only 20 missing
  entries. It now advances through bounded pages. Explicit crew listings no
  longer silently hide everything after the twentieth row.
- Forget without stopping left the thread marked as a crew, so the next listing
  recovered it. Retirement now clears that metadata and persists a tombstone
  that also rejects stale sweep results or a failed metadata update.
- Teardown treated unreadable Git state as clean, and metadata-only recovery
  bypassed the ordinary dirty-work checks. Both paths now use the same checks;
  unavailable environment/diff/Git results refuse cleanup and retain the crew.
- Failed stop, archive, worktree deletion, or native metadata removal previously
  reported success or removed the recovery record. These failures now remain
  visible and retryable. Native metadata removal precedes register removal.
- A PR URL was incorrectly taken as proof that all commits were pushed; a file
  diff also missed empty commits. Cleanup now uses Git commit reachability
  against the base and local remote-tracking refs, without fetching. New local
  commits after a PR still prevent removal unless force was explicitly supplied.

Validation added 18 regressions. The initial 15 failed against the pre-audit
implementation. Reinstating the old PR/file-diff shortcut separately killed all
four targeted Git regressions. A scratch native home exercised a real failed
metadata removal followed by successful retry through `fm-tasks-axi.sh`: all 60
other metadata records and crew entries survived. A disposable Git repository
and local bare remote proved that an empty commit after a pushed PR is refused,
then accepted after that commit is pushed. No live crew was stopped or forgotten
for these tests.

The full suite passed 345 tests with zero skips; TypeScript, plugin build,
skill fidelity, and native overlay verification passed. Existing historical
native task records are not bulk-retired by this change. The broader native
parity limits listed above still apply.

Reloaded the installed path plugin; both supervision services reported running.
Live `bb firstmate crews --all --json` returned 79 unique crews across four
captains, confirming the register and list no longer truncate at 50/20. Changes
remain local and uncommitted.

## Remaining-policy follow-up

The follow-up routes merge and landed cleanup through native scripts, makes
native mutations fail closed, introduces per-captain homes with legacy record
pinning, bounds repeated wake episodes, and enables the native secondmate
captain adapter. See [current implementation and limits](native-parity.md);
the older “What still differs” section above records the earlier audit state.

## Wake reachability error masking

A reported `No real fm-wake queue reachable` was accompanied by a host-terminal
HTTP 504 and `Timed out waiting for host command`, despite configured native
home and host settings. `drainWakes` caught every transport exception and returned
the same null used for missing configuration. It also reported nonzero native
exits as successful text. A related transport path treated a failed output read
on an exited terminal as successful empty output.

The wake tool and CLI now retain the cause, home, host, terminal ID and timeout
budget. Native failures remain errors. Failed output reads on exited terminals
retry within the original deadline without starting another command; drain/ack
operations are never automatically rerun. If the host setting is absent, the
calling captain's environment resolves it. Five regressions failed before these
changes and pass afterward, including a real host-shell script failure that
leaves the queue unchanged. Infrastructure timeouts remain possible; they are
no longer misdiagnosed as missing initialization.

Validation: 364 tests pass with no skips; TypeScript and build pass. After reload,
the live `firstmate_wake` tool returned `Wake queue empty.` from this captain's
native home.
