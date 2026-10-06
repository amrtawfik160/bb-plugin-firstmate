# Captain role persistence and bounded native contract transport

Status: implemented in the isolated implementation checkout. Production and the
incident thread are untouched. Fresh multi-turn ACP model acceptance remains
parent-owned and pending. Text equality does not prove model behavior.

## Incident and cause

Read-only evidence: `/tmp/firstmate-ehfwkgziyt.json`, event sequences 151,
2229, 2238 and 2901. Event 151 records Grok's explicit 19.5 KB preview of a
66.2 KB Firstmate contract, cut inside section 7. Native delegation and the
concrete-operation exception were visible. Truncation therefore explains missing
intake/delivery/catalog context, but does **not** independently explain the
supervisor's project writes. No incident work, branch, files or execution settings
were changed for this repair.

The retained Grok session at
`/root/.grok/sessions/%2Froot%2F.bb-server%2Fplugins%2Fenvironment-personal-workspace%2Fhost-data%2Fworkspaces%2Fthr_ehfwkgziyt/01a10d05-2f63-7fa1-9b85-f4ae9e2425cc/`
has one ordinary-thread availability pointer in `chat_history.jsonl`, and zero
bound-captain bootstrap pointers. All three observed turns use that provider
session identity. `system_prompt.txt` includes provider guidance to start
subagents when explicitly requested. It contains no observed blanket prohibition
on native BB child-thread dispatch, nor a bound Firstmate role. This inspection
covers the saved public/provider evidence; it does not claim visibility into
unrecorded provider instructions or explain every model decision.

SDK 0.4.104's `PluginAgents.configure` and `contributeInstructions` explicitly
retain constructed instructions in a live provider session. Captain metadata
binding does not hot-replace them. `PluginAgentToolRegistrationBase.instructions`
is the supported usage surface appended when its tool is selected. The deck tool
is already selected in the ordinary cold-entry session; its conditional native
role can therefore persist after binding and on subsequent turns. The previous
deck registration supplied no such usage instructions.

## Change and boundary

| Requirement | Implementation and evidence |
| --- | --- |
| Complete bounded contract delivery | `lib/contract-transport.ts` splits UTF-8 at 8,000 payload bytes; normal registered tool results fit below the observed 19,500-byte preview. Header includes the next concrete call before the body. Native bytes, complete trigger frontmatter and BB adaptations reconstruct exactly. |
| Read protocol, not false readiness | Start `firstmate_contract {}` then follow every returned cursor until the end marker. CLI equivalent: `bb firstmate contract --paged`, then `bb firstmate contract --cursor <cursor>`. Default operator CLI remains complete in one response. No page alone asserts complete reading or comprehension. |
| Scope, reload and source changes | Stateless cursor pins text, section, owning captain, home, host, selected root and audited commit. Repeat a lost response or resume after factory reload. Changed source/selection or another captain refuses; restart without cursor. Cursor progress is not an acknowledgement or native mutation. |
| Persistent native supervisor identity | `lib/captain-role.ts` provides the exact native section 1 excerpt through the cold-entry deck tool's public `instructions` field. Tests byte-check it against both audited pins, including all five hard rules and the concrete-operation exception. Conditional activation follows explicit supervisor invocation and deck binding. |
| Worker and conversational exclusion | Ship/scout identity wins; worker configuration selects no deck tool or captain skills. Before binding the conditional supervisor role is inactive. Native delegation exceptions remain verbatim; conversational/setup actions do not acquire a new worker mandate. |
| Execution selection | Project-task provider/model/effort belongs to worker intake. Supervisor selection changes only on an explicit supervisor-thread change request. This patch changes no catalog resolution, execution settings, existing worker, or task contract. |
| Native policy default | No method skills, added reviewer, merge authority, blanket write ban or competing instruction corpus. Selected native contract/catalog, delivery gates, inbox and browser transport remain authoritative. Native source and runtime asset bytes are unchanged. |

`docs/verification/native-transport-allowlist.v1.json` records the new usage bytes
and bounded-read pointer with the transport reason. The static native role
excerpt is identical in the only two supported revisions, `2d833ff147cd26a5c461e914e06854e0eb2707ce`
and `1f3e769616fdf9f31f85f4c3e6a9f71606634238`. It is not a fallback to a different
native policy revision. Unknown/changed selected native policy still refuses.

## Validation

Focused checks:

```sh
node --test --experimental-strip-types lib/contract-transport.test.mjs server.native-policy.test.mjs
node --test --experimental-strip-types --test-name-pattern='native captain contract tool|captain skill|firstmate entry|native contract' server.test.ts
npx tsc --noEmit
npm run fidelity
bb plugin build .
git diff --check
```

The first command passed 17 tests, zero failures/skips, including both disposable
real native revisions with actual registered CLI/tool reads, UTF-8 reassembly,
complete selected trigger inventories, cross-captain refusal, and factory reload
continuation. The second passed 2 tests, zero failures/skips. Evidence:
`/tmp/fm-captain-role-targeted.log`, `/tmp/fm-captain-contract-factory.log`.
Typecheck, fidelity and build passed. Fidelity checked 33 skills, 12 divergence
anchors and 7 authorized fences. Build reports the existing SDK 0.4.104 versus
installed BB SDK 0.5.29 warning; no dependency upgrade was made.

The persistent usage snippet measures 3,739 characters (SDK limit: 4,096).
A synthetic maximum 200-character non-ASCII section yields a 10,167-byte page
including continuation header, below the 19,500-byte preview check.

Causal mutations (each restored immediately):

1. Remove `instructions: CAPTAIN_ROLE_INSTRUCTIONS` from deck registration.
   `cold-entry tool instructions ...` fails through actual SDK role resolution.
   Evidence: `/tmp/fm-captain-role-mutation-role.log` (exit 1).
2. Change the MCP contract caller's paging argument from `true` to `false`.
   `native captain contract tool pages ...` fails at the actual registered
   factory's 19,500-byte preview boundary, before lossless source assertions.
   Evidence: `/tmp/fm-captain-role-mutation-pages.log` (exit 1).
3. Restore the narrower 600-character cursor decoder limit.
   The lossless UTF-8 test fails on a valid 200-character non-ASCII section.
   Evidence: `/tmp/fm-captain-role-mutation-unicode.log` (exit 1); restored check
   passes 1 test in `/tmp/fm-captain-role-unicode-final.log`.

Full native-fixture suite command:

```sh
env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION \
-u BB_THREAD_ID -u BB_PROJECT_ID -u BB_ENVIRONMENT_ID -u BB_HOST_ID \
-u BB_SERVER_URL -u BB_HOST_DAEMON_PORT -u BB_DATA_DIR \
HOME=/root SHELL=/bin/bash \
PATH=/root/.local/bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin \
FM_TEST_HOME=/tmp/fm-crew-state-native-yq_lrbsn/home \
FIRSTMATE_TEST_NATIVE=/tmp/fm-crew-state-native-yq_lrbsn/home \
FM_SCOUT_NATIVE_BIN=/tmp/fm-crew-state-native-yq_lrbsn/home/bin-bb \
FM_CLASSIFY_LIB=/tmp/fm-crew-state-native-yq_lrbsn/home/bin/fm-classify-lib.sh \
/usr/bin/npm test
```

Full suite result: **826 passed, zero failures and zero skips**, 194,544.7 ms.
Log `/tmp/fm-captain-role-full.log` (final code, including non-ASCII cursor bounds).
Registered help/role checks also passed 2 tests in
`/tmp/fm-captain-role-final-focused.log`.
The fixture is task-owned. Actual native policy/helper reads are real; BB worker
transport is fake and no model or product task launches in these tests. The full
suite includes actual installed BB package discovery on owned servers; this does
not establish fresh ACP model behavior.

## Parent acceptance and refresh

1. Install the reviewed candidate only in the parent's isolated BB acceptance
   environment. Preserve the explicitly selected ACP provider/model/effort.
2. Start a **fresh** root provider session. Invoke supervisor/Telegram setup;
   verify every contract page, end marker, selected trigger inventory, native
   startup digest and exact bound home. Existing setup routing uses the current
   thread and preserves its selection; do not bind production Telegram.
3. In a separate later user turn, request a small disposable product change with
   an explicit worker provider/model/effort and agreed delivery requirement.
   Do not authorize the captain itself to edit that project.
4. Observe exactly one native worker before any supervisor product writes;
   verify real spawn success and no fallback. Confirm the worker's actual
   settings, unchanged supervisor settings, worker tool exclusion, native done
   gate, exact artifact/PR identity and agreed delivery behavior. No generic
   additional PR question should replace already-authorized implementation.
5. Record actual ACP tool byte lengths and all cursor reads. Preserve negative
   evidence: no supervisor product writes, no task-model application to captain,
   no additional method or reviewer. Report observed behavior separately from
   text-composition checks.

For established live captains, plugin reload/metadata binding alone does not
retroactively replace provider instructions. Parent must coordinate a safe
provider-session reconstruction if desired. `bb thread stop <captain>` is the
supported command that releases its loaded runtime; a later ordinary follow-up
constructs the session without selecting a new model. Do not stop a busy captain
or resume work automatically. Workers and saved product work remain intact;
read the complete paged native contract after reconstruction. This repair does
not stop/refresh any existing session itself.

The external user-owned Telegram skill source is outside this checkout and was
read only. Its setup already preserves the current captain. Its final model-change
sentence is ambiguous about task versus supervisor changes; parent may clarify
that source during coordinated integration: “If the user explicitly requests a
change to this supervisor thread's execution settings, use supported BB thread
settings and verify it. A model named for a project task belongs to Firstmate
worker intake.” No live skill file or connector setting was edited here.

Large `firstmate_skill` reference documents still use the existing complete-file
transport; this patch bounds the required contract/catalog read only. A preview
of another document still requires reading its saved remainder under native
instructions. No server-side text protocol guarantees model comprehension or
compliance. Fresh ACP multi-turn acceptance is required before claiming the
reported supervisor behavior fixed in a live model.
