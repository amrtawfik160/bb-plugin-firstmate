# Native BB worker-state reconciliation correction

Baseline: `c7ca7b9`. Parent actual-model acceptance evidence: `/tmp/fm-ca5-events.json`, command-execution items `dac18eb9ef-i68` and `dac18eb9ef-i69`. The native-policy scout and ship had durable native done records and exact artifacts. Both `bb firstmate fm crew-state -- <task-id>` calls nevertheless returned `state: unknown · source: pane · harness state unavailable (unknown missing)`.

## Cause and bounded adaptation

Argument forwarding is correct: the registered CLI forwards the exact task ID to the installed native `fm-crew-state.sh`, which resolves `backend=bb` and `harness=bb` from native metadata. The native reader delegates semantic turn state to `fm-busy-lib.sh`. The prior BB overlay accepted only a **busy** BB verdict; it discarded **idle** because its original herdr transport rule treated native idle as generation state. BB core thread lifecycle covers the whole turn, including foreground tools. Discarding its settled verdict prevented the reader from reaching its native status-log and ship DoD checks.

Both exact audited patch sets now add an explicitly marked BB transport branch only for `backend: harness = bb:bb`. A valid busy verdict reads `working`; a valid idle verdict permits the existing native status/DoD reader. Unknown execution remains unknown. Native malformed/stale record rejection runs before this branch. Other harnesses retain their upstream classification. No done line is written and no completion, merge or review gate is replaced.

[The BB activity transport](../../overlay/bin/backends/bb.sh) validates snapshot version/type, exact thread identity, runtime status, execution status and interaction count before permitting idle. Host disconnection/provisioning/stopping and queued/starting execution remain unknown, even when an interaction exists. Runtime statuses come from SDK 0.4.104's public thread runtime schema. Existing compatibility execution aliases remain supported. Incomplete or malformed evidence cannot license status-log reconciliation.

Native source, skill bytes, task text, delivery mode/requirement, provider/model/effort, branch, worker identity and authority are unchanged. The generated release includes the same native snapshot plus the matching adapters: release `8af1c9c31bb3d1520e7d7ebd5ed8cbadcf66797d5e025cedefb2327a6bf7dece`, adapter revision `999e0c6438c04b3347157ac91b472ca3067e72859f31f29befbe94709a0146bf`, archive 2666957 bytes. Native upstream remains `1f3e769616fdf9f31f85f4c3e6a9f71606634238`; external old pin `2d833ff147cd26a5c461e914e06854e0eb2707ce` retains its audited exact patch set and loader loop.

## Evidence

[Registered CLI/tool regression](../../server.native-crew-state.test.mjs) uses disposable real native clones on both audited pins and owned Git worktrees. The public SDK test host supplies the actual registered `activity` response; a fake BB transport supplies only that response to the real installed native scripts. Registered `fm crew-state -- owned` and `firstmate_fm` run the real host command and native reader. No model launch or forge mutation occurs.

| Requirement | Observed assertion |
| --- | --- |
| Settled scout | Exact native done/report declaration reads done; report bytes remain intact |
| Settled ship, three modes | direct-PR, no-mistakes and local-only reach native status/DoD rather than unknown-missing |
| Still working | Active BB turn supersedes an older done event |
| Unavailable host / invalid record | Unknown remains unknown; malformed native busy record cannot fall through |
| Native ship gate | A new unpublished worktree commit is blocked as unreachable outside the worker copy |
| Independent task verdict | Idle plus native blocked declaration remains blocked |
| Preservation | Every CLI read preserves metadata/status bytes, branch and HEAD; report intact; all terminals closed |
| No worker operations | Zero SDK spawns/sends; transport log contains only exact-worker activity reads |

```sh
FIRSTMATE_TEST_NATIVE=/tmp/fm-prompt-fixture-hGuT6L node --test --experimental-strip-types \
  server.native-crew-state.test.mjs lib/bb-activity.test.ts \
  scripts/native-compat.test.mjs scripts/native-runtime.test.mjs
FIRSTMATE_TEST_NATIVE=/tmp/fm-prompt-fixture-hGuT6L node scripts/bb-crew-state-mutation.mjs
npx tsc --noEmit
npm run fidelity
npm run runtime:verify
bb plugin build .
git diff --check
```

Affected results: **33/33 passed**, zero failures/skips, 60353 ms. Two causal mutations are killed in private copies: restoring busy-only classification fails registered native reconciliation on **both** audited pins; restoring permissive activity parsing fails the malformed idle-evidence regression. Typecheck, fidelity, reproducible runtime verification and build pass. The existing CLI/SDK build warning remains; neither version was changed.

Logs: `/tmp/fm-crew-state-{affected,mutations,package,tsc,fidelity,runtime-verify,build}.log`.

The initial full run passed 821/822 tests; the local-merge fixture linked an older disposable `bin-bb`. The stale-payload guard correctly refused its old adapter. A new owned clone `/tmp/fm-crew-state-native-yq_lrbsn/home` was checked out at the audited newer pin and installed with the current overlay. The previous fixture and all production/parent homes were left untouched. Final full-suite command:

```sh
env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION \
  -u BB_THREAD_ID -u BB_PROJECT_ID -u BB_ENVIRONMENT_ID -u BB_HOST_ID \
  -u BB_SERVER_URL -u BB_HOST_DAEMON_PORT -u BB_DATA_DIR \
  HOME=/root SHELL=/bin/bash PATH=/root/.local/bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin \
  FM_TEST_HOME=/tmp/fm-crew-state-native-yq_lrbsn/home \
  FIRSTMATE_TEST_NATIVE=/tmp/fm-crew-state-native-yq_lrbsn/home \
  FM_SCOUT_NATIVE_BIN=/tmp/fm-crew-state-native-yq_lrbsn/home/bin-bb \
  FM_CLASSIFY_LIB=/tmp/fm-crew-state-native-yq_lrbsn/home/bin/fm-classify-lib.sh \
  /usr/bin/npm test
```

Final result: **822/822 passed**, zero failures/skips, 182825 ms. This includes both actual installed-BB entrypoint discovery tests, native guarded local merge/hold integration, and the new registered native crew-state reads. Initial log: `/tmp/fm-crew-state-full.log`. Final log: `/tmp/fm-crew-state-full-final.log`.

## Refresh and limits

Parent owns integration and activation. External audited homes can refresh their mirror through the existing owning-captain deck/installer path. Bundled homes continue selecting their immutable existing release after reload. The regenerated release is available for new homes or an explicit guarded selection once native task/runtime-consumer checks permit it. Do not replace files in an existing selected release or erase retained metadata to force an upgrade. This correction does not auto-migrate homes, restart a worker or change task contracts.

The separate `bb firstmate scout-report <id>` command reads the plugin's owned promotion-artifact register. A scout launched directly through native `fm spawn` can have a native report without an entry in that register. The supported native read is the exact bound home's `data/<task-id>/report.md`, as declared by the scout brief and done record. For example, after confirming the bound home from deck, read `<bound-home>/data/native-policy-scout/report.md` through the captain's host shell. No report is inferred from an arbitrary URL or another home. Registration/discovery expansion is outside this bounded state fix.

Parent observed real model launch/completion before this correction. The disposable proofs here run real native read paths using a fake BB activity transport; they do **not** claim fresh-model behavior or actual live reconciliation after the fix. Parent must verify that final live read and safe runtime selection independently. No production home, worker, parent acceptance server or task was touched.
