# Queue storage and exact native reconciliation

Baseline: `8ca0ccc`. Queue changes only. Production acceptance and operations belong
to the parent; this implementation does not read production task details, mutate
native homes, dispatch production work or contact a forge.

## Storage and migration

`lib/queue-store.ts` uses the public SDK `storage.database()` API from SDK 0.4.104.
Each queue item has its own SQLite row. Identity is owner + project + task ID.
Unattributed legacy owners remain unattributed. SQL ordinals retain the original
array order; new tasks prepend. Reads page 100 rows at a time without cutting off
history or dependency lookup. Dependency resolution stays within owner/project.

The first queue read loads the complete legacy `queue` KV value. Strict schema
validation and duplicate identity checks run before one synchronous SQLite
transaction inserts every item and its completed migration marker. The transaction
also retains the original serialized value, SHA-256 and original record count.
The KV value remains unchanged as additional evidence. No asynchronous operation
runs inside a transaction. A malformed array, unknown field, duplicate scoped ID,
KV read failure or SQL write failure propagates an error; none becomes an empty
queue. Migration failure rolls back all rows and the marker. Another instance
rechecks the marker inside its transaction. Once committed, reload never imports
legacy KV again, so pruning cannot resurrect old records.

Mutations insert, patch or delete exact rows, or transform selected rows in one
transaction. They do not write stale whole-inventory snapshots. Captain pruning
preserves foreign records. Completion uses the exact crew owner/project/task,
and explicit handoff retains original native home and execution/delivery fields.
A late dispatch publication cannot change terminal queue history back to dispatched.
No other ledger moves storage. The existing `queueOwner=kv` setting name remains
compatible; its label now identifies SQLite.

All supported queue fields and full task text remain durable. New titles must fit
500 characters and the combined task must fit the existing 4,000-character launch
constraint. Oversize input is refused before filing, never truncated. Migration
retains even longer historical content; dispatch refuses an oversize full task
while retaining its record.

## Native partial outcomes and supported repair

Native scripts still own backlog transitions and launch admission. New adds save
the entire immutable queue request first, including a native-publication-pending
flag. Native add success publishes the exact backlog ID. An uncertain native
outcome or a failed publication keeps the saved request visibly gated. An adopted
native queued task also persists before dispatch. No SQLite storage failure before
those durable writes can invoke a native add or create a worker.

Inspect the native row and worker evidence before repair. Run under the owning
captain with its exact project:

```sh
bb firstmate queue reconcile <task-id> --project <project-id> --json
```

`firstmate_queue action=reconcile queueId=<task-id> projectId=<project-id>` is the
same operation. For a saved pending add it reads the exact native ID and checks
its title/kind. It does not repeat add. For a native in-flight or done task whose
old queue write failed, it requires exactly one registered crew and a running
launch reservation, matching owner/project/home/task/thread, the authoritative BB
thread parent/project, seeded metadata, and native `bb_thread_id`. It rejects
retired/deleted, unadmitted, missing, ambiguous and conflicting identities. It
retains the full original crew task and execution/delivery contract. An orphan
record stores the exact original launch task in `detail`; that record is already
dispatched and cannot launch again. Existing records preserve their original
detail, dependencies, gates, creation time and options. A handoff keeps the
original task home through its owned durable linkage.

This handles an already-running task after an old post-launch queue-save failure.
It performs no spawn, send, retry, stop, archive, native add/start, worktree action,
branch change or forge mutation. Queue registration is distinct from PR delivery
and does not grant merge authority. A subsequent dispatch of the repaired task
refuses its dispatched status, including after reload.

A queued native-only row has **no proof of lost BB detail/options**: the old add
projected only a short title and kind. Existing native-only dispatch adoption is
appropriate only when that native row is itself the complete agreed task. It
cannot recover a failed BB add's original contract from a similar title. Do not
retry add or dispatch such an orphan based on a title match.

For that case, inspect the exact native ID in the owning captain's isolated home
and recover the original request from retained task files/caller evidence. Supply
its complete contract explicitly:

```sh
bb firstmate queue reconcile <exact-native-id> --project <project-id> \
  --title '<exact original title>' --detail '<complete original detail>' \
  --mode direct-PR --delivery-requirement merged-and-verified \
  --provider '<original provider>' --model '<original model>' \
  --reasoning-level '<original level>' --after '<original dependency>' \
  --wait-until '<original time gate>' --json
```

The mode/requirement above are examples: use the actual agreed values. Omit
execution/dependency/time options only if originally absent. The tool accepts
the same fields, with `after` for dependencies. Title and kind must match the
exact native row; a shared legacy home without captain-specific provenance is
refused. The owner explicitly supplies the recovered contract; the plugin does
not infer it. If the original contract/full task or exact admitted worker evidence
is unavailable, repair refuses. Recover that evidence before taking another action.

The reported running native task must not be dispatched again. The two held native
queued tasks remain held; repair is registration only. Parent inspects original
rows and chooses any authorized production operation after acceptance.

## Validation

Synthetic equivalents reproduce the reported 261,986-byte legacy value and all
184 records (24 dispatched, 41 queued, 62 done, 57 dropped). No production task
text is copied. The actual factory migrates those records and accepts CLI/tool
adds beyond 262,144 aggregate bytes, retaining every field and order. Tests cover
list/next/drop/done/prune, full execution/spec dispatch, simultaneous owners,
same-task requests, worker completion and handoff, malformed/duplicate input,
read/write faults, transactional rollback, repeat migration and durable reload.

The actual factory also proves native add uncertainty and post-launch SQL
publication failure recovery. The older failed KV save is reproduced against the
SDK's real 262,144-byte limit; its exact launch/worker survives registration repair
and reload with zero worker calls. Real installed native backlog scripts at both
audited pins execute add, show and done in disposable homes through the factory's
host transport. Only BB transport is fake; no model starts or forge actions occur.

Validation commands/results are recorded after execution below. Parent owns the
full integration suite and production acceptance.

Executed in this isolated checkout:

| Command | Result |
| --- | --- |
| `FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types lib/queue-store.test.mjs server.queue-storage.test.mjs` | 17 passed, zero failures/skips; `/tmp/fm-queue-final-new.log` |
| `FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types --test-name-pattern='queue\|handoff\|migrate-owners\|fan-out\|fanout' server.test.ts` | 32 passed, zero failures/skips; `/tmp/fm-queue-final-existing.log` |
| `node --experimental-strip-types scripts/queue-storage-mutation.mjs` | Four causal mutations killed; source bytes restored |
| `npx tsc --noEmit` | Passed |
| `npm run fidelity -- --native /tmp/fm-launch-pr-verified` | Passed: 33 skills, 12 divergence anchors, seven BB-only fences |
| `bb plugin build .` | Passed; installed build host reports SDK 0.5.29, project remains pinned at 0.4.104 |
| `git diff --check` | Passed |

Mutation evidence: restoring the baseline factory's aggregate KV storage kills
the 184-record cap reproduction with the actual 262,144-byte rejection; moving
native add before durable intent kills the storage-failure-before-execution test;
removing the exact native ID check kills orphan identity refusal; restoring
whole-array KV completion kills the exact owned worker completion test.

The SDK fixture's reload opens a new plugin instance against the same durable
SQLite file. The migration crash test additionally closes/reopens a standalone
SQLite file after an injected mid-inventory insert failure, then proves rollback,
retry, preserved evidence and prune/restart without resurrection. Native fixtures
are disposable clones of the two audited full SHAs; installed native homes remain
unchanged. No full suite was rerun here; the parent owns that check and the bounded
production reconciliation after review. The execution-change request is a separate
follow-up and is not part of this queue commit.
