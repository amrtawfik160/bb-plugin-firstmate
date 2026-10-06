# Crew reporting and validation root causes

Date: 2026-10-06. Supervisor audited: `thr_xetkwhfexs`. Fixing thread: `thr_tfq68viuzg`.

The plugin fixes are loaded. The verified runtime is installed but is not selected by the audited supervisor. The approved coordinated instruction update was sent to the supervisor. Delivery was accepted. The supervisor then sent one task-specific correction to each of its three active workers. Areliaa and the new Cyndra review worker have recorded setup and completed the initial required reads; Cyndra implementation has not yet recorded setup. Further application and completion remain under the supervisor. Cyndra's independent pre-push scope fix is merged in [PR #2088](https://github.com/Cyndra-AI/cyndra-saas/pull/2088). GitHub records account `amrtawfik160` merging it at 09:36 UTC, commit `71b7f575de7b319ab7c418bd8ebf2e9d11c9e308`. This coding thread did not merge it. Required CI remained pending at readback.

## Causes and changes

| Observed problem | Cause | Fix |
|---|---|---|
| Inactivity alert despite tool work | Fallback monitor omitted tool item events accepted by native activity tracking | Use the shared activity event set in the fallback monitor |
| Initial status and old progress after edits | Independent manual reporting paths did not connect evidence, phase, and revision | Task-owned checkpoint helper writes a report before appending native status; preserves authored notes and old reports |
| Background checks repeatedly polled without paused status | No shared command owned launch, wait declaration, durable receipt, and exact-key resolution | Helper records paused before execution; uses a durable unit or native-required foreground execution; detects missing receipts and stale revisions |
| Required setup and instruction reads lacked evidence | Prompt asked for setup and reads without recording completion | Recorded setup runs the actual doctor in no-mistakes mode and tracks complete, unchanged project and TypeScript guide reads |
| Investigation prompt requested implementation | Role-independent default specification used shipping boilerplate | Report-only default requests investigation, commands, outcomes, revision, limits, and recommendations; explicit captain specification still wins |
| Cyndra pre-push selected zero changed files despite staged changes | File selection used only committed base...HEAD | Separate PR unions committed, staged/unstaged, and untracked non-ignored paths using NUL-delimited Git output |

The new helper preserves native status, exact-key resolution, fleet-ledger callback, and completion authority. It rejects another task's worktree/thread, symlinked namespaces, stale revision receipts, incomplete required reads, and a substituted delivery mode. A failed report write cannot publish completion. Missing background completion evidence is recorded as failure, not indefinite activity.

Native source briefs, Task and copied intent bytes, merge/deployment authority, and exact-ID inbox acknowledgment remain unchanged. The adapter's foreground mode comes from the actual optional native waiting clause, not an inferred configuration flag. The no-mistakes pipeline retains its native commands and outcome artifacts because it may change source. The helper only handles source-stable local checks. Future prompts include the recorded setup/report/check commands.

## Evidence

Stable artifacts: `/root/.bb-server/thread-storage/thr_tfq68viuzg/artifacts/crew-root-fixes-2026-10-06/`.

| Validation | Result | Artifact |
|---|---|---|
| Full plugin suite, with real native fixture and locked BB CLI | 887 passed, 0 failed, 0 skipped | `full-release.log` |
| Offline CI profile | 356 passed, 0 failed, 0 skipped | `ci-release.log` |
| Causal regression mutations | All 14 removed fixes were detected | `mutations-release.log` |
| Installed helper with real systemd boundary | 14 passed, 0 failed, 0 skipped | `checkpoint-installed-live.log` |
| Plugin typecheck and native skill fidelity | Passed | `typecheck-final.log`, `fidelity-final.log` |
| Reproducible runtime verification and plugin build | Passed | `runtime-release.log`, `build-release.log` |
| Live plugin readback | Enabled and running from this checkout | `plugins-loaded.json` |
| Runtime installation readback | Installed, selected=false | `runtime-installed.json` |
| Cyndra regression and planner behavior | 26 focused tests passed | `cyndra-scope-final.log` |
| Cyndra project typecheck, focused lint, script typecheck | Passed | `cyndra-typecheck.log`, `cyndra-lint.log`, `cyndra-scripts-typecheck-final.log` |

The no-mistakes setup test replaces the external doctor command to exercise its initialization decision. It does not verify the actual active Areliaa worker's setup. Live helper tests run only disposable task fixtures and their own systemd units. Worker behavior after receiving updated instructions remains a separate acceptance step.

Pre-fix reproductions are retained in `activity-red.log`, `scout-red.log`, `interrupted-red.log`, `report-order-red.log`, `zero-turn-red.log`, and `cyndra-scope-red.json`. The mutation suite runs in copies and verifies that removing each behavior makes its assertion fail.

The curated `changes.patch` compares task-start baseline copies, so it excludes pre-existing dirty changes. It includes the task's source changes and new helper/tests. The binary runtime archive is recorded by hash in `changes.json`, rather than embedding it in the patch. No unrelated working changes were discarded or staged.

## Installed distribution

- Release: `d1100be21aed94c329e47d0611b9d780489cd977c3e1f9b8c087a417efd1f6a5`.
- Adapter: `e5c6d8e7456c8fd46c509403d893167f0a458f701f5c77ec772fe2e0a36538a3`.
- Runtime archive SHA-256: `c16e1b03c8f707b3d0dd0212e3f543c14a7cd355d5de2b744b035de713b29f82`.
- Installed root: `/root/.local/share/bb-firstmate/versions/d1100be21aed94c329e47d0611b9d780489cd977c3e1f9b8c087a417efd1f6a5/runtime`.
- Cyndra PR head: `47e1d67bc96ae81d483768c25e1db77f55c68a5d`.

No existing worker prompt, task status, report, inbox, or selected runtime pointer was directly modified by this coding thread. One approved update was sent to the supervisor; `supervisor-delivery.json` records delivery=sent. The captain approved sending `supervisor-update.md` by selecting A on 2026-10-06. Selection must use the native quiescence procedure; do not force or hand-edit the pointer.

The audit established that repeated steering was relevant to the work. These fixes do not suppress valid new instructions or treat an inbox acknowledgment as proof of completion.

## Supervisor acceptance readback

`supervisor-readback.txt` records acknowledgment, current metadata inspection, preserved runtime selection, and three successful native tell calls without interrupts. The new review worker was created independently by the supervisor during this coding task; this thread did not spawn it. Initial `worker-acceptance.json` captures early setup/read state. Subsequent readback confirmed the initial required reads complete for Areliaa and the review worker. Cyndra implementation setup was still pending. Valid application review and CI waits were preserved.
