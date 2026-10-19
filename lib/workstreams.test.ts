import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createWorkstreams, WorkstreamWaiting, DEV_IDLE_MS, type WorkstreamDeps } from './workstreams.ts';
import { FAILED_KEEP_MS, FOLD_CONFLICT_TELL, MEMORY_GUARD_BYTES } from './workstream-fold.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  let now = 100;
  const started: string[] = [], stopped: string[] = [];
  const statuses = new Map<string, string>();
  const deps: WorkstreamDeps = {
    now: () => now,
    provision: async (w) => [{ repository: 'cyndra-ai/app', projectId: w.projectId, hostId: 'h1', path: `/tmp/${w.id}`, sourcePath: '/tmp/main', branch: `workstream/${w.id}`, environmentId: null }],
    start: async (_w, job) => { started.push(job.id); statuses.set(job.id, 'active'); return job.id; },
    status: async (id) => statuses.get(id) ?? 'unknown',
    startDev: async (w) => `https://example.test/${w.devLink.port}`,
    stopDev: async (w) => { stopped.push(w.id); },
    unsaved: async () => [], remove: async () => {},
    ship: async () => {}, taskState: () => 'live',
  };
  const store = createWorkstreams(db, deps);
  const create = (name = 'Design', topicId = 1) => store.create({ threadId: 'cap', projectId: 'cyndra', name, requestId: name, topic: { chatId: '200', topicId } });
  return { db, deps, store, create, started, stopped, statuses, time: (v: number) => { now = v; } };
}

test('creation survives reload and deduplicates a Telegram topic', async () => {
  const f = fixture();
  try {
    const first = await f.create();
    const second = await f.store.create({ threadId: 'cap', projectId: 'cyndra', name: 'Renamed', requestId: 'retry', topic: { chatId: '200', topicId: 1 } });
    assert.equal(second.id, first.id);
    const reloaded = createWorkstreams(f.db, f.deps);
    assert.deepEqual(reloaded.list('cap'), [first]);
    assert.throws(() => reloaded.get(first.id, 'other'), /captain/);
  } finally { f.db.close(); }
});

test('created workstreams start editing tasks together; scouts run alongside; a retry does not spawn twice', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    await Promise.all([
      f.store.submit(w.id, 'cap', { id: 'editor1', editing: true, payload: '{}' }),
      f.store.submit(w.id, 'cap', { id: 'editor2', editing: true, payload: '{}' }),
      f.store.submit(w.id, 'cap', { id: 'scout', editing: false, payload: '{}' }),
    ]);
    assert.deepEqual([...f.started].sort(), ['editor1', 'editor2', 'scout']);
    await f.store.submit(w.id, 'cap', { id: 'editor2', editing: true, payload: '{}' });
    assert.deepEqual([...f.started].sort(), ['editor1', 'editor2', 'scout']);
  } finally { f.db.close(); }
});

test('fourth dev link stops least recently requested, keeps fixed port and stops after two idle hours', async () => {
  const f = fixture();
  try {
    const a = await f.create('a', 1), b = await f.create('b', 2), c = await f.create('c', 3), d = await f.create('d', 4);
    await f.store.devLink(a.id, 'cap'); f.time(200);
    await f.store.devLink(b.id, 'cap'); f.time(300);
    await f.store.devLink(c.id, 'cap'); f.time(400);
    await f.store.devLink(a.id, 'cap'); f.time(500);
    await f.store.devLink(d.id, 'cap');
    assert.deepEqual(f.stopped, [b.id]);
    const port = b.devLink.port;
    await f.store.devLink(b.id, 'cap');
    assert.equal(f.store.get(b.id, 'cap').devLink.port, port);
    f.time(500 + DEV_IDLE_MS);
    await f.store.reconcile();
    assert.equal(f.store.list('cap').filter((w) => w.devLink.state === 'running').length, 0);
  } finally { f.db.close(); }
});

test('End refuses merged tasks and unsaved work, then leaves the topic after cleanup', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.store.attachTask(w.id, 'cap', 'T1');
    f.deps.taskState = () => 'merged';
    await assert.rejects(f.store.end(w.id, 'cap'), /Live or Dropped/);
    f.deps.taskState = () => 'live';
    f.deps.unsaved = async () => ['1 commit(s) on no remote'];
    await assert.rejects(f.store.end(w.id, 'cap'), /Unsaved work/);
    f.deps.unsaved = async () => [];
    const ended = await f.store.end(w.id, 'cap');
    assert.equal(ended.closeTopicRequested, false);
    assert.equal(ended.state, 'ended');
  } finally { f.db.close(); }
});

test('Ship is repeatable by requestId and created editors still start while the checker waits', async () => {
  const f = fixture(); let ships = 0;
  try {
    const w = await f.create();
    f.deps.ship = async () => { ships++; if (ships === 1) throw new WorkstreamWaiting('checker pending'); };
    assert.equal((await f.store.ship(w.id, 'cap', 'tap1')).ship.state,'running');
    await f.store.submit(w.id, 'cap', { id: 'editor', editing: true, payload: '{}' });
    assert.deepEqual(f.started, ['editor']);
    await f.store.ship(w.id, 'cap', 'tap1');
    await f.store.ship(w.id, 'cap', 'tap1');
    assert.equal(ships, 2);
  } finally { f.db.close(); }
});

test('a project without a web app refuses dev link before any service starts', async () => {
  const f = fixture(); let starts = 0;
  try {
    f.deps.supportsDevLink = async () => false;
    f.deps.startDev = async () => { starts++; return 'https://example.test'; };
    const w = await f.create();
    assert.equal(w.supportsDevLink,false);
    await assert.rejects(f.store.devLink(w.id,'cap'),/no web app/);
    assert.equal(starts,0);
  } finally { f.db.close(); }
});

test('a failed created spawn retries the same identity and does not block the next editor', async () => {
  const f = fixture(); let attempts = 0;
  try {
    f.deps.start = async (_w,job) => { attempts++; if (job.id === 'one' && attempts === 1) throw new Error('spawn outcome unknown'); f.started.push(job.id); return job.id; };
    const w = await f.create();
    const first = await f.store.submit(w.id,'cap',{id:'one',editing:true,payload:'{}'});
    assert.equal(first.state,'starting');
    const reload = createWorkstreams(f.db,f.deps);
    await reload.submit(w.id,'cap',{id:'two',editing:true,payload:'{}'});
    assert.ok(f.started.includes('two'));
    await reload.reconcile();
    assert.ok(f.started.includes('one'));
  } finally { f.db.close(); }
});

test('workstream ends automatically only after every task is Live or Dropped and all work is saved', async () => {
  const f = fixture(); let removed = 0;
  try {
    const w = await f.create(); f.store.attachTask(w.id,'cap','T1');
    f.deps.remove = async () => { removed++; };
    f.deps.taskState = () => 'merged';
    await f.store.reconcile(); assert.equal(removed,0);
    f.deps.taskState = () => 'live'; f.deps.unsaved = async () => ['unpushed'];
    await f.store.reconcile(); assert.equal(removed,0);
    f.deps.unsaved = async () => [];
    await f.store.reconcile(); assert.equal(removed,1);
    assert.equal(f.store.get(w.id,'cap').closeTopicRequested,false);
    await f.store.reconcile(); assert.equal(removed,1);
  } finally { f.db.close(); }
});

test('a failed created editor does not hold the next editing task', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    await f.store.submit(w.id,'cap',{id:'one',editing:true,payload:'{}'});
    await f.store.submit(w.id,'cap',{id:'two',editing:true,payload:'{}'});
    assert.deepEqual([...f.started].sort(), ['one', 'two']);
    f.statuses.set('one','error'); await f.store.reconcile();
    assert.equal(f.store.get(w.id,'cap').jobs[0]!.state, 'failed');
    assert.equal(f.store.get(w.id,'cap').jobs[1]!.state, 'running');
  } finally { f.db.close(); }
});

test('End and task attachment serialize so a late task cannot join a removed worktree', async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const checking = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const w = await f.create(); await f.store.attachTask(w.id,'cap','T1');
    f.deps.taskState = (id) => id === 'T1' ? 'live' : 'working';
    f.deps.unsaved = async () => { entered(); await gate; return []; };
    const ending = f.store.end(w.id,'cap'); await checking;
    const attachment = Promise.resolve(f.store.attachTask(w.id,'cap','T2'));
    const rejected = assert.rejects(attachment,/ended/);
    release(); await ending; await rejected;
    assert.deepEqual(f.store.get(w.id,'cap').taskIds,['T1']);
  } finally { release?.(); f.db.close(); }
});

test('adopt groups open tasks without provisioning; a retry of the same requestId is a no-op', async () => {
  const f = fixture();
  let provisions = 0;
  const inner = f.deps.provision;
  f.deps.provision = async (w) => { provisions++; return inner(w); };
  try {
    const first = await f.store.adopt({ threadId: 'cap', projectId: 'cyndra', name: 'Cyndra web chat restyle', requestId: 'adopt-chat', taskIds: ['T1', 'T2'] });
    assert.deepEqual(first.taskIds, ['T1', 'T2']);
    assert.equal(first.provisioned, true);
    assert.deepEqual(first.repos, []);
    assert.equal(provisions, 0);
    const retry = await f.store.adopt({ threadId: 'cap', projectId: 'cyndra', name: 'Cyndra web chat restyle', requestId: 'adopt-chat', taskIds: ['T1', 'T2'] });
    assert.equal(retry.id, first.id);
    assert.equal(f.store.list('cap').length, 1);
  } finally { f.db.close(); }
});

test('adopt stores provided existing repos without provisioning', async () => {
  const f = fixture();
  let provisions = 0;
  const inner = f.deps.provision;
  f.deps.provision = async (w) => { provisions++; return inner(w); };
  try {
    const repo = { repository: 'example/repo', projectId: 'cyndra', hostId: 'h1', path: '/repo/feat', sourcePath: '/repo/main', branch: 'feat/original', environmentId: 'env_original', existing: true };
    let removed = 0, inspected = 0;
    f.deps.remove = async () => { removed++; };
    f.deps.unsaved = async () => { inspected++; return []; };
    const first = await f.store.adopt({ threadId: 'cap', projectId: 'cyndra', name: 'Running', requestId: 'repos', taskIds: ['T1'], repos: [repo] });
    assert.deepEqual(first.repos, [repo]);
    assert.equal(provisions, 0);
    const ended = await f.store.end(first.id, 'cap');
    assert.equal(ended.state, 'ended');
    assert.equal(removed, 0);
    assert.equal(inspected, 0);
  } finally { f.db.close(); }
});

test('adopt retry with a different name or task list is refused', async () => {
  const f = fixture();
  try {
    const first = await f.store.adopt({ threadId: 'cap', projectId: 'cyndra', name: 'Chat', requestId: 'stable', taskIds: ['T1', 'T2'] });
    await assert.rejects(f.store.adopt({ threadId: 'cap', projectId: 'cyndra', name: 'Renamed', requestId: 'stable', taskIds: ['T1', 'T2'] }), /changed its original/);
    await assert.rejects(f.store.adopt({ threadId: 'cap', projectId: 'cyndra', name: 'Chat', requestId: 'stable', taskIds: ['T1', 'T2', 'T3'] }), /changed its original/);
    const listed = f.store.list('cap');
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.name, 'Chat');
    assert.deepEqual(listed[0]!.taskIds, ['T1', 'T2']);
    assert.equal(listed[0]!.id, first.id);
  } finally { f.db.close(); }
});

test('an editing follow-up waits while the workstream is busy', async () => {
  const f = fixture();
  f.deps.busy = async () => true;
  try {
    const w = await f.store.adopt({ threadId: 'cap', projectId: 'cyndra', name: 'Follow', requestId: 'follow', taskIds: ['T1'] });
    const job = await f.store.submit(w.id, 'cap', { id: 'follow', editing: true, payload: '{}' });
    assert.equal(job.state, 'queued');
    assert.deepEqual(f.started, []);
  } finally { f.db.close(); }
});

test('Ship queues while an attached editor is busy, tells the owner once, then ships after idle', async () => {
  const f = fixture();
  let busy = true;
  const told: string[] = [];
  let ships = 0;
  f.deps.editorBusy = async () => busy;
  f.deps.waiting = async (w) => { told.push(w.id); };
  f.deps.ship = async () => { ships++; };
  try {
    const w = await f.store.adopt({ threadId: 'cap', projectId: 'cyndra', name: 'Existing', requestId: 'adopt', taskIds: ['T1'] });
    const first = await f.store.ship(w.id, 'cap', 'tap');
    assert.equal(first.ship.state, 'queued');
    assert.equal(ships, 0);
    await f.store.ship(w.id, 'cap', 'tap');
    assert.deepEqual(told, [w.id]);
    busy = false;
    const second = await f.store.ship(w.id, 'cap', 'tap');
    assert.equal(second.ship.state, 'complete');
    assert.equal(ships, 1);
    busy = true;
    await f.store.reconcile();
    assert.equal(ships, 1);
  } finally { f.db.close(); }
});

test('adopt refuses a task already in another workstream and creates nothing', async () => {
  const f = fixture();
  try {
    const held = await f.store.adopt({ threadId: 'cap', projectId: 'cyndra', name: 'Held', requestId: 'held', taskIds: ['T1'] });
    await assert.rejects(f.store.adopt({ threadId: 'cap', projectId: 'cyndra', name: 'Other', requestId: 'other', taskIds: ['T1', 'T2'] }), /already belongs to a workstream/);
    assert.deepEqual(f.store.list('cap').map((w) => w.id), [held.id]);
  } finally { f.db.close(); }
});

test('End leaves the topic after cleanup, for created and adopted workstreams', async () => {
  const f = fixture();
  try {
    const created = await f.create();
    f.store.attachTask(created.id, 'cap', 'T1');
    const endedCreated = await f.store.end(created.id, 'cap');
    assert.equal(endedCreated.closeTopicRequested, false);
    assert.equal(endedCreated.state, 'ended');
    const adopted = await f.store.adopt({ threadId: 'cap', projectId: 'cyndra', name: 'Chat', requestId: 'adopt-end', taskIds: ['T2'] });
    await f.store.bindTopic(adopted.id, 'cap', { chatId: '200', topicId: 9 });
    const endedAdopted = await f.store.end(adopted.id, 'cap');
    assert.equal(endedAdopted.closeTopicRequested, false);
    assert.deepEqual(endedAdopted.topic, { chatId: '200', topicId: 9 });
  } finally { f.db.close(); }
});

test('HTTP activity renews the dev link idle window without another Open tap', async () => {
  const f = fixture();
  try {
    const w = await f.create(); await f.store.devLink(w.id,'cap');
    f.time(100 + DEV_IDLE_MS + 1000);
    f.deps.devActivity = async () => 100 + DEV_IDLE_MS;
    await f.store.reconcile();
    assert.equal(f.store.get(w.id,'cap').devLink.state,'running');
    f.time(100 + 2 * DEV_IDLE_MS + 1000); await f.store.reconcile();
    assert.equal(f.store.get(w.id,'cap').devLink.state,'stopped');
  } finally { f.db.close(); }
});

test('fourth dev link uses HTTP activity received since the last reconciliation', async () => {
  const f = fixture();
  try {
    const a = await f.create('a',1), b = await f.create('b',2), c = await f.create('c',3), d = await f.create('d',4);
    await f.store.devLink(a.id,'cap'); f.time(200);
    await f.store.devLink(b.id,'cap'); f.time(300);
    await f.store.devLink(c.id,'cap'); f.time(500);
    f.deps.devActivity = async (w) => w.id === a.id ? 400 : 0;
    await f.store.devLink(d.id,'cap');
    assert.deepEqual(f.stopped,[b.id]);
  } finally { f.db.close(); }
});

test('adopted workstreams still run one editor at a time', async () => {
  const f = fixture();
  try {
    const w = await f.store.adopt({ threadId: 'cap', projectId: 'cyndra', name: 'Chat', requestId: 'serial', taskIds: ['T1'] });
    await f.store.submit(w.id, 'cap', { id: 'editor1', editing: true, payload: '{}' });
    await f.store.submit(w.id, 'cap', { id: 'editor2', editing: true, payload: '{}' });
    await f.store.submit(w.id, 'cap', { id: 'scout', editing: false, payload: '{}' });
    assert.deepEqual(f.started, ['editor1', 'scout']);
    f.statuses.set('editor1', 'idle');
    await f.store.reconcile();
    assert.deepEqual(f.started, ['editor1', 'scout', 'editor2']);
  } finally { f.db.close(); }
});

test('created editors wait when memory is below 3 GB and start after it recovers', async () => {
  const f = fixture();
  let free = MEMORY_GUARD_BYTES - 1;
  f.deps.memAvailable = async () => free;
  try {
    const w = await f.create();
    const one = await f.store.submit(w.id, 'cap', { id: 'e1', editing: true, payload: '{}' });
    const two = await f.store.submit(w.id, 'cap', { id: 'e2', editing: true, payload: '{}' });
    assert.equal(one.state, 'waiting-memory');
    assert.equal(two.state, 'waiting-memory');
    assert.deepEqual(f.started, []);
    free = MEMORY_GUARD_BYTES;
    await f.store.reconcile();
    assert.deepEqual([...f.started].sort(), ['e1', 'e2']);
  } finally { f.db.close(); }
});

test('a created fold merges when tests passed, tells the same crew on conflict, and rolls a partial fold back', async () => {
  const f = fixture();
  const folded: string[] = [];
  const told: string[] = [];
  const archived: string[] = [];
  const deleted: string[] = [];
  let conflict = false;
  let files = ['src/app.ts'];
  f.deps.report = async () => '1995 pass, 0 fail';
  f.deps.fold = async (_w, job) => {
    folded.push(job.id);
    return conflict ? { ok: false, conflict: true, files: [] } : { ok: true, conflict: false, files };
  };
  f.deps.tell = async (_w, job, message) => { told.push(`${job.id}:${message}`); };
  f.deps.archive = async (_w, job) => { archived.push(job.id); };
  f.deps.deleteBranch = async (_w, job) => { deleted.push(job.id); };
  try {
    const w = await f.create();
    await f.store.submit(w.id, 'cap', { id: 'crew', editing: true, payload: '{"task":"Restyle composer"}', taskId: 'T3', title: 'Restyle composer', model: 'gpt-6.1-sol' });
    f.statuses.set('crew', 'idle');
    conflict = true;
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').jobs[0]!.state, 'running');
    assert.equal(told[0]!.startsWith('crew:'), true);
    assert.match(told[0]!, new RegExp(FOLD_CONFLICT_TELL.slice(0, 20)));
    assert.deepEqual(archived, []);
    conflict = false;
    f.statuses.set('crew', 'idle');
    await f.store.reconcile();
    const job = f.store.get(w.id, 'cap').jobs[0]!;
    assert.equal(job.state, 'folded');
    assert.deepEqual(archived, ['crew']);
    assert.deepEqual(deleted, ['crew']);
    assert.deepEqual(job.files, ['src/app.ts']);
  } finally { f.db.close(); }
});

test('folds wait while Ship is checking, and Ship proceeds with already folded work', async () => {
  const f = fixture();
  const folded: string[] = [];
  let ships = 0;
  f.deps.report = async () => 'All tests passed.';
  f.deps.fold = async (_w, job) => { folded.push(job.id); return { ok: true, conflict: false, files: ['a.ts'] }; };
  f.deps.archive = async () => {};
  f.deps.deleteBranch = async () => {};
  f.deps.ship = async () => { ships++; if (ships === 1) throw new WorkstreamWaiting('checker pending'); };
  try {
    const w = await f.create();
    await f.store.submit(w.id, 'cap', { id: 'done', editing: true, payload: '{}' });
    await f.store.submit(w.id, 'cap', { id: 'live', editing: true, payload: '{}' });
    f.statuses.set('done', 'idle');
    await f.store.ship(w.id, 'cap', 'tap');
    assert.equal(f.store.get(w.id, 'cap').ship.state, 'running');
    assert.deepEqual(folded, ['done']);
    f.statuses.set('live', 'idle');
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').jobs.find((j) => j.id === 'live')!.state, 'finished');
    assert.match(f.store.view(w.id, 'cap'), /live .* folding/);
    assert.deepEqual(folded, ['done']);
    ships = 1;
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').ship.state, 'complete');
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').jobs.find((j) => j.id === 'live')!.state, 'folded');
  } finally { f.db.close(); }
});

test('a fold that changes package files restarts a running dev link', async () => {
  const f = fixture();
  const restarted: string[] = [];
  f.deps.report = async () => '12 passed';
  f.deps.fold = async () => ({ ok: true, conflict: false, files: ['package.json'] });
  f.deps.archive = async () => {};
  f.deps.deleteBranch = async () => {};
  f.deps.restartDev = async (w) => { restarted.push(w.id); };
  try {
    const w = await f.create();
    await f.store.devLink(w.id, 'cap');
    await f.store.submit(w.id, 'cap', { id: 'crew', editing: true, payload: '{}' });
    f.statuses.set('crew', 'idle');
    await f.store.reconcile();
    assert.deepEqual(restarted, [w.id]);
  } finally { f.db.close(); }
});

test('cleanup never deletes unsaved work, archives a drop at once, and archives a failed crew after 7 days', async () => {
  const f = fixture();
  const archived: string[] = [];
  const unsaved = new Map<string, string[]>();
  f.deps.archive = async (_w, job) => { archived.push(job.id); };
  f.deps.unsavedJob = async (_w, job) => unsaved.get(job.id) ?? [];
  const states = new Map<string, string>([['T1', 'working'], ['T2', 'working']]);
  f.deps.taskState = (id) => states.get(id);
  try {
    const w = await f.create();
    await f.store.submit(w.id, 'cap', { id: 'keep', editing: true, payload: '{}', taskId: 'T1' });
    await f.store.submit(w.id, 'cap', { id: 'drop', editing: true, payload: '{}', taskId: 'T2' });
    unsaved.set('keep', ['1 uncommitted file(s)']);
    f.statuses.set('keep', 'error');
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').jobs.find((j) => j.id === 'keep')!.state, 'failed');
    states.set('T2', 'dropped');
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').jobs.find((j) => j.id === 'drop')!.state, 'dropped');
    assert.deepEqual(archived, ['drop']);
    f.time(100 + FAILED_KEEP_MS + 1);
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').jobs.find((j) => j.id === 'keep')!.state, 'kept-unsaved');
    assert.equal(archived.includes('keep'), false);
    unsaved.set('keep', []);
    f.statuses.set('keep', 'error');
    const failed = await f.create('other', 9);
    await f.store.submit(failed.id, 'cap', { id: 'old', editing: true, payload: '{}' });
    f.statuses.set('old', 'error');
    await f.store.reconcile();
    f.time(100 + 3 * FAILED_KEEP_MS);
    await f.store.reconcile();
    assert.equal(f.store.get(failed.id, 'cap').jobs[0]!.note, 'archived after 7 days');
    assert.ok(archived.includes('old'));
  } finally { f.db.close(); }
});

test('card revisions rise on each task state change, and lookup stays short', async () => {
  const f = fixture();
  const revisions: number[] = [];
  f.deps.card = async (w) => { revisions.push(w.cardRevision ?? 0); };
  try {
    const w = await f.create();
    await f.store.submit(w.id, 'cap', { id: 'crew', editing: true, payload: '{"task":"Restyle composer"}', taskId: 'T3', title: 'Restyle composer', model: 'gpt-6.1-sol' });
    assert.ok(revisions.length >= 2);
    assert.equal(revisions.every((n, i) => i === 0 || n > revisions[i - 1]!), true);
    f.store.noteJob(w.id, 'cap', 'crew', { report: 'line 1\nline 2', files: ['a.ts'] });
    const lookup = f.store.lookup(w.id, 'cap', 'T3');
    assert.ok(lookup.split('\n').length <= 15);
    assert.match(lookup, /^T3 Restyle composer/);
    assert.match(f.store.view(w.id, 'cap'), /T3 Restyle composer gpt-6.1-sol working/);
  } finally { f.db.close(); }
});

test('a follow-up of a folded task is a new crew linked to the old one', async () => {
  const f = fixture();
  f.deps.report = async () => 'All tests passed.';
  f.deps.fold = async () => ({ ok: true, conflict: false, files: ['a.ts'] });
  f.deps.archive = async () => {};
  f.deps.deleteBranch = async () => {};
  try {
    const w = await f.create();
    await f.store.submit(w.id, 'cap', { id: 'first', editing: true, payload: '{"task":"first brief"}', taskId: 'T3' });
    f.statuses.set('first', 'idle');
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').jobs[0]!.state, 'folded');
    const next = await f.store.submit(w.id, 'cap', { id: 'second', editing: true, payload: '{"task":"first brief\\nlast report"}', taskId: 'T3', followUpOf: 'first' });
    assert.equal(next.followUpOf, 'first');
    assert.equal(next.state, 'running');
    assert.ok(f.started.includes('second'));
  } finally { f.db.close(); }
});
