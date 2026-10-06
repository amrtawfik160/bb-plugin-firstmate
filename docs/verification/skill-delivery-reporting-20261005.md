# Verified skill reads and notification continuation

The agreed public interfaces are `firstmate_skill`, registered `bb firstmate skill`, diagnostic descriptions and final reporting after notifications.
This record covers implementation and local verification on 2026-10-05.
Parent model acceptance and production activation remain separate.
Native policy stays at the two audited commits `2d833ff147cd26a5c461e914e06854e0eb2707ce` and `1f3e769616fdf9f31f85f4c3e6a9f71606634238`.

## Findings and requirement map

| Requirement | Finding and correction | Observable evidence |
|---|---|---|
| Complete skill/reference delivery | Tool responses were unpaged, including a 223,333-byte linked configuration document. Tool reads now use byte-bounded verified pages; operator CLI retains full output. | Both pins, tool and CLI, reload, foreign captain, changed bytes, native nested references and fragments in `server.native-policy.test.mjs`. |
| Usable continuation | Cursors retain captain/home/host/runtime/resource and text snapshot identity. Unicode resource identifiers can exceed cursor capacity despite a character limit; oversized identities refuse clearly before publishing an unusable page. | Public Unicode-reference regression; full operator output remains intact. |
| Complete diagnostic descriptions | The old line parser returned literal `>-`, cut descriptions at 160 characters, and fed a second 2,400-character rendered limit. That unused cache is removed. | `skill --list --json` and `firstmate_skill {"list":true}` return complete descriptions from the verified catalog; role instructions exclude that diagnostic output. |
| Reporting after a notification continuation | Native section 9 was fully received. Private Stop feedback requested receipt operations after an earlier report, without directing the resumed reply back to native reporting. | Real BB hook regression proves the narrow section-9 cue, retained reports, explicit handling and bounded recursion. It does not prove a model's final wording. |
| Install and refresh the correction | The added hook cue pushed an inline startup installation command to 10,496 bytes, above BB's 10,000-byte cap. The previous setup cache also omitted hook identity. | Registered startup CLI/tool tests were RED; staged stdin installation and a hook hash in setup identity make them GREEN. Existing runtime and report records remain intact. |

The full [skill inventory](firstmate-skills-audit-20261005.json) records source revisions, complete descriptions, references, roles and actual invocation for both native pins, two registered entries and 32 historical source copies.
The two native inventories contain 28 unique skills each.
Direct native Markdown file references resolve at both pins.
Historical imported/method sources remain unregistered and outside automatic captain and worker instructions.
Native frontmatter invocation flags are policy intent; BB 0.44.0 does not implement Claude's invocation flags as access controls.
The required contract catalog retains native frontmatter verbatim and remains the authoritative trigger read.
The diagnostic inventory never becomes an alternate policy or instruction surface.

## Delivery interface

`firstmate_skill {"name":"afk"}` returns the first bounded page.
Follow each returned `firstmate_skill {"cursor":"…"}` until `END OF NATIVE SKILL TRANSPORT`.
CLI agent reads use `bb firstmate skill afk --paged`, then `bb firstmate skill --cursor <cursor>`.
Operator `bb firstmate skill afk` still returns the complete document.
Native nested references retain `reference` and `source` resolution within the verified selected root.
An end marker states that its page alone does not establish a complete read.
Foreign-owner/resource cursors and changed selected-runtime bytes refuse; reload needs no in-memory cursor cache.

The body bound reuses the contract transport's 8,000 UTF-8 bytes per page.
The resource identifier bound is 2,200 serialized UTF-8 bytes, with a 4,096-character cursor limit.
An oversized fragment can be omitted because the reader returns the complete document; operator full reads remain available.
No native body is shortened to fit these limits.
The actual pinned-source responses tested include identity headers, continuation instructions and BB routine markers within 12,000 bytes.
That tested bound is not claimed for every arbitrary accepted identifier.

Grok 1.0.46 (`2765805b9442`) is the inspected incident provider binary.
Its public help exposes no configurable tool-preview limit.
The approximately 19.5 KB preview was an observed prior incident boundary, not a universal provider limit.
The initial RED reproduces the oversized public response; the GREEN delivers the same verified native text in bounded pieces.
Parent actual ACP acceptance must verify that the configured provider receives every page and follows continuation.

## Reporting boundary and limits

Incident events 5469 and 5564 exposed unread-message mechanics and repeated an unchanged decision without the self-contained outcome.
The exact incident provider history contains all nine contract pages, including section 9 and its trigger catalog.
It also contains successful scout and ship dispatches and complete small skill reads.
Missing policy, missing delegation and unlabelled child notifications are therefore disproved explanations for this incident.
The stop-hook continuation is the observed adapter interaction, not proof that missing a cue alone caused stochastic model behavior.

Only that private continuation gains a pointer to native section 9 and its exact final-message sentence.
No global instruction wall, outgoing-text filter, automatic acknowledgement or notice suppression was added.
The installed hook still runs native guards first, preserves receipt handling and allows at most the existing bounded continuation.
The Brands audit-only implementation question remains valid.
The separate supervisor-authored Claude scope restriction is unresolved and outside this correction.
The archived incident thread and Telegram binding were not touched.

## RED and GREEN commands

Run from the implementation checkout with an owned audited native source.
The following focused commands use `/tmp/fm-launch-pr-verified` only as a read-only clone source.
Every stateful native test creates a disposable home.

```sh
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node --test --experimental-strip-types --test-name-pattern='bounded native skill reads' server.native-policy.test.mjs
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node --test --experimental-strip-types --test-name-pattern='public diagnostic inventory' server.native-policy.test.mjs
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node --test --experimental-strip-types --test-name-pattern='late audit notification' scripts/wake-receipt.test.ts
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node --test --experimental-strip-types --test-name-pattern='oversized Unicode reference identity' server.native-policy.test.mjs
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node --test --experimental-strip-types --test-name-pattern='bound captain refresh replaces' server.native-runtime.test.mjs
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node --test --experimental-strip-types --test-name-pattern='captain cli first binding.*2d833|clean captain binding' server.captain-startup.test.mjs server.native-runtime.test.mjs
```

Each new behavior test failed before its fix.
The original paging RED failed both pins at the oversized payload assertion; GREEN passed 2/2.
Diagnostic RED refused the public inventory request; GREEN passed 1/1 with full multiline branches.
Continuation RED lacked the native reporting pointer; GREEN passed 1/1 and retained explicit receipt handling.
Unicode and legacy hook-refresh RED/GREEN evidence is retained alongside these logs.
The initial full suite exposed ten startup failures caused by the composed command overflow, with no skipped tests.
After staging, the affected startup/refresh group passed 7/7.

Evidence is retained in [skill-reporting-20261005-evidence](skill-reporting-20261005-evidence/).
The source-level causal mutations separately restore unpaged output, the description cutoff, absent reporting cue, inline oversized hook installation, the old setup-cache identity and the missing UTF-8 resource bound.
All six mutations failed their public-interface regressions; the restored implementation passed afterward.

## Refresh and approval boundary

Parent integration installs the reviewed plugin build; implementation does not activate production.
An owning captain's supported `deck` refresh updates its user-level hook when hook bytes change, without selecting a new native runtime, sending worker prompts or altering reports.
Diagnostic refresh overwrites only the diagnostic setting with complete verified descriptions; failure remains labelled stale.
Existing native skills, task briefs, execution settings, contracts and authority remain unchanged.
New parsing uses pinned `yaml@2.8.3` under ISC; `npm audit` reports zero vulnerabilities for this lock.

Fresh model acceptance remains required for a completed audit followed by a late notification and receipt handling, ending with a self-contained plain outcome.
No deterministic test proves guaranteed model compliance.
Parent owns that acceptance, production refresh and any PR update/merge.

Hosted PR53 remains open at https://github.com/amrtawfik160/bb-plugin-firstmate/pull/53.
Runs https://github.com/amrtawfik160/bb-plugin-firstmate/actions/runs/37370591317 and https://github.com/amrtawfik160/bb-plugin-firstmate/actions/runs/37370591352 both failed to acquire a hosted runner and executed zero steps.
Their identical annotation is `The job was not acquired by Runner of type hosted even after multiple attempts`.
No check was weakened to address that infrastructure failure.

## Final validation

The settled implementation passed **843/843 tests**, with zero failures and zero skips, in 188,876.91353 milliseconds.
The full run clears BB inference/context variables and uses the owned `/tmp/fm-prompt-fixture-diRWgF` native fixture:

```sh
env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION \
-u BB_THREAD_ID -u BB_PROJECT_ID -u BB_ENVIRONMENT_ID -u BB_HOST_ID \
-u BB_SERVER_URL -u BB_HOST_DAEMON_PORT -u BB_DATA_DIR \
FM_TEST_HOME=/tmp/fm-prompt-fixture-diRWgF \
FIRSTMATE_TEST_NATIVE=/tmp/fm-prompt-fixture-diRWgF \
FM_SCOUT_NATIVE_BIN=/tmp/fm-prompt-fixture-diRWgF/bin-bb \
FM_CLASSIFY_LIB=/tmp/fm-prompt-fixture-diRWgF/bin/fm-classify-lib.sh npm test
npx tsc --noEmit
npm run fidelity -- --native /tmp/fm-prompt-fixture-diRWgF
npm run runtime:verify
env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION \
node scripts/ci-tools/node_modules/bb-app/host-daemon/dist/bb plugin build .
npm audit --json
git diff --check
```

All commands exited zero. Audit reports zero vulnerabilities.
The build emits the existing SDK availability warning; the contractual SDK remains pinned at 0.4.104.
Final test and check logs are retained in the evidence directory, with trailing whitespace removed from test-runner formatting.
The YAML dependency's exact ISC notice is retained in [third-party/yaml/LICENSE](../../third-party/yaml/LICENSE).

The independent Astra read-only audit reconstructed five afk pages, 28 configuration pages and three diagnostic pages exactly, and rejected another captain's cursor.
That supports transport correctness; it does not establish model reporting compliance.

The same audit confirmed three separate public dispatch defects: accepted task tails shorten silently, worker CLI callers can enter supervisor dispatch, and secondmate routing loses child intake fields.
They remain tracked follow-up work under the existing repair scope, after this committed slice.
Related intent/specification attribution and inactive optional methods need a separately scoped native-ownership design; this correction does not activate them.
