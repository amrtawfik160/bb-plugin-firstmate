# Firstmate plugin: launch and supervision review

**Upgrade blocker:** the current overlay installs against latest upstream but produces a BB backend that cannot load. Keep the current pin until the adapter is updated.

Recommendation: make worker creation atomic, centralize launch admission, and preserve native policy ownership. Then reduce manager turns and update the upstream pin.

## Scope and evidence

Reviewed the current checkout, including existing uncommitted changes. Inspected both bb-cli skill copies, creation/operation/recovery references, live BB command help, and the installed SDK types.

| Component | Inspected version |
| --- | --- |
| BB CLI | 0.44.0 |
| Plugin SDK | 0.4.104 |
| Plugin manifest | 0.4.0 |
| Installed native home `$FIRSTMATE_HOME` | `2d833ff1`, 2026-09-28 |
| Separate checkout `$FIRSTMATE_CHECKOUT` | `6f0f1399`, 2026-09-22 |
| Upstream HEAD fetched for review | `1f3e7696`, 2026-10-03 |

Upstream HEAD contains 35 commits beyond the plugin pin. Fetching updated Git objects; it did not change either native working checkout.

No live workers were launched. Existing source edits and fleet state were preserved. Reproductions use the SDK fake host.

## Findings, in priority order

### 1. Worker identity arrives after execution starts

The native adapter calls `bb thread spawn` with the task prompt, then calls `mark-crew`. Marking failure is ignored with `|| true`.

Before that mark, the plugin gives unmarked threads its captain tools. The SDK path already supplies worker metadata during creation.

This establishes an ordering defect and a silent failure path. Whether a particular provider loaded the initial configuration during that interval was not tested live.

**Change:** add a plugin-owned worker-creation command that invokes `sdk.threads.spawn` with metadata in the creation request. Native scripts should call this command. Preserve native brief, authority, backlog, and isolation checks.

Source: [native adapter](../overlay/bin/backends/bb.sh#L423), [role configuration](../server.ts#L9285), [existing atomic SDK path](../server.ts#L4267).

### 2. Launch admission is neither centralized nor atomic

The cap check runs outside `dispatchCrew`. Parallel calls can both pass before either worker enters the register. The native per-home lock serializes the spawn command, but does not reserve capacity or repeat this cap check.

Reproduction in the compatibility transport:

- With a cap of five workers and four active workers, two concurrent dispatches both succeeded. The resulting count was six workers.
- With five active workers, promotion of an active scout still created a ship. Promotion checks the task shape, but does not require a completed scout or available capacity.

The native transport has additional native gates. These reproductions do not claim those gates were bypassed in a live deployment.

**Change:** reserve capacity inside one shared launch service. Apply it to dispatch, promotion, queue dispatch, and replacement. Preserve reservations across restart while launch outcome is uncertain. Release them only after reconciliation proves that no worker exists.

Promotion also needs a completed scout and a durable report. Its current 2,000-character output read can omit findings; pass the report artifact instead.

Source: [cap check](../server.ts#L3920), [dispatch entry](../server.ts#L8455), [promotion](../server.ts#L8788).

Run the non-destructive reproduction:

```sh
node --experimental-strip-types docs/verification/launch-review-probe-2026-10-04.mjs
```

### 3. Advertised launch options differ by transport

The native path does not forward `worktree` or `visible` into its adapter. The common environment forces visibility on. Consequently, `visible:false` does not hide native workers, and shared-environment requests do not match the recorded launch intent.

Future `sendAt` is advertised but explicitly rejected in native mode. The error suggests a backlog time gate; that is eligibility for later dispatch, not proof of an automatic scheduled launch.

**Change:** define transport capabilities once. Reject unsupported options before creating the brief or backlog row. Keep native ship isolation mandatory. Forward visibility explicitly. Make scheduling behavior explicit and recheck native authority when a scheduled task becomes eligible.

Source: [native dispatch inputs](../server.ts#L3374), [forced visibility](../server.ts#L559), [schedule refusal](../server.ts#L4217).

### 4. Host and checkout can be selected independently

`resolveHostForProject` prefers the manager's host. `projectCheckoutPath` independently selects the first ready checkout or default project source, without filtering by that host.

For a project on multiple machines, the selected path can belong to a different machine. This is a code-path finding; no multi-machine launch was attempted.

**Change:** resolve one tuple containing project, host, environment, checkout, provider, and model. Use it for validation, native commands, and worker creation. Do not fall back to the first connected machine when identity is uncertain.

Source: [checkout selection](../server.ts#L3060), [host selection](../server.ts#L4032), [adapter fallback](../overlay/bin/backends/bb.sh#L373).

### 5. Creation and readiness need separate states

The adapter starts the task, then polls for its environment path for up to 45 one-second attempts. If no path appears, it stops the thread. Native isolation validation follows the creation call.

A slow environment can therefore be treated as a failed launch. A returned thread ID does not prove the worker accepted the brief.

**Change:** persist launch progress as `reserved → creating → provisioning → running`, with explicit failed and uncertain outcomes. Record the thread ID immediately. Reconcile provisioning from BB state. Test cancellation and restart at every boundary.

Where BB cannot provide a required pre-start boundary, request a supported held-creation mechanism. Do not simulate a hold with an arbitrary delay.

Source: [path polling](../overlay/bin/backends/bb.sh#L455), [post-creation isolation check](../overlay/firstmate-bb-backend.patch#L401).

## What the bb-cli review changes

| BB behavior verified in skills/help/types | Plugin implication |
| --- | --- |
| SDK creation accepts `pluginMetadata` | Use it to establish the worker role before the initial turn. The generic CLI has no equivalent metadata flag. |
| Omitted execution flags use project defaults | Record resolved provider/model/reasoning. Do not describe omission as manager inheritance. |
| SDK supports more reasoning values than the plugin | Validate against provider capabilities. The plugin currently drops CLI values such as `ultra` to an unspecified value. |
| Queued sends return a typed waiting reason | Distinguish accepted, queued, delivered, and worker-acknowledged. Never resend merely because a message is queued. |
| `thread retry` resubmits a failed turn | Use `tell` for new instructions. Use replacement only when a new session is necessary. |
| Scheduled creation defers environment work | Useful primitive, but native authority must be checked at execution time. |
| `thread count` is an aggregate | Useful for BB runtime inventory. It does not replace Firstmate reservations or native waiting-state rules. |
| Hidden children still notify their parent | Hiding workers will not remove manager token cost. |
| Parent linkage and lifecycle ownership are distinct | Do not automatically cascade archival before native cleanup proves work is preserved. |
| Explicit environment reuse is supported | Keep the author and its worktree for fixes. Use a separate reviewer when independence is required. |

I did not modify BB core. Current plugin documentation identifies core child notifications as a remaining batching limit. Removing their display alone does not remove their model input.

## Native repository improvements worth adopting

The [native repository](https://github.com/kunchenguid/firstmate) remains the policy source. Relevant changes after the plugin pin include:

- `fd325b1b`: opt-in `config/wait-no-turns`. Waiting workers avoid polling their inbox. This changes brief and recovery behavior; test it before enabling it.
- `549e07f3` and `65e2aa44`: reduce supervision and remote-job polling overhead.
- `46d58d64` and `8690c411`: improve watcher continuity and reclaim orphaned watcher arms.
- `c5f48e4c`: bounded recovery when GitHub mergeability is unknown.
- `6af83310`: preserve hold reasons and reject invalid completion inventories.

The current overlay installed against the fetched upstream snapshot in a disposable directory. One patch hunk required fuzz level two. The resulting BB backend could not load.

Upstream commit `589ccec8` changed backend sibling lists from a `siblings` string to positional parameters. The overlay still inserts `siblings="fm-composer-lib.sh fm-transition-lib.sh"`. The new loop therefore treats the argument `bb` as a sibling filename and refuses the load.

The same targeted suite passed all nine tests against the installed pin. Against latest upstream, seven tests passed and two scout-cleanup tests failed before reaching their expected gates. A direct `fm_backend_source bb` call returned zero on the pin and one on the latest patched snapshot.

The required adapter change for the new pin is `set -- fm-composer-lib.sh fm-transition-lib.sh`. Updating the upstream pin and overlay must happen together; that syntax cannot simply replace the old clause while retaining the old native loop.

Changing only that clause in the disposable generated backend restored backend loading and passed both previously failing cleanup tests. The repository overlay and installed native home remain unchanged.

Source: [overlay clause](../overlay/firstmate-bb-backend.patch#L84), [upstream loader change](https://github.com/kunchenguid/firstmate/commit/589ccec821bf6310ce888e2a702e4fc9258eb1e8).

**Update process:** test the new pin in a scratch home, regenerate snapshots and skill metadata, run native integration checks, then perform a bounded live acceptance task. Add a strict patch check so fuzzy application requires explicit review.

The README also needs correction: it says seeded secondmate homes are unsupported, while the adapter, native-parity document, and integration tests now implement them.

## Recommended implementation order

1. Introduce atomic worker creation and a durable launch record with a stable task identifier. Reconcile uncertain outcomes before retrying.
2. Add durable follow-up for open PRs, as detailed below. Worker completion must not remove the manager's outstanding delivery obligation.
3. Centralize capacity, completed-scout checks, host selection, and transport capability validation. Add concurrency and restart regressions.
4. Replace path polling with explicit provisioning state. Show queued reasons and resolved execution settings in the fleet UI.
5. Reduce manager overhead through existing durable receipts, task-delta reports, author reuse, and deterministic queue eligibility checks. Keep judgment and authority decisions with the manager.
6. Update the native pin through scratch-home checks. Align documentation and supported reasoning values.
7. Extract launch, scheduling, supervision, and native transport from `server.ts` behind tested interfaces. The current file contains 11,085 lines; avoid a simultaneous wholesale rewrite.

Measure launch latency, time waiting for capacity, duplicate launches, uncertain launches, manager turns per completed task, and review regressions. Record cached and uncached tokens separately. Do not promise savings without matched before/after workloads.

## Follow-up: PRs require user reminders

The user reports that Firstmate repeatedly opens PRs and loses follow-up until reminded. This review found a mechanism consistent with that report. It did not trace an individual forgotten PR's history.

### What currently exists

- PR URLs are stored on worker records. Fleet views can show ready PRs while those records remain discoverable.
- The background `landedPass` scans registered ships. Its reconciliation skips open PRs and handles externally merged PRs.
- Native `fm-pr-poll.sh` deliberately emits only a merged result. An open PR, failed lookup, or unchanged unmerged state is silent.
- Native ship-landing instructions require the manager to register a ready PR with `fm-pr-check.sh`. This is a model action, not an automatic consequence of every worker completion.
- `forgetCrew` can record idle work as done, close the queue item, remove native task monitoring, and remove the worker record. The independent outstanding PR obligation is not preserved by that path.

The existing machinery can retain a PR URL and report a merge. It does not guarantee continued ownership and a next action for every open PR. A handled notification also does not establish completed delivery.

Sources: [merge reconciliation](../server.ts#L5674), [worker removal](../server.ts#L5927), [native merge poll](https://github.com/kunchenguid/firstmate/blob/2d833ff147cd26a5c461e914e06854e0eb2707ce/bin/fm-pr-poll.sh#L1), [landing instructions](../skills/ship-landing/SKILL.md#L18).

### Proposed behavior

1. Register each produced PR as an outstanding deliverable. Store repository, PR number, head commit, task, owning manager, current blocker, next action, and next check time. Recover missing registrations from recorded worker output and scoped forge reconciliation.
2. Track PR progress separately from worker execution. Suggested states are draft, awaiting checks, awaiting review, changes requested, awaiting merge approval, ready to merge, merged awaiting verification, complete, and explicitly abandoned.
3. Keep each PR open in that register until its agreed delivery contract is satisfied or the user explicitly abandons it. Archiving a worker, acknowledging a notification, or changing manager threads must preserve or explicitly transfer ownership.
4. Use background code to check forge changes. Wake the manager when action becomes possible, a blocker appears, or a recorded follow-up becomes overdue. Deduplicate unchanged results and back off on forge errors.
5. Make unresolved PRs visible in the fleet and session recovery brief. Show their owner and next action. If manager ownership disappears, surface that condition instead of silently dropping the PR.
6. Apply the existing merge authority. When approval is required, retain an approval item. When merge is already authorized, continue through native merge and verification checks.

Do not use a repeated generic reminder prompt as the primary fix. The obligation and follow-up schedule must survive context compaction and plugin restart.

Acceptance tests should cover worker completion before checks finish, later check failures, requested changes, a new PR head, manager compaction, plugin restart, worker archival, ownership transfer, explicit abandonment, and duplicate notifications. An acknowledged ready notification must leave an unmerged PR outstanding. Closed-unmerged PRs need a recorded disposition, and forge errors must preserve the prior record as unverified.

## Validation

- Existing suite: 590 tests reported; 582 passed; zero failed; eight opt-in tests skipped.
- TypeScript passed. Skill fidelity passed. `git diff --check` passed.
- Fake-host probes reproduced concurrent cap overflow and promotion of an active scout at capacity.
- Additional targeted native suite: nine tests passed against the installed pin. Against latest upstream, seven passed and two failed due to the backend-loading incompatibility.
- Latest upstream overlay installation succeeded, but direct backend loading failed. This is a reproduced upgrade blocker, not a currently deployed failure.
- Scratch-only adapter correction: backend loading succeeded; both previously failing cleanup tests passed. The full latest-upstream suite was not rerun after this correction.
- No live provider launch, production merge, plugin reload, or native upgrade was performed.
