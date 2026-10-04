# Launch reliability and persistent PR delivery

Baseline: `95f589359627ff65b859f3ae5393b153dda273ed`.
Implementation/native compatibility commit: `87507587ebace16e1c3a619e8594e16427e9918e`.
Implementation checkout: `/root/github_projects/bb-plugin-firstmate-launch-pr-lifecycle`.
The baseline's existing server, README, review and reproduction changes are preserved.

This document is the recovery checkpoint and review matrix. Initial implementation validation and the parent-review corrections are recorded below. No live plugin was installed or reloaded, no real worker/model task was launched, and no PR was created or merged.

## API and native contract

- Installed dependency and lockfile contract: `@get-bb/plugin-sdk` **0.4.104**. `bb --version`: **0.44.0**.
- Public SDK declarations and live CLI help were consulted for creation metadata, project defaults, environment selection, reasoning levels, events, queued inputs, SQLite storage, background schedules and disposal. No private SDK transport or invented hold API is used.
- Audited native Git object: `1f3e769616fdf9f31f85f4c3e6a9f71606634238`. This is an exact pin, not a moving upstream HEAD.
- `/root/firstmate` remains at deployed commit `2d833ff147cd26a5c461e914e06854e0eb2707ce`. The source checkouts were only read. Scratch clones and scratch fleet fixtures were used for native validation.
- Dependency verification uses a local `node_modules` symlink to the original checkout's installed dependencies. No shared dependency was changed. The Git ignore pattern covers this symlink as well as a directory; the symlink is not committed.
- `bb plugin build .` succeeds against the pinned package. It reports that this host's bundled SDK is **0.5.29**. The dependency pin was deliberately preserved. Build success is not live runtime acceptance.

## Requirements matrix

| Requirement | Implementation and code | Behavioral evidence | Boundary |
| --- | --- | --- | --- |
| A: atomic worker role | [creation bridge](../../server.ts), [native adapter](../../overlay/bin/backends/bb.sh) pass role, task, native home, shape, key and generation in `sdk.threads.spawn` metadata | Initial agent configuration has crew restrictions before creation returns; seeded secondmates have captain role and child home; parent permission caps and hidden visibility are asserted | No supported pre-turn hold. Native post-creation guards still require the prepared environment |
| A: durable creation and uncertain outcomes | [launch store](../../lib/launch.ts) persists reservation and creation claim before external spawn; returned identities are written promptly | Reservation-write failure makes zero external calls; identity-write failure, cancellation, response deadline, late identity and separate-process restart retain capacity; reload recovers exact metadata without respawn | Missing response or bounded inventory absence never proves that no worker exists |
| A: provisioning and disposal | [bridge/recovery integration](../../server.ts) bounds provisioning reads and uses disposal/caller abort signals; native admission metadata proves readiness | Reload during creation, blocked inventory cancellation and late real worker tests; no timeout stop/kill | Slow or unknown workers stay provisioning/uncertain and retain their reservation |
| B: shared admission | [launch reservation transaction](../../lib/launch.ts) and shared launch capacity integrate dispatch, queue, promotion, bridge and replacement | Four active workers with cap five plus two requests create one worker; concurrent same-item queue creates one worker; unfinished scout creates none; finished scout at cap creates none | BB host limits and native gates still apply. Explicit over-cap authority uses the existing authorized retry path |
| B: recovery and retention | Replacement reserves a generation, reconciles before stopping, archives the prior thread before creation; successful handoff updates launch accounting | Uncertain replacement reuses its reserved slot at capacity; forgotten running workers and transferred reservations still count | Native `fm-control` has no verified BB recovery classifier. SDK replacement is a documented BB adaptation, using the existing environment and full native brief |
| B: promotion | [complete scout artifacts](../../lib/scout-report.ts) and promotion eligibility in [server](../../server.ts) require idle successful scout and readable durable report | Full long report survives reload, with its final verdict; no 2,000-character truncation; exact project delivery mode and ownership preserved | Native report stays in its original file; compatibility report uses scoped SQLite artifact accessed by `scout-report` |
| C: coherent execution | [execution selection](../../lib/execution-selection.ts) resolves matching source/environment and host as one tuple; provider validation uses that host | Host-A-only source refuses host-B execution; replacement validates reasoning on its reused environment's host before stopping | Missing matching source refuses, rather than forwarding a foreign-host path |
| C: capabilities and defaults | [policy types](../../lib/policy.ts), schemas/help and adapter support all eight SDK reasoning values; actual execution is read after creation | Unsupported isolation/scheduling/proof requests make zero reservations/spawns; provider capability refusal; resolved replacement model/reasoning persisted | Omitted values use project defaults. Unreadable actual defaults remain unresolved. Selected model aliases are forwarded, not replaced by a hardcoded catalog |
| C: scheduling/visibility | Native ship shared environment is refused before side effects; hidden visibility reaches creation; `sendAt` schema is unsupported | Native bridge hidden creation and unsupported-option regressions | Backlog `waitUntil` means eligibility. There is no implicit timed dispatch or silent scheduling acceptance |
| D: independent deliverable register | [PR store/reconciler](../../lib/pr-delivery.ts) uses indexed SQLite per canonical repository+PR record, with task/project/manager/worker references, contract, head and merged commit | 1,000 records exceed one KV value while list remains bounded; real SQLite reopen and separate-process launch recovery; worker forgotten/reload leaves PR pending | GitHub canonical identities only; no claim of generic forge support |
| D: lifecycle/current head | Draft/checks/review/changes/approval/merge/verification/disposition are typed statuses; new head cancels obsolete readiness/notification; approval must name current head | Pending→passing, failure, changes requested, old-head approval invalidation, completion notice, closed-unmerged and stale forge tests | Unknown forge result preserves stale last-known state; it cannot mean merged or abandoned |
| D: persistent follow-up | Supported minute schedule rotates discovery/recovery and bounded due records; error backoff; durable notification attempts/acceptance and markers | Worker ends while checks are pending; later green checks wake manager; receipt acknowledgement keeps open PR; unchanged waiting creates no model send; overdue action sends one durable reminder | Polling is bounded; larger cohorts have proportional latency. Hidden notices do not establish token savings |
| D: crash/dedup/failure | PR notice marker persists through native wake queue, held input, SDK queued input and event reconciliation; fresh-record callbacks preserve handoff and verification | Failed send stays retryable; duplicate events/reload do not resend successful notice; write-after-acceptance fault reconciles before resend; in-flight callbacks cannot overwrite new owner or completed verification | SDK has no idempotent-send key. Ambiguous send with unreadable/incomplete evidence stays pending; see limits below |
| D: scope/ownership | Fleet, session, bearings, RPC and consolidated `deliveries` tool/CLI show unresolved work; explicit handoff and previous-owner assignment are scoped | Lost/archived/deleted manager surfaces owner-needed; forgotten author handoff; cross-project refusal; conflicts beyond first page; explicit unassigned recovery | Read-only project visibility never transfers ownership. Other captains' PRs and scout report URLs are not automatically claimed |
| D: authority/completion | Existing native guarded merge remains the merge route; follow-up preserves agreed native review/validation and authorized continuation; contract is immutable on re-register | Approval-required records stay pending; explicit owner/reason abandonment; merged commit evidence satisfies only agreed verification; PR-only task completes with non-draft PR | No automatic merge, new merge grant or implied deployment. Verification is manager-recorded evidence |
| E: native loader/update | [all four patches](../../overlay), [installer](../../overlay/install-bb-backend.py), [refresh tool](../../scripts/refresh-native-pin.mjs) and [manifest](../../lib/upstream-surface.ts) target the audited pin | Exact four-patch application; installer/verify; clean tracked native tree; actual BB backend source load; loader mutation reproduces failure | Positional `set --` clause changes with the native pin; offsets/fuzz are rejected |
| E: native fidelity/options | [vendored snapshot](../../native-snapshot/1f3e7696), pinned skill headers and adapted anchors updated; [backend docs](../../overlay/docs/bb-backend.md), [README](../../README.md) corrected | Fidelity: 33 skills, 12 authorized divergence anchors, seven authorized BB-only fences; opt-in native tests | Wait-no-turns, watcher continuity, bounded mergeability retry and completion inventory preserved. No home-local preferences silently enabled |
| F: structure/delivery | Launch, execution selection, scout report and PR reconciliation are cohesive modules; replaced orphan/title adoption, late marking, timeout kill and outer replacement-cap path removed | TypeScript, full tests, build/RPC schema, whitespace and mutation checks | Existing server integrations remain; no unrelated cosmetic rewrite or second policy owner |

## Validation

All commands run from the implementation checkout. `/tmp/fm-launch-pr-verified` is a fresh native scratch clone detached at the audited pin. Native tests were inspected first: they create their own scratch state, use fake BB adapters/SDK harnesses, and do not run model workers or touch live fleet state.

### Full suite and affected schema

```bash
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified \
FM_TEST_HOME=/tmp/fm-launch-pr-verified \
FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb \
FM_CLASSIFY_LIB=/tmp/fm-launch-pr-verified/bin/fm-classify-lib.sh \
npm test

npx tsc --noEmit
bb plugin build .
git diff --check
```

Initial implementation full-suite result: **626 tests passed**, zero failed, zero skipped. Duration: **168882.645806 milliseconds**. The count increased from the baseline's 590 tests because 36 regression tests were added. All eight baseline opt-in skips ran successfully against scratch native state. TypeScript, build and whitespace checks exited zero.

Local captured output: `/tmp/fm-full-final.log`, `/tmp/fm-new-final.log`, `/tmp/fm-retry-final.log` and `/tmp/fm-mutation-final.log`. These are review aids; the commands above reproduce the results without relying on the temporary logs.

Fleet RPC output is parsed against `rpcContract.fleet.output` in the background delivery test. The new RPC field defaults to an empty array for reload compatibility. The build emits server and frontend assets.

```bash
node --test --experimental-strip-types \
  lib/launch-delivery.test.mjs server.launch-delivery.test.mjs
```

Result: **36 passed**, zero failed, zero skipped. These cover required PR transitions, actual durable restart, notification faults, scope, admission and promotion. Six affected pre-existing replacement tests also pass:

```bash
node --test --experimental-strip-types \
  --test-name-pattern='retry with a new reasoning|long briefs|relaunch stops|dispatch records its title|native replacement retry' \
  server.test.ts
```

### Native proofs

Scratch setup used local clone and detached checkout, without changing the source clone:

```bash
git clone --quiet --local --no-hardlinks /root/github_projects/firstmate /tmp/fm-launch-pr-verified
git -C /tmp/fm-launch-pr-verified checkout --quiet --detach 1f3e769616fdf9f31f85f4c3e6a9f71606634238
python3 overlay/install-bb-backend.py --home /tmp/fm-launch-pr-verified --project-id proj_1
python3 overlay/install-bb-backend.py --home /tmp/fm-launch-pr-verified --project-id proj_1 --verify
git -C /tmp/fm-launch-pr-verified status --short --untracked-files=no
```

Results: successful atomic mirror installation; verify reports siblings, HEAD, overlay and frozen copies current; tracked native status empty. Re-installation after the backend documentation update also passed.

```bash
FM_HOME=/tmp/fm-launch-pr-verified \
FM_ROOT_OVERRIDE=/tmp/fm-launch-pr-verified \
bash -c '. /tmp/fm-launch-pr-verified/bin-bb/fm-backend.sh; fm_backend_source bb; declare -F fm_backend_bb_create_task'

FM_TEST_HOME=/tmp/fm-launch-pr-verified \
node scripts/patch-drift-check.mjs --ref 1f3e769616fdf9f31f85f4c3e6a9f71606634238

npm run fidelity -- --native /tmp/fm-launch-pr-verified
bash -n overlay/bin/backends/bb.sh
```

Results: backend source exposes `fm_backend_bb_create_task`; four patches apply exactly; fidelity passes 33 skills/12 anchors/seven fences; shell syntax passes.

Pin/manifest/snapshot refresh is reproducible without checking out or editing native:

```bash
node scripts/refresh-native-pin.mjs /root/github_projects/firstmate 1f3e769616fdf9f31f85f4c3e6a9f71606634238
```

It reads native Git objects. Re-running it at the audited pin was byte-identical across skill files, snapshots, pin and manifest. Adapted policy anchors still require human audit and fidelity verification. The manifest names **194 callable scripts** and **22 support files/adapters**.

### Reproductions and causal tests

```bash
node --experimental-strip-types docs/verification/launch-review-probe-2026-10-04.mjs
FM_TEST_HOME=/tmp/fm-launch-pr-verified node scripts/launch-pr-mutation-check.mjs
```

Results: concurrent cap probe creates **one worker**, with the second request refused at cap five. Active scout promotion creates **zero workers**, with a finished-successful-scout refusal. Successful-scout-at-cap is asserted separately by the regression suite.

Six isolated mutations reproduce assertion failures: remove atomic admission, remove creation role, accept wrong-host source, retire PR on acknowledged notification, retain old-head readiness, and revert the positional native loader. The mutation script copies the checkout into a temporary directory, runs existing behavioral assertions, restores copies and deletes scratch. It never installs a plugin or starts a real worker.

## Limits and bounded parent follow-up

1. **Final live acceptance remains with the parent.** The parent reports 17/17 live-mirror checks at candidate `3282ed6` on its isolated BB server/host. It created and removed one real ship and one real scout without production state changes. That proof predates these corrections; final acceptance must use the new commits. This implementation agent has not installed/reloaded a live plugin or launched real workers.
2. **No pre-turn hold/cancel API exists in SDK 0.4.104.** Atomic role metadata fixes captain-tool exposure. A prepared environment is still needed for native isolation guards. Creation/provisioning stays recoverable; no native readiness is claimed before guard publication.
3. **Unknown create outcomes hold capacity.** Discovery pages at most 500 scoped threads. Safe retries reuse task identity/generation. No force-release treats incomplete inventory as proof of absence. Permanently unreadable workers can need operator diagnosis through `launches` and BB inventory.
4. **Notification exact-once is bounded by core evidence.** Accepted messages have durable identity and accepted-write-fault recovery. Definite failure can retry. Ambiguous failure reconciles held/queued/event markers first. Event inventory is bounded to 100 rows. Incomplete evidence leaves the obligation pending. SDK lacks an idempotent-send key, so a core RPC accepted arbitrarily late after a complete absence observation has no absolute exactly-once guarantee.
5. **Monitoring requires a loaded plugin.** Supported schedules resume after reload and read durable records. Each pass reads ten due PRs, ten worker discoveries, ten launch records and ten historical done references, plus up to 20 notification retries. Forge backoff grows from one minute to one hour. Large cohorts increase latency; obligations remain visible and explicitly reconcilable.
6. **Forge/review conservatism is deliberate.** Only GitHub PR URLs are canonicalized. A repository-required review remains pending until satisfied. Unknown review evidence stays unresolved and asks an authorized manager to continue through native gates; it does not invent external GitHub approval for direct-PR or no-mistakes work. Approval cannot replace native required checks or authority. Closed-unmerged needs explicit replacement/reopen/abandonment disposition.
7. **Recovery is an explicit BB adaptation.** SDK replacement reuses the existing environment/full native brief and stops/archives the previous thread before creation. The native BB recovery classifier is not claimed verified or rewritten to manufacture approval. Existing brief, ownership, machine permission, isolation and merge gates remain in force.
8. **Parent acceptance stays bounded.** After review, parent can authorize one ship and one scout in a throwaway BB project with a source matching its host. Check initial metadata/role, native guard publication and slow/reload recovery. Verify one owned PR through pending checks, later readiness, handoff and reload. Do not merge without existing authority. Existing live scripts that select an unrelated temporary checkout must first supply/register a matching project source for the new execution-selection contract.

## Recovery checklist

1. Read this matrix and `git log 95f589359627ff65b859f3ae5393b153dda273ed..HEAD`.
2. Inspect only this checkout's uncommitted state. Do not reset the baseline or source checkout.
3. Use the exact commands above for independent review. Do not repeat live acceptance without parent authority.
4. Review the implementation/native compatibility commit, then the verification evidence commit.
5. Preserve the baseline..HEAD range and remaining live acceptance boundary when handing off.


## Parent-review corrections, 2026-10-04

Correction commit: `0396b2e` (all nine findings). The following documentation
commit records final validation. Full implementation range starts at the baseline
above; parent can review corrections with `git diff 3282ed6..HEAD`.

Parent found blocking defects after the initial implementation. The changes below
preserve both existing implementation commits and the baseline. Each regression
uses the registered plugin factory or an actual patched native setup function.

| Finding | Correction and code | Causal validation |
| --- | --- | --- |
| 1: recovery lost delivery contract | [server](../../server.ts) resolves original launch/metadata contract during adoption, retry, queue, routing, promotion and completion recovery; conflicting or unreadable launch contracts refuse | Factory reload exercises both metadata adoption and dispatch recovery, then discovers a merged PR that remains `merged-needs-verification` |
| 2: hung schedule/disposal | Discovery, launch/history recovery and notification reconciliation propagate cancellation and bounded reads; each item has a 15-second total budget; schedule tracks its pending promise and releases it on every exit | Actual registered schedule handles hung SDK discovery, advances to another PR, runs again, and disposes promptly during discovery or notification recovery |
| 3: late terminal leak | Terminal creation is inside cleanup scope; only its close callback is retained while API context is live; a late identity closes once after cancellation/disposal | Deferred creation + disposal + late reply makes one force-close and zero terminal reads or manager sends |
| 4: invented external approval | [delivery reconciliation](../../lib/pr-delivery.ts) separates required repository review from unknown evidence; authorized unknown evidence requests the existing native review/validation path with `waiting-native-gates` | Unknown evidence never becomes ready-to-merge, required review/changes-requested remain blockers, and default native continuation does not require self-approval on GitHub |
| 5: unadmitted worker reported running | One shared admission predicate requires ready environment, selected host and exact native `bb_thread_id` publication | Factory invokes the real creation bridge, then injects native post-creation guard failure; worker stays provisioning, one spawn occurs, and its cap slot stays held |
| 6: partial handoff split ownership | Task-associated records exclude failed reparenting; explicit orphan-only transfer remains supported and reported separately | One successful worker, one failed worker and one orphan: failed task keeps worker, decision, launch and PR owner; retained authors participate in reparent gates even after forget |
| 7: register ignored original contract | CLI/tool registration inherits original contract and refuses an explicit mismatch | Both actual entrypoints without requirement retain `merged-and-verified`; queue and promotion carry that requirement into creation metadata |
| 8: forget destroyed continuation | Per-record SQLite stores complete trusted worker/task continuation; plain forget keeps native task authority and environment; destructive retirement refuses outstanding delivery. Scoped merge/tell/retry resolve retained records; requested fixes restore worker role and unarchive through public SDK APIs | Forgotten worker + plugin reload + archived author accepts an authorized fix instruction; guarded merge remains callable and reports a native required-check refusal. No raw GitHub merge occurs. Foreign managers cannot resolve this continuation |
| 9: startup cd caused second turn | [backend patch](../../overlay/firstmate-bb-backend.patch) skips shell cd only inside native startup workspace handoff for BB. Subsequent cwd assertion still runs | Applies exact patch to audited source, executes native startup function with zero model input, and proves explicit captain cd instructions still reach adapter delivery |

The four older orphan tests now require a truthful provisioning refusal when
native admission metadata is absent. Adoption still retains the original worker
without duplicating it. The existing squash-merge retirement regression still
passes: confirmed merge satisfies a merged-only contract; required verification
and unrelated PR obligations remain outstanding.

### Validation of the corrections

- Targeted launch/delivery tests: **46 passed**, zero failed/skipped.
- Affected orphan/retirement tests: **7 passed**, zero failed/skipped.
- Fifteen mutation checks pass. They remove each original reliability guard and
  each parent-review fix in isolated copies. End-to-end cancellation mutation
  reproduces hung disposal; startup mutation produces extra model input.
- `npx tsc --noEmit`, `git diff --check`, `bb plugin build .`, strict scratch
  overlay install/verify, actual BB backend source load, four-patch drift check,
  and `npm run fidelity -- --native /tmp/fm-launch-pr-verified`: exit zero.
- Build reports the host CLI's bundled SDK as 0.5.29. The project's public API
  contract and installed declarations remain pinned to 0.4.104; no upgrade was
  performed. Fleet RPC output still parses against its registered schema.
- Final full-suite result for the corrections: **636 passed**, zero failed,
  zero skipped. Duration: **162581.765579 milliseconds**. This is 10 additional
  behavioral tests beyond the initial 626-test implementation; all eight native
  opt-in tests ran against scratch state.

Exact commands are the full-suite/native commands above plus:

```bash
node --test --experimental-strip-types lib/launch-delivery.test.mjs server.launch-delivery.test.mjs
FM_TEST_HOME=/tmp/fm-launch-pr-verified node scripts/launch-pr-mutation-check.mjs
```

Local review logs: `/tmp/fm-review-target-verified.log`,
`/tmp/fm-review-affected.log`, `/tmp/fm-review-mutation-complete.log`, and
`/tmp/fm-review-final-acceptance.log`. These are scratch evidence, not required
inputs to reproduce verification.

### Remaining acceptance boundaries

1. Point the CLI at the parent's isolated BB server. Run `bb machine list --json`
   and choose that server's connected host ID. Set `FM_BB_MACHINE` explicitly;
   the live script refuses a missing value before creating scratch records.
2. Parent reruns `live-mirror-check` with explicit provider/model/reasoning and
   the new candidate. Check startup events contain one task prompt and no setup
   cd prompt. Preserve native cwd/isolation refusal evidence.
3. Parent verifies persistent PR follow-up through pending checks, later native
   continuation, worker forget, manager handoff and plugin reload. Merge remains
   subject to already-existing authority and native checks.
4. SDK 0.4.104 cannot cancel a host terminal creation before its identity returns.
   A command might start during that RPC; cancellation prevents plugin polling or
   continuation, and a late identity triggers force-close. If core never returns
   an identity, plugin-only cleanup cannot prove that no terminal exists.
5. Older forgotten records without a trusted continuation snapshot or native
   task state cannot acquire invented authority. They remain visible obligations
   requiring explicit recovery from actual native evidence. New forget paths
   preserve this linkage and refuse destructive retirement while it is needed.
