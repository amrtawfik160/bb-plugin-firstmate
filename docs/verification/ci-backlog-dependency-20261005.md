# Hosted native backlog dependency repair — 2026-10-05

## Confirmed failure and scope

Frozen `0e521d6` hosted checks acquired runners and executed tests, then failed four adoption cases. This differs from the earlier runner-acquisition failures.

- [Pull-request run 37388195941](https://github.com/amrtawfik160/bb-plugin-firstmate/actions/runs/37388195941): native backlog pairing and interrupted metadata/backlog publication failed at both audited pins.
- [Push run 37388192556](https://github.com/amrtawfik160/bb-plugin-firstmate/actions/runs/37388192556): same four failures.
- Native diagnostic: `fm-tasks-axi: tasks-axi is not on PATH; run bin/fm-bootstrap.sh for the install command`.
- Parent preserved the exact log at `/root/firstmate-bb-homes/thr_jm4qnewqmf/data/acceptance-0e521d6/hosted-failed.log`.

Acceptance hosts had global `tasks-axi` 0.2.6; clean runners did not. The existing CI tools manifest pinned BB alone. The adoption cases remained in the CI profile and legitimately required the real backlog tool. No change to adoption behavior, native scripts, methods readers, policy, test exclusions or assertions was needed.

## Bounded correction

`npm ci --prefix scripts/ci-tools` now installs exact `tasks-axi` 0.2.6 alongside exact BB 0.44.0. The lockfile records package integrity and the two transitive dependencies. The published package and locally verified working CLI agree on version 0.2.6 and Node >=20. CI uses Node 24.18.0.

`ciEnvironment` places the owned refusing BB fixture first, the locked CI-tools bin second, then Node/system bins. Actual native adoption uses the pinned tasks CLI; fake BB remains authoritative for tests and refuses worker operations. The workflow already installed this lockfile, so no workflow bypass or unpinned global installation was added.

The public CI environment regression checks actual executable resolution, real CLI version and refusal of real BB transport. Removing the locked directory from PATH kills this regression even on the acceptance host where a global tool could otherwise conceal the defect.

## Validation

| Command / proof | Result |
| --- | --- |
| `node --test scripts/ci-check.test.mjs` before PATH/dependency fix | RED: 1 failure; resolved globally installed tasks CLI rather than locked CLI |
| Same command after fix | GREEN: 3/3, zero failures/skips |
| Remove only locked CI-tools directory from `ciEnvironment`, then `node --test --test-name-pattern='clean CI resolves' scripts/ci-check.test.mjs` | Causal RED: 1/1 fails; fix restored in `finally` |
| `npm ci --prefix scripts/ci-tools` | Passed from lockfile |
| Real native targeted proof below | 4/4, zero failures/skips; both audited pins |
| Full `npm run test:ci` with owned exact native fixture | Passed: 333/333, zero failures/skips; 106.913 seconds |
| `npm run typecheck` | Passed |
| `npm run fidelity` | Passed: 33 skills |
| `npm run runtime:verify` | Passed; runtime release unchanged |
| `env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION scripts/ci-tools/node_modules/.bin/bb plugin build .` | Passed; CLI version separately verified as 0.44.0. Existing local BB configuration emits deprecated-inference and SDK-version notices; no SDK pin changed. |
| `git diff --check` | Passed |

Reproduce the native proof after lockfile installation, using an owned fixture containing both commits:

```sh
PATH="$PWD/scripts/ci-tools/node_modules/.bin:/usr/bin:/bin" \
FIRSTMATE_TEST_NATIVE=/path/to/owned/exact-native-fixture \
node --test --experimental-strip-types --test-reporter=tap \
  --test-name-pattern='backlog pairing|interrupted metadata/backlog' \
  scripts/launch-adoption.test.mjs
```

The recorded proof used `ciEnvironment` with an owned fake BB (exit97) ahead of the locked tools. The actual tests retain add/show/start/done, closed-task refusal, injected publication failure, exact endpoint reuse, immutable branch/task and untouched dirty-work assertions. No workers or forge mutations run.

Evidence: [native GREEN](ci-backlog-dependency-20261005-evidence/native-green.log), [causal RED](ci-backlog-dependency-20261005-evidence/causal-red.log), [full CI profile](ci-backlog-dependency-20261005-evidence/ci-green.log).

## Limits and follow-through

This is CI dependency portability, not new model acceptance. No production installation, binding, fleet, home or worker changed. Parent methods acceptance on frozen0e521d6 remains independent. The prior full suite was 860/860; this bounded correction adds one CI regression and reruns the complete supported CI profile. Full native/model acceptance remains separate from that profile. Existing npm audit notices were not addressed through unrelated dependency upgrades.

After committing, push this branch to PR53 and monitor both hosted runs; do not merge. Record exact hosted results before handing off. Every-message reporting still has failed actual model acceptance; external no-mistakes `/pr` author loading remains unresolved. This repair does not alter those limits.
