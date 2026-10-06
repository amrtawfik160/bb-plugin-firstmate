# Crew reporting and validation fixes

The supervisor audit found a false inactivity alert, stale task reports, unrecorded check waits and setup, and an investigation prompt requesting implementation.

This change fixes their transport paths:

| Problem | Cause | Change |
|---|---|---|
| False inactivity alert | Fallback monitor omitted started/completed tool items recognized by native activity | Share the activity event set |
| Stale status and progress | Independent manual reporting paths | One task-owned report command saves evidence before appending status and preserves prior authored reports |
| Checks without a paused state or durable result | Separate launch, polling, and status commands | Record paused before execution, resolve the exact key afterward, and bind command receipts to the tested revision |
| Missing setup and guide evidence | Setup and reads had no recorded completion | Record doctor, required project/TypeScript reads, and additional registered guides |
| Investigation asked to implement | Shipping default used for both roles | Use a report-only default for investigations; explicit captain specifications retain precedence |

The helper handles source-stable local checks. It preserves native-required foreground waiting and otherwise uses durable systemd units with bounded waits. A unit that disappears without a result fails explicitly. Changed staged, unstaged, or untracked work invalidates old receipts. A report-write failure cannot publish completion. Task metadata, worktree, thread, and native delivery mode must agree.

The no-mistakes pipeline keeps its native commands and outcome artifacts. Task/intent rendering bytes, native source briefs, exact-ID inbox acknowledgment, fleet ledger, and completion/merge/deployment authority are preserved. Existing workers receive corrections through their supervisor; installation does not rewrite their prompts or select a runtime.

## Verification

This PR is isolated against main `c9177c075991a1d25c9b00c28ed595c696ca4f5c`. It excludes earlier unrelated changes in the working checkout. Its packaged release differs from the previously loaded combined checkout.

- [Full suite](crew-root-causes-20261006-evidence/full-suite-summary.log): 838 passed, 0 failed, 0 skipped. The earlier combined checkout ran 887 tests; this PR excludes its unrelated pending work.
- Typecheck, native skill fidelity, reproducible runtime verification, and plugin build passed.
- [All 14 causal mutations](crew-root-causes-20261006-evidence/mutations.log) failed their named behavior assertions when the corresponding fix was removed.
- [All 14 installed-helper live cases](crew-root-causes-20261006-evidence/installed-live.log) passed with actual systemd, subprocess commands, task status, reports, and revision receipts.
- [Runtime installation](crew-root-causes-20261006-evidence/installed-runtime.json) emitted `FM_BUNDLED_RUNTIME_INSTALLED` and did not select a captain runtime.

The full suite uses the actual native scripts at both audited revisions with an owned fixture. Run it using the existing test variables: `FM_TEST_HOME`, `FIRSTMATE_TEST_NATIVE`, `FM_SCOUT_NATIVE_BIN`, and `FM_CLASSIFY_LIB`. The test host's official BB CLI is locked at 0.44.0.

The installed-helper proof uses:

```sh
FM_CHECKPOINT_LIVE=1 FM_CHECKPOINT_HELPER=<installed-runtime>/bin-bb/fm-worker-checkpoint.py node --test scripts/worker-checkpoint.test.mjs
```

The mutation proof uses:

```sh
FIRSTMATE_TEST_NATIVE=<owned-native-fixture> node scripts/crew-health-mutation-check.mjs
```

The no-mistakes doctor command is replaced only in its decision regression. That test proves initialization handling, not an active application's setup. The supervisor dispatch regression simulates the external transport. Actual native prompt tests and installed-helper checks are separate proofs. No application or production correctness claim follows from these transport tests.

## Runtime

- Release: `dd3fbcd7b7b1fe33246bb29b7fe7f545dba8324109dc2abe3a58a358ce937dfb`.
- Archive SHA-256: `4fb27250366481d8536d04f1307bf12b1435a594e2ecb1355d34a597c71f3561`.
- Adapter: `8a88e4ce6681e9baef510f2de6eac5904abf9cbb458a48da9256b7fc9e4d93b0`.
