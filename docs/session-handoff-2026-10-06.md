# Firstmate improvement work: goals, results, and handoff

Recorded on 2026-10-06 for the owner and the next supervising agent.
This is a dated account of this conversation, not a replacement for native Firstmate policy.
Historical implementation reports, parent verification, and current activation are distinguished below.

## Current result

The reviewed plugin through `89154935f5c829c0ffa077b134de4ccf42825199` is integrated, built, reloaded, and running on the production BB server.
The selected Pstack-derived methods and the verified `/pr` source are enabled for this installation.
The production build matches the isolated accepted build byte for byte.

The overall request is **not fully closed**:

- [PR 53](https://github.com/amrtawfik160/bb-plugin-firstmate/pull/53) remains open despite green checks. Its historical author has no genuine native task registration.
- Actual model testing still exposed internal notification-handling narration. Final audit findings survived, but every-message reporting compliance failed.
- The external no-mistakes PR author has not been proved to load `/pr`. A supported template setting is not equivalent to a skill read.

## What the owner wanted

The initial complaint was that Firstmate launched agents and opened PRs, then lost track of the PRs until reminded.
Later incidents showed launch uncertainty, missing registration, queue limits, prompt conflicts, slow startup, and inconsistent delegation or reporting.

The intended result was a dependable global Firstmate that:

1. Delegates project work through native Firstmate and follows its delivery pipeline and exceptions.
2. Preserves each task's owner, worktree, provider, model, reasoning level, and delivery contract.
3. Tracks unfinished PRs after the worker stops or a notification is acknowledged.
4. Recovers interrupted operations without creating duplicate workers or losing work.
5. Delivers complete native instructions and selects the right skills for the role and task.
6. Adds only the requested Pstack methods and `/pr`, without creating a competing supervisor policy.
7. Runs without requiring an external native Firstmate checkout.
8. Supports Telegram as a useful, quiet interface to one bound captain.

The owner clarified that “BR” meant `/pr`. The owner also requested independent Astra/high audits, TDD, review, actual verification, and reload.

## Work completed and why

### Launch reliability and PR follow-up

Introduced durable launch records, early worker-role identity, recoverable publication, and persistent PR delivery tracking.
An uncertain launch remains uncertain until its existing worker can be identified; a timeout alone does not authorize another launch.
Original execution and delivery requirements survive recovery.

PR records outlive worker retirement and notification acknowledgement. PR health is tracked separately from worker completion.
This addresses the original forgotten-PR complaint; reporting instructions alone cannot solve durable tracking.

Independent review found and corrected contract loss, disposal/cancellation problems, late resource leakage, ownership splits, and premature admission.
See [implementation and progress](verification/launch-pr-lifecycle-progress.md) and [parent acceptance](verification/parent-launch-pr-acceptance.md).

### Worker prompts, inboxes, and native compatibility

Corrected conflicting browser instructions, worker/supervisor identity, artifact locations, and steering acknowledgement guidance.
Inbox acknowledgement now identifies the exact handled messages, preserving later arrivals. FIFO entries refuse instead of blocking reads.
Installer compatibility covers two audited native revisions and refuses unknown or mismatched sources.

Existing workers were not broadly restarted to rewrite their context. Initial launches and replacements were tested separately.
See [prompt fixes](verification/prompt-fixes.md), [compatibility](verification/native-compatibility.md), and [parent acceptance](verification/parent-prompt-acceptance.md).

### Repair of genuinely interrupted native launches

Added guarded adoption for an existing worker whose original native launch publication was interrupted.
The repair requires actual launch, task, thread, project, environment, and contract evidence.
It preserves the original branch contract and distinguishes it from the worker's current branch.

This repaired task `574cbb72` without spawning a replacement or discarding work.
It is deliberately not a general import for historically non-native authors.
See [adoption design](verification/legacy-launch-adoption.md) and [actual repair evidence](verification/parent-adoption-acceptance.md).

### Notification command size

Receipt commands exceeded BB's 10,000-character host-command limit.
The correction stages the complete guarded script rather than shortening commands or weakening receipt semantics.
Queued reports and explicit acknowledgements remain durable.
See [command-size correction](verification/wake-command-size.md) and [parent acceptance](verification/parent-wake-command-acceptance.md).

### Queue storage and explicit model changes

Moved queue records from one size-limited KV value to SQLite records, preserving full task data and partial outcomes.
Actual migration preserved 184 original records. Reconciliation retained an already launched worker instead of dispatching it twice.

Separated user-directed execution changes from automatic failure retries.
A requested model change can preserve the worktree and original contract without consuming the failure-recovery allowance incorrectly.
Interrupted publication resumes the existing replacement instead of creating another.
See [queue storage](verification/queue-storage.md), [model changes](verification/explicit-model-change.md), and [parent acceptance](verification/parent-queue-model-acceptance.md).

### Startup and a self-contained native runtime

Bound startup to the exact captain home, deferred fleet scans, bounded prerequisite/contract reads, and shipped cold-start dependencies.
Bundled pinned native assets with hashes, MIT attribution, guarded host staging, durable captain homes, and migration/rollback support.
Existing external homes remain supported; bundling does not silently migrate them.

Actual isolated BB-host/model tests ran with external native repositories masked.
The plugin can use its bundled runtime without deleting or depending on those repositories.
The precise subprocess behind the original slow-start incident was not identified; bounded startup behavior was tested instead.
See [startup](verification/captain-startup.md), [cold package](verification/captain-cold-package.md), and [self-contained acceptance](verification/parent-self-contained-runtime-acceptance.md).

### Native policy, delegation, and skill delivery

Audited the plugin against both selected native revisions. The inventory contained 28 unique native policy skills with valid references.
Restored native defaults, selected-runtime policy reads, complete trigger catalogs, relative references, and persistent captain-role instructions.
Fixed skill discovery by registering parent skill directories in the package.
Preserved native brief → resolver → backlog → spawn ordering and local-only branch delivery.

Long native skills now use bounded, verified pages. Diagnostic lists retain complete multiline descriptions.
The actual model read all nine contract pages and a five-page native skill without losing bytes.

Delegation follows native Firstmate's rules, including its explicit exceptions. The work does not establish that every future model turn will comply perfectly.
See [native defaults](verification/native-policy-defaults.md), [dispatch mapping](verification/native-dispatch-mapping.md), and [skill/reporting delivery](verification/skill-delivery-reporting-20261005.md).

### Dispatch and secondmate ownership

The Astra audit reproduced five related defects; all five received structural corrections:

| Defect | Correction and purpose |
|---|---|
| Accepted task text lost its tail | Preserve full intent/specification; stage bulky commands instead of truncating them. |
| Workers could use supervisor commands through the CLI | Check worker identity at public command/tool boundaries before mutation; retain exact-task inbox/status access. |
| Routed work lost execution settings | Preserve a durable child-task envelope, separate from the domain supervisor's own model/settings. |
| A shared task ID could select another supervisor's worker | Resolve ownership and original home; refuse ambiguous or foreign operations. |
| Forgetting a routed task disabled the domain supervisor | Separate route retirement from worker retirement; preserve the child and its native records. |

Parent independently passed six real native-script cases across both pins and six public ownership/role cases.
See [dispatch requirements and evidence](verification/dispatch-preservation-20261005.md).

### Selected Pstack methods and `/pr`

Retained a small, role-specific set of existing Pstack-derived methods: assignment coverage, decision trails, scoped investigation/design/review, requested reflection, behavioral proof, and product verification.
Removed the competing Calm reporting pointer. Native Firstmate remains the owner of reporting, delegation, review allocation, merge authority, and delivery.
Worker scope questions return to Firstmate rather than directly to the owner.

The `selected-v1` profile is an explicit durable installation setting. Unconfigured installations retain native defaults.
Ten existing method files are hash-verified and delivered through bounded readers. Initial and replacement worker composition was tested.

Direct-PR ship authors resolve `/pr` through public BB skill APIs in their actual workspace.
The reader pins source ID, revision, and full-body hash. Missing, changed, unreadable, or conflicting sources refuse rather than silently substituting another skill.
An explicit readable source handles this installation's symlinked duplicate skill entries.

Actual worker testing exposed a usability gap: the reader verified source revision internally but showed only a transport snapshot.
The final correction exposes `FIRSTMATE_PR_SOURCE` metadata outside the unchanged body on every paged PR read.
Metadata and complete serialized responses have explicit size limits; oversized responses refuse without truncation.
See [selected methods](verification/selected-methods-20261005.md) and [source provenance](verification/pr-provenance-20261005.md).

### CI and verification reliability

Added pinned CI dependencies, explicit fixture isolation, coverage accounting, and a read-only acceptance preflight.
The preflight verifies the exact test server, plugin root/build hash, host, project, and bundled runtime before model acceptance.

Early hosted runs failed to acquire runners. Later runs executed and exposed a real fixture dependency: `tasks-axi` was globally available locally but absent on clean CI.
Pinned `tasks-axi` 0.2.6 in the existing CI tools lockfile and preserved the fake BB launch refusal first on PATH.
No native assertion was removed or skipped to obtain green checks.
See [CI dependency correction](verification/ci-backlog-dependency-20261005.md).

## Telegram work from this conversation

Telegram was a separate connector workstream. Its author reported implementation and successive local verification of:

- One private chat bound to one captain, durable incoming updates, and explicit uncertain-send handling.
- Binding-specific decisions, one answer per decision, send fencing, and restart behavior that avoids replaying old history.
- Holding captain replies until a turn completes, with immediate pending questions.
- Quiet task notices and removal of internal BB thread identifiers from Telegram text.
- Forwarded text and media attachment delivery to BB. Images depend on the receiving model's capabilities.
- Video preview isolation, preservation of originals when previews fail, and accounting for actual attachment sizes.
- A skill to make the current thread the Telegram captain using its selected model, as requested instead of restoring an old captain.

These reports do not establish that every connector branch was installed or that the bot currently works.
Several explicitly stated that production was unchanged. The latest Firstmate release did not re-pair Telegram, change its binding, or verify a live Telegram round trip.
Earlier evidence showed a binding to an archived captain; treat present connector health as unverified until checked through its supported status interface.
The connector also documented that public events could not reliably distinguish final text from commentary when both shared the same message shape.

## Verification results and their limits

Counts below describe different suites and revisions. They must not be added together or described as one final full suite.

| Evidence | Observed result |
|---|---|
| Full author suite at selected-methods revision `0e521d6` | 860 tests passed; zero failures/skips. |
| Parent frozen dispatch verification at `71e4bb3` | 12 checks passed, including real native scripts at both pins. |
| Parent frozen methods verification at final `8915493` | 12 tests passed; zero failures/skips. |
| Latest PR and push hosted checks at `8915493` | Each passed 335 tests; zero failures/skips, plus typecheck, fidelity, runtime integrity, and build. |
| Actual ACP captain setup | Full 4,169-byte `/pr` read; exact captain-methods and coverage reads. |
| Actual ACP worker | Same worker read methods and `/pr`, wrote the synthetic body, then re-read the corrected source metadata. |
| Same-worker final acceptance | Source ID/revision/hash matched all 4,169 bytes; sample body matched `/pr` and was preserved unchanged. |
| Actual reporting acceptance | Receipt handled and final findings preserved; intermediate internal narration still failed. |

Latest hosted evidence: [PR run](https://github.com/amrtawfik160/bb-plugin-firstmate/actions/runs/37390351965) and [push run](https://github.com/amrtawfik160/bb-plugin-firstmate/actions/runs/37390347701).
Causal mutation tests temporarily removed specific guards, observed the intended regression, restored code, and rechecked it. They supplement actual-path testing rather than prove all model behavior.

The sample PR body describes fictional duplicate-profile behavior. Its evidence is explicitly synthetic and not executed.
No product fix, GitHub PR publication, or completion of that test worker's original direct-PR contract was claimed.

## Corrections to earlier claims

- The initial `/pr` discovery message incorrectly described local file hashes as successful public API reads and gave a 2,452-byte size. That claim was withdrawn. The verified body is 4,169 bytes.
- A reporting test injected its notification after the turn ended. It was retained as invalid fixture evidence, not counted as a product pass or failure.
- The correctly timed reporting test still leaked internal handling text. Additional wording alone was not called a verified behavioral fix.
- Green tests, a worker's completion message, plugin reload, PR merge, and deployment are distinct outcomes. Example URLs and placeholder results in earlier test messages are not release evidence.

## What was activated on 2026-10-06

Integrated the reviewed `4f72518..8915493` delta into the existing production source checkout after checking every affected file against the expected baseline.
All 137 affected files passed that conflict check. Existing files were backed up; unrelated dirty files were preserved.
Installed lockfile dependencies, built the plugin, and confirmed the production server bundle matched the accepted isolated bundle.
Reloaded Firstmate, completed this captain's native startup, enabled the selected methods with the verified `/pr` ID, and checked the production methods read.

| Item | Recorded value |
|---|---|
| Production source | `/root/github_projects/bb-plugin-firstmate` |
| Reviewed implementation HEAD | `89154935f5c829c0ffa077b134de4ccf42825199` |
| Server bundle SHA-256 | `313d622b47cae67d5bc9f50f0bcafea45153e7dd3d3a74413d35ef8c8da361a7` |
| Plugin read-back | Enabled and running |
| Methods profile | `selected-v1` |
| Selected `/pr` ID | `skill_31727271933b0c288fc1c87139bb3f6b6c838af88670efddceab3428fc018806` |
| `/pr` revision and body SHA-256 | `ab63f1cf78647389edcd386c9427c5dfca27ed2836930c24773ffee834c19bcd` |
| Selected native upstream | `1f3e769616fdf9f31f85f4c3e6a9f71606634238` |
| Selected bundled release | `8af1c9c31bb3d1520e7d7ebd5ed8cbadcf66797d5e025cedefb2327a6bf7dece` |

This release did not upgrade the native upstream revision or restart all existing workers.
Installation settings do not prove every already-running model context has refreshed.
The source checkout remains dirty by design; preserved pre-existing work was not reset or committed as part of reload.

## Remaining work and why it remains

### Merge PR 53 through a truthful native path

The owner has explicitly authorized completion and merging. Approval is not missing.
The original implementation author was a direct BB thread in an unmanaged worktree, with no corresponding native task record in this captain's current home.
The native merge command requires that record. Existing adoption repairs interrupted native launches; it cannot import historically non-native work.

Registration tags, an unrelated task ID, or reconstructed metadata would invent original admission and contract history.
None was created. No raw forge merge was used to bypass the native guard.
A supported guarded external-work import, with truthful provenance and preserved merge checks, is a future design need—not an implemented command.

### Fix every-message reporting behavior

The actual Grok 4.7/high test received complete policy and retained final audit findings, but still narrated private handling in an intermediate message.
The public BB event trace does not show the model's received Stop-hook context or competing provider preamble.
The exact cause remains unproved. A narrow provider-owned hook/context trace would help distinguish delivery/formatting from model noncompliance.
No output filter, automatic acknowledgement, or guarantee of perfect future behavior was added.

### Enforce `/pr` at the external pipeline author

Direct-PR BB worker reading is verified. The separate no-mistakes author is outside that proof.
Its supported `pr.template` configuration supplies narrative instructions, but does not prove an installed `/pr` read.
The remaining integration needs a trusted skill-read capability at the actual external author, with source/revision and complete-read evidence.
No shared daemon, repository template, native intent, or pipeline ownership was changed to simulate this.

### Preserve test work and finish cleanup deliberately

The isolated test worker is paused under a publication hold. Its artifact and original contract remain preserved.
No replacement was created. Do not report this as a completed direct-PR delivery or remove its worktree through a landed-work cleanup.
Any test-service cleanup should target only the owned isolated server/host units and preserve the saved evidence and artifact.

## Evidence and ownership for continuation

| Resource | Location / identity |
|---|---|
| Original implementation author | `thr_s8c8ckk8jd` |
| Author checkout | `/root/github_projects/bb-plugin-firstmate-launch-pr-lifecycle` |
| Author branch | `fix/native-policy-defaults-20261005` |
| Supervising conversation | `thr_jm4qnewqmf` |
| Visible Astra/high audit | `thr_fmuzten5yw`, task `2a7b4cb5` |
| Astra report | `/root/.local/share/bb-firstmate/homes/thr_jm4qnewqmf/data/2a7b4cb5/report.md` |
| Production activation, backups, read-back | `/root/firstmate-bb-homes/thr_jm4qnewqmf/data/release-8915493/` |
| Actual captain setup and initial worker proof | `/root/firstmate-bb-homes/thr_jm4qnewqmf/data/acceptance-0e521d6/` |
| Same-worker source re-read and saved sample body | `/root/firstmate-bb-homes/thr_jm4qnewqmf/data/acceptance-8915493/` |
| Failed reporting test | `/root/firstmate-bb-homes/thr_jm4qnewqmf/data/acceptance-e0d6247/` |
| Isolated captain / worker | `thr_xxyu5aunvx` / `thr_gzkskzz5ks` on the separate test server |

The older `firstmate-bb-homes` directory above holds durable evidence. It is not the currently bound native home.
Current native state belongs to `/root/.local/share/bb-firstmate/homes/thr_jm4qnewqmf`.
Use the dated documents and exact source/evidence identities when resuming; recheck live PR, plugin, and connector status before claiming current results.
