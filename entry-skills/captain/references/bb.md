# BB

## Boundary

BB is the active Firstmate transport. A crew is a child BB thread, and an isolated ship uses a BB managed worktree. The real scripts run with `FM_BACKEND=bb`; `overlay/bin/backends/bb.sh` translates their endpoint operations to BB.

## Selected policy and intake

The required complete `firstmate_contract` / `bb firstmate contract --paged` read also loads the selected runtime's complete skill trigger catalog as verbatim native frontmatter; it loads no skill bodies and does not invoke the maintenance-only trigger-index skill. Follow each exact returned cursor with `firstmate_contract {"cursor":"…"}` or `bb firstmate contract --cursor <cursor>` until the end marker; do not combine snapshots or act from a preview. The default operator CLI still returns the full source. Repeat this complete read after compaction if the contract or trigger catalog is no longer in context.

Read native skills with `firstmate_skill` or `bb firstmate skill <name> [relative-reference] --paged`; read their relative references through the same operation.
Follow every returned cursor with `firstmate_skill {"cursor":"…"}` or `bb firstmate skill --cursor <cursor>` until `END OF NATIVE SKILL TRANSPORT`; a single page or saved preview is incomplete.
The operator CLI without `--paged` still returns the full document.
Links resolve from the skill entry file by default, including `..` and `#fragment` inside the runtime; for a nested file, pass `source=<exact selected-root relative source file>` or CLI `--source`, using the path printed by the previous read.
The complete linked document is returned with its fragment identified, without heading-only truncation.
These reads use the selected runtime, not globally copied policy skills.
Unknown revisions or modified native bytes refuse without implicit upgrade.
Native source owns delegation, reporting, review, completion and authority.
For diagnostic descriptions use `bb firstmate skill --list --json` or `firstmate_skill {"list":true}` and its continuation cursors; this inventory is separate from the required native contract/catalog read.

Use `bb firstmate dispatch --help`, `bb firstmate queue --help` and `bb firstmate help` for the registered options. Read `firstmate_posture` / `bb firstmate posture --json` for native registry context, explicit BB posture and approval provenance before mode/authority intake. Native registry is context; apply the native precedence for current user/project instructions. Existing approved standing yolo needs no fresh merge request, actual user holds still apply, and unexplained legacy flags remain unverified until resolved from recorded approval.

The `firstmate_dispatch` description and required contract's BB dispatch appendix explain the native-to-BB mapping: this operation creates the native brief, immediately runs native dispatch resolution, seeds/reuses the exact backlog row, then calls guarded native spawn. Do not create a parallel matching brief to satisfy this ordering. Native script help uses `firstmate_fm` with `script="brief", args=["--help"]`, or `bb firstmate fm brief -- --help`; without `--`, CLI help describes the wrapper.

For an intake-selected local-only change, use the worker selection requested by the user and its verbatim task, for example:

```text
bb firstmate dispatch --project <selected-project> --shape ship --mode local-only --delivery-requirement branch --provider <selected-provider> --model <selected-model> --reasoning-level <selected-level> -- "<verbatim-task>"
```

`branch` records ready-in-branch completion without requiring push, PR or merge. It does not change project merge authority. Native local-only completion and any separately authorized local merge retain their native guards. An enabled native resolver's refusal returns the task ID and retained result; read it, finish native intake, then reuse that ID with `--dispatch-profile-reason` and explicit validated BB worker execution. A reason records the selection; it grants no approval. Resolver configuration/usage errors remain refusals.

A bound captain remains the supervisor on later turns. BB live provider sessions keep the instructions constructed at session start; the conditional native role is therefore included in the cold-entry deck tool usage instructions before binding. Worker tool exclusion keeps their launch identity authoritative. The excerpt is identical in both audited native versions; the complete selected-runtime read remains required. A project-task provider/model/effort request applies to worker intake, preserving supervisor execution unless the user explicitly requests a supervisor-thread change. Native delegation exceptions and merge authority still apply.

## Operations

- Start with `firstmate_dispatch`; use `shape=scout` for read-only investigation and `shape=ship` for changes.
- Inspect with `firstmate_crew`, steer with `firstmate_tell`, and hard-stop with `firstmate_interrupt`.
- Call `firstmate_watch` once per crew batch to hand supervision to private event-driven durable wakes, then end the turn and never retry or poll.
- The `bb firstmate watch` CLI remains blocking via BB `threads.wait` for operator use.
- Retry the same failed turn with `firstmate_retry`. A provider, model, or reasoning override relaunches a replacement thread in the same worktree.
- Deliver with `firstmate_deliver`; land only through `firstmate_merge`.
- Run an upstream script with `firstmate_fm`, passing the script stem and its original arguments.

The plugin applies the crew marker and task id as thread metadata. Crew threads receive no captain tools or captain skills, which prevents nested dispatch.

## Recovery

Use the recorded `threadId` and `crewId`. The real transport writes both into `state/<id>.meta`; if a hard kill lands between thread creation and that write, the plugin reconciles exact seeded launch metadata before any replacement; legacy unmarked threads require explicit guarded `bb firstmate launches adopt <task> --thread <thread> --check` provenance validation.

Wake receipt handling follows [supervision](supervision.md#durable-wake-handling); complete `handledWake` only after handling the whole batch.

## Bundled runtime (BB transport adaptation)

A clean `firstmate_deck` / `bb firstmate deck --json` stages the plugin's pinned native bundle on this thread's execution host and returns its exact durable home. Execute the returned startup command beneath the agent harness; installation alone does not establish native lock/readiness. Native scripts still own policy and prerequisites.

Run `bb firstmate runtime status --json` (or `firstmate_runtime action=status`) to distinguish the plugin bundle, installed releases and the selected per-home runtime. On a plugin update, `bb firstmate runtime install` stages the current bundle without changing selection. For an owning quiescent captain, run `runtime select <exact-release> --check`, then `runtime select <exact-release>` for an explicitly authorized upgrade. Existing external homes instead require `runtime migrate <exact-release> --check` and explicit `runtime migrate <exact-release>`; retained native task identities, locks, watchers and launch reservations refuse selection. Nothing moves under existing worker paths, and no execution settings or task briefs change.

`runtime rollback <previous-release> --check` / `runtime rollback <previous-release>` restore only a compatible recorded previous selection. After external migration the recorded previous target is `external`. Do not delete locks or task records to force selection. If interrupted, inspect `runtime status --json`, then retry the same exact operation if still needed; an unknown target or damaged bytes refuse. See the plugin README runtime procedure for operator detail; startup does not require reading that source file.
