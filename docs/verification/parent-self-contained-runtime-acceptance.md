# Parent acceptance: self-contained native runtime

Implementation reviewed: `0d0f03c..f111531`. Production activation is complete; existing native homes were not migrated. This document distinguishes real BB proof from host-local fixtures.

## Independent code review

Reviewed native asset generation and MIT attribution, exact snapshot attestation, SDK file transfer and cancellation, staged installation and publication locks, selected-runtime verification, per-home owner/host binding, native task-set selection lock, retained-consumer refusal, migration/rollback journals, worker prompt/replacement source selection, captain hooks, and built package asset resolution. Native policy bytes remain unchanged. Existing external homes and their original native source remain supported.

Parent TypeScript, fidelity, deterministic runtime package verification, build, and whitespace checks passed. Parent built-package suite passed **7 tests**, zero failures/skips. The archive is **2,666,874 bytes**, release `597623fe465df0234bb58eee41b06fc0d4cc686e3949530e9654461ea7574ae9`, upstream pin `1f3e769616fdf9f31f85f4c3e6a9f71606634238`.

## Actual BB host and model proof

Used a separate BB database/server on port 38990, connected host `host_sybevze3fv`, and test project `proj_gamc6hhbvv`. The host systemd mount namespace masked `/root/firstmate` and `/root/github_projects/firstmate`. Runtime storage, captain-hook registration, and Codex/Claude settings were privately bound into the parent evidence tree. No production plugin or fleet participated.

The actual registered `runtime install` command transferred the archive with public SDK files and emitted `FM_BUNDLED_RUNTIME_INSTALLED`. Host-local installation took **782 milliseconds**, excluding transport. Two overlapping repeat installations emitted `FM_BUNDLED_RUNTIME_REUSED` for the same release without selecting another home.

A real `codex/gpt-6.1-sol/high` captain `thr_ts364bxdsh` used the shipped captain skill. `firstmate_deck` bound `/root/.local/share/bb-firstmate/homes/thr_ts364bxdsh` in **5,917 milliseconds**. Exactly one agent-shell native startup acquired the harness-owned lock, passed prerequisites/network checks, and printed the complete digest in **6,134.107141 milliseconds**, exit 0. Native described the harness as unknown; supervision followed the shipped BB harness adaptation.

The root user could list the empty masked directory inodes, initially causing a false isolation warning. A subsequent model-shell content check confirmed both directories empty and reads of `AGENTS.md`, `bin/fm-spawn.sh`, `.git`, and `.git/HEAD` failing with ENOENT. Original raw checks and the corrected interpretation were retained. No native source repositories were removed or changed.

Real native workers, both explicitly `codex/gpt-6.1-sol/high` with full permission:

| Worker | Native/BB identity | Observed result |
| --- | --- | --- |
| Scout | `bundled-acceptance-scout` / `thr_x3qtc497js` | Read-only report at the exact native report path; original HEAD `0b1dd3baa7eca0855ccf4e4ff0424efab529ff95`; done gate, crew and deliver passed |
| Local-only ship | `bundled-acceptance-ship` / `thr_8v6bcizf7n` | Isolated worktree, assigned branch `fm/bundled-acceptance-ship`, commit `78a5a9d140a6025c84f301fce466025ad31e8d07`; only the required 37-byte file, clean worktree, done and deliver passed |

Plugin logs contain both exact `real transport spawn crew=<id> ok` signatures and no `using native dispatch` or `real transport unavailable` signatures during the proof. Worker prompts name the pinned selected runtime and exact durable home. No replacement, promotion, push, external PR, merge or deployment occurred.

Reloaded the isolated plugin after delivery. Runtime status, scout crew, and ship deliver returned success. Hashes of the selection descriptor, both native task metadata files, and scout report were unchanged. Ship HEAD, branch, committed file bytes and clean worktree were preserved. Task records and the unmerged test commit remain intact. Both workers and the test captain were stopped; the test plugin was disabled and the two owned services stopped.

The compatibility-only `scout-report` command was additionally tried and refused because no SQLite promotion artifact existed. Native reports are read from `home/data/<task>/report.md`; those bytes were verified. This refusal does not invalidate native scout delivery. BB environment labels retain their provisioned branch names, while Git/native records carry the assigned worker branch.

## Parent full-suite correction

The initial parent service lacked HOME/PATH and failed prerequisite fixtures. After correcting its shell environment, **795 of 798 tests** passed. Three fake-BB fixtures reached real BB. The implementation worker reproduced Bash sourcing `.bashrc` when SHLVL is unset and Node supplies socket-backed stdin; `.bashrc` reordered PATH ahead of the fake executable. The fixture correction closes stdin while preserving stdout/stderr capture and explicit staged stdin redirection. A disposable two-stub test reproduces and kills that escape without contacting BB. Runtime product code is unchanged by this correction.

Final independent full-suite result: **799 tests passed**, zero failures, cancellations or skips. The new test covers shell startup isolation. Parent ran the full suite in an owned systemd service with SHLVL and inherited BB context unset; evidence is `full-suite-fixed.log`. Duration was **196,433.085528 milliseconds**.

## Production activation

Integrated all 40 reviewed files after matching every affected primary file against the integration baseline. Unrelated existing changes were preserved. Built and reloaded the production plugin; all four background services report running. Installed the verified bundled runtime on production host `host_m4jkvpkw67`; runtime status reports the installed release compatible. The parent remains unbound.

A read-only audit found explicit native homes on 250 crews, 18 decisions, 187 queue records and 30 launch records. All six active marked captains have exact existing home bindings. Set the global `fmHome` default to blank so new captains install/bind the bundled runtime. Read-back confirmed every prior home binding unchanged.

Verified the BB adapter for the six active captain homes plus `/root/firstmate`. Native HEAD and native `bin/` source were unchanged in all seven locations at `2d833ff147cd26a5c461e914e06854e0eb2707ce`. No bundled selection file was added to an existing home. The plugin refreshed active-home adapters automatically; the parent refreshed the legacy base adapter. Read-only runtime status for each of the six existing captains confirmed its original external home and compatible native commit. No existing worker was restarted, task contract rewritten, or native repository deleted. Integrated primary TypeScript validation passed.

## Evidence and limits

Durable private evidence root: `/root/firstmate-bb-homes/thr_jm4qnewqmf/data/self-contained-runtime/parent-review/`. Key files: `install.json`, `reinstall-a.json`, `reinstall-b.json`, `built-tests.log`, `before-reload.json`, `reload-preservation.json`, `after-reload-*.json`, `isolated-plugin.log`, `namespace-source-check.json`, and `live/store/homes/thr_ts364bxdsh/data/runtime-acceptance/`.

Unit/script proofs cover staged interruption, corruption, conflicting ownership, retained-consumer refusal, migration and rollback. They remain distinct from the actual BB install/startup/worker/reload proof above. No external forge PR was required for this packaging acceptance. No existing production home was migrated. Existing native state schemas and old runtime retention remain subject to the documented guards; no garbage collection or schema downgrade is introduced.
