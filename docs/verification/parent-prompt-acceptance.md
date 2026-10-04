# Parent prompt and inbox acceptance

Final result, 2026-10-04: code through `82ae472ccf660038616c4ddd5dd1aafaf8bd9f80` is integrated and active. Plugin reload succeeded; all four services are running. All 15 installed BB adapters verified against the new payloads. Every native HEAD and working-tree status remained unchanged.

New launches and replacements receive the corrected prompt. Existing workers keep their supplied context; their installed helper now refuses unsafe bare acknowledgements. No production worker was restarted or live inbox acknowledged.

Reviewed prompt correction: `33d5cb0..56295c14f26381ed817e74a6cb6d8374b1fea162`.

Independent full suite: 654 passed, zero failures/skips. Log `/tmp/fm-parent-prompt-full.log`.
Independent typecheck, fidelity, build passed. Logs `/tmp/fm-prompt-parent-{tsc,fidelity,build}.log`.
All eight causal mutations failed their intended assertions. Log `/tmp/fm-prompt-parent-mutations.log`.
The mutation script first refused an archive without Git history; fetching the exact reviewed commit into its isolated candidate supplied the required baseline. No production code changed.

Real native initial launch acceptance on private BB server port38990/daemon38991: 25/25 passed. Both ship/scout models received one initial prompt, the corrected browser rule without the conflicting native rule, exact acknowledgement IDs and concrete artifact paths, and responded to their bounded acceptance task. Log `/tmp/fm-prompt-parent-live-retry.log`; event files `/tmp/fm-prompt-live-thr_*.json`. The first attempt reached the expected cap because four old uncertain test reservations existed. Sequential teardown freed the fifth slot; no cap was raised.

Real plugin dispatch and model-override replacement: 8/8 passed. Replacement thread differed, both prompts preserved task content, both carried current native identity and corrected browser/inbox policy; replacement model accepted. Evidence `/tmp/fm-prompt-replacement-live/`. Disposable threads/project deleted.

Independent standards review found an additional defect: a FIFO inbox entry blocks before fstat. Nonblocking open plus pending/handled regressions requested from implementation agent.
Independent spec review found no prompt-policy blocker; 12 helper/renderer tests and six affected server tests passed. Two reviewer transport fixtures escaped their fake CLI environment and failed against nonexistent fixture identifiers; they created no worker. Parent full suite and real acceptance independently cover the intended paths; reviewer-shell fixture isolation is not claimed proven.

The initial prompt review preceded the compatibility/FIFO follow-up documented below.

Compatibility candidate: recorded production-file SHA256 values in `/tmp/fm-compat-candidate-hashes.json`, to be compared against the implementation commit before integration. Real old-native acceptance also passed 25/25; log `/tmp/fm-compat-parent-live.log`. Both native source pins therefore have actual ship/scout launches under the corrected prompt renderer. The replacement proof used the newer native pin; the shared replacement renderer has differential tests for both pins.

Activation backup: `/tmp/fm-prompt-activation/before.json` records the native HEAD and original working-tree status of all 15 installed BB homes, plus adapter/config backup paths. No native upgrade is required.

Final compatibility snapshot full suite: **662 passed, zero failed/skipped**, 175984 ms. Log `/tmp/fm-compat-parent-full-final.log`. This increases the earlier 654 total by adding compatibility coverage. An earlier provisional snapshot failed two remote-test imports and the synthetic migration fixture; the final tests correct the imports and explicitly assert unknown-version refusal preserves the working mirror before returning to an audited native source. Production code still matches its reviewed hashes.

Independent compatibility review: no blockers. FIFO pending/handled reads and acknowledgements refuse immediately; both source pins install, verify and load transition helpers; the older loader retains its correct siblings mechanism. Unsupported source versions fail before publishing a mirror.

Exact user task rendering: all seven checks passed against task71452b07's actual source, read-only. Identity first, one BB browser rule, no native browser contradiction, concrete artifact path, exact-message acknowledgements, unchanged source. Evidence `/tmp/fm-prompt-actual-task-check.json`.

Activation evidence: `/tmp/fm-prompt-activation/{reload.json,plugins-after.json,results.json,integrated.json,helper-proof.json}`. The actual task71452b07 source also renders through the installed adapter. Installed helper smoke proof used a disposable inbox: read001, arrive002, reject bare ack, ack001, preserve002. Both private acceptance services are stopped and all test workers/projects created in this round were removed. Adapter backups remain under `/tmp/fm-prompt-activation/backup-*`.

The final runtime and test files matched the reviewed snapshot before integration. The source checkout’s pre-existing edits were preserved. Parent build, typecheck, fidelity and whitespace checks passed.
