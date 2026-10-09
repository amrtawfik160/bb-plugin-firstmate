# Parent acceptance: queue storage and explicit model changes

Activated candidate `a19e30f` on 2026-10-04 after independent review and final testing.

- Final full suite: **741 passed, zero failures/skips**. Typecheck, fidelity and build passed. Integrated source matched the reviewed candidate; prior source changes were preserved.
- Both independent reviewers reproduced the interrupted replacement publication defect in the earlier candidate. Their original reproductions passed after correction. Exact request replay completes the existing worker publication; altered identity/request checks still refuse.
- All **15 installed adapters** verified. Native HEAD and working-tree status were unchanged. Plugin reloaded with all four services running.

## Queue acceptance

The real legacy queue contained 184 records and 261,986 bytes. All 184 records migrated, preserving every original field and array order. The original KV value and SQLite migration evidence remain retained.

The supported exact reconciliation registered `qa-point6` as dispatched using its existing admitted worker. No dispatch/retry/worker operation occurred. After reconciliation the SQLite queue holds 185 records, totaling 264650 aggregate serialized bytes, above the old 262,144-byte limit.

Native `qa-point7` and `qa-point8` remain queued. Their saved task files were preserved. The owning Firstmate received the complete-contract reconciliation procedure before it resumes those tasks under its current user instructions. The parent did not infer missing contract fields or dispatch either task.

## Model-change acceptance and limit

The installed native rebind helper passed `--check` against the actual stopped `c0fdc9c4` worker. Its HEAD, branch, dirty state, diff and all eight uncommitted files remained unchanged. This preflight does not start or replace a worker.

The owning Firstmate received the supported explicit execution-change command targeting `acp-grok / grok-4.6 / xhigh`. Parent did not execute that replacement; the owner must apply its current user instruction and invocation-time catalog validation. Real replacement/recovery behavior is proven by disposable native helpers and SDK execution fixtures, not claimed as a production model launch here.

Evidence is retained under `$CAPTAIN_HOMES/thr_example04/data/queue-storage-20261004/` and `data/model-change-20261004/`. Native adapter backups and per-home checks are under `/tmp/fm-queue-model-activation/`.
