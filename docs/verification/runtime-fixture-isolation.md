# Native-runtime test transport isolation correction

Baseline: `a05766ddf930d1da80cc086e003167fdb70ee01a`.
This correction changes tests only. Runtime assets, native sources, plugin
behavior, production state and parent live acceptance are unchanged.

## Root cause

Parent's systemd full run passed 795 of 798 tests. Three fake-BB fixtures reached
the real CLI: worker prompt, local merge teardown and secondmate launch/stop.
Unsetting `BB_CLI` did not fix them because Bash changed executable search order.

The fixtures inherited a fake-first `PATH`, then used Node `spawnSync('bash',
['-c', ...])` with default piped stdin. In this environment Node supplies a
socket-backed pipe. With `SHLVL` absent or zero, Bash's remote-shell startup
detection reads `$HOME/.bashrc`; the host's `~/.bashrc` prepends `.bun/bin` and
`.local/bin` **before** the fixture directory. `bb` then resolves to the real CLI.
An existing shell normally supplies a higher `SHLVL`, explaining the passing
single-test and implementation-shell runs.

Read-only process probes measured the distinction without executing BB:

| Incoming shell level | Child stdin | Observed PATH |
| --- | --- | --- |
| absent / `0` | default pipe | `.bun/bin:.local/bin:fixture-prefix:...` |
| absent / `0` | ignored | `fixture-prefix:...` |
| `1` / `2` | default pipe | `fixture-prefix:...` |

The new regression recreates the shell-less service case in a disposable HOME.
Its `.bashrc` prepends a second **fake** BB executable that exits 97. The old
spawn reaches that stub; the corrected spawn reaches the intended stub and exits
zero. Neither branch can call production BB.

## Correction and causal evidence

[server.test.ts](../../server.test.ts) now uses one `fixtureShell` helper with
`stdio: ['ignore', 'pipe', 'pipe']` for the fake host terminal and the affected
direct adapter calls. No fixture supplies native input through Node stdin;
commands already stage files or redirect explicit input. A regression verifies
that staged stdin redirection still works. This changes test transport setup,
not native shell or product policy.

The prompt and secondmate fixtures also source their complete disposable adapter
mirror rather than the raw overlay file. Native composer/transition siblings
are available, source errors are not hidden, and launch/stop assertions remain.
The local merge fixture still proves the hold refusal, exact landed HEAD,
native teardown, removed task metadata and zero raw forge merge calls.

Mutation in a private archived source copy removed the helper's closed stdin.
The regression failed with `97 !== 0`; restored code passed. Results:
`/tmp/fm-runtime-fixture-isolation-mutation/result.json`, `healthy.log` and
`mutation.log`. Only disposable fake executables were invoked.

## Validation

The focused command uses the parent's clean HOME/SHELL/PATH and BB-variable
unsets, additionally removing `SHLVL` to reproduce the identified service
condition. All four native fixture variables point at the owned current mirror.

```sh
env -u SHLVL -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK \
  -u BB_TRANSCRIPTION -u BB_THREAD_ID -u BB_PROJECT_ID -u BB_ENVIRONMENT_ID \
  -u BB_HOST_ID -u BB_SERVER_URL -u BB_HOST_DAEMON_PORT -u BB_DATA_DIR \
  HOME="$HOME" SHELL=/bin/bash \
  PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin \
  FM_TEST_HOME=$(cat /tmp/fm-runtime-native-fixture-final-path) \
  FIRSTMATE_TEST_NATIVE=$(cat /tmp/fm-runtime-native-fixture-final-path) \
  FM_SCOUT_NATIVE_BIN=$(cat /tmp/fm-runtime-native-fixture-final-path)/bin-bb \
  FM_CLASSIFY_LIB=$(cat /tmp/fm-runtime-native-fixture-final-path)/bin/fm-classify-lib.sh \
  /usr/bin/node --test --experimental-strip-types \
  --test-name-pattern='closed-stdin BB fixtures|bb crew launch prompt preserves|IT native local merge respects|IT BB secondmate launch keeps' server.test.ts
```

Focused result: **4/4 passed**, zero skips/failures. Log:
`/tmp/fm-runtime-fixture-isolation-targeted.log`. The full command used the same
environment with `/usr/bin/npm test`: **799/799 passed**, zero skips/failures,
exit 0. Log: `/tmp/fm-runtime-fixture-isolation-full.log`. The extra test is the
new causal startup/PATH regression; the previous suite contained 798 tests.

The same four focused checks also ran through an owned transient systemd unit:
`systemd-run --wait --collect --unit=fm-fixture-isolation-owned-20261005
--property=WorkingDirectory=$PLUGIN_CHECKOUT
--property=RuntimeMaxSec=90`, followed by the complete focused command above.
Result: **4/4 passed**, service exit 0. Evidence:
`/tmp/fm-runtime-fixture-isolation-systemd-command.log` and
`/tmp/fm-runtime-fixture-isolation-systemd-tests.log`. The collected unit ended;
no parent acceptance service was changed. These logs contain no real BB CLI
diagnostic/host-not-found/thread-not-found escape signatures.

Typecheck, native fidelity, plugin build, package verification and diff check
passed. Logs: `/tmp/fm-runtime-fixture-isolation-{tsc,fidelity,build,package}.log`.
The bundled release remains
`597623fe465df0234bb58eee41b06fc0d4cc686e3949530e9654461ea7574ae9`;
archive hash remains
`0399578caa2eab04274e13473fb71ade297386c89afea09142e9388a63431764`.

No real model worker, production fleet operation, PR operation or plugin reload
was performed. Parent's independent runtime acceptance remains parent-owned.
