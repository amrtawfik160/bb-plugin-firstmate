# Follow-up native parity audit, 2026-09-29

Requirement: preserve upstream Firstmate prompts and behavior; change only what BB environment/CLI transport requires.

Upstream: `$FIRSTMATE_HOME`, `2d833ff147cd26a5c461e914e06854e0eb2707ce`. Plugin baseline: `ee1a87afc63d377d0cf69b610c142399f08ec062`, plus the existing uncommitted parity changes. The review includes active runtime paths outside that diff. Two independent reviewers covered Standards and Spec. This audit initially changed documentation only. The findings below record that audit baseline; subsequent fixes and remaining validation limits are tracked in [the resolution report](native-policy-fixes-2026-09-29.md).

## Standards

1. **P1: replacement retry discards the native brief.** `server.ts:4347` rebuilds native-home workers with `crewPrompt`; `lib/policy.ts:546–570` supplies an independent worker playbook, including the custom CI rule. This violates CONTRIBUTING's native-policy ownership rule and contradicts the new instruction at `server.ts:9163`. Provider/model/reasoning replacements restore behavior removed from initial launches. Reuse the native launch/relaunch contract rather than the legacy prompt builder.

2. **P2: startup acceptance does not exercise the changed entry points.** `scripts/live-startup-harness-check.mjs:21–37` invokes `captainStartupCommand` directly through Bash. It does not execute the tool interception or SessionStart hook; reverting those changes would leave this proof green. The ancestry mutation demonstrates the old transport's failure, but does not establish all changed paths under CONTRIBUTING §§1, 2, 4. Run those paths with real native scripts and mutations of their actual routing fixes. The earlier live CLI check establishes the returned command, not its execution through every provider's hook.

3. **P2: enabled startup failures are silent.** `overlay/bin/bb-captain-hook.sh:55–58` exits successfully without diagnostics if an owned captain home's runner is missing/non-executable or the home cannot be entered. This violates CONTRIBUTING §3: broken enabled behavior must be distinguishable from disabled behavior. Warn with the thread and failed path.

Possible smell, **low**: browser/Lavish adaptation text has separately maintained variants in `lib/policy.ts:490`, `server.ts:1394`, and `overlay/bin/backends/bb.sh:361–362`; wait/timer instructions are duplicated too. One transport text owner or an equality check would reduce drift.

## Spec

1. **P1: wake reads silently resolve unanswered decisions.** `server.ts:6541–6543`, called by `drainWakes` at `6603`, appends synthetic `resolved` declarations when a crew has no register record or native metadata and its status log is quiet for an hour. Upstream `bin/fm-classify-lib.sh:817–826,852,876–883` deliberately preserves decisions for unknown/metaless tasks and requires folding the durable open-set. Missing crew metadata and elapsed time do not establish a decision answer. Remove automatic decision resolution; preserve or explicitly surface the orphaned decision.

2. **P1: valid native completion restarts workers.** `server.ts:9511–9519` checks final chat for DONE/BLOCKED/FAILED and sends protocol nudges otherwise, without consulting native status. This is enabled by default and explicitly enabled by the full-parity profile (`server.ts:6228`). Upstream `bin/fm-brief.sh:559–592` requires appending durable status and stopping; it does not require a chat verdict. Its turn-end guard exempts child worktrees. Consume native declarations for native workers instead of imposing a second completion protocol.

3. **P1: Bearings classifies chat instead of native status.** `server.ts:4831–4839,4896–4899` derives completion/decisions from chat and BB idle state. A native log can contain `needs-decision` while chat says “Please choose A or B”; Bearings offers the crew as ready to review. A resolved native decision can also remain a phantom blocker in chat. Tools, CLI, session and RPC use this projection; only deck prepends a native snapshot. Upstream `bin/fm-classify-lib.sh:876–883` requires the complete durable status stream. Use the native snapshot/classifier as the authority.

4. **P2: custom waiting policy remains active.** Initial native launches (`overlay/bin/backends/bb.sh:330–335,359–360`) and SDK configuration (`server.ts:9163`) still inject WAITING, five-minute foreground rechecks, scheduled resumes and mandatory shutdown of worker background commands. `server.ts:9444–9480` implements this second lifecycle. Upstream `bin/fm-brief.sh:90–94` owns the configured `paused` declaration and explicitly includes the worker's own background work. BB event delivery may require adaptation, but these additional worker rules change policy. Preserve native pause/process-event ownership and adapt its delivery.

5. **P2: the Stop hook lacks native supervision predicates.** `overlay/bin/bb-captain-hook.sh:40–49` allows stop when queue/receipt are empty. Upstream `bin/fm-turnend-guard.sh:227–254` also blocks for tasks, process-event sources, custom checks or X-mode when supervision is absent. The plugin supervisor may repair later, but the stop predicate is different. This gap is already disclosed in `docs/native-parity.md`; it is still inconsistent with full behavior equivalence. Invoke the native predicate through BB home bindings wherever the harness permits it.

## Evidence and limits

- Executed the real upstream `status_open_decisions` on a disposable metaless log. Before the plugin's generated append: `release\tneeds-decision\towner must approve release`. `orphanCandidateScript` selected the two-hour-old log; `orphanResolveLines` generated `resolved [key=release]: auto-closed: crew gone ...`. After appending it, the native fold returned an empty set. No live fleet state was changed.
- Executed the actual plugin CLI retry with fake BB transport, a real-mode/native-home crew, and `--reasoning-level xhigh`. It spawned one replacement with no `FIRSTMATE_OP` brief, no native sentinel and the custom CI rule. No native brief file was read. Scratch evidence: `/tmp/firstmate-relaunch-audit.json`, `/tmp/firstmate-relaunch-captured-prompt.txt`, `/tmp/firstmate-relaunch-repro.mts`.
- Source checks establish the competing prompt/status/Stop implementations. Fake transport reproductions establish plugin control flow; they are not live BB model/harness acceptance proofs. The earlier green suite does not establish policy equivalence: some existing tests explicitly assert the divergent behavior, including orphan auto-resolution at `server.test.ts:9473`.
- Dedicated-home wake scoping was checked and is not a finding: `wakeStateDir` uses the dedicated home's root state correctly.

Standards: 3 violations, 1 possible smell; worst is native policy loss on replacement. Spec: 5 defects; worst severity is P1 for decision loss, completion and Bearings. Complete tmux equivalence remains unproven.
