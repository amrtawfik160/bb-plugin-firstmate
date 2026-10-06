# Native dispatch mapping correction — 2026-10-05

Baseline: `89c5d14ee7dbd1fd9a81f07c6a3171de99cc33b1`. Implemented in the isolated implementation checkout. Production activation and fresh multi-turn model acceptance remain parent-owned and pending. No model launch, production operation, native source change, runtime selection change or task migration ran here.

## Cause and bounded correction

Parent's valid fresh ACP captain retained its role, read the entire contract and planned delegation, but could not map native intake onto BB. Read-only evidence: `/root/.local/share/bb-firstmate/homes/thr_jm4qnewqmf/data/captain-role-89c5d14/acceptance-events.json`, sequences 578, 586, 694, 797, 819, 841 and 902. The agent inferred that it needed to write a matching brief manually. That workaround is unsupported.

Tracing the actual dispatch confirmed a behavioral omission: BB wrote the native brief and registered the backlog before native spawn, but never called the required resolver on the written brief. The local-only task also carried a misleading default merge requirement. Bare `fm brief --help` exposed only wrapper usage without explaining forwarding.

[dispatch-intake.ts](../../lib/dispatch-intake.ts) contains the shared transport mapping, delivery selection and resolver-result handling. Its text is reused by the exposed dispatch tool, guide and complete selected-runtime contract appendix. The versioned [transport allowlist](native-transport-allowlist.v1.json) hashes that mapping and the updated entry reference. Native policy, task wording, role excerpts, triggers and worker renderer are unchanged.

## Requirement map

| Native responsibility | BB mapping and observed proof |
| --- | --- |
| Write native brief, then directly resolve it before spawn | `dispatchViaRealTransport` calls real native brief with the selected checkout, then immediately calls `dispatch-resolve`, before backlog add or spawn. Unique task artifact retains the complete returned result and selected BB execution/intake reason. Both audited pins execute the real scripts through the registered CLI in disposable fixtures. |
| Native resolution off/default and enabled decisions | Off remains native off, without new network/config probing. Enabled clear/ambiguous/escalate/error results require the caller's recorded `dispatchProfileReason` and explicit catalog-validated BB provider/model. Native configuration/usage failures refuse regardless of a reason. No resolver outcome grants approval. Factory tests cover clear refusal, exact-task retry and configuration refusal. |
| Harness/model/effort | Backend and native harness are `bb`; provider/model/reasoning select the worker via supported BB APIs and adapter environment. Native CLI harness/account profiles cannot be inferred from BB provider identity. No supervisor execution change is performed. |
| Delivery mode/yolo | Mode is recorded in the native brief and passed to spawn. Existing posture supplies yolo; native merge guards and actual user holds remain authoritative. No new task yolo flag or merge authority. `firstmate_posture` now also returns native registry branch prefix. |
| Branch prefix | Intake-selected `branchPrefix` / `--branch-prefix` is retained in launch/crew/queue records and passed identically to brief and native spawn. Default remains `fm/`; empty prefix remains supported by native. Changed explicit retry prefix refuses. SDK compatibility dispatch explicitly refuses native prefix/profile options rather than ignoring them. |
| Backlog | BB seeds or reuses the exact task ID through native tasks-axi before guarded spawn. Native spawn owns admission/start. Queue identity, dependencies and time gates retain their existing owners. No second manual spawn or parallel brief is required. |
| Local-only completion | New local-only ships default to `deliveryRequirement=branch`: native committed, validated ready-in-branch completion, without push/PR/merge required. PR/merge requirements with local-only, or branch with PR modes, refuse before launch. PR registration refuses branch obligations. A later authorized local merge is separate. |
| Recovery and contracts | Omitted retry requirement inherits the original immutable contract instead of being treated as an explicit new default. Existing legacy/PR requirements are not rewritten. Queue add with unresolved mode defers its default until intake at dispatch. Known resolver failures precede the external spawn boundary and become failed reservations; only crossing native spawn can retain uncertain worker capacity. |
| Native help | `bb firstmate fm brief -- --help` forwards native help; `firstmate_fm script=brief args=["--help"]` does the same. Without the separator, registered wrapper help explains this syntax and managed dispatch ownership. The obsolete direct-spawn example is removed. |

## Supported intake

After required native startup and project/shape/mode/execution intake, invoke `firstmate_dispatch` directly, or:

```text
bb firstmate dispatch --project <selected-project> --shape ship --mode local-only --delivery-requirement branch --provider <selected-provider> --model <selected-model> --reasoning-level <selected-level> -- "<verbatim-task>"
```

Use `posture --json` for registry/authority context and `dispatch --help` / `queue --help` for schema-derived options. Pass a nondefault intake-selected branch prefix explicitly. If enabled resolution refuses pending intake, read the returned native result and its artifact, apply native intake/approval policy, then reuse the returned task ID with the explicit BB target and a recorded profile decision. A reason is evidence of intake, not proof of approval. Queue dispatch can supply that reason while retaining the stored branch/contract.

No production migration is needed. Existing workers, native homes, briefs, delivery contracts and pending records remain intact. Parent integration must refresh the plugin/entry instructions and obtain the complete current contract. It must not rewrite old local-only contracts to obtain branch delivery.

## Validation and causal proof

Owned native fixture for full integration: `/tmp/fm-crew-state-native-yq_lrbsn/home`. Tests for both pins clone disposable fixtures and install the exact overlay; the BB CLI in real dispatch tests is a fixture refusal endpoint, never a model launcher. Native sources tested: `2d833ff147cd26a5c461e914e06854e0eb2707ce` and `1f3e769616fdf9f31f85f4c3e6a9f71606634238`.

Commands:

```sh
node --test --experimental-strip-types lib/dispatch-intake.test.mjs server.native-policy.test.mjs
node --test --experimental-strip-types --test-name-pattern='native resolver decisions|real transport|C1:|C2:|F2:|F3:|native captain contract tool' server.test.ts
node --test --experimental-strip-types --test-name-pattern='factory metadata adoption|native guard failure|actual dispatch returns|registered local-only|queued local-only' server.launch-delivery.test.mjs server.queue-storage.test.mjs
npx tsc --noEmit
npm run fidelity
bb plugin build .
git diff --check
env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION \
  -u BB_THREAD_ID -u BB_PROJECT_ID -u BB_ENVIRONMENT_ID -u BB_HOST_ID \
  -u BB_SERVER_URL -u BB_HOST_DAEMON_PORT -u BB_DATA_DIR \
  FM_TEST_HOME=/tmp/fm-crew-state-native-yq_lrbsn/home \
  FIRSTMATE_TEST_NATIVE=/tmp/fm-crew-state-native-yq_lrbsn/home \
  FM_SCOUT_NATIVE_BIN=/tmp/fm-crew-state-native-yq_lrbsn/home/bin-bb \
  FM_CLASSIFY_LIB=/tmp/fm-crew-state-native-yq_lrbsn/home/bin/fm-classify-lib.sh npm test
```

Focused results: 20/20 policy/intake, 22/22 existing real-transport/receipt paths, 5/5 branch/recovery/partial-publication cases. Logs: `/tmp/fm-dispatch-policy.log`, `/tmp/fm-dispatch-existing.log`, `/tmp/fm-dispatch-recovery.log`. Typecheck, fidelity (33 skills, 12 anchors, 7 fences), build and diff check pass. Build retains the existing CLI SDK-version warning; SDK pin was not changed.

Five isolated mutations all exited 1, followed by byte-exact restoration:

1. Replace the actual resolver call with synthetic off output: both real native intake tests fail their command-order assertion.
2. Restore the generic merged default in `taskDelivery`: the local-only delivery test fails (`merged` versus `branch`).
3. Remove spawn's branch-prefix argument: both real native intake tests fail identical brief/spawn prefix evidence.
4. Replace wrapper's `fm brief -- --help` guidance with bare `fm brief --help`: both real native intake tests fail the help assertion.
5. Treat an omitted retry requirement as the newly computed default again: the actual metadata-adoption/dispatch-recovery test fails preservation of `merged-and-verified`. Restoring the explicit-request distinction passes all five recovery cases.

Logs: `/tmp/fm-dispatch-mutation-{resolver-bypass,branch-default,prefix-forwarding,wrapper-help,omitted-retry}.log`. These execute the focused commands above, with `--test-name-pattern='native dispatch intake'` for the three real-script mutations, `lib/dispatch-intake.test.mjs` for the default mutation and `--test-name-pattern='factory metadata adoption'` for omitted-retry. Restored recovery log: `/tmp/fm-dispatch-recovery-final.log`.

The first full run found one omitted-retry/default bug and two newly affected fixture answers (830/833). The retry now distinguishes explicit requirements; fixtures answer the real resolver/prefix reads while retaining their original causal assertions. All five affected recovery cases pass after correction. Final full result: **833/833 passed, zero failures/skips**, 180272 milliseconds, `/tmp/fm-dispatch-full-final.log`. Typecheck, fidelity, build and diff check also pass on the restored implementation.

## Limits and parent acceptance

This verifies native brief/resolver/backlog ordering and an attempted guarded native spawn, not a successful real worker launch. The positive runtime signature is `real transport dispatch-resolve crew=<id> status=<native-status> evidence=<artifact>`, followed by native backlog/spawn signatures when admitted. No compatibility fallback is allowed on a real-path failure.

Enabled external Typesafe resolution was not contacted: status/approval handling uses factory result fixtures; native off and configuration source semantics are preserved. No automatic native harness-to-BB provider/account map is claimed. Native policy still owns intake judgment, review, completion and merge authority.

Parent must repeat the fresh, separate-turn ACP delegation acceptance without dispatch steering: same captain execution, user-selected worker execution, one actual native worker before product writes, local-only branch completion, no generic PR question. Text/fixture equality is not evidence of model behavior. Production activation remains pending.
