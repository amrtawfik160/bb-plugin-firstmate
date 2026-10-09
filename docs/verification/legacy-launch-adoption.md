# Explicit legacy launch adoption

Status: implementation complete; disposable native regressions and mutation checks passed.
Production integration and the concrete captain repair belong to the parent.

## Operator procedure

Run in the owning captain's original BB project. The captain must have an
explicit native-home binding. The reservation must retain its original native
home, host, project checkout, task, generation, mode and delivery requirement.

1. Inspect `bb firstmate launches list --json`. Select the exact unresolved task.
2. Inspect the existing worker through BB. Confirm its exact identity and worktree.
3. Run `bb firstmate launches adopt <task-id> --thread <thread-id> --check --json`.
4. If eligible, repeat without `--check`. No worker turn or merge starts.
5. Inspect `bb firstmate crew <task-id> --json`. Delivery and merge remain separate.
6. Register each agreed PR separately with `deliveries register --crew <task-id>
   --url <canonical-url>`. Do not infer every report URL is this task's deliverable.
   Existing registrations retain their contract and state.
7. Continue independent review and the existing native guarded merge route only
   under the captain's actual authority. Adoption grants no merge authority.

For the supplied case, the proposed exact command is:

```sh
bb firstmate launches adopt 574cbb72 --thread thr_example02 --check --json
bb firstmate launches adopt 574cbb72 --thread thr_example02 --json
```

These commands have **not** been run on the supplied captain or worker. The
already-merged sibling task and all original/intermediate/successor branches
remain outside this operation. No PR lookup or forge mutation occurs in adoption.

## Repair boundary and evidence

`mark-crew` changes BB role metadata only. Seeded launch reconciliation needs an
exact launch key. Native `fm-spawn --relaunch` can allocate an endpoint or send a
turn. None provides the requested legacy repair. The new CLI uses public SDK
thread, project, environment and immutable initial event reads, then a marked
BB helper that cannot invoke spawn/send/retry or worktree/forge mutation.

The helper runs on the original host and uses both audited native sources:
`2d833ff147cd26a5c461e914e06854e0eb2707ce` and
`1f3e769616fdf9f31f85f4c3e6a9f71606634238`. It extracts only the identical,
hash-checked `spawn_worktree_isolated` function from native `fm-spawn.sh`; it does
not source or execute that script. Native filled-brief, task endpoint, lease,
task-set/meta locking and backlog publish/dispatch functions remain authoritative.
Initial worktree freshness cannot apply to a worker that has already made work.
Registration records `bb_admission=explicit-repair` and
`bb_original_admission=unconfirmed`; it never fabricates original admission.
Absent original native merge authority is not reconstructed from current defaults:
the repaired native ship metadata records `yolo=off`.

Authoritative SDK evidence must prove the exact parent/project, ready active managed
isolated environment on the original host, exclusive thread binding, and original
project source. The first `client/turn/requested` event must be a thread start and
contain the native task region verbatim plus exact status/inbox paths. The native
brief must name the original checkout or the exact legacy scaffold project token
`crew`, with the same Setup scaffold appearing once in the immutable first prompt.
`crew` is not repository evidence. The original reservation checkout must still be
an SDK project source on the original host; its origin and the worktree origin
must agree. Any other scaffold project name refuses, even if repeated in the
first prompt. Mode, status and branch/report namespace must still agree.
The source ship branch must exist and is preserved as native metadata `branch=`.
The current Git branch can differ and is never changed; it is observed separately
as `bb_adopt_observed_branch=`. Retrying refuses a conflicting native `branch=`.
The helper result's `branch` and `head` describe current Git observations, not a change
to the original native delivery contract or ownership of every referenced PR.
The initial event's resolved model, reasoning and permission settings remain
evidence, not a request to change the worker. Known original execution selections
must agree. Missing legacy model fields are populated in repaired native metadata
from that original event, rather than current project defaults.

Conflicting metadata, native task records, another worker for this task, another
native task using this endpoint, missing provenance, primary checkouts, tombstones,
archived/deleted workers, native closed/held backlog rows and retirement markers
refuse before registration. Native status, brief, inbox, artifacts, commits, dirty
files and branch refs remain intact. No done/resolved status line is written.

The durable reservation journals exact worker/environment identity, immutable
prompt/brief hashes, core creation time, original error/time and publication phase
before native publication. Native publication and backlog pairing are idempotent
under native locks. BB role metadata and the crew cache follow. An interruption
retains provisioning capacity; background reconciliation cannot certify the
unfinished repair. Repeat the same exact command after reload to finish. A
different worker/proof cannot replace that journal. Outstanding PR records are
independent and are never cleared or rewritten by adoption.
The full immutable task region is stored per launch in SQLite, outside the KV
value limit; the crew cache carries only its existing bounded inline prefix.

## Bounded limits

- Only unresolved generation-one native ship/scout launches with a preserved
  contract are eligible. Completed repair retries retain that same identity.
- Ordinary native brief scaffolds are supported. Herdr laboratory scaffolds need
  their separate lifecycle proof and refuse here.
- Canonical home/data/state layout is required. Relocated paths, unresolvable
  origin identity, missing first event, changed native task text or unsupported
  source/predicate refuse instead of guessing.
- SDK identity reads have individual five-second deadlines and one sixty-second
  operation deadline, linked to caller cancellation and plugin disposal. Host
  guards have twenty-second transport deadlines and bounded native backlog calls.
- Worker uniqueness inventory is at most 200 rows in pages of 50. Native endpoint
  inventory is at most 500 records. An unexhausted inventory refuses.
- `--check` inspects eligibility and takes native coordination locks but does not
  publish registration or a reservation journal. The publication rechecks evidence.
- CLI output reports the existing worker's actual core status and preserved native
  status. A registered idle worker is not asserted to have succeeded or merged.
- The concrete production repair still requires the parent's real-host verification.

## Verification

No real model launch is permitted in this implementation checkout. Native proofs
execute real audited scripts against disposable homes and repositories; only BB
transport/identity is fake. The parent owns real-host acceptance and the full final
integration suite.

The regressions reproduce uncertain generation-one creation with no native meta
and an unmarked, completed BB worker. Both audited native versions exercise ship
direct-PR/no-mistakes/local-only and scout registration. Native endpoint preflight
finds the published identity. Tests assert unchanged HEAD, branch refs, dirty work,
source brief/status and multiple durable PR obligations, and zero SDK
spawn/send/retry/update/stop/archive/delete calls. No forge API is invoked.

Faults before reservation publication, after native registration, before crew
cache publication and before completion leave a retryable durable journal. Actual
plugin reload reconstructs those stages and finishes the same endpoint. Real native
metadata/backlog pairing failure preserves metadata and retries only the native
pairing, on both pins. Closed native backlog rows refuse. Hung SDK identity reads
settle on disposal before publication. Existing seeded recovery/deletion/cap/
promotion/PR lifecycle tests remain part of the affected validation.

`scripts/launch-adoption-mutations.mjs` requires an otherwise idle isolated
checkout. It temporarily changes one guard, runs its behavioral assertion and
restores the original source bytes. Six mutants are killed: native isolation,
repository identity, source-project correspondence, BB parent identity, BB task
metadata collision, and premature readiness during interrupted adoption.

Final validation:

| Command | Result / evidence |
| --- | --- |
| `FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types scripts/launch-adoption.test.mjs scripts/native-compat.test.mjs server.launch-delivery.test.mjs lib/launch-delivery.test.mjs` | 75 passed, zero failed/skipped. `/tmp/fm-adoption-affected-final.log`. Includes 20 new adoption tests. |
| Selected server tests (exact command below) | 19 selected tests passed, zero failed/skipped. `/tmp/fm-adoption-server-affected-final.log`. Remote installer bundle/manifest and replacement paths included. |
| `FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node scripts/launch-adoption-mutations.mjs` | Six mutants killed. `/tmp/fm-adoption-mutations-final.log`. All source bytes restored. |
| `npx tsc --noEmit` | Passed against pinned SDK declarations `0.4.104`. |
| `npm run fidelity` | Passed: 33 skills, 12 divergence anchors, seven BB-only fences. |
| `bb plugin build .` | Passed. `/tmp/fm-adoption-build.log`. Build reports host-global SDK `0.5.29`; repository SDK remains `0.4.104`, unchanged. |
| `git diff --check` | Passed. |

```sh
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types --test-name-pattern='installer|mirror|payload|remote installation|native replacement|real spawn' server.test.ts
```

The full `npm test` integration run belongs to the parent, as requested. No frontend
or RPC schema changed. No production native home, source checkout, live fleet,
worker turn or PR was modified. Production activation and real-host repair of the
supplied task remain pending parent review/acceptance.

| Required repair invariant | Implementation / causal evidence |
| --- | --- |
| Exact owner/project/home/thread/host/environment and execution provenance | `lib/launch-adoption.ts`; SDK refusal matrix, parent/task-metadata mutants. |
| Existing dirty isolated worktree belongs to original repo; source task unchanged | `overlay/bin/fm-launch-adopt.py` and `.sh`; both native pins, isolation/repo/source-project mutants, unchanged HEAD/refs/files assertions. |
| Native registration and backlog pairing without allocating or prompting | Native locks, predicate, brief/endpoint/backlog seams in `.sh`; real native preflight and interrupted pairing proofs on both pins. |
| Immutable contract, creation history and retry-safe publication | `lib/launch.ts` transaction/journal/per-record task storage; four factory publication faults, actual reload, premature-readiness mutant. |
| Crew read-through and separate outstanding PR obligations | `server.ts` CLI/cache/full-task read-through; actual `firstmate_crew`, two PR records unchanged, no forge call. |
| Installer/remote refresh/stale helper detection without native upgrade | `OVERLAY_INSTALL_INPUTS`, installer owned payloads and shared prompt fixture; selected installer/mirror/remote/replacement tests. |

## Parent review corrections: legacy project token and immutable branch

The old adapter used the exact `crew` Setup token for the supplied task. The
earlier checkout-only guard would refuse that valid legacy evidence. Both audited
native versions now accept this token only with matching immutable prompt Setup
and the original SDK project-source/host and Git origin checks described above.
The refusal matrix runs with this legacy token and still rejects mismatched
project source, arbitrary matching prompt/source project names, and a differing
initial Setup. The actual plugin factory tests publish registration, read
`firstmate_crew`, preserve two independent PR obligations and repeat after reload.

Native metadata `branch=` now preserves `Ship branch:` from the source brief.
The original implementation incorrectly wrote the current Git branch there.
Both-pin regressions give the successor branch a distinct commit, publish the
original branch contract, then run the real native `fm-review-diff.sh --stat`.
Review resolves the original branch; HEAD, refs, dirty files, status and brief
remain unchanged. Fetch in this test is redirected to a disposable local source.
No remote forge is accessed. A retry with conflicting `branch=` refuses.

Bounded correction validation:

```sh
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types scripts/launch-adoption.test.mjs
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types --test-name-pattern='real native adoption|native immutable branch' scripts/launch-adoption.test.mjs
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node scripts/launch-adoption-mutations.mjs 'source project' 'legacy generic token' 'immutable setup correspondence' 'immutable native branch' 'existing branch collision'
npx tsc --noEmit
npm run fidelity
bb plugin build .
git diff --check
```

The adoption suite passed 24 tests with zero failures/skips
(`/tmp/fm-adoption-correction-tests.log`). Final ship/scout mode and native review
checks passed 10 selected tests with zero failures/skips
(`/tmp/fm-adoption-correction-branch-final.log`). All five selected mutants were killed
(`/tmp/fm-adoption-correction-mutations.log`). Typecheck, fidelity and build passed
(`/tmp/fm-adoption-correction-{tsc,fidelity,build}.log`). Diff check passed.
SDK pin remains unchanged.
Parent owns final full-suite and real-host acceptance. These corrections do not
change the procedure or its existing limits; production repair remains pending.
