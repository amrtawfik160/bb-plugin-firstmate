# Audited native version

The script surface, overlay patches and all 21 fidelity-managed skill files use
`b42d4fa8a752fad9a5f0235783b02534bce29219`. This is an audited commit, not a claim
that the plugin follows upstream HEAD. `npm run fidelity` rejects a different
skill or overlay pin; `--native` also checks the snapshot against Git objects.
BB-specific captain, firstmate, ahoy, quiet and stow instructions remain adapters,
outside the verbatim-policy check.

An installed home is separate state. Changing these files does not upgrade that
home, reload a plugin, compact a captain, or replace instructions already loaded
in a captain's conversation. Read the installed commit and mirror manifest before
an upgrade, install and verify the mirror on that commit, then refresh the captain
contract at the next safe boundary. Keep queued wakes and unresolved decisions.

## Changes that affect the BB adapter

- `fm-wake-drain.sh` main acknowledgement claims only rows at or below the shown
  cutoff; later arrivals remain available to the next presenter. The existing
  `--ack-through` and recovery-generation protocol remains compatible.
- `fm-spawn.sh` preserves native `branch`, `account` and `account_provider` fields
  on relaunch. The BB patch additionally owns `bb_thread_id`.
- `fm-merge-local.sh` now selects the recorded immutable branch. The BB patch must
  resolve BB's managed worktree branch **after** native's default assignment and
  before validation. The previous hunk applied with fuzz before assignment and
  lost the BB branch; the executable mutation check reproduces that failure.
- `fm-watch.sh` imports `fm-secondmate-liveness-lib.sh` and probes registered
  secondmate endpoints every 60 seconds, with bounded relaunches only for a
  confirmed dead or missing endpoint. The seventh mirror copy keeps the library
  relaunch on the BB-aware sibling spawn script instead of pristine native bin,
  recognizes BB as a verified harness, and passes recorded BB backend/harness
  explicitly so a timeout subprocess does not fall back to ancestry detection.
  No new secondmates are registered here.
- `fm-supervision-host.sh` is opt-in through `config/supervision-host`; the BB
  adapter does not enable it. Presence in the script catalog is availability,
  not an active extra supervisor or a tested BB supervision-host integration.
- The imported process-event skill now explains that Lavish `arm` confirms its
  listener and may return `still-listening`; native project and secondmate skills
  describe their forge and account bindings. BB runtime constraints still apply
  to imported native harness commands.

## Verification

Use a disposable native clone containing the audited commit, never a live home:

```sh
FM_TEST_HOME=/path/to/clone node scripts/patch-drift-check.mjs --ref b42d4fa8a752fad9a5f0235783b02534bce29219
npm run fidelity -- --native /path/to/clone
FM_TEST_HOME=/path/to/clone node --experimental-strip-types scripts/live-mirror-check.mjs
```

The mirror check installs the actual overlay into a scratch home at the pin,
requires pristine native to reject `bb`, requires the mirror to accept it, and
spawns disposable ship/scout BB threads before cleaning them up. It also executes
the real local-merge script against a scratch Git worktree: moving the BB branch
selection back above native assignment must fail; restoring the patch must
fast-forward to the managed branch's exact commit. Liveness relaunch probes
execute the native function with and without its timeout, require the actual
spawn invocation to stay in the mirror, and retain native refusal of an
unregistered secondmate; restoring the pristine library must bypass the mirror.
This tests routing and refusal, not a successful secondmate recovery. The optional
`FM_MIRROR_CHECK_NO_REAL_PROJECT=1` run proves shell dispatch reaches the BB layer
but does **not** prove real thread creation.

These checks establish installation, script routing, skill provenance and the
merge ordering regression. They do not measure fleet token savings, prove every
new native capability on BB, or refresh existing captain context automatically.
