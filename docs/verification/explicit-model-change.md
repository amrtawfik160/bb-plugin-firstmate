# Explicit execution change

Baseline: queue repair `78c9b01`. This is a separate commit and does not operate
production workers. Parent reviews, activates and confirms the exact requested
worker with its owner before any production invocation.

## Supported operation

Under the owning captain, after activation and renewed confirmation that the
specific stopped worker still needs this change:

```sh
bb firstmate retry c0fdc9c4 --intent execution-change \
  --reason 'User explicitly requested Grok 4.6 xhigh for this existing task' \
  --provider acp-grok --model grok-4.6 --reasoning-level xhigh
```

The tool equivalent is `firstmate_retry` with `intent=execution-change`, explicit
`reason`, and the same provider/model/reasoning fields. These are the reported
selection, not a hardcoded catalog. Current public SDK provider/model/reasoning
catalogs on the source worktree's host must confirm them at invocation.

Explicit intent and a nonempty user-directed reason are required. Reason text
alone never changes authority. The current thread's authoritative execution must
resolve, the requested execution must actually differ, the owner/project must
match, and the original worktree must be ready. Missing intent stays failure
recovery. Missing overrides/reason, unchanged execution, foreign ownership,
unreadable capabilities and invalid selection refuse before stop/archive/spawn.
Execution change refuses a capacity override. The source permission is retained
under the parent's ceiling; this operation grants no merge authority.

Default retry behavior remains: no overrides retries the failed turn; overrides
without execution-change intent use bounded failure recovery. A second recovery
replacement still refuses. Old `relaunches` counts are conservatively treated as
failure recoveries, never retroactively reclassified. Explicit execution changes
leave that count unchanged. A separate monotonic replacement generation uses the
maximum of durable launch history, the crew's generation and legacy counts.
Each replacement gets a distinct launch key even when its failure count stays one.
Legacy metadata recovery with generation greater than one conservatively retains
that consumed recovery history.

## Crash and concurrency handling

`lib/replacement.ts` binds a durable request to its source thread/environment,
intent, reason, target execution, full task/prompt, original crew/history and
recovery count. The request persists in the per-record launch database before
stopping the source. Exact concurrent requests share one operation; different
requests serialize and cannot silently replace a changed worker. Stop/archive
progress is recorded. Unknown creation retains its reservation and seeded exact
generation metadata; retry reconciles that identity before any further create.
A changed target/reason/intent cannot reuse an unresolved request.

The replacement uses the same SDK environment ID. No worktree allocation,
checkout, reset, cleanup, commit, push or forge operation occurs. Original task,
creation time, prior thread IDs, delivery contract, owner/project/home and PR
obligations persist. Full task and original crew snapshots live in the durable
launch record for cache recovery. Retired/deleted source identities refuse.
An archived source is not adopted as the current worker after successful
replacement. An interrupted publication recovers its original source snapshot
and exact authorized request rather than creating another generation.

## Native publication boundary

The old replacement path wrote a fresh generic native metadata file and could
lose the immutable branch and other native fields. Replacement now uses the
explicit BB-only `fm-worker-rebind` seam. Installer inputs, remote manifest and
payload freshness checks include both new helper files on both audited pins.
Old mirrors refuse until refreshed; no native upgrade is required.

Before stop, the helper validates the existing exact BB endpoint, canonical
namespace/project/worktree, source branch contract, filled source brief, native
isolation predicate, captain-intent guard and backend endpoint shape. It uses
native task-set/meta locks, lease authority and atomic publication primitives.
Both audited native sources supply the unchanged isolation predicate. The source
brief SHA persists before stop and is checked again on retry/publication.

Publication changes only endpoint identity, generation and observed execution
fields. It preserves all other metadata, including branch, mode, yolo, native
extra fields and worktree/project paths. If legacy generic metadata lacked a
branch, only the original source brief's immutable branch can supply it. Current
Git HEAD/branch remains untouched and does not become the task branch. Status,
brief, inbox, saved files, commits and outstanding PR obligations are unchanged.
Native review/merge continues to use its own independent current-state gates.

Native registration and crew cache must publish before the replacement launch
becomes running. If a helper/cache write fails, the existing new worker remains
provisioning and its exact request remains retryable. Publication is idempotent
under native locks, including when native metadata succeeded before a cache write
or reload. No alternative `fm-spawn`, raw database edit or forge merge is used.

## Evidence and limits

Tests use the installed SDK fake transport and real SQLite persistence. They
prove a second explicit change succeeds with the same environment and no recovery
allowance consumption, while ordinary second failure and unchanged/missing-intent
calls still refuse. Catalog and owner refusals occur before worker mutation.
Concurrent/uncertain reloads reconcile one exact worker. Native publication plus
cache loss recovers the same generation without another stop/archive/spawn.

Eight native cases execute actual installed helpers/renderers in disposable
homes: ship direct-PR/no-mistakes/local-only and scout at each audited full SHA.
BB model creation alone is fake. Native source, status, branch/HEAD/refs and an
uncommitted saved skill remain byte-for-byte unchanged. Metadata retains the
original `fm/c1` contract while Git remains on `fm/c1-disclosures`. Source branch
collision and a primary checkout refuse without publication. The source checkout
and installed native homes are not changed.

Catalog aliases not advertised by the public SDK refuse explicit change; ordinary
recovery's existing alias policy is unchanged. Missing or conflicting source
metadata, a changed native brief, missing original worktree, unresolved legacy
launch intent or deliberate retirement require inspection/repair first. This
operation does not infer those facts, change the native delivery policy, reset
failure accounting or resume held unrelated tasks. No production model starts in
implementation tests. Parent owns full integration and live acceptance.

Exact validation commands and results:

| Command | Result |
| --- | --- |
| `FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types server.explicit-execution.test.mjs` | 25 passed, zero failures/skips; `/tmp/fm-model-final-new.log` |
| `FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types --test-name-pattern='retry\|replacement\|relaunch\|uncertain replacement' server.test.ts server.launch-delivery.test.mjs` | 22 passed, zero failures/skips; `/tmp/fm-model-final-existing.log` |
| `FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types scripts/native-compat.test.mjs scripts/skill-fidelity.test.ts lib/queue-store.test.mjs server.queue-storage.test.mjs` | 49 passed, zero failures/skips; `/tmp/fm-model-compat-queue.log` |
| `FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types --test-name-pattern='native publication plus\|native rebind refuses\|authoritative deletion' server.explicit-execution.test.mjs` | Three passed after final helper refresh, zero failures/skips; `/tmp/fm-model-final-guard.log` |
| `node --experimental-strip-types scripts/explicit-execution-mutation.mjs` | Three causal mutations killed; source bytes restored |
| `npx tsc --noEmit` | Passed |
| `npm run fidelity -- --native /tmp/fm-launch-pr-verified` | Passed: 33 skills, 12 divergence anchors, seven BB-only fences |
| `bb plugin build .` | Passed; project SDK remains pinned at 0.4.104 |
| `git diff --check` | Passed |

The three causal mutations restore the blanket recovery guard, derive the launch
key from the unchanged recovery counter, and remove native branch collision
validation. They respectively kill the second explicit change, distinct-generation
replacement, and branch-preservation refusal tests. The fixture for existing
native replacement tests now has an actual source repository/worktree and valid
metadata instead of a stale source brief and nonexistent worktree; it executes
both guarded preflight/publication through real host shell transport.

The source-identity deletion test reports a core deletion after creation and
proves native rebind does not run, with the source cache, metadata and all work
preserved. Scratch `/tmp/fm-launch-pr-verified` received an overlay refresh only;
its native source pin was not upgraded (`/tmp/fm-model-scratch-install.log`). All
other native cases install current helpers into disposable audited clones.
Parent must refresh each applicable BB mirror before activation of this commit;
the existing audited old-pin installer suffices. No production operation occurred.
