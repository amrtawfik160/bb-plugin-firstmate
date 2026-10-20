import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_UNDO_GRACE_MS, UNARCHIVE_RESERVE_MS, archiveWithUndo, type ArchiveUndoOps } from './workstream-archive.ts';

// A virtual clock: each call takes its latency; `within` gives up at its limit, as a timeout would.
function virtual(latency: { archive?: number; thread?: number; environment?: number; unarchive?: number }, state: { threadBusy?: boolean; environmentBusy?: boolean; taken?: string[] } = {}) {
  let clock = 0;
  const calls: Array<{ call: string; at: number }> = [];
  const take = (call: string, ms = 0) => { clock += ms; calls.push({ call, at: clock }); };
  const ops: ArchiveUndoOps = {
    now: () => clock,
    within: async (call, ms) => {
      const start = clock;
      const value = await call();
      if (clock - start > ms) { clock = start + ms; throw new Error(`timed out after ${ms} ms`); }
      return value;
    },
    archive: async (id) => { take('archive', latency.archive); return state.taken ?? [id]; },
    threadBusy: async () => { take('thread', latency.thread); return state.threadBusy === true; },
    environmentBusy: async () => { take('environment', latency.environment); return state.environmentBusy === true; },
    unarchive: async (id) => { take(`unarchive ${id}`, latency.unarchive); },
  };
  return { ops, calls, now: () => clock };
}

test('an archive that stands is read back once and kept', async () => {
  const v = virtual({ archive: 1_000, thread: 500, environment: 500 });
  assert.deepEqual(await archiveWithUndo(v.ops, 'thr', ['env']), { undone: false, taken: ['thr'] });
  assert.deepEqual(v.calls.map((c) => c.call), ['archive', 'thread', 'environment']);
});

test('a thread read that already shows work undoes at once, without waiting for the worktree read', async () => {
  const v = virtual({ archive: 3_000, thread: 14_000, environment: 14_000 }, { threadBusy: true });
  const result = await archiveWithUndo(v.ops, 'thr', ['env']);
  assert.equal(result.undone, true);
  assert.deepEqual(v.calls.map((c) => c.call), ['archive', 'thread', 'unarchive thr']);
  assert.ok(v.calls.at(-1)!.at <= ARCHIVE_UNDO_GRACE_MS, 'the undo starts inside the grace');
});

test('slow read-backs stop at the verification budget and leave the reserve for the undo', async () => {
  const v = virtual({ archive: 3_000, thread: 14_000, environment: 14_000 });
  const result = await archiveWithUndo(v.ops, 'thr', ['env']);
  assert.equal(result.undone, true);
  assert.match(result.undone ? result.reason : '', /not verified after archiving/);
  const undo = v.calls.find((c) => c.call === 'unarchive thr')!;
  assert.ok(undo.at <= ARCHIVE_UNDO_GRACE_MS - UNARCHIVE_RESERVE_MS, `undo began at ${undo.at} ms`);
});

test('a slow or failed archive, or one that took other threads, is undone crew thread first', async () => {
  const slow = virtual({ archive: 25_000 });
  const late = await archiveWithUndo(slow.ops, 'thr', []);
  assert.match(late.undone ? late.reason : '', /archive failed/);
  assert.deepEqual(slow.calls.map((c) => c.call), ['archive', 'unarchive thr']);
  const wide = virtual({}, { taken: ['child', 'thr'] });
  const widened = await archiveWithUndo(wide.ops, 'thr', ['env']);
  assert.match(widened.undone ? widened.reason : '', /BB also archived child/);
  assert.deepEqual(wide.calls.map((c) => c.call), ['archive', 'unarchive thr', 'unarchive child']);
  assert.deepEqual(widened.taken, ['child', 'thr']);
});
