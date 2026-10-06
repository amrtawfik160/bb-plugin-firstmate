# Dispatch preservation and role boundaries

Base: e0d6247. Parent owns live launch acceptance and activation; this implementation did not launch models or mutate production.
Independent public reproductions: parent-owned task 2a7b4cb5 report and public-dispatch-probes.json / followup-final-probes.json.

| Confirmed defect | Correction | Public proof |
|---|---|---|
| Accepted 4000-unit input lost intent/spec after 3000 units | Preserve complete accepted fields; measure the fully quoted command and stage complete script bytes through existing bounded host transport when necessary. Refuse over-limit tasks before reservation. | Actual factory tool/CLI → real native brief, resolution, backlog and guarded spawn endpoint, both audited pins. ASCII and Unicode/code-fence tails retained. |
| Worker CLI bypassed static no-tools configuration | Shared public supervisor guard checks metadata, current/prior crew identities and durable retirement/deletion before receipts, publication or spawning. | Mixed captain/worker, replacement/prior and retired identities refused; owning captain works. Actual exact-ID inbox acknowledgement and native status notification remain callable at both pins. Foreign task/home and bare legacy --ack refuse. |
| Secondmate received incomplete child selection, then its supervisor defaults replaced requested execution | Durable schema-1 routed envelope preserves task/options/posture provenance and parent permission ceiling. Recovery reuses it; response truthfully leaves child launch pending. | Public tool/CLI routing → actual native child brief at both pins; exact provider/model/effort/branch/profile/visibility/contract; reload and unknown send never resend. |
| Same task ID chose foreign child, including stop/forget | Resolve within caller ownership; refuse ambiguity/foreign identities; explicit supported owner override retains its existing authority boundary. | Parent and secondmate independently inspect same-ID route/child; parent cannot stop foreign child; forgetting parent route leaves child intact and secondmate stop works. |
| Forgetting route retired a live supervisor | Separate route retirement evidence from worker tombstones. Legacy boolean is ignored only for registered captain secondmate + exact durable route-only journal, with no worker/replacement/deletion history. | Forget then secondmate dispatch succeeds; legacy route-only evidence recovers, actual retired worker with captain flag remains refused. |

## Reproduce without model launches

```sh
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node --test --experimental-strip-types \
  --test-name-pattern='accepted dispatch intent|worker CLI exact inbox|secondmate public dispatch' \
  server.native-policy.test.mjs
node --test --experimental-strip-types \
  --test-name-pattern='registered supervisor tool and CLI mutations|routed child intake|unknown secondmate send|same-id secondmate|route-only retirement' \
  server.launch-delivery.test.mjs
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node --test --experimental-strip-types \
  server.launch-delivery.test.mjs server.native-policy.test.mjs
```

The first command clones only owned disposable fixtures from the audited native source. It executes real scaffold/resolve/backlog/render/guarded-spawn scripts. A fake BB executable refuses the external launch endpoint; no fallback SDK launch occurs. This proves native input/prompt preservation and guards, not a live model launch/completion.
The final affected run passed 62/62 tests, zero skips (86.703 seconds). Earlier settled focused run passed 11/11, zero skips; ownership additions passed 2/2.

Five causal reversions fail: restoring 3000-unit intent truncation loses the native brief tail; removing CLI worker guard launches a forbidden nested task; omitting routed model loses structured child selection; restoring bare-ID lookup selects the foreign child; restoring route worker tombstone prevents normal secondmate operation. Logs are retained in [evidence](dispatch-preservation-20261005-evidence/).
Native scripts, intake normalization and merge authority remain native-owned. Routing records existing posture, grants no new merge authority, and never treats a domain supervisor as its child worker. Uncertain send remains unresolved rather than guessed delivered.

## Reporting contrary evidence

Parent actual ACP Grok 4.7/high acceptance on e0d6247 injected before response completion and handled one receipt correctly. Final response kept findings/limits; intermediate message 1988 still narrated private receipt mechanics. Queue empty and receipt absent are handling evidence, not reporting compliance.
The public event transcript exposes no hook-result/provider-preamble event; it cannot establish how that provider rendered the Stop stderr or which instruction competed. The plugin emits exact native section 9 before handling and has no supported SDK control over provider-authored message text. Another cue or unit assertion cannot establish the missing model behavior. No output filtering, unseen acknowledgement or new reporting policy was added. Parent evidence: acceptance-e0d6247/acceptance.md, report-events.json, report-result.json, injection.json.

### Caller fixtures and compatibility

Older tests had no stub for the now-required public caller-role read; the SDK fake refuses unimplemented reads. The shared test factory now explicitly returns empty ordinary-thread metadata unless a case supplies its own role mapping. Three orphan/late-creation fixtures returned worker metadata for every thread, including their captain; they now associate it only with their named orphan/late worker. Assertions still require native publication unresolved and zero duplicate SDK spawn. New unreadable-role test refuses before receipt/native command/reservation, and mixed/prior/retired worker refusals remain.
Foreign inactive ownership is retained: inactivity is not takeover. The earlier test's implicit orphan merge now requires the supported explicit owner override. Explicit handoff continues to preserve a worker's original home.
Route retirement also preserves same-ID child wait/nudge records, never removes child native metadata, and cannot resurrect/resend a forgotten route. Child operations remain the secondmate's responsibility.

### Smallest supported read-only reporting trace

Installed BB CLI `bb thread log <exact-test-thread> --json --after-seq <n> --limit <count>` is the bounded raw-event trace. `bb thread context <id> --json` reports context usage, not prompt text or hook results. `bb diagnostics --help` exposes only CLI-error tally. `bb plugin rpc list provider-acp --json` advertises only provider-usage inventory/observation, no received-hook or assembled-provider-prompt operation. SDK 0.4.104's public event inventory has no provider Stop stderr/context trace.
Those public interfaces cannot establish whether a hook was masked by a higher-priority provider preamble. The supplied raw events prove narration before receipt read but contain no received-hook event. No provider-cause conclusion is made. The smallest further supported remedy is provider-owned opt-in read-only hook/context observability on the exact acceptance thread; parent can coordinate that provider boundary. Broad filesystem/session searches, output filtering and another cue rewrite were not used.

Required checks use the owned private native fixture, with BB_CLI/BB_INFERENCE/BB_INFERENCE_FALLBACK/BB_TRANSCRIPTION and all inherited BB thread/project/environment/host/server/data routing cleared. Set FM_TEST_HOME and FIRSTMATE_TEST_NATIVE to /tmp/fm-prompt-fixture-diRWgF, FM_SCOUT_NATIVE_BIN to its bin-bb, and FM_CLASSIFY_LIB to its bin/fm-classify-lib.sh. Then run npm test; npx tsc --noEmit; npm run fidelity -- --native /tmp/fm-prompt-fixture-diRWgF; npm run runtime:verify; pinned BB 0.44.0 plugin build .; git diff --check. The build keeps SDK 0.4.104 despite the CLI's informational newer-SDK notice.

Final settled required suite: **855/855 passed, zero skipped**, 183.269 seconds, [full log](dispatch-preservation-20261005-evidence/fm-dispatch-settled-full.log). Typecheck, selected-native fidelity, bundled runtime integrity, pinned CLI build and diff check passed. Final bounded identity/fixture test commands passed 6/6, 4/4 and 3/3; logs retained above. The failed initial full run (790/854) and subsequent pre-correction run were fixture diagnosis, not passing evidence; no failed run is labeled verified.
