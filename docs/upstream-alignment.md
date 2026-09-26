# Audited native version

The script surface, overlay patches and all 21 fidelity-managed skill files use
`4299683d5b656a70ced609d7d929499ddc0d675a`. This is an audited commit, not a claim
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

At `4299683d5b656a70ced609d7d929499ddc0d675a`, the direct upstream delta adds three callable scripts: `fm-git-strip-ai-trailers.sh`, `fm-host-mirror.sh`, and `fm-lab-home.sh`. The script manifest includes all three, and the Cursor adapter documents the trailer handling. `fm-spawn.sh` installs its new per-task commit-message hook (`state/<id>.git-hooks`) for every spawn, BB crews included, but activates it only by exporting `core.hooksPath` through the pane launch command. The BB adapter launches the agent at thread creation, skips the pane-send block, and drops `export` lines, so `core.hooksPath` is never delivered to BB threads: the hook is installed and torn down but inert for BB crews, and AI trailers are not stripped at the commit object. Follow-up: deliver `core.hooksPath` to BB threads.

- `fm-pr-merge.sh` adds the attended-only `--allow-missing <check>` waiver for one exact required context that has not reported. `firstmate_merge` forwards it only through the native verification path and refuses the option on the BB API path, which cannot verify required contexts; it remains separate from `yes` and `allowRedCheck`.
- The plugin mirrors AGENTS section 9; that section is unchanged at this pin. Upstream's section 6 project-memory rule and section 7 merge wording are outside the plugin's mirrored AGENTS slice; the captain merge guidance now describes the native missing-check waiver.
- The upstream AFK/stow skill edits add away-mode delivery details and restrict project `AGENTS.md` additions. BB's AFK and stow instructions retain their transport-specific behavior; the imported AFK snapshot is refreshed from the new pin.

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
FM_TEST_HOME=/path/to/clone node scripts/patch-drift-check.mjs --ref 4299683d5b656a70ced609d7d929499ddc0d675a
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
