# Bounded captain startup

Status: implementation and isolated verification complete; parent review,
integration and production activation remain pending. No production startup,
lock, worker, native home or plugin was changed. Parent-owned method changes
remain intact; worker-method refinements are outside this correction.

## Incident and diagnosis

Read-only evidence: `/tmp/captain-slow-events.json`, thread `thr_8j32bnxm3b`.
The user invoked `/captain` at 21:36:06 UTC on 2026-10-04 and interrupted at
21:48:14 UTC. The ACP Cursor agent used Grok 4.7, xhigh. It read skills but called
no Firstmate agent tools. It searched filesystem, plugin bundles and SQLite
instead of following a supported binding/contract/startup sequence.

| Evidence | Observed behavior |
| --- | --- |
| Events 158 / 161 | `bb firstmate deck --json 2>&1` started at 21:40:01 and was presented as completed at 21:40:32. Output contained only BB's removed `BB_INFERENCE_FALLBACK` warning, no deck JSON. |
| Event 182 | A subsequent process snapshot still showed the deck CLI process. The per-thread home existed. A shared-home bearings process was also present. |
| Event 517 | The agent guessed `/root/firstmate` and ran native session-start there. Native returned exit zero with `STARTUP TRUNCATED`, its 120-second bound, and incomplete `bootstrap`. |
| Event 542 | The same guessed-home startup was retried and interrupted. |

The events do **not** identify the exact hung bootstrap child. Source tracing
finds unbounded local version probes and tasks-axi feature-help probes on this
blocking path. The tasks compatibility check can run before the lock section;
other probes run during bootstrap. Isolated fault injection reproduces the
unbounded dependency wait and now returns a named refusal after five seconds.
Healthy installed tools complete these reads quickly; increasing native's
120-second startup budget would not repair this failure class.

The old deck path registered a watcher before binding the thread's home, then
refreshed the adapter, inventory, memory and legacy projection, and requested a
fleet digest and other-captain discovery before responding. Bare new-captain
binding now avoids that fleet inventory. Required native startup still performs
its complete scoped digest; optional explicit fleet views remain available.
The BB environment warning and ACP's incomplete command presentation are core
client behavior, not evidence that deck or native startup completed.

## Supported procedure and completion criterion

1. In the captain thread, call `firstmate_deck`, or run
   `bb firstmate deck --json` on ACP/CLI. Require a successful result containing
   `nativeHome`, `hostId` and `startupCommand`. Binding has an end-to-end
   60-second deadline. It returns `ready: false`: native readiness is unverified.
2. Read `firstmate_contract` without a section, or `bb firstmate contract`.
   The full native source stays intact. Host resolution and the mandatory SDK file
   read use 15-second bounds and propagate cancellation. Neither operation falls back to the
   shared source home for an unbound captain in the default profile.
3. If the complete native startup digest is absent, run the exact returned
   `startupCommand` once through the agent's shell. `firstmate_fm` with
   `script=session-start`, or `bb firstmate fm session-start --json`, retrieves
   the same bound command. A foreign `--home` refuses.
4. Require the complete digest, successful native lock and prerequisites before
   orchestration. Native exit zero alone is insufficient: lock refusal,
   `MISSING`, `MISSING_MANUAL`, backend refusal or `STARTUP TRUNCATED` remains
   unresolved. Diagnose its named prerequisite/stage before retry.
5. For an additional fleet view, explicitly request `deck --digest`, `deck --all`
   or `session`. Existing legacy plugin records remain durable; use supported
   `migrate-state` / `migrate-owners` for deliberate import with native overwrite
   guards. Binding does not bulk-project an unrelated legacy fleet.

For this incident's thread, the binding response must name
`/root/firstmate-bb-homes/thr_8j32bnxm3b`, not the shared source clone. No command
was executed in that home during this verification.

## Implementation and policy boundary

| Concern | Implementation / regression |
| --- | --- |
| Shared bounded CLI/tool orchestration | [server.ts](../../server.ts), [startup module](../../lib/captain-startup.ts), actual registered paths in [factory tests](../../server.captain-startup.test.mjs) |
| Bind actual host/home before watcher registration | Authoritative thread environment must match configured/bound host; failed prerequisites create no watcher registration. Foreign-source sentinel remains unchanged. |
| Honest readiness and harness ancestry | Binding returns the exact home and shell command; RPC never runs session-start or acquires its lock. Native startup and lock policy are unchanged. |
| Bound resume | Installer `--verify` checks the mirror. A per-captain home/host/overlay stamp skips repeated inventory and hook writes only after verified setup. Stale/new inputs refresh. Hook installation failure refuses setup. |
| Discoverable ACP path | [captain skill](../../skills/captain/SKILL.md), CLI help and runtime contract pointer name deck, contract and bound shell startup; no plugin internals search. |
| Native dependency probes | [BB-only helper](../../overlay/bin/fm-bb-probe-lib.sh), exact patches for both audited pins, [native tests](../../scripts/captain-startup-native.test.mjs) |
| Shipping and stale detection | Installer, remote input manifest, payload fingerprint and disposable fixtures ship the new helper. Ten native files are patched copies; source `bin/` stays unchanged. |

The marked BB adaptation bounds **read-only** version/help probes through native's
process-group timeout runner. Native version floors and feature verdicts remain
authoritative. Version stderr remains discarded; feature help still includes
stderr, as native requires. Timeout names the tool and preserves nonzero status.
BB also stops requiring an inactive native Cursor CLI when SDK provider/catalog
selection owns execution. Non-BB harness detection remains byte-original.

Native pins remain `2d833ff147cd26a5c461e914e06854e0eb2707ce` and
`1f3e769616fdf9f31f85f4c3e6a9f71606634238`. Their loader clauses, native lock
policy, startup stages and required checks remain intact. Imported policy prose
and vendored snapshots were not rewritten. The captain adaptation stays inside
the existing six-sentence BB fence.

## Exact verification

All commands ran in the isolated implementation checkout. The final full suite
serializes test files to avoid host load starving unrelated CLI probes; explicit
concurrency regressions within each file still run unchanged. Native test homes were
disposable. The full suite points **all** fixture selectors at private native
state; `FM_TEST_HOME` matters for the local-merge mirror fixture.

```sh
python3 overlay/install-bb-backend.py --home /tmp/fm-launch-pr-verified
FM_TEST_HOME=/tmp/fm-launch-pr-verified \
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified \
FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb npm test -- --test-concurrency=1
npx tsc --noEmit
npm run fidelity -- --native /tmp/fm-launch-pr-verified
bb plugin build .
git diff --check
node --experimental-strip-types scripts/captain-startup-mutation.mjs
node --experimental-strip-types scripts/captain-startup-proof.mjs /tmp/fm-captain-startup-proof
```

| Result | Evidence |
| --- | --- |
| Full suite: **766 passed**, zero failed/skipped | `/tmp/fm-captain-full-final.log`; 160334.895188 ms. Includes 12 registered startup tests, 10 real native prerequisite tests and six native compatibility cases. |
| Focused existing startup/contract callers: **21 passed** | `/tmp/fm-captain-existing.log` |
| Corrected contract/local-merge/silent-wake callers: **8 passed** | `/tmp/fm-captain-corrected.log` |
| Method instruction budget: **3 passed** | `/tmp/fm-captain-methods.log`; all pre-existing obligations retained. |
| Typecheck / fidelity / build / whitespace: exit zero | `/tmp/fm-captain-{tsc,fidelity,build}-final.log`, `/tmp/fm-captain-diffcheck.log`; 33 skills, 12 anchors, seven authorized fences; native snapshot fresh. Build warns that the current BB binary embeds SDK 0.5.29 while the package remains pinned to 0.4.104. No pin upgrade or new SDK API. |
| Real locked native startup: **two passed** | `/tmp/fm-captain-startup-proof/{2d833ff1,1f3e7696}.{json,output,bb-commands}`; old pin 5705 ms, newer pin 6341 ms. Actual agent harness PID acquired each owned lock. Complete BOOTSTRAP / WAKE QUEUE / NEXT STEP sections; no refusal, missing prerequisite or truncation banner. |
| No worker commands / source changes | The native proof uses an owned recording BB transport, asserts zero spawn/send/retry/dispatch/create/delete commands, preserves its status sentinel and asserts zero native `bin/` diff. Only owned fixture processes/homes are removed. No model launches. |
| Seven causal mutations killed | `/tmp/fm-captain-mutations.log`; isolated copies, implementation checkout untouched. |

The seven mutations restore: bare fleet scanning, watcher-before-binding,
unbound shared-home startup, unbounded dependency reads, discarded feature-help
stderr, reinstallation on every bound resume, and an uncancelable mandatory contract read. Each fails its actual factory
or native-script regression with the matching assertion. Additional pre-fix
stderr-help reproduction failed on both pins (`/tmp/fm-captain-help-before.log`);
the corrected ten-case probe suite passes (`/tmp/fm-captain-probes-final.log`).

An initial full run found six failures: fence sentence count, two dependent
fidelity mutations, a removed instruction pointer, a wording expectation and an
old mirror selected by the local-merge fixture. All were corrected without
weakening the behavioral checks. A later parallel run during concurrent fault probes suffered four host-load
timeouts. The new probe test now bounds the whole script at 60 seconds while
requiring the specific dependency's native `exit=124` timeout and `MISSING` verdict;
it does not confuse total bootstrap time with one probe's five-second limit.
The final serial full run above passed without skips or failures.

## Remaining limits and parent follow-up

A committed [evidence summary](captain-startup-evidence.json) records the owned native commands, lock signatures and raw-output hashes.

The exact incident's hung subprocess remains unproven; new probe diagnostics
make recurrence actionable. Binding does not attest native harness readiness.
Cold or remote setup can reach its named 60-second refusal; a remote host without
local overlay templates still uses the existing staged installer. Explicit fleet
views retain their native inventory cost. No native timeout was increased.

The real-script proof ran under this Codex harness with owned fake BB read
transport, not a new ACP model session. Native prints its generic unverified
primary-harness supervision reference; this proof does not certify a new ACP
watcher adapter. The registered SDK fixtures cover ACP metadata and both public
entrypoints. Explicit `fullParityOnDeck=false` compatibility retains the old SDK
fleet view; without a native home it returns no invented shell command. Hidden output is not a token-savings claim.

Parent follow-up:

1. Review the scoped commit and repeat the isolated native proof if needed.
2. Integrate/build/activate under the existing authorization, preserving native
   pins and ownership. Production activation remains parent-owned.
3. In the intended captain context, verify the binding response and complete
   native startup, retaining events if a named prerequisite still fails. Do not
   substitute the shared source home or blindly repeat a truncated startup.
