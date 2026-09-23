# AXI toolchain

`bb firstmate toolchain --json` (or `firstmate_toolchain`) checks native bootstrap compatibility without installing dependencies.
Use the home's `bin/fm-tasks-axi.sh` for backlog operations, `gh-axi` for GitHub, `quota-axi` for quota decisions, and `lavish-axi` for visual review.
The native `no-mistakes` pipeline remains worker-owned when that delivery mode is selected.
Missing essential tools block their workflows; Lavish readiness is reported separately for visual work.

## Browser policy

Firstmate uses BB's `/browser` skill and `browser_script` (or `bb browser script`).
Leave `profileId` unset for the thread's isolated default profile.
This overrides imported native AXI browser instructions for captains, secondmates, and crews.
The bootstrap overlay removes `chrome-devtools-axi` from BB's required tools; other native backends retain their original dependencies.
Do not install AXI browser hooks for BB.

## Lavish review hosting

Read the home's `config/lavish-axi-host`, when present, and set `LAVISH_AXI_HOST` on the open command because BB threads do not inherit launcher exports.
Open the artifact before arming the home's `fm-procevent-lavish.sh` with its owning task ID.
Keep one listener per board.
Use BB Connect for remote review access; third-party publishing requires a publication request.

An optional [systemd service template](../scripts/host/lavish-axi.service) keeps reviews available across idle periods and process exits.
Its header owns host configuration and installation instructions.
The [lifecycle check](../scripts/host/lavish-lifecycle-check.mjs) uses the installed Lavish in a disposable service and store; `--help` describes its mutation checks.
It never restarts the shared review server.

## Verification

Real-bootstrap regressions in [`server.test.ts`](../server.test.ts) check incompatible dependencies, essential versus presentation readiness, and unchanged fleet state.
A browser dependency regression hides `chrome-devtools-axi` and asserts BB passes while native tmux still reports the missing tool.
These fixtures substitute the SDK boundary; they do not establish a live agent's complete review or no-mistakes workflow.
