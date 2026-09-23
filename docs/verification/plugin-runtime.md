# Plugin runtime verification

Verified 2026-09-23 with Node 24.18.0, BB 0.43.3, SDK 0.4.104, ShellCheck 0.11.0, and Lavish 0.1.78.
Overlay base: `9296f9b9d2566797b9a9aecaa5956bb8e471d2cd`.
This record separates native execution from substituted SDK boundaries.

## Repeatable gates

| Command | Result |
| --- | --- |
| `FM_SCOUT_NATIVE_BIN=/root/firstmate/bin-bb npm test` | 377 passed, zero failed or skipped |
| `npx tsc --noEmit` | Exit 0 |
| `bb plugin build .` | Server and app bundles built |
| `npm run fidelity -- --native /root/firstmate` | 21 skills; 11 divergence anchors; 6 authorized fences; snapshots fresh |
| `node scripts/patch-drift-check.mjs` | All four patches apply without fuzz at upstream `fdd36879df8de0a2b9455b5427227f100758b108` |
| Native `fm-lint.sh` with the absolute `overlay/bin/backends/bb.sh` path | Pinned ShellCheck 0.11.0, full extended analysis, exit 0 |
| `systemd-analyze verify scripts/host/lavish-axi.service` | Exit 0 |

The native paths above identify verification dependencies, not required installation locations.
Set `FM_TEST_HOME`, `FM_CLASSIFY_LIB`, and `FM_SCOUT_NATIVE_BIN` for another installation.
Native absence must not be reported as verified coverage.

## Live runtime signatures

`node --experimental-strip-types scripts/live-mirror-check.mjs`: **12/12 passed**.
It installed the final overlay into a scratch clone, created its own BB project, and spawned real ship and scout threads through native `fm-spawn.sh`.
Both produced `window=bb:<thread-id>` and successful exit status.
Neither accepted path emitted `unknown backend 'bb'`.
The same native scripts without the mirror rejected the backend and produced no spawn signature.
Both test threads and the disposable project were deleted; the check never selects an existing project or invokes global pruning.
The mirror reported `mirror OK: siblings present, HEAD matches, frozen copies current.`
This proves dispatch through the installed overlay, not an autonomous implementation/review/merge cycle.

`node scripts/host/lavish-lifecycle-check.mjs` ran the installed server in a disposable systemd service and private store:

```text
PASS idle: same process with no browser or poller
PASS recovery: new process, same review URL and exact saved state
PASS normal restart: same review URL and exact saved state
```

The observation window is 1.6 seconds, paired with an accelerated 250ms idle counterexample; it does not claim a 30-minute production observation.
The shared review service was not restarted or reconfigured.

## Mutation sensitivity

Each mutation below was applied separately and rejected, then restored.
The restored plugin cases passed all 17 selected tests.

| Mutation | Failing check |
| --- | --- |
| Bypass native scout teardown | `scout forget`: native ownership, refusal retention, missing report and inventory assertions |
| Return base settings instead of the captain's scoped home | `IT captain homes isolate native backlog, memory and away authority` |
| Restore the generic wake-drain minimum to 15 seconds | Tool and CLI `host timeout: survives an agent-supplied 15-second timeout` |
| Ignore nonzero native wake-drain exit | `IT wake script failure remains an error and preserves the queue` |
| Restore Lavish's idle timeout (`--mutate-idle`) | `idle review server exited` |
| Disable systemd restart (`--mutate-restart`) | `service did not recover after exit` |
| Use native bin instead of the patched mirror | Both ship and scout reject BB instead of spawning |

## Evidence boundaries

The 377-test suite includes real native backlog, decision, away, memory, merge, teardown, bootstrap and secondmate scripts operating on disposable state.
Its SDK responses and forge writes are simulated; those cases are not live BB endpoint or production merge evidence.
Scout report/inventory refusals execute installed native scripts; successful scout cleanup and routing use simulated SDK responses.
Previously recorded installation proof confirms the imported server source bytes built and reloaded successfully, with 11 scout regressions passing against the installed bundle through a simulated SDK host.
Recorded installed-CLI checks also returned `ready: true`, `presentationReady: true`, and `Wake queue empty.` from a dedicated captain home.
They verified a native captain hold before answering/removing a disposable decision, and a generic wake drain requested with a 15-second budget completed past that former deadline.
These are reused installation observations, not reruns against customer state.
That installation proof does not establish destructive cleanup against a real worker.

The optional Lavish template is parameterized for an operator's home, state store, installation path, port and forwarded hostname.
Installing it is a separate host operation.
Worker CLI home routing remains outside this change; see [runtime limits](../native-parity.md).
