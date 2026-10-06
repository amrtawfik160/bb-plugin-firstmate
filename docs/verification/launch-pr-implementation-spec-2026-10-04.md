# Implement Firstmate launch reliability and persistent PR follow-up

You are the single implementation agent requested by the user, running GPT-6.1 Sol. Parent will independently review and verify your work. Implement the full scope below, not only a plan or the easiest subset. Work in /root/github_projects/bb-plugin-firstmate-launch-pr-lifecycle. Do not edit the source checkout /root/github_projects/bb-plugin-firstmate. Do not spawn additional agents.

User request: "run 6.1 sol agent to implement all of that, give him a detailed spec and review and verify after him. /bb-cli". Context: user repeatedly sees Firstmate open PRs and forget follow-up until reminded. This is a primary product defect alongside unreliable worker launch.

## Baseline and authority

Your baseline commit is 95f589359627ff65b859f3ae5393b153dda273ed. It contains pre-existing user edits to server.ts/server.test.ts/README.md plus the review and reproduction probe. Preserve these. Commit YOUR changes in coherent units after this baseline. Never reset or drop baseline changes.

Read CONTRIBUTING.md, the full docs/plugin-launch-review-2026-10-04.md, and the relevant /bb-cli and bb-plugin-authoring skills. Apply native fidelity rules. Installed SDK 0.4.104 and BB CLI 0.44.0 are the API contract. Use public SDK APIs. Consult current declarations and live help for exact command behavior.

You may install local dependencies, create scratch native homes, run test fixtures, build, and commit in your isolated checkout. Do not reload/install the live plugin, upgrade /root/firstmate, mutate live fleet state, launch real worker/model tasks for tests, merge PRs, publish or deploy. Parent handles any justified live verification after review. No PR is required yet. If writing a PR description later, the user requires the show-me skill.

Source node_modules exists in the original checkout; install from the lockfile in yours or use a symlink for verification without modifying shared dependencies. Native /root/firstmate is the deployed pin 2d833ff147cd26a5c461e914e06854e0eb2707ce. /root/github_projects/firstmate has fetched upstream commit 1f3e769616fdf9f31f85f4c3e6a9f71606634238. Never change those working checkouts. Scratch work is allowed.

## A. Atomic worker role and recoverable creation

Default native transport currently calls generic bb thread spawn with a live prompt and later mark-crew; marking failure is swallowed. During initial configuration the worker can receive captain tools. Introduce a plugin-owned internal creation command/bridge called by the native adapter which uses sdk.threads.spawn with pluginMetadata seeded in the creation request. Establish crew/captain role, native home, task id and shape before the first turn. Keep seeded secondmate behavior correct and parent permission as the ceiling. Native policy/backlog/brief/isolation checks remain authoritative.

Persist a launch record before the external spawn call. Stable task identity and attempt/generation must let retries reconcile an existing thread instead of duplicating it. Record returned thread id promptly. Unknown outcome after timeout/reload stays recoverable; do not free its capacity or blindly respawn. Reconcile using metadata and scoped identifiers, with bounded paging. Avoid treating a missing response as proof of no worker.

Separate reserved, creating, provisioning, running, failed and uncertain launch states as appropriate. Replace the current 45-second environment-path failure/kill heuristic with bounded, cancellation-aware provisioning handling that retains a slow real worker. Do not invent unsupported hold APIs. If initial native guards necessarily require a prepared environment, use supported lifecycle APIs or explicitly preserve a truthful unresolved state instead of claiming full readiness. Include cancellation/disposal and crash boundary tests.

## B. Central launch admission and promotion

Move capacity enforcement inside shared launch orchestration so dispatch CLI/tool, backlog dispatch, promotion and recovery all follow the same rules. Count reservations atomically with running workers and pending work as appropriate. Preserve native gates as well as BB limits. Respect explicitly authorized over-cap semantics; do not increase caps.

Current proof: four active workers with cap five plus two concurrent dispatches starts two. Current promotion also starts a ship with five active workers, including an unfinished scout. Regressions must prove these fail safely after changes. Test same-task concurrent queue requests and restart during creation. Resolve/reuse uncertain launches before new attempts.

Promotion requires a finished successful scout and a readable durable report. Use the artifact instead of silently truncating output to 2000 characters. Do not promote failed/active/blocked scouts. Preserve report/ownership and exact project delivery mode.

## C. Coherent launch options and execution selection

Resolve project, host, checkout/environment, provider/model/reasoning together. projectCheckoutPath currently chooses independently of parent-preferred host. Never pass a host-A path into host-B operations. Missing matching source is an explicit refusal.

Capabilities must be truthful across SDK compatibility and native transports. Native ship isolation remains mandatory; reject unsupported shared-worktree requests before side effects rather than ignoring them. Forward visibility. Define scheduling deliberately: native time gates are dispatch eligibility, not automatically completed scheduling. Implement durable due-task dispatch only with authority checked at execution, or reject unsupported sendAt clearly in the exposed capability/schema/help before creating records. Do not silently accept unsupported options.

Resolve and record actual execution settings where SDK supports that. Respect project defaults instead of pretending omitted provider/model inherits from parent. Support or explicitly reject provider-specific reasoning values, including ultra/none/ultracode where supported; no silent downgrade to unspecified. Do not hardcode model catalogs or change the user's selected model policy.

## D. Persistent PR delivery tracking, highest product priority

Worker completion/notification acknowledgement is not completed PR delivery. Implement a durable PR/deliverable register independent of worker retention. Use scalable per-record storage or database rather than an ever-growing single KV value; SDK KV limit is 256KB.

Persist canonical repository+PR identity, head SHA, originating task and project, manager owner, worker references, agreed delivery requirement, current status/blocker, next action, next check time, observation/error freshness, and dedup/recovery data. Register on PR discovery/ready signal/deliver, reconcile older tracked work, and recover scoped orphan references without taking ownership of unrelated PRs. Avoid assuming every URL in a scout/report belongs to that task.

Represent actual lifecycle, e.g. draft, waiting-checks, waiting-review, changes-requested, waiting-approval, ready-to-merge, merged-needs-verification, complete, explicitly-abandoned. Choose sound types and avoid contradictory booleans. A new head invalidates old checks/review readiness. Unknown forge lookup retains last known state labeled stale; it never means merged or abandoned.

Background work polls/subscribes through supported APIs with bounded batches and backoff. Wake the manager on actionable transitions, overdue next actions or lost ownership. Persist notification delivery/dedup so restart does not spam or lose needed work. No model turn for unchanged waiting. A failed delivery must remain retryable. Acknowledging wake receipts does not clear the deliverable.

Manager can continue already-authorized review/fix/merge work, prefer reuse of author for fixes, retain independent review, and use native guarded merge. Never grant new merge authority. Approval-required PRs remain pending visibly until approval. This register must not bypass native checks, rewrite native authority policy, or directly merge merely because checks are green.

Worker forget/archive/teardown and compaction must preserve outstanding PR records and monitoring. Manager handoff transfers ownership explicitly. Deleted/archived manager leaves a surfaced owner-needed obligation. Closed-unmerged PR needs an explicit disposition. Completion requires the task's delivery contract: merged+required verification where that was agreed; do not impose deployment on a PR-only task. Explicit abandonment needs a recorded reason and appropriate authority.

Expose unresolved deliverables in fleet UI, CLI/tools and session/bearings/catch-up. Show owner, current blocker/next action and PR link. Preserve captain/project scope; no silent cross-captain takeover. Add bounded list/inspect/reconcile/assignment/disposition operations as needed, not a pile of overlapping interfaces. Reuse existing receipt/decision/authority mechanisms.

Required behavioral tests: create PR and worker ends while checks pending; checks turn green later; failing check; reviewer requests changes; new head invalidates readiness; notification acknowledged while PR remains open; reload/compaction; archived/forgotten worker; manager handoff/lost manager; transient forge failure; closed-unmerged; explicit abandonment; verification after merge; duplicate events and failed notification; isolated owner/project scope. Include restart using durable state, not only same-instance unit tests.

## E. Native compatibility, upstream update and docs

Current overlay applies to latest fetched upstream but fails to load BB backend. Upstream 589ccec8 changed sibling lists to positional parameters; overlay still injects siblings="fm-composer-lib.sh fm-transition-lib.sh". New source loop instead needs set -- fm-composer-lib.sh fm-transition-lib.sh. Fix overlay and native pin together. Do not change clause while retaining the old native loop. Audit all patched scripts against 1f3e769616fdf9f31f85f4c3e6a9f71606634238, regenerate snapshots/skill pins/manifest through existing tools, and require exact patch application instead of fuzzy acceptance. Test backend source loading, not only installation exit.

Relevant upstream improvements include wait-no-turns, watcher continuity, bounded mergeability-unknown retry and completion-inventory checks. Preserve default/opt-in semantics; do not silently enable home-local preferences. Support/document the no-turn waiting capability where appropriate without creating competing polling loops.

README currently falsely says native seeded secondmates are unsupported. Align documentation with verified behavior and PR lifecycle changes. Keep BB-specific policy adaptations explicitly marked; do not rewrite native skill policy for convenience.

## F. Structure and delivery

Extract cohesive launch, PR-delivery state/reconciliation and execution-selection modules with clear interfaces. Avoid expanding the 11k-line server with another monolithic state machine. Do not undertake unrelated cosmetic rewrites. Delete replaced call paths when migrated; avoid two policy owners. State what remains blocked on BB core APIs honestly; hidden notifications do not imply token savings.

Provide a requirements matrix covering A-F, code links, exact validation commands/results, known limitations, and bounded follow-up actions. Keep a progress document in docs/verification/ so context recovery can resume from it. Commit all finished work in this checkout. Give parent final baseline..HEAD commit range and test results. Do not declare done with major requirements omitted or only documented.

## Validation baseline and commands

Before changes, npm test reported 590 tests: 582 passed, 8 skipped, zero failed. TypeScript and fidelity passed. Nine targeted native checks passed with deployed pin. Latest upstream snapshot had seven pass/two cleanup failures; changing the loader clause in scratch passed both failures and backend source load.

Run meaningful new regression tests, full npm test, npx tsc --noEmit, npm run fidelity, git diff --check, bb plugin build . . Include affected app/RPC schema verification if frontend changes. Run opt-in tests with FIRSTMATE_TEST_NATIVE=<scratch native home> FM_SCOUT_NATIVE_BIN=<scratch bin-bb>; inspect test definitions to ensure no live fleet is touched. Update test inputs for the new pin. Native installed home must remain untouched. Add fault injection around state-write/spawn/notify boundaries and show the cap and promotion probes are fixed.

Parent will review implementation and run independent tests; keep going until the complete authorized scope is concrete and reviewable.
