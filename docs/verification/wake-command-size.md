# Wake receipt command size

Baseline: `6180dbb`. Scope: host transport for every `runFmScript` receipt action.
Parent owns final full-suite verification and production wake retry. No production
home, report, receipt, fleet, worker or PR was changed during implementation.

Implementation: [server.ts](../../server.ts), `runFmScript` and receipt-only error
propagation in `writeHostBytes`. Regressions:
[server.wake-command-size.test.mjs](../../server.wake-command-size.test.mjs).

## Failure and transport choice

The actual plugin factory reproduced the reported captain/home configuration:
`Host command too long (10011 > 10000)`. The regression used that home as a string
in a recording SDK fixture; it never executed a command against the home. The
failure occurred before any host command, native presentation or acknowledgement.
Before-fix evidence: `/tmp/fm-wake-size-before.log`.

`overlay/bin/bb-wake-receipt.py` is plugin-shipped but is absent from the
installer's `OVERLAY_INSTALL_INPUTS`, `TRANSPORT_PAYLOADS` and owned-copy list.
An existing installed, hash-verified receipt helper therefore cannot be assumed.
The fix stages the complete command with the existing atomic `writeHostBytes`
transport, then runs `bash /tmp/.fm-receipt-<uuid>.sh`. It does not require an
installer refresh or change the native source pin.

The staged command retains the compressed helper source, native script path,
environment, captain state directory, action, full receipt ID and complete stale
guard. Compression only reduces staged bytes; it no longer establishes a command
size claim. Every actual terminal command still passes the unchanged 10,000
character limit after shell quoting. Payload chunks and generated temporary paths
are ASCII. Long or quoted home paths and arguments occur inside the staged file.
The guarded native invocation starts only after atomic staging succeeds.

All receipt actions use this one transport: receive, inspect, begin-action,
mark-success, complete and legacy-ack. Current public receipt callers omit stdin.
If a caller supplies stdin, the existing `runOnHost` transport stages it separately
and redirects it into the short `bash <temporary-path>` invocation. Neither the
command contents nor stdin contents are placed in terminal stdin or truncated.

Failure stops before the receipt action. Cleanup removes only the operation's
UUID-named script and its writer scratch files, including after cancellation.
Thrown staging transport errors retain their original cause; existing other file
writers retain their prior boolean failure contract. Cleanup remains bounded and
best effort if the host is unreachable. A process crash can leave inert temporary
files; no automatic execution or acknowledgement uses those files on restart.
Native receipt journals and reports remain the recovery authority.

## Causal and native evidence

- Actual factory: the reported configuration now returns a recoverable receipt.
  Reverting only the staged transport reproduces the exact `10011 > 10000` error,
  with zero host/native execution. The mutation runner restores source bytes.
- Actual tool and CLI callers: long quoted home paths retain actions, IDs,
  environment and hash/HEAD stale guards. Firstmate tools, handledWake actions,
  generic `firstmate_fm wake-drain`, CLI wake and legacy acknowledgement all use
  staging. The full rendered scripts exceed 10,000 characters while every wrapped
  terminal command fits the limit.
- Faults: init, chunk append and atomic rename failures execute no receipt action.
  Cancellation after staged publication removes the script and writer files.
  An SDK staging error retains its HTTP 504 cause. No worker/model call occurs.
- Disposable native homes at both audited pins (`2d833ff147cd26a5c461e914e06854e0eb2707ce`
  and `1f3e769616fdf9f31f85f4c3e6a9f71606634238`) use real installed scripts and the
  real receipt helper through the factory's host transport. BB alone is fake.
  The fixture's quoted home does not execute its embedded shell text. Presentation leaves native queue
  rows unacknowledged; a fresh plugin factory replays the same durable receipt.
- Native stage-write fault: a failed completion attempt leaves the original queue
  and ready receipt intact. A successful handledWake action records begin-action,
  mark-success and completion. A report arriving during handling becomes a
  retained successor receipt. Wrong legacy acknowledgement preserves it; the
  exact matching acknowledgement completes it. Another captain's queue remains
  byte-for-byte unchanged throughout.
- Inspect has no public caller today. Its native proof executes a copy of the
  exact full guarded script rendered by the actual factory, changing only the
  action and receipt ID. No test-only product API is added.

The output-read timeout/retry fixtures identify the staged receipt invocation.
They still prove one receipt execution, retained timeout diagnostics and an output
read retry without rerunning or acknowledging the native command.

Parent's full run at `8fdfbcb` found six failing host-timeout fixtures among 695
tests (689 passed, zero skipped; `/tmp/fm-wake-parent-full.log`). The original
targeted pattern omitted test names containing `host timeout`. Those fixtures
still treated staging as the slow native command and expected one terminal.
The correction changes tests and this document only; product code is unchanged.

All eight tool/CLI host-timeout cases now model the staged files and identify the
actual native execution. They preserve the original slow-read scenarios and
observe the final read deadline one millisecond before the exact 180-second
minimum or explicit 240-second budget. Peek still times out at 15 seconds.
Success and timeout both assert one native invocation without retry or
acknowledgement. The fixture's two payload chunks require seven receipt terminals
(init, two appends, atomic publication, writer cleanup, execution, receipt cleanup).
Peek requires one terminal. Every created terminal closes exactly once, and no
staged file remains. Coverage now includes all eight cases plus the 40 previously
selected wake/receipt/host tests.

## Validation

```sh
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types server.wake-command-size.test.mjs scripts/wake-receipt.test.ts lib/wake-receipt.test.ts
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types --test-name-pattern='host timeout|wake|receipt|host (file|stdin)|host operations' server.test.ts
node scripts/wake-command-size-mutation.mjs
npx tsc --noEmit
npm run fidelity -- --native /tmp/fm-launch-pr-verified
bb plugin build .
git diff --check
```

Run the mutation command alone in the isolated checkout; it temporarily replaces
the receipt transport in `server.ts` and restores every source byte in `finally`.

| Check | Result / evidence |
| --- | --- |
| Receipt helper, framing and new transport regressions | 52 passed, zero failed/skipped. `/tmp/fm-wake-size-affected-final.log`; includes nine new transport tests. |
| Selected server host-timeout/wake/receipt/host tests | 48 passed, zero failed/skipped. Includes all eight host-timeout cases. `/tmp/fm-wake-timeout-correction-server.log`. |
| Inline-transport causal mutation | Killed; exact reported overflow reproduced. `/tmp/fm-wake-size-mutation.log`. |
| Typecheck | Passed after fixture correction. `/tmp/fm-wake-timeout-correction-tsc.log`. |
| Native skill fidelity | Passed: 33 skills, 12 adaptation anchors, seven BB-only fences; snapshot fresh. `/tmp/fm-wake-timeout-correction-fidelity.log`. |
| Plugin build | Passed after fixture correction. `/tmp/fm-wake-timeout-correction-build.log`. SDK remains pinned at 0.4.104. |
| Diff check | Passed. |

No app/RPC schema or native receipt semantics changed. Staging adds host file
transport calls; it does not start a model turn. This bounded fix covers receipt
commands. Unrelated oversized host commands keep their existing explicit refusal.
Production retry and receipt handoff remain separate parent operations.
