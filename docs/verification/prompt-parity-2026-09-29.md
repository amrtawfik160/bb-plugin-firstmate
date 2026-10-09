# Native prompt and startup parity, 2026-09-29

Initial verification snapshot; subsequent fixes and current results are in [the resolution report](native-policy-fixes-2026-09-29.md).

Audited native revision: `2d833ff147cd26a5c461e914e06854e0eb2707ce`.

The quoted startup blocker came from invoking native session start through BB's host-terminal RPC, outside the agent harness ancestry required by `fm-lock.sh`.
Startup tools and CLI now return the exact command for the agent shell; SessionStart hooks run the same native entry point through `bin-bb` with explicit home bindings.
Actual native lock refusals retain read-only behavior.

Captain entry skills bind the BB home and load the complete native supervisor contract verbatim.
The independent captain, intake, and supervision playbooks were removed.
`ahoy`, `quiet`, `stow`, and `bearings` now preserve their complete upstream skill text; Bearings uses upstream's four sections.
BB crew instructions preserve the native launch brief and map runtime paths, browser access, and the BB scheduled-resume mechanism; the added CI policy was removed from this launch path.
The fidelity check now covers every registered upstream skill and both BB entry skills, including byte equality and deletion checks for verbatim skill copies.

Validation:

- `npm test`: 563 passed, 2 skipped, 0 failed (565 total). The two skips are existing scout report/inventory recovery cases.
- `npx tsc --noEmit`: passed.
- `npm run fidelity -- --native $FIRSTMATE_HOME`: passed; 33 checked files, 12 divergence anchors, 7 adaptation fences.
- `scripts/live-startup-harness-check.mjs`: real full native startup acquired the calling harness lock and recorded startup completion; the detached process refused read-only and preserved that owner. Tracked native files stayed clean.
- `--mutate-host-transport`: failed the real harness-lock acquisition assertion, reproducing the old transport bug.
- Tool and CLI regression cases reject detached startup execution and preserve shell arguments literally.
- `bb plugin build` and `bb plugin reload firstmate`: succeeded. Live CLI returned `requiresAgentShell: true` with the native startup command.

Existing clean native homes were fast-forwarded to the audited revision where needed, their mirrors refreshed, and the installed BB captain hook updated.
No fleet records were moved or deleted.

These checks establish the reviewed skill-copy fidelity and native startup ancestry/locking, not prompt ownership across every lifecycle path. The [follow-up audit](prompt-parity-followup-2026-09-29.md) identifies remaining retry, status, waiting and hook differences.
The BB hook/event limits documented in [native parity](../native-parity.md) remain; this is not a proof of complete tmux equivalence across every provider and workflow.
