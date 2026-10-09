# Parent review and live acceptance

Status: independent review, isolated live acceptance, and the final full suite passed.

Implementation uses GPT-6.1 Sol at high reasoning. Baseline: `95f589359627ff65b859f3ae5393b153dda273ed`.
Parent reviewed the original `3282ed6` implementation, the `3e9702e` corrections, and the final live-test corrections at `098db97`.

## Independent review

Separate standards and spec reviewers found recovery contract loss, unbounded follow-up reads, late terminal leakage, and lost native continuation after forgetting workers. Parent also identified review-policy mismatch, premature native admission, partial-handoff ownership splits, and an extra startup prompt. The implementation agent corrected all nine findings. Both reviewers cleared their focused re-review at `3e9702e`.

Four independent parent probes failed on the original implementation and passed on the corrections:

| Probe | Original failure | Corrected observation |
| --- | --- | --- |
| Hung PR discovery during disposal | Schedule did not settle | Schedule settles after disposal |
| Late terminal creation after cancellation | Zero close calls | Exactly one close call |
| Register an existing task | Required verification weakened to merge-only | Original requirement preserved |
| Recover task from creation metadata | Requirement absent | Original requirement preserved |

Independent full suite at `3e9702e`: **636 passed, zero failed, zero skipped**. TypeScript, plugin build, and skill fidelity passed.

## Real native launch acceptance

Tests used a separate BB server and host daemon, a disposable project, a native clone at `1f3e769616fdf9f31f85f4c3e6a9f71606634238`, and the candidate plugin. No production plugin, native home, or fleet state changed.

The native mirror acceptance script passed **21 checks**. It created real coding and research workers with GPT-6.1 Sol, then removed them. Added parent assertions inspected their actual event logs and replies:

- Each worker received one initial task prompt, with no startup `cd` continuation.
- Each worker reported no Firstmate manager tools in its initial tool catalog.
- Patched native scripts accepted the BB backend; pristine native scripts refused it.
- Native workspace handoff and local landing checks executed on disposable repositories.

Separate plugin CLI dispatch emitted both `real transport backlog add crew=delivery-proof ok` and `real transport spawn crew=delivery-proof ok`. No fallback signature appeared.

## PR lifecycle acceptance

The disposable task uses an existing, already-merged project PR as a read-only GitHub fixture. No PR creation, modification, merge, or deployment is part of this test.

Registration through the real CLI preserves `merged-and-verified` without repeating the requirement. The initial live lookup exposed an additional defect: GitHub CLI prints `Working...` into a PTY before JSON. The record correctly stayed stale, but could not refresh. Commit `098db97` captures stdout and stderr separately. The same real lookup then passed without changing GitHub state.

All seven remaining lifecycle assertions passed on `098db97`:

1. A real merged PR remains pending its required verification.
2. Reload preserves that record and its owner.
3. Forgetting the worker preserves the pending record.
4. An archived, forgotten author can be resumed through the retained task.
5. Manager handoff transfers the author and PR together.
6. Reload preserves the new owner.
7. Archiving the manager marks the PR as needing a new owner.

The disposable obligation was explicitly abandoned after acceptance. That changes only the scratch plugin record. The fixture PR was already merged; no GitHub mutation occurred.

A further real native launch at `098db97` passed **17 checks**, including one initial prompt, no manager tools, and exact worker deletion changing its held provisioning reservation to `deleted`. The native script, worker, and disposable project were cleaned up.

Known limitation: a deletion event missed before this version recorded it cannot be inferred from a transient SDK lookup failure. Such uncertain launch records remain held. Recorded exact deletion events survive reload. Creation with no returned identity also remains held until reconciled; this avoids duplicate workers.

## Reproduction and evidence

Parent scratch evidence is under `/tmp/firstmate-implementation-20261004/`:

- `parent-final-tests.log` at `3e9702e`; `parent-098db97-tests.log` for the final code.
- `parent-final-tsc.log`, `parent-final-build.log`, `parent-final-fidelity.log`.
- `parent-deletion-live.log` and `parent-lifecycle-live-final.log` for final acceptance.
- `parent-live-final.log` and `live-<thread-id>-events.json`.
- `parent-hung-schedule.mjs`, `parent-late-terminal.mjs`, `parent-spec-register.mjs`, `parent-spec-recovery.mjs`. Each supports `FM_REVIEW_ROOT`.
- `lifecycle-live.py`, `lifecycle-live-resume.py`, and the lifecycle result JSON.

The repository's permanent regression suite, mutation checks, and exact native commands are recorded in [the implementation matrix](launch-pr-lifecycle-progress.md). Scratch evidence is supporting material, not a required dependency for the test suite.

## Final result

Final code at `098db97773c4cb0399c38e39d2fc7c824e6c0503`: **641 tests passed, zero failed, zero skipped** in the parent’s independent full run. The increase from 636 is five added capture/deletion regressions. The final narrow standards review found no blockers and passed six focused tests.

The scratch plugin was disabled, its disposable lifecycle project was removed, and both isolated BB services were stopped. The production plugin was not reloaded. The deployed `$FIRSTMATE_HOME` checkout was not upgraded.

Integration applies only the implementation delta after the saved baseline. Original source files matched their saved hashes before integration; pre-existing edits are preserved.

Integrated source checks also passed: TypeScript, skill fidelity against the scratch native pin, plugin build, and whitespace validation. All 99 changed paths matched the reviewed commit contents immediately after integration. Production inspection confirmed Firstmate still running its prior version with no PR-follow-up schedule; `$FIRSTMATE_HOME` remains at `2d833ff147cd26a5c461e914e06854e0eb2707ce`. Both acceptance services are inactive.
