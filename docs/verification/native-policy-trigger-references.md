# Native trigger catalog and reference correction

Review baseline: `afc1483718d9b77372d764a629b0bd52ecd1f861`. This correction addresses both blocking parent findings. No production installation, home change, native upgrade, worker launch, forge mutation or delegation occurred.

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Complete native trigger index before orchestration | [Required captain bootstrap](../../skills/captain/SKILL.md) and dynamic configuration require the full `firstmate_contract` read. [Contract reader](../../server.ts) appends the complete selected-root catalog; missing, modified or unknown native files refuse completion. | Registered CLI/tool configuration and actual contract composition at both audited pins. Every tracked native `SKILL.md` has its complete original frontmatter and file SHA-256 in the result. |
| Accurate multiline descriptions, no premature bodies | [Reader](../../lib/native-policy.ts) returns verbatim frontmatter, including YAML folded/literal description syntax and all continuation lines. There is no lossy YAML summary parser. | Full frontmatter comparison for every tracked skill. Maintenance-only `agent-skill-trigger-index` description remains part of the index; its body is absent. No global mixed-version manifest fallback. |
| Selected-home isolation | Catalog and native contract share the same exact selected root. Git verifies every original file, the audited upstream identity and the contract hash before the result is called complete. | An unbound captain refuses the global policy root even in compatibility mode. Two captains select different audited pins. Each receives its own complete index; corruption in one refuses that captain's contract without affecting the other. Bundled snapshot coverage also passes. |
| Native relative reference links | `firstmate_skill(name, reference, source?)`; CLI `bb firstmate skill <name> [relative-reference] [--source <selected-root source-file>]`. Default base is `.agents/skills/<name>/SKILL.md`. Nested links use the exact selected-root source file printed by the previous read. | Real stuck-recovery links to configuration and agent-control; actual nested Codex harness link to supervision-host, at both pins. Fragment-only links return the complete source document. |
| Confinement and immutable bytes | Normalize relative paths inside the selected root; verify source and target against Git; reject escaping paths, absolute/URL paths, symlink files/ancestors and modified bytes. Fragments identify the link without shortening the document. | Invalid paths refuse before host execution. Symlinked source/target, changed source/target, unknown HEAD and missing resources refuse. SDK transfer hash and actual byte count detect truncation or mutation. |
| Complete document transport and bounded command | Stage the plugin-owned Python reader through `writeHostBytes`, execute a short structured host command, and remove the helper in `finally`. Host verification returns document identity/hash/size; SDK `files.read` transfers the full document. | All actual wrapped fixture commands remain within 10000 bytes. Staging failure does not read a target or claim completed inventory. All created terminals close; no worker spawn/send calls. |

## SDK boundary

SDK 0.4.104 accepts static skill names, without a verified per-home skill-root mapping. Registering copied native skill bodies/descriptions globally would silently mix native revisions. The mandatory bootstrap/contract read is therefore the explicit BB transport adaptation for native AGENTS sections 9 and 13: it loads the selected runtime's full trigger catalog before orchestration; bodies load only at their native trigger through `firstmate_skill`. Read the complete contract/catalog again after compaction if absent from context. This does not force-load the maintenance-only index skill or change native trigger wording. It does not prove identical model behavior.

Both supported native revisions have 28 tracked skill entry files. Verbatim frontmatter totals 13515 bytes at `2d833ff1` and 13469 bytes at `1f3e7696`. Their catalog entry JSON totals 17974 bytes and 17927 bytes, respectively, before the root/identity envelope. The tracked `firstmate-calm` link points to the native presentation mod, which has no `SKILL.md` entry. It is not a skill trigger entry; no symlink or global target is followed.

Native configuration documents are 219005 bytes and 223059 bytes, respectively. The new complete skill/reference bound is 2097152 bytes (2 MiB) per file, with refusal rather than truncation. Contract reads retain the existing 200000-byte bound. Large documents do not cross the PTY JSON envelope; their actual file API content is matched against the host-verified hash and size.

## Validation

Disposable native source: `/tmp/fm-prompt-fixture-hGuT6L`; tests clone private homes and remove only those owned homes. Public SDK factory/registered CLI/tool paths run the actual staged Python reader and Git validation. BB calls in fixtures are isolated/fake; no real model or live home is used.

```sh
FIRSTMATE_TEST_NATIVE=/tmp/fm-prompt-fixture-hGuT6L node --test --experimental-strip-types server.native-policy.test.mjs server.methods.test.mjs server.captain-startup.test.mjs
FIRSTMATE_TEST_NATIVE=/tmp/fm-prompt-fixture-hGuT6L node --test --experimental-strip-types --test-name-pattern='native captain contract tool returns' server.test.ts
FIRSTMATE_TEST_NATIVE=/tmp/fm-prompt-fixture-hGuT6L node scripts/native-policy-trigger-mutations.mjs
npx tsc --noEmit
FM_TEST_HOME=/tmp/fm-prompt-fixture-hGuT6L FIRSTMATE_TEST_NATIVE=/tmp/fm-prompt-fixture-hGuT6L FM_SCOUT_NATIVE_BIN=/tmp/fm-prompt-fixture-hGuT6L/bin-bb FM_CLASSIFY_LIB=/tmp/fm-prompt-fixture-hGuT6L/bin/fm-classify-lib.sh npm run fidelity
bb plugin build .
git diff --check
```

Results: focused native-policy/method/startup tests 30/30; oversized complete-contract transport 1/1; seven causal mutations killed. Typecheck, fidelity and build pass. Fidelity verifies 33 skills, 12 divergence anchors and 7 authorized fences. Build emits the existing SDK 0.4.104 versus CLI SDK 0.5.29 warning; no dependency pin changed. The current CLI accepts one build path; the two-path invocation refuses before build, so the validated command is `bb plugin build .`.

Logs: `/tmp/fm-trigger-references-affected.log`, `/tmp/fm-trigger-references-contract.log`, `/tmp/fm-trigger-references-mutations.log`, `/tmp/fm-trigger-references-tsc.log`, `/tmp/fm-trigger-references-fidelity.log`, `/tmp/fm-trigger-references-build.log`. Mutations restore absent catalog, multiline truncation, global HOME instead of selected runtime, unbound global fallback, rejected native `..` links, omitted source verification and accepted SDK transfer corruption. Each fails the corresponding causal assertion in a private candidate; no syntax/load failures count.

Parent owns final integration suite, fresh-model acceptance and activation. After activation, refresh the captain configuration and perform the required complete contract read. Existing external homes, selected runtime identities, task briefs, standing authority, delivery requirements and worker settings remain unchanged. Actual BB file transport/model behavior remains pending parent acceptance; fixture text/byte equality is not evidence of model behavior.
