# Installation-selected methods and PR-body reader, 2026-10-05

Implementation baseline: `71e4bb3`. Parent approved this bounded composition after the public dispatch preservation fixes.
Native policy, task/role/execution settings, direct-PR/no-mistakes/local-only gates and reporting ownership remain unchanged.
No production activation, installation setting change, shared pipeline change, model launch or forge mutation occurred during implementation.

**Open limits:** actual model use of methods and `/pr` remains parent acceptance. External no-mistakes author loading/enforcement of `/pr` is unresolved. Every-message reporting failed actual ACP acceptance; the final-outcome pass does not close that failure.

## Requirements and evidence

| Requirement | Implementation | Observed proof | Limit |
|---|---|---|---|
| Explicit durable installation selection; native defaults off | Existing SDK settings `selectedMethods` and actor/time/reason. Shared public role guard excludes worker enable/disable, including mixed captain/worker flags. | Public CLI status/enable/disable; reload; another captain/home inherits selection without another opt-in. Default-off and role-reference causal mutations fail. | An explicit reason records the caller's stated user direction; it is not independently inferred authority. Direct setting changes remain the normal operator settings surface. |
| Role-owned selected trigger routing | `lib/selected-methods.ts`, ten existing BB-owned files pinned by `lib/method-assets.ts`; bounded `firstmate_methods` reader reuses skill transport. No raw method/native skill registration. | Real registered SDK configuration, role reads, foreign-role/traversal refusal and byte-exact references; hash mutation fails. Installed BB packages contain matching ten-file inventory with both official launchers. | Instruction/read delivery is not proof a model selected the right method. |
| Remove competing reporting ownership | Captain router no longer points to Calm; worker router and product verification return scope questions through the native manager channel. | Public composed instructions and method reads contain no Calm policy or direct worker-to-captain instruction. Native section 9 remains complete. | Calm/catch-up sources stay unregistered and inactive. No new reporting owner. |
| Preserve selected native sources and modes | Selected methods remain a separate BB namespace. Native contract/catalog/renderer bytes are not edited. | Actual native scripts at both audited pins compose ship direct-PR/no-mistakes/local-only and scout guidance. Source task/spec exact; isolation, exact inbox IDs, completion/merge gates remain. Default transport allowlist stays unchanged. | Script/configuration proof only, no new model launch. |
| Direct-PR author `/pr` read | Resolve exact worker project/environment using public SDK `threads.get`, `skills.list`, `skills.getContent`. Use actual provider-specific/neutral `pr` candidates; accept multiple copies only after complete byte equality. Explicit selection stores validated ID/revision/content hash and ignores unselected conflicting copies without reading them. Return its complete API content through bounded pages; pin owner/home/environment/skill ID/revision/content. Abort-aware reads. | Public author tests validate exact workspace request arguments, full synthetic installed-skill reconstruction, provider/copy equivalence, explicit source reload, changed-revision/wrong-owner refusal, missing/unreadable/differently named source refusal. Lookup disposal test settles a never-returning SDK read. Causal trigger/revision/owner/cancellation mutations fail. | Dependency content in unit tests is an SDK fixture, not a bundled `/pr` copy or live model read. Real operator API discovery/read is recorded below; it does not establish worker model use. Parent actual body-author acceptance pending. |
| Preserve replacement/work/task/authority | Installation setting feeds the supported role configuration of initial and replacement metadata; no task brief or execution selection rewrite. | Eight actual native rebind cases across both pins preserve source brief/status, task, environment, dirty work, branch/HEAD/refs, original mode/requirement and native metadata. New replacement receives only worker methods; `/pr` pointer only ship/direct-PR. | No real replacement model turns during implementation. |
| External pipeline `/pr` boundary | No caller intent rewriting or parallel PR creator. Supported external template path documented below. | Exact installed v1.79.0 CLI help and upstream tag source inspected. | **Unresolved:** template narrative is not skill loading or verified author-read enforcement. No template or daemon was changed. |
| Reporting acceptance honesty | Existing receipt/cue correction preserved. No further wording patch or output filtering. | Parent final message passes findings/limits/decision; actual intermediate response still leaks receipt mechanics. Supported trace inspection below. | Failed all-message model acceptance remains open; no established provider cause. |

## One-time supported selection and reads

After parent integration/reload, from the owning **bound captain** context:

```sh
bb firstmate methods status --json
bb firstmate methods enable selected-v1 --reason 'User selected existing Pstack methods and /pr' --pr-skill <verified-workspace-pr-id>
bb firstmate methods read captain-methods --paged
bb firstmate methods read captain-methods references/coverage.md --paged
```

`firstmate_methods` equivalents use `action=status|enable|disable|read`, `profile=selected-v1`, optional `prSkillId=<verified-pr-id>`, and the same explicit reason. An explicit resource selection must be named `pr`, available in that captain workspace and completely readable through the public SDK before settings publication. Body reads revalidate worker workspace availability, exact ID, selected revision and content hash; changed/unavailable sources remain pending, never fall back. An explicit reselection with its reason validates a changed skill. Failed selection leaves prior settings intact.
Tools are always bounded. Operator CLI without `--paged` returns complete content.
For every agent read, follow `firstmate_methods {"action":"read","cursor":"…"}` or `bb firstmate methods read --cursor <cursor>` through `END OF BB METHODS TRANSPORT`.
Do not mix changed snapshots. Native `firstmate_skill`/catalog reads remain separate and mandatory where native policy requires them.

| Selected existing branch | Intended role | Resource |
|---|---|---|
| Assignment, handoff and completion coverage | Captain | `captain-methods/references/coverage.md` |
| Consequential decision trail | Captain or assigned worker | Its role's `references/decision-trail.md` |
| Scoped explanation, design or independent review | Captain allocation; assigned worker execution | Its role's `references/research-design-review.md` |
| Explicitly requested history/reflection/preferences | Captain | `captain-methods/references/requested-review.md` |
| Consequential behavior/shared-state/retry/migration proof | Assigned worker | `worker-methods/references/proof.md` |
| Changed journey verification; full verification-skill creation/upkeep only if assigned | Assigned worker | `worker-methods/references/product-verification.md` |
| Actual direct-PR ship body creation/update | Body-writing worker | `name=pr`, resolved from that workspace's BB skill inventory |

These adaptations retain existing Pstack source attribution at `e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a`. No new method corpus, reviewer count, model choice, merge relaxation or reporting policy is introduced.
The profile applies to new captains and workers/replacements under this plugin installation. Existing running model contexts need their normal parent-owned refresh; selection does not restart or send to them.
Disable explicitly with `bb firstmate methods disable --reason <reason>`; pending native work and task contracts are untouched. No external home/runtime migration is needed.

## Actual operator PR discovery: correction and limitation

Read-only `bb skill list --json` in the CLI default personal workspace listed three provider-user `pr` entries tagged claude-code, codex and pi. No project/environment selectors were set; this is **not** a worker workspace read.
Local hashes of the three paths matched, but that did not establish API readability. The initial progress message incorrectly called those hashes successful public reads and stated 2452 bytes; both claims were withdrawn promptly. Correct size is **4169 bytes per copy**.
Actual `bb skill show <claude-copy-id> --json --path SKILL.md` refused with HTTP 502/invalid_path because the skill root is a symlink. That refusal is preserved.
Actual public `bb skill show <codex-copy-id> --json` successfully returned all 4169 bytes with SHA-256/revision `ab63f1cf78647389edcd386c9427c5dfca27ed2836930c24773ffee834c19bcd`.
Sanitized exact identities/results are in [operator-pr-read-summary.json](selected-methods-20261005-evidence/operator-pr-read-summary.json); no full global inventory or skill body was committed.

This discovery drove a public RED→GREEN for provider-specific/byte-equivalent copies, then a separate RED→GREEN for explicit readable source selection across reload and unreadable aliases. The latter is the supported remedy for this installation: parent chooses the verified requested `pr` ID in the activation captain's actual workspace through `--pr-skill`. The reader does not follow a symlink through a filesystem fallback or guess a global path. If no explicit selection exists, provider-compatible/neutral copies are considered; cross-provider copies for ACP require successful full API reads and exact byte equality. Different or unreadable copies refuse. At most eight candidates are read; larger ambiguous inventories explicitly refuse without truncating any skill.
Actual worker `/pr` acceptance remains parent-owned and pending. Local hashes, operator reads and fixture reconstruction do not substitute for it.

## External no-mistakes author: exact supported path and missing capability

Installed `no-mistakes --version` is v1.79.0. `axi run --help` provides no general skill/instruction-file propagation argument; the driving agent is not the pipeline PR author.
Native `fm-dod-lib.sh` keeps `--intent` captain-goals-only and owns the pipeline allocation. Appending method or `/pr` directives there would misattribute instructions as user intent.

At the exact [v1.79.0 configuration source](https://github.com/kunchenguid/no-mistakes/blob/v1.79.0/internal/config/config.go), the supported repository key is:

```yaml
pr:
  template: docs/pr-narrative.md
```

This is trusted-default-branch publication configuration, not an installation-wide author skill setting.
[The v1.79.0 PR template loader/drafter](https://github.com/kunchenguid/no-mistakes/blob/v1.79.0/internal/pipeline/steps/pr_template.go) reads a regular Git blob at the pinned trusted configuration SHA, refuses symlinks/submodules, permits 1–16384 bytes and passes the template into the actual drafting `RunAgentContext` prompt. Its structural validation preserves H1 headings; lower-level instructions are best effort. Code still owns intent/risk/testing/pipeline appendices.
Source inspection proves this route exists, not that an external author used it in this installation.

**The template does not satisfy loading `/pr`.** Do not substitute it silently or change templates in this assignment.
Smallest missing supported capability: the pipeline PR author needs a configured, trusted skill-read step for the actual installed `/pr` resource, with source/revision and complete-read evidence before its body write; a missing skill must be surfaced at that author boundary. A scoped upstream author hook or supported skill injection can supply it without changing native `--intent` or skipping pipeline steps. Parent must coordinate that external integration and prove the emitted author prompt/read in an owned fixture. Firstmate cannot enforce this by changing its calling worker's text. Local-only delivery remains available and unchanged.

## Reporting trace and unresolved model acceptance

Parent frozen `e0d6247` actual ACP Grok 4.7/high acceptance injected a native record during first reasoning event 1856, before response 1988. Response 1988 narrated pending-report handling. Wake read 1990 and acknowledgement 1995 handled the real receipt; queue emptied, receipt removed, and final 2098 retained both findings and limitations.
Evidence: parent `/root/firstmate-bb-homes/thr_jm4qnewqmf/data/acceptance-e0d6247/{acceptance.md,report-events.json,report-result.json,injection.json}`.
The earlier late-injection run is explicitly invalid and excluded.

Smallest supported read-only trace is `bb thread log <exact-owned-test-thread> --json --after-seq <sequence> --limit <count>`. Public completed-message/tool events show the behavior but not the model's actual Stop-result/preamble composition. `bb thread context` exposes usage, not a prompt transcript. `bb diagnostics` is CLI error tallying. Installed `provider-acp` public RPC methods are only `provider-usage.v1.getResource` and `provider-usage.v1.listResources`; SDK 0.4.104 has no hook-context trace API.
Therefore competing provider instructions and precise hook delivery are unobserved, not proved causal. Smallest next change is provider-owned opt-in exact-thread hook-context observability for a parent-owned fixture. No hidden provider filesystem scan, output rewrite, autoack or further wording-only loop was used.

## Validation commands and causal proof

Public REDs were captured **before** their implementations: missing `methods` command, then missing direct-PR `/pr` trigger/read. Each became GREEN. Subsequent real operator discovery added two further public RED→GREEN slices for provider copies and explicit source selection. Evidence is stored in [the evidence directory](selected-methods-20261005-evidence/).

```sh
node --test --experimental-strip-types server.methods.test.mjs
node --test --experimental-strip-types --test-name-pattern='native policy and complete contract through' server.native-policy.test.mjs
node --test --experimental-strip-types --test-name-pattern='real native.*preserves branch/work/contract' server.explicit-execution.test.mjs
env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION \
  node --test --experimental-strip-types scripts/plugin-package-discovery.test.mjs
python3 docs/verification/selected-methods-20261005-evidence/causal-mutations.py
npx tsc --noEmit
npm run fidelity -- --native /tmp/fm-prompt-fixture-diRWgF
npm run runtime:verify
env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION \
  node scripts/ci-tools/node_modules/bb-app/host-daemon/dist/bb plugin build .
git diff --check
```

Observed focused results: methods 10/10 (includes read cancellation and actual-discovery regressions); native initial composition 2/2 across both pins, each exercising four roles/modes; native replacement 8/8; owned installed package 3/3. Zero failures/skips. Thirteen causal mutations die: default-on injection, foreign role reference, changed asset hash, removed direct-PR trigger, removed revision pin, removed owner pin, removed abort racing, removed activity folding, removed provider applicability/equivalence, removed explicit ID use, removed explicit revision/hash pin and removed requested-name validation. The last mutation is bounded by the public test's disposal deadline; valid messages/state are not acknowledged or written.

Full-suite command (owned native fixture; real model routing cleared):

```sh
env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION \
  -u BB_THREAD_ID -u BB_PROJECT_ID -u BB_ENVIRONMENT_ID -u BB_HOST_ID \
  -u BB_SERVER_URL -u BB_HOST_DAEMON_PORT -u BB_DATA_DIR \
  FM_TEST_HOME=/tmp/fm-prompt-fixture-diRWgF \
  FIRSTMATE_TEST_NATIVE=/tmp/fm-prompt-fixture-diRWgF \
  FM_SCOUT_NATIVE_BIN=/tmp/fm-prompt-fixture-diRWgF/bin-bb \
  FM_CLASSIFY_LIB=/tmp/fm-prompt-fixture-diRWgF/bin/fm-classify-lib.sh npm test
```

The first integration run found one stale default-tool inventory expectation and missing activity folding for the opt-in reader. The default inventory now explicitly excludes only `firstmate_methods`; all native tools remain required. Reader activity uses existing routine/attention markers and folding, so failures retain visibility. Those two tests passed after correction. The final full-suite result is recorded below after completion. BB build uses CLI 0.44.0; SDK pin remains 0.4.104. The CLI's packaged SDK comparison prints 0.5.29, but the build passed without changing this repository's SDK pin.
All checks preserve installed production homes, both native checkouts, task/PR records and parent acceptance fixtures.

Final settled integration: **860/860 passed, zero failures/skips, 190.831 seconds**.
Typecheck, fidelity (33 skills/12 divergence anchors/7 BB-only fences), bundled runtime integrity, BB 0.44.0 build and diff check passed.
The ten public methods cases, two native initial-composition cases, eight native replacement cases and three actual package cases are included in this full run.
Thirteen causal mutations were independently killed and restored before the final run.
See `selected-methods-20261005-evidence/full-final.log` and `validation-summary.json`.
This is source/adapter/script/loader proof, not fresh worker/model acceptance or production activation.
