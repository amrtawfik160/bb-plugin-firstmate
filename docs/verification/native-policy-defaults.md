# Native policy defaults and PR health

Date: 2026-10-05 UTC. Baseline: `1e0f94d736d97be3fbb4e00c8201f5d2b242cb90`.
Branch: `fix/native-policy-defaults-20261005`. This document describes the implementation commit that contains it.

Implementation and local verification are complete. Production integration, configuration refresh and fresh model acceptance belong to the parent. No production plugin, native home, task, worker, approval or PR was changed. No model was launched. The primary checkout and untracked Python caches were left untouched.

Read in full: parent `native-instruction-audit/audit.md` and `native-instruction-audit/cyndra/findings.md`, CONTRIBUTING, BB plugin authoring and writing-for-agents. Installed public SDK 0.4.104 and CLI 0.44.0 remain the contract. No native version upgrade or bundle regeneration was needed.

## Requirements and evidence

| Requirement | Implementation | Observed evidence and limit |
| --- | --- | --- |
| 1. Native policy defaults | [Role configuration](../../server.ts), [manifest](../../package.json). Only captain/firstmate transport entries are registered. No default captain-methods, worker-methods, calm or catch-up selection, contract instruction or reference pointer. Retained sources are unregistered. | Actual public SDK configuration before/after reload, dual crew/captain metadata exclusion, cold runtime package closure and complete native contract tests. Source-only methods cannot become required through a default pointer. |
| 2. Native reporting | Removed default presentation/report-editor requirements; native section 9 remains in the full contract. Event visibility, wake receipts, AFK and explicit quiet controls remain. | Both native contracts returned verbatim through CLI/tool; material final outcomes and exact URL requirements remain in source. Existing wake/receipt/timeline tests pass. No claim that text equality guarantees model reporting behavior. |
| 3. Effective instructions | [Versioned transport allowlist](native-transport-allowlist.v1.json) covers actual dynamic configuration, default entry/reference bytes and native renderer/fragment bytes. [Behavior tests](../../server.native-policy.test.mjs) compose captain configuration, mandatory references and full selected contract; crew configuration plus actual native-rendered task. | Both pins, ship direct-PR/no-mistakes/local-only and scout. Exact task/spec/source bytes, roles, no crew delegation, inbox IDs, completion/native gates and operational reference content survive. Injecting a method into dynamic instructions or a transitive captain reference fails. |
| 4. Selected policy revision | [Policy reader](../../lib/native-policy.ts), `firstmate_skill` / CLI `skill`. Reads exact selected runtime, complete tracked native bytes and their references. Accepts only the two audited upstream commits and the verified bundled snapshot. | Both external pinned fixtures and actual bundled runtime; changed policy, unknown HEAD, traversal, missing references refuse. No global policy manifest injection. SDK configuration only accepts static skill names, so automatic per-home slash-skill mapping is unavailable; use the selected-runtime reader. |
| 5. Supported CLI help | [Schema help renderer](../../lib/cli-help.ts). Dispatch/queue registered help and handler use the dispatch option schema with explicit supported aliases. Parser validates shape, mode and contract before launch. | Actual SDK registered CLI metadata/handler: project/provider/model/all reasoning levels/mode/contract/shape, identity, ownership, dependencies, eligibility and dispatch-only options. Full spec survives queue storage and gates. This is public SDK registration proof; fresh real BB-server help/package acceptance remains parent-owned. |
| 6. Delivery versus health | [Durable state](../../lib/pr-delivery.ts), [schedule/account operations](../../server.ts), [RPC](../../rpc.ts), [Fleet](../../app.tsx). PR artifact satisfaction is independent of status/check failures. PR-only open records remain monitored; original author and each failure persist. Old terminal PR-only records resume observation without changing their contract. | Actual factory schedule: artifact → reload/author cache removal → baseline red check → existing authorized baseline accounting → second independent red check → author accounting → unchanged dedup → passing checks. RPC validates and exposes both failures, author and contract timestamp. No worker turn, forge mutation or merge authority from accounting. |
| 7. Mode and standing authority | `posture` reads the real native registry and existing BB record. Unregistered default matches native no-mistakes/off. Explicit task mode preserves the orthogonal registered yolo selection. Existing tasks merge/recover with their recorded mode. New explicit posture source/actor/time/reason stay in the existing posture record. | Real native project-mode for both pins: unregistered defaults, registered direct-PR/on, unchanged legacy records, reason-required registered mode change, explicit task mode preserves yolo, actual hold off. Recorded standing approval reaches the existing native guarded merge route without a fresh ask; guard refusal retains task. Unknown legacy provenance stays explicit. |
| 8. Retained method ambiguity | [Changed journey reference](../../skills/worker-methods/references/product-verification.md) separates journey execution from assigned whole-skill maintenance. [Proof reference](../../skills/worker-methods/references/proof.md) scopes Firstmate-specific evidence language to Firstmate work. | Unregistered source/reference graph tests; default manifest/configuration/composed transport checks prevent automatic reintroduction. No clean SDK user-only opt-in was verified, so these methods are not exposed as default or optional slash commands. |

## Native authority boundary

Inspected native `AGENTS.md` sections 1/7/9, `fm-project-mode.sh`, `fm-pr-merge.sh`, `fm-merge-local.sh` and captain-hold lifecycle rules. The registry mechanically returns mode/yolo; it is not attributed proof of a user instruction. Task control/away locks, captain holds and `answer --release`, current-head checks, exact PR/task identity and native merge outcomes retain their existing owners. No native authority file or merge guard changed.

Legacy `{mode, yolo}` BB records are preserved. Absence of provenance does not prove absence of approval. The status response labels unexplained flags unverified; it does not turn them off. Resolve standing authority from the existing recorded user instruction, then use the existing owning-captain `posture set` operation with that evidence. A mode-only edit cannot manufacture approval provenance for legacy yolo. An actual user hold remains a hold; supervisor-authored caution does not become a user hold. Explicit approved standing yolo does not need another per-PR request.

The plugin records the captain instruction asserted by an explicit supported call; it does not independently authenticate the truth of prose evidence. Native gates remain the merge authority/check boundary. A legacy automatic merge with no attributable evidence refuses explicitly until existing authority is reconciled; it is never silently treated as newly approved or denied.

## Validation commands

Owned fixture: `/tmp/fm-prompt-fixture-hGuT6L`. Tests clone only disposable native fixtures and remove only those fixtures. Synthetic tasks/check URLs replace customer content. Native shell reads/rendering execute real scripts locally; SDK worker/forge boundaries are fake, with no real BB/model spawn. Fixture terminals use non-login shells, ignored stdin and a fake PATH BB that exits 97 rather than reaching production.

```sh
node --test --experimental-strip-types server.native-policy.test.mjs \
  server.launch-delivery.test.mjs server.methods.test.mjs lib/launch-delivery.test.mjs

FIRSTMATE_TEST_NATIVE=/tmp/fm-prompt-fixture-hGuT6L \
  node --test --experimental-strip-types server.native-policy.test.mjs

FIRSTMATE_TEST_NATIVE=/tmp/fm-prompt-fixture-hGuT6L \
  node scripts/native-policy-mutations.mjs

node --test --experimental-strip-types --test-name-pattern='owned launch metadata|durable launch orphan' \
  server.launch-delivery.test.mjs

npx tsc --noEmit
npm run fidelity -- --native /tmp/fm-prompt-fixture-hGuT6L
bb plugin build .
git diff --check

env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION \
  -u BB_THREAD_ID -u BB_PROJECT_ID -u BB_ENVIRONMENT_ID -u BB_HOST_ID \
  -u BB_SERVER_URL -u BB_HOST_DAEMON_PORT -u BB_DATA_DIR \
  FM_TEST_HOME=/tmp/fm-prompt-fixture-hGuT6L \
  FIRSTMATE_TEST_NATIVE=/tmp/fm-prompt-fixture-hGuT6L \
  FM_SCOUT_NATIVE_BIN=/tmp/fm-prompt-fixture-hGuT6L/bin-bb \
  FM_CLASSIFY_LIB=/tmp/fm-prompt-fixture-hGuT6L/bin/fm-classify-lib.sh npm test
```

Results:

- Focused SDK/state/method/composition tests: 64 passed, zero failures/skips (`/tmp/fm-policy-focused-final.log`); later intake/queue set: 43 passed (`/tmp/fm-policy-intake.log`).
- Final selected-native/composed/help/intake/bundled tests: 7 passed, zero failures/skips (`/tmp/fm-policy-native-final.log`). Orphan original-mode/scoped recovery: 2 passed (`/tmp/fm-policy-orphan-mode.log`).
- Full suite after the final orphan-mode correction and fixture update: 810 passed, zero failures/skips, 176177 ms (`/tmp/fm-policy-full-final-candidate.log`). The first run caught a synthetic orphan fixture without an original mode; its explicit original direct-PR contract was restored, retaining scope/refusal assertions. Prior candidate: 809 passed, zero failures/skips (`/tmp/fm-policy-full-candidate.log`).
- After the full suite, the diagnostic inventory label/comment was corrected to stop claiming default policy injection; configuration/package tests passed 5/5 (`/tmp/fm-policy-settings-final.log`), and typecheck/fidelity/build were rerun. No runtime policy behavior changed in that display correction.
- Typecheck passed (`/tmp/fm-policy-typecheck-final-candidate.log`). Fidelity passed: 33 source files, 12 marked adaptation anchors, 7 authorized fences; snapshot fresh against the owned native fixture (`/tmp/fm-policy-fidelity-final-candidate.log`). These 33 files are fidelity inventory, not 33 registered skills.
- Build and diff check passed (`/tmp/fm-policy-build-final-candidate.log`). Build printed its existing SDK 0.5.29 versus contract pin 0.4.104 diagnostic. No repin performed. Incident `BB_INFERENCE_FALLBACK` warning text is not emitted by plugin/server/lib/overlay source; no BB core or other plugin was changed.

### Causal checks

[Private mutation runner](../../scripts/native-policy-mutations.mjs): all 12 restored defects fail their behavior assertions, without altering the candidate checkout. Log: `/tmp/fm-policy-mutations-final.log`.

| Mutation | Decisive behavior |
| --- | --- |
| Mandatory worker method instruction | Actual configured instruction hash/default role fails. |
| Global pinned skill manifest | Saturated configuration detects mixed global policy inventory. |
| Modified selected policy accepted | Real native byte read incorrectly succeeds; CLI refusal assertion fails. |
| Unknown native revision accepted | Real Git HEAD read incorrectly succeeds; revision refusal assertion fails. |
| Minimal registered CLI help | Actual registered metadata differs from full handler/help/options. |
| PR artifact made terminal | Real factory schedule fails artifact-health separation/reload. |
| Failure identities omitted from dedup | Second independent failure cannot produce its distinct notification. |
| Current project mode substituted for task mode | Existing direct-PR task with zero checks gains a wrong no-mistakes gate. |
| Standing approval requires another request | Approved manager cannot reach the native guarded route. |
| Explicit task mode resets native yolo | Actual native intake fails seeded authority/reservation invariant. |
| Method added through captain reference | Composed default reference hash rejects mandatory method injection. |
| Orphan recovery substitutes direct-PR | Real factory orphan discovery publishes the wrong task-mode continuation. |

## Parent acceptance and refresh

1. Review/integrate the commit and independently run the fixture suite and actual isolated BB CLI/runtime-package checks.
2. In the disposable acceptance server, inspect fresh captain and ship/scout composed instructions. Preserve selected provider/model/effort. Parent alone owns any genuine model launch; verify delegation, no default added reviewer/methods, native done/merge gates, exact inbox IDs and section 9 material-only reporting separately from text checks.
3. Activate only after that evidence. Refresh captain configuration and reread the complete selected contract. Do not auto-migrate externally managed homes or restart active workers. Existing task briefs, native pins, source repositories, authority records and old assets remain intact.
4. Resolve each legacy authority record from existing user approval before automatic merge. Observe PR-only migrated records and independently account existing failures; no automatic baseline classification, dispatch or merge is authorized by this migration.

Limits: no fresh-model behavior or production activation proved here; no actual GitHub mutation in tests; no dynamic per-home slash-skill API in SDK 0.4.104; only the two audited native versions are supported. The follow-up [trigger/reference correction](native-policy-trigger-references.md) supplies the required full native trigger catalog and raises the complete skill/reference read bound to 2 MiB per file; contract reads retain their 200000-byte bound. No read truncates. Orphan recovery without a readable original delivery mode refuses instead of guessing; the reservation/history remains intact. Failure accounting keeps a failure unresolved until fresh passing evidence, and links existing authorized work rather than creating new work. Product review policy and user permission remain native-owned.
