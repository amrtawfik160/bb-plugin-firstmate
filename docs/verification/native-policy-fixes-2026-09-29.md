# Native policy fixes — 2026-09-29

Requirement: retain upstream Firstmate prompts and behavior, adapting only BB environment and CLI transport. Native reference: `$FIRSTMATE_HOME` at `2d833ff147cd26a5c461e914e06854e0eb2707ce`. Plugin baseline: `ee1a87afc63d377d0cf69b610c142399f08ec062`; this report accompanies the native-policy fix PR.

## Resolved audit findings

The eight findings in [the follow-up audit](prompt-parity-followup-2026-09-29.md) have implementation fixes:

| Finding | Result |
| --- | --- |
| Replacement loses native brief | Initial launches and replacement retries share the BB shell prompt wrapper around the native brief. Missing/unreadable briefs refuse before stopping the prior thread. |
| Startup proof misses actual routes | Acceptance exercises actual tool and CLI handlers, the hook adapter, native scripts under this agent's harness, and installed BB CLI startup. |
| Enabled startup failures are silent | Registered captains receive errors for a missing installed hook, malformed marker, missing native runner or inaccessible home. Native intentional stand-downs retain their upstream behavior. |
| Quiet/absent crews auto-resolve decisions | Removed synthetic `resolved` writes. Native folding preserves unanswered metaless decisions after a wake read. Stale Lavish-source retirement remains separate. |
| Native completion starts repair turns | Native workers use durable status and native supervision; ordinary final chat does not trigger verdict nudges. |
| Bearings competes with native state | Tool, CLI, session and RPC consume the canonical native snapshot. No native snapshot failure falls back to chat classification. |
| WAITING/timer policy changes native lifecycle | Removed from native launch/retry and SDK worker instructions. Native workers do not get scheduled WAITING resumes or blanket background-process shutdown rules. |
| Stop ignores native supervision | Hook invokes native turn-end guard before BB receipt/queue checks; Claude registration includes native cooperation and autoarm entry points. |

Further review fixed missing gate reasons, contribution deduplication/coverage disclosures, unavailable and inconsistent secondmate warnings, and the prescribed durable secondmate reconcile request. Request-publication failure is disclosed while the captured digest remains available. Native task rows outside the BB register render without an invalid thread link. The snapshot's display-only `home` label never replaces the requested absolute home path when matching registered BB workers. Shared worker transport text replaces separately maintained browser/path policy variants.

The SDK-only compatibility dispatch path retains its legacy lifecycle; this report's worker policy claims cover the native/full profile. Real-mode dispatch refuses native failures rather than selecting that compatibility transport.

## Verification

- `npm test`: **569 tests; 567 passed, zero failed, two skipped**. Includes native replacement refusal, shared prompt transport, native idle handling, canonical Bearings across entry points, and registered-hook failures.
- `npx tsc --noEmit`, Bash syntax and `git diff --check`: passed.
- `npm run fidelity -- --native $FIRSTMATE_HOME`: passed; 33 skills, 12 declared BB-DIVERGE anchors, seven BB-ONLY fences; native snapshot fresh.
- `node scripts/live-native-policy-check.mjs --live-cli`: executes pinned native startup, hooks, status folding, snapshot, reconcile publication, native brief scaffold and retry prompt construction on disposable homes. Actual installed `bb firstmate fm --home ... session-start --json` returns the agent-shell command; executing it beneath this agent records the native harness lock and matching completed-startup marker. Tool/SDK command routing uses the official fake plugin host; its host-command bridge executes real native scripts. BB worker spawn/send operations are recorded rather than dispatched. This does **not** prove a live model worker dispatch or every provider's hook delivery.
- Real synchronous Stop: an in-flight task with empty wake queue and absent watcher exits 2 with `TURN WOULD END BLIND`; active-loop payload allows the subsequent stop. Claude guard routing and empty-home native autoarm are exercised. Missing session runner fails visibly.
- Native fold retains the two-hour-old metaless `release` question after actual plugin wake presentation; no synthetic close appears.
- Installed live `bb firstmate bearings --json` returned `fm-bearings.v1` for the base home: 20 in-flight rows, five live calls, six recent completions, 20 gates and 11 omitted disclosures. Native bounds and exclusions remain intact. A first read overlapped reload and received the SDK's stale-handle error; its own leftover terminal was retired, then the fresh read succeeded.
- Fixture cleanup sends TERM/KILL only to processes bound to that unique scratch home by environment/cwd and asserts no survivors before removing the home. Test markers and mutant modules are removed.

## Causal checks

`live-native-policy-check.mjs --mutate=<name>` operates on isolated source/hook copies and disposable homes. Baseline passes; the mutations below fail at their behavior assertions:

| Mutation | Failure |
| --- | --- |
| `tool-startup` | Tool no longer returns the agent-shell startup command. |
| `cli-startup` | Actual prior CLI route returns no `requiresAgentShell` handoff, with host discovery stubbed so failure is not missing setup. |
| `hook-startup` | Native startup completion marker is absent. |
| `silent-startup` | Restoring the old conditional startup wrapper silently accepts a missing runner. |
| `hook-wrapper` | Restoring the old installed-hook command silently accepts a missing registered hook. |
| `stop-guard` | Empty queue plus in-flight task stops without native exit-2 protection. |
| `orphan-close` | Exact baseline sweep/helper restoration removes the unanswered native decision. |
| `retry-brief` | Restored custom prompt builder omits upstream worker-role/status text. |
| `bearings` | Restored competing cache reader loses canonical schema/hold authority. |
| `idle-nudge` | Native idle completion sends a repair turn. |
| `waiting` | Restoring the removed shell WAITING/timer rule functions to the common prompt wrapper injects prohibited extra policy. |
| `worker-config` | Restoring the actual baseline SDK configuration callback and its imports yields the independent worker playbook. |
| `reconcile` | Removing native publication means Bearings never executes the reconcile request. |

Five isolated mutations of the renderer also fail its unit assertions: removing structured gate reasons, removing coverage, reverting deduplication to owner/id instead of owner/key, hiding an active mate's inventory warning, and claiming a clear action set without native proof. These renderer checks use structured fixtures, not live secondmate discovery. Reverting the home-path match to the native display label also fails the registered-thread assertion in the canonical Bearings entry-point test.

## Installed state and limits

Built and reloaded the local Firstmate plugin. Refreshed the base mirror and eight existing captain-home mirrors; preserved all captain bindings, fleet records and unrelated hook entries. Installed user-level hooks now delegate to the current native runner/guard and Claude autoarm. No project crew, external message, PR, merge or commit was created by this verification.

Complete tmux equivalence is **not** established. End-to-end Claude `asyncRewake` ownership, successor survival and delivery inside BB remain unverified; the current Codex-hosted check establishes adapter routing and inert eligibility only. BB's core child completion visibility and provider-specific hook trust still impose the limits described in [native-parity.md](../native-parity.md). Runtime equivalence claims must retain these limits until provider acceptance demonstrates them.
