# Self-contained runtime implementation evidence

Implementation baseline: `0d0f03c2fc1cf181e5f4c9cc5b65971517fa39fc`.
Production activation and existing-home migration have **not** occurred.
Mandatory acceptance with actual BB host transport and a real model worker remains
parent-owned. The proofs below do not substitute for that acceptance.

## Release identity and licensing

| Identity | Exact value |
| --- | --- |
| Plugin manifest version | `0.4.0` |
| Bundled upstream | `https://github.com/kunchenguid/firstmate` |
| Audited native commit | `1f3e769616fdf9f31f85f4c3e6a9f71606634238` |
| Preserved external compatibility commit | `2d833ff147cd26a5c461e914e06854e0eb2707ce` |
| Filtered packaging Git commit | `4cdbef4dbf44a721e55cf0ad01524ee27b377e05` |
| Native source inventory SHA256 | `098f5aae7887df23ae1e696634a937b83fd08c02d32a3b34b06f65cef639b58f` |
| Adapter fingerprint | `b435326123441eac4de8fc46c1f5694fc61183d4112c545abf897082affa4cdf` |
| Native plus adapter release | `597623fe465df0234bb58eee41b06fc0d4cc686e3949530e9654461ea7574ae9` |
| Archive SHA256 | `0399578caa2eab04274e13473fb71ade297386c89afea09142e9388a63431764` |
| Host helper SHA256 | `55f3858c73e8a7f205a2616530fc0de17a96f7b2de572436e0fd9da85f43d0f1` |
| Supported state contract | `native-flat-v1` |

Native Firstmate is MIT licensed, copyright 2026 Kun Chen. The full permission
and copyright notice ships in [LICENSE.firstmate](../../runtime-assets/LICENSE.firstmate),
the native Git snapshot and each installed release. [NOTICE](../../runtime-assets/NOTICE)
records author, source and audited commit. A committed-tree license inventory found
one native license and no additional license/vendor directory in the packaged tree.
The plugin's existing MIT license remains separate. No native policy source bytes
were edited.

The archive contains 27 regular payloads: a filtered Git bundle with 383 native
files, 21 exact adapter inputs, the host helper, native manifest, license, notice
and release manifest. Compressed size is **2,666,874 bytes**; uncompressed archive
payloads total **2,838,969 bytes**. The intermediate native bundle is 2,590,114
bytes and is ignored by Git; only the compressed release ships.

## Packaging and path audit

[generate-native-runtime.py](../../scripts/generate-native-runtime.py) reads the
exact committed upstream tree. Its allowlist includes native `bin/`, skills and
their assets, static harness hooks, contracts/docs, root policy files and backlog
configuration templates. Symlink targets must exist inside the exported tree.
It excludes upstream tests/development tools, marketing banner, history/remotes,
credentials, live config, state, customer tasks and session data. Generator tools
were Git 2.43.0 and Python 3.12.3. Archive ordering, modes, timestamps, identity
and gzip header are deterministic; source generation and archive rebuilding were
byte-compared successfully.

Native home seeding, remote provisioning, `fm-on`, bootstrap primary identity and
pristine-source overlay checks require Git/HEAD/committed files. A plain file
export would break these contracts. The smallest adopted compatible format is a
filtered, parentless Git snapshot with separate upstream identity attestation.
Native scripts remain unchanged; the installer maps this exact attested snapshot
to the already audited patch set. An arbitrary synthetic commit cannot declare
itself audited. Development/update script entrypoints remain present for source
fidelity but bundled tools explicitly refuse them.

Public SDK 0.4.104 host `files.write`/`files.remove` transfer checked bytes, and
host-path terminals execute short commands. No asset payload enters shell argv
or stdin, no server checkout path is sent to the host, and no startup fetch is
used. [plugin-assets.ts](../../lib/plugin-assets.ts) resolves source and built
entrypoints to their own installed package assets. The runtime is published at
the actual host user's `$HOME/.local/share/bb-firstmate/versions/<release>/`.
Captain homes are separate durable Git/state directories under `homes/<thread>/`.

Audited callers include server init/deck/contract/script/wake/inbox/away paths,
native initial/replacement/adoption prompts, seeded secondmates, captain hooks
and watcher keeper script generation. They resolve selected code while retaining
original state/data/worktree paths. Worker native commands now carry an explicit
home/code environment because BB worker shells do not inherit launch exports.
The original task text and fleet-ledger status arguments remain intact.

## Requirements matrix

| Requirement | Implementation | Observed proof / remaining limit |
| --- | --- | --- |
| 1. Pinned, complete, licensed assets | [generator](../../scripts/generate-native-runtime.py), [packer](../../scripts/package-native-runtime.py), [assets](../../runtime-assets/distribution.json), [exact installer attestation](../../overlay/install-bb-backend.py) | Reproducible bytes, both audited patch sets, backend source loading, missing/corrupt/source-identity refusal; no network native update |
| 2. Actual-host staging and native Git compatibility | [SDK transport](../../lib/native-runtime.ts), [host publisher](../../scripts/runtime-host.py), [package root](../../lib/plugin-assets.ts) | Registered CLI/tool and built entrypoints execute real host-local scripts with public SDK fixtures; actual connected-host transfer still requires parent acceptance |
| 3. Durable captain state and recorded selection | [home binding](../../scripts/runtime-host.py), [server bindings](../../server.ts), [worker transport](../../overlay/bin/backends/bb-worker-transport.txt), [rebind](../../overlay/bin/fm-worker-rebind.py) | Reload and partial KV publication recover exact home/root; seeded child recovery; original task, execution, native metadata, branch/HEAD, dirty skill, reports preserved by real-script fixtures |
| 4. Serialized release/selection/rollback | [host locks/publication](../../scripts/runtime-host.py), [launch consumer check](../../lib/launch.ts), [selection journal](../../server.ts) | Concurrent installation, SDK cancellation/late cleanup, SIGKILL before publication, native task-set contention, lost selection response/cache write, compatible rollback; old releases retained |
| 5. External compatibility and explicit migration | [host migration/rollback](../../scripts/runtime-host.py), [audited registry](../../overlay/patch-sets.json), [operator procedure](../self-contained-runtime.md) | Both old/new external pins check/migrate/read-back/rollback; exact Git source and state unchanged; live consumers/foreign owner/host/unknown source refuse |
| 6. Clear status and conditional instructions | `firstmate_runtime` / `bb firstmate runtime` in [server](../../server.ts), [captain](../../skills/captain/SKILL.md), [harness reference](../../skills/harness-adapters/references/harness/bb.md), [README](../../README.md) | Installed versus selected identities, compatibility, migration requirement and pending selection surfaced; fidelity gate passes |

## Dependencies

Transport/install require BB and a connected host, SDK >=0.4.104, Git, Python 3
with POSIX `fcntl`, Bash, GNU patch and ordinary Unix tools. Runtime hook/native
bootstrap dependencies include Node, jq, GitHub CLI and host authentication.
Native bootstrap owns version/feature requirements: tasks-axi >=0.2.4,
quota-axi >=0.1.29, gh-axi >=0.1.29 and no-mistakes >=1.46.0 at this pin.
Lavish >=0.1.46 is a presentation prerequisite, not mandatory for nonvisual work.
The existing BB browser adaptation remains explicit. Conditional Herdr,
treehouse, systemd, SSH/tmux and provider/harness dependencies remain conditional.
No credentials, external CLIs, BB binary or provider catalog were bundled.

## Exact validation commands and evidence

All fixtures were disposable, task-owned paths. No production home, fleet,
provider/model, PR or native working checkout was changed. `FM_BOOTSTRAP_NETWORK=skip`
was restricted to these fixture processes. Installed BB CLI was 0.44.0, Node
24.18.0, TypeScript used installed SDK 0.4.104. Build reports that BB embeds SDK
0.5.29; the project dependency pin was retained.

```sh
python3 scripts/generate-native-runtime.py --source /root/github_projects/firstmate --output /tmp/fm-runtime-reproduced-release
cmp runtime-assets/native.bundle /tmp/fm-runtime-reproduced-release/native.bundle
cmp runtime-assets/native-manifest.json /tmp/fm-runtime-reproduced-release/native-manifest.json
npm run runtime:verify
node --test --experimental-strip-types lib/native-runtime.test.mjs scripts/native-runtime.test.mjs server.native-runtime.test.mjs
FM_RUNTIME_BUILT=1 node --test --experimental-strip-types server.native-runtime.test.mjs
npx tsc --noEmit
npm run fidelity -- --native /tmp/fm-launch-pr-verified
bb plugin build .
git diff --check
python3 scripts/native-runtime-mutations.py --evidence /tmp/fm-self-contained-runtime-mutations-release
node --experimental-strip-types scripts/native-runtime-proof.mjs /tmp/fm-self-contained-runtime-proof-release
```

Affected runtime tests: **30 passed**, zero failures/skips. Built SDK factory
paths: **7 passed**, zero failures/skips. Typecheck, fidelity (33 skills, 12
marked adaptations, 7 authorized fences), build, reproducibility and diff check
passed. Logs: `/tmp/fm-runtime-affected-immutable.log`,
`/tmp/fm-runtime-built-release.log`, `/tmp/fm-runtime-tsc-release.log`,
`/tmp/fm-runtime-fidelity-release.log`, `/tmp/fm-runtime-build-immutable.log`,
`/tmp/fm-runtime-repro-release.log`, `/tmp/fm-runtime-package-release.log`.
Final immutable-release full suite: **798 tests passed**, zero failures/skips,
exit 0. Log: `/tmp/fm-runtime-full-release.log`. The previous complete run also
passed 798 tests; the final run additionally includes the last native watcher
lock guard and its fixture against the final packaged helper.

The final suite uses an owned audited native clone and fresh current mirror:

```sh
FM_TEST_HOME=$(cat /tmp/fm-runtime-native-fixture-final-path) \
FIRSTMATE_TEST_NATIVE=$(cat /tmp/fm-runtime-native-fixture-final-path) \
FM_SCOUT_NATIVE_BIN=$(cat /tmp/fm-runtime-native-fixture-final-path)/bin-bb \
FM_CLASSIFY_LIB=$(cat /tmp/fm-runtime-native-fixture-final-path)/bin/fm-classify-lib.sh \
npm test
```

Ten causal mutations were killed in private source copies:

| Removed/broken guard | Regression that failed |
| --- | --- |
| Archive SHA check | Corrupted release refuses before installation |
| Retained native identities | Selection refuses native consumers |
| Native task-set lock | Concurrent admission blocks selection |
| Exact snapshot attestation | Synthetic Git identity cannot self-declare audited |
| Selected-root prompt support | Real bundled ship initial prompt |
| Worker code-root selection | Real bundled ship initial launch |
| Worker home environment | Rendered command addresses durable backlog from an unexported worker shell |
| Replacement selected source | Real bundled ship replacement preserves native/worktree identity |
| External rollback selection removal | Old-pin migration/rollback restores external selection |
| Built package asset resolution | Actual built CLI cold binding |

Exact results/logs: `/tmp/fm-self-contained-runtime-mutations-release/results.json`.

## Real native proof and acceptance boundary

[native-runtime-proof.mjs](../../scripts/native-runtime-proof.mjs) installed and
bound the shipped archive, then ran actual `fm-session-start.sh` under this
agent's harness ancestry in a disposable home. It observed the native harness
lock, `BOOTSTRAP`, `WAKE QUEUE` and `NEXT STEP`, a complete digest and no missing
prerequisite/truncation/fallback signature. The pending report sentinel remained
unchanged. Fake BB transport logged no spawn/send/retry/dispatch/create/delete.

For the final release, one measured local run took **1,218 milliseconds** to
install/bind and **6,968 milliseconds** for native startup. These measurements
exclude real SDK network transfer and a model worker. Evidence is
`/tmp/fm-self-contained-runtime-proof-release/result.json`, `startup.output` and
`bb-commands`. The installed runtime/home used only shipped native bytes; an
external Firstmate repository was not used. The original upstream checkout was
used solely for offline maintainer generation and read-only audit.

Real `fm-brief.sh`/`fm-spawn.sh`/renderer/rebind fixtures cover ship direct-PR,
no-mistakes, local-only and scout, with fake BB creation and fixture completion
records. These prove native guards, paths and preservation, **not** real model
completion or forge delivery. Existing delivery lifecycle tests pass separately;
new bundled-worker delivery must still be proved on actual BB.

Parent acceptance must use an isolated BB server/host with external Firstmate
repositories inaccessible. Install the immutable plugin package; start via both
CLI/tool and harness shell; require positive bundled-install/bind/native-startup
signatures and absence of external-source/fallback paths. Run real ship/scout
completion and PR delivery tracking, reload, interruption/overlapping install,
old-home read-back/migration refusal or safe explicit migration, rollback and
reports/contracts preservation. Record actual host transfer, worker execution
selection and package runtime logs. No production migration should be inferred
from successful installation.

## Operational limits

Selection refuses all retained native task metadata, session/control/spawn/watch
locks, watchers and held BB launch reservations, including unresolved creation.
It does not delete locks or reinterpret completed tasks to force an upgrade.
Existing active homes therefore remain external/old until native-authorized
retirement permits selection. There is no old-release garbage collector and no
cross-version state-schema migration. Unknown state contracts refuse rollback.

Installation leaves an unselected staging directory after hard process death;
retry publishes one verified release without selecting the incomplete directory.
Cleanup is scoped to operation-owned transfer/staging paths. Selection changes
only its durable descriptor; original task/status/inbox/data paths and recorded
worker references stay fixed. No merge/review/provider authority changes.

Use the [documented install/migration/rollback procedure](../self-contained-runtime.md).
Inspect status after an interrupted call, then retry its exact target. Production
review, activation, real-worker acceptance and migration are separate outcomes.
