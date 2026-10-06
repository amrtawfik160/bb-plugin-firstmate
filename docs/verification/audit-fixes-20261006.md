# Audit fixes and verification skill

The four defects confirmed against [the session handoff](../session-handoff-2026-10-06.md) are fixed in this checkout.
The plugin and bundled runtime were rebuilt. Production reload and existing captain runtime migration were not performed.
The handoff's reporting-compliance, external no-mistakes `/pr`, and historical PR-registration limitations remain separate work.

## Fixes

| Defect | Result | Regression evidence |
|---|---|---|
| Generated native scripts and redirected sibling links passed integrity checks. | Mirror manifests record generated-script hashes. Verification refuses changed or symlinked generated scripts and incorrect native sibling links before execution or reuse. | The shipped runtime helper refuses corruption of four executable scripts. Resolver refusal prevents injected marker execution. Restored bytes and links pass. |
| Full tasks used a shared task-ID storage key. | Storage keys include the launch identity. Full task recovery checks launch ownership and prefers original durable task data. Legacy storage alone cannot prove ownership. | Public dispatch and replacement retain different full tasks with matching task IDs and prefixes across reload. Ambiguous legacy data refuses before stop/spawn. Complete exact-worker evidence permits guarded migration. |
| Cache loss reconstructed a worker from retry input. | Launch reservation stores the original intake. Recovery preserves original task, isolation, execution, posture, and delivery requirement. Changed retry input or unavailable original intake refuses. | Public dispatch after reload and cache loss restores the original worker without another spawn. Legacy refusal preserves the worker and reservation. |
| One recovered PR check stayed unresolved while another failed. | A complete current observation retires each absent failure independently. Unknown or incomplete observations retain evidence. A repeated failure becomes unresolved again. | Public registration, reconciliation, inspection, and accounting retain only the current failing check. Accounting for the recovered check refuses. SQLite reload and incomplete-observation branches also pass. |

Assignment and PR regressions use the actual plugin CLI harness and real SQLite. External BB SDK and forge responses are simulated at their existing boundaries.
Runtime integrity checks execute shipped native scripts in disposable homes. These checks do not prove model compliance or live forge operations.

## Verification

These are separate suites. Their counts must not be added.

| Check | Result |
|---|---|
| Final full suite | 871 tests passed. Zero failures, cancellations, or skips. |
| Final clean CI profile | 342 tests passed. Zero failures, cancellations, or skips. |
| Focused audit regressions | Eight tests passed. Zero failures or skips. |
| Isolated causal mutations | Reverting each of the four fixes failed its named behavioral regression. The live checkout was not reverted. |
| Typecheck | Passed. |
| Skill fidelity | Passed. |
| Runtime package integrity | Passed. |
| Locked BB plugin build | Passed. |

The initial six regressions failed against the original checkout before the fixes. Two further CLI cases were added afterward.
The final full suite includes all eight cases. Build emitted the existing BB setting and SDK-version notices.

Build SHA-256: `498ec313460bae21598684303fcc7f45e3c73efc0ca52008627d31ae032a0444`.
Bundled release: `28b236f605b587679468065b9fcf68f9026e010bd0a9cfe1d7e76b8426221282`.
Archive SHA-256: `9f92983761faaa67073594b852bda843d984ed99d301685d23c98c192d03da2d`.
Audited native pins and source snapshot are unchanged.

## Generated skill

Use [.cursor/skills/verify-firstmate/SKILL.md](../../.cursor/skills/verify-firstmate/SKILL.md).
Its [feature map](../../.cursor/skills/verify-firstmate/features/README.md) covers installation, runtime integrity, assignments, PR follow-up, and role instructions.
The executable helper creates a private BB server, connected host, HOME, and data directory. It installs the candidate and runs the read-only doctor before each drive.

All five feature drives passed. Every invocation confirmed stopped processes, removed scratch data, and retained evidence.
The doctor refused after cleanup because its owned server no longer existed. Local links, feature-map sections, and executable permissions were checked.
Use `/maintain-verification-skill` when entry points or commands change.

## Evidence and reproduction

Evidence remains outside the checkout at `/tmp/firstmate-fixes-20261006-vp_1d9ja`.
The original dirty checkout was preserved. Baseline copies and a scoped patch identify this task's changes independently of earlier work.

- [Final full suite](/tmp/firstmate-fixes-20261006-vp_1d9ja/full-final.log)
- [Final CI profile](/tmp/firstmate-fixes-20261006-vp_1d9ja/ci-final.log)
- [Focused regressions](/tmp/firstmate-fixes-20261006-vp_1d9ja/regressions-current.log)
- [Causal mutation results](/tmp/firstmate-fixes-20261006-vp_1d9ja/mutations.json)
- [Installation proof](/tmp/firstmate-fixes-20261006-vp_1d9ja/skill-package/result.json)
- [Runtime proof](/tmp/firstmate-fixes-20261006-vp_1d9ja/skill-runtime/result.json)
- [Assignment proof](/tmp/firstmate-fixes-20261006-vp_1d9ja/skill-assignments/result.json)
- [PR proof](/tmp/firstmate-fixes-20261006-vp_1d9ja/skill-pull-requests/result.json)
- [Instruction proof](/tmp/firstmate-fixes-20261006-vp_1d9ja/skill-instructions/result.json)
- [Scoped source patch](/tmp/firstmate-fixes-20261006-vp_1d9ja/source-changes.patch)

Each skill proof directory also contains expectations, doctor output, CLI transcripts, service logs, and cleanup confirmation.

Run the skill helper from the checkout after the documented build:

```sh
node .cursor/skills/verify-firstmate/scripts/verify-firstmate.mjs \
  --feature assignments --evidence "$(mktemp -d /tmp/verify-firstmate-evidence-XXXXXX)"
```

For the final full-suite environment, use the existing [isolated fixture recipe](session-retro-20261005.md#evidence-and-checks).
The CI profile requires the audited native fixture through `FIRSTMATE_TEST_NATIVE`.

```sh
FIRSTMATE_TEST_NATIVE=/tmp/fm-crew-state-native-yq_lrbsn/home npm run test:ci
node --test --experimental-strip-types --test-name-pattern='audit regression:' \
  server.launch-delivery.test.mjs lib/launch-delivery.test.mjs scripts/native-runtime.test.mjs
python3 /tmp/firstmate-fixes-20261006-vp_1d9ja/check-mutations.py
```

The mutation helper copies the candidate into a temporary directory, reverts one fix there, and removes only that copy.
Its logs and results survive cleanup.
