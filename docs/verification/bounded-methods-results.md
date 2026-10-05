# Local method-routing verification

Date: 2026-10-04 UTC. Baseline: `9aafc9e`. Candidate: this commit's changes.
These results cover local configuration and package checks, not activation or
model performance. Parent-owned live acceptance and final integration checks
remain pending at this handoff.

| Check | Observed result |
|---|---|
| New SDK routing, fresh reload, saturated budget, package-reference tests | 3 tests passed. |
| Focused existing role, native-bridge, calm resume, and memory-budget checks plus new tests | 8 tests passed. |
| Routing mutation script | All 4 mutations failed the decisive configuration/budget assertions; original source restored. |
| Typecheck | `npx tsc --noEmit` passed. |
| Native fidelity | `npm run fidelity` passed: 33 inventory files, 12 divergence anchors, 7 authorized fences. Inventory and snapshots unchanged. |
| Plugin build | `bb plugin build` passed. Existing package SDK pin 0.4.104 differs from host SDK 0.5.29; no repin performed. |
| Package inclusion | `npm pack --dry-run --json` included all 11 new method files and references. |
| Whitespace check | `git diff --check` passed. |
| Full local suite in original worktree | 744 tests ran. 733 passed, 3 failed, 8 skipped. Details below. |
| Isolated archived baseline, same three failing fixtures | 3 tests passed; [baseline log](bounded-methods-baseline.log). |
| Isolated candidate copy, same three failing fixtures | 3 tests passed; [candidate log](bounded-methods-candidate.log). |

## Original worktree failure details

The focused rerun reproduced all three failures before the isolated comparison.
Unsetting `BB_CLI` did not change them. No native policy, test predicate, overlay,
or launch renderer was changed to make them pass.

1. `bb crew launch prompt preserves the brief with only BB transport adaptations`
   (`server.test.ts:3272`) returned process status 1 instead of 0. Its purported
   fake transport reached the real CLI and returned `HTTP 404: Host not found`.
2. `IT native local merge respects captain hold and lands BB-named branch`
   (`server.test.ts:7717`) landed the scratch work, but teardown returned exit 1
   instead of 0. The real CLI returned `HTTP 404: Thread not found` for the
   fixture endpoint `bb:thr_crew`. Native retained the task record rather than
   claiming cleanup success.
3. `IT BB secondmate launch keeps captain role and seeded home; stop failures
   propagate` (`server.test.ts:7766`) returned process status 1 instead of 0.
   It reported `HTTP 404: Host not found`. Direct sourcing of the existing
   overlay backend also printed a missing `fm-composer-lib.sh` warning.

Both isolated copies used the same environment and dependency-directory
symlink. The baseline came from `git archive 9aafc9e`. The candidate copy used
that archive plus every tracked candidate change, the new test, and both new
skill directories. The same three tests passed in each copy. This isolates a
path/environment-dependent fixture problem; its precise cause is unresolved.
Do not describe the original full suite as green or these results as live
transport acceptance.

The full suite's eight skips remain explicit. Native tests choose the default
home or opt-in flags; these results do not establish every optional live path.
The parent will use a separate pinned native home for final checks and a fresh
isolated BB server/host for captain and worker package acceptance.
