import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createWorkstreams, WorkstreamWaiting, DEV_IDLE_MS, type WorkstreamDeps } from './workstreams.ts';

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

test('two editing tasks never run at once; scouts run alongside; queued editors resume in order after reload', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    await Promise.all([
      f.store.submit(w.id, 'cap', { id: 'editor1', editing: true, payload: '{}' }),
      f.store.submit(w.id, 'cap', { id: 'editor2', editing: true, payload: '{}' }),
      f.store.submit(w.id, 'cap', { id: 'scout', editing: false, payload: '{}' }),
    ]);
    assert.deepEqual(f.started, ['editor1', 'scout']);
    f.statuses.set('editor1', 'idle');
    await createWorkstreams(f.db, f.deps).reconcile();
    assert.deepEqual(f.started, ['editor1', 'scout', 'editor2']);
    await f.store.submit(w.id, 'cap', { id: 'editor2', editing: true, payload: '{}' });
    assert.deepEqual(f.started, ['editor1', 'scout', 'editor2'], 'a retry must not start a second editor');
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

test('End refuses merged tasks and unsaved work, then closes topic only after cleanup', async () => {
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
    assert.equal(ended.closeTopicRequested, true);
    assert.equal(ended.state, 'ended');
  } finally { f.db.close(); }
});

test('Ship is repeatable by requestId and blocks new editors while the checker waits', async () => {
  const f = fixture(); let ships = 0;
  try {
    const w = await f.create();
    f.deps.ship = async () => { ships++; if (ships === 1) throw new WorkstreamWaiting('checker pending'); };
    assert.equal((await f.store.ship(w.id, 'cap', 'tap1')).ship.state,'running');
    await f.store.submit(w.id, 'cap', { id: 'editor', editing: true, payload: '{}' });
    assert.deepEqual(f.started, []);
    // The queued editor cannot prevent resuming the Ship it is waiting for.
    await f.store.ship(w.id, 'cap', 'tap1');
    await f.store.ship(w.id, 'cap', 'tap1');
    assert.equal(ships, 2);
    await f.store.reconcile(); assert.deepEqual(f.started, ['editor']);
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

test('a failed spawn keeps its editing reservation across reload and retries the same identity', async () => {
  const f = fixture(); let attempts = 0;
  try {
    f.deps.start = async (_w,job) => { attempts++; if (attempts === 1) throw new Error('spawn outcome unknown'); f.started.push(job.id); return job.id; };
    const w = await f.create();
    await assert.rejects(f.store.submit(w.id,'cap',{id:'one',editing:true,payload:'{}'}),/unknown/);
    assert.equal(f.store.get(w.id,'cap').jobs[0]!.state,'starting');
    const reload = createWorkstreams(f.db,f.deps);
    await reload.submit(w.id,'cap',{id:'two',editing:true,payload:'{}'});
    assert.deepEqual(f.started,['one']);
    assert.equal(reload.get(w.id,'cap').jobs[1]!.state,'queued');
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
    assert.equal(f.store.get(w.id,'cap').closeTopicRequested,true);
    await f.store.reconcile(); assert.equal(removed,1);
  } finally { f.db.close(); }
});

test('a failed editor releases its slot, while an unreadable editor keeps the next task queued', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    await f.store.submit(w.id,'cap',{id:'one',editing:true,payload:'{}'});
    await f.store.submit(w.id,'cap',{id:'two',editing:true,payload:'{}'});
    f.statuses.set('one','unknown'); await f.store.reconcile(); assert.deepEqual(f.started,['one']);
    f.statuses.set('one','error'); await f.store.reconcile(); assert.deepEqual(f.started,['one','two']);
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
