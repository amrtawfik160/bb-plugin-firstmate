import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createWorkstreams, WorkstreamWaiting, DEV_IDLE_MS, type WorkstreamDeps } from './workstreams.ts';
import { FAILED_KEEP_MS, FOLD_CONFLICT_TELL, MEMORY_GUARD_BYTES } from './workstream-fold.ts';
import { seedLegacyWorkstream } from '../test/legacy-workstream.mjs';

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

test('a workstream adopted before adopt with fold keeps its existing repos, and End leaves them', async () => {
  const f = fixture();
  let provisions = 0;
  const inner = f.deps.provision;
  f.deps.provision = async (w) => { provisions++; return inner(w); };
  try {
    const repo = { repository: 'example/repo', projectId: 'cyndra', hostId: 'h1', path: '/repo/feat', sourcePath: '/repo/main', branch: 'feat/original', environmentId: 'env_original', existing: true };
    let removed = 0, inspected = 0;
    f.deps.remove = async () => { removed++; };
    f.deps.unsaved = async () => { inspected++; return []; };
    const first = seedLegacyWorkstream(f.db, { projectId: 'cyndra', name: 'Running', requestId: 'repos', taskIds: ['T1'], repos: [repo] });
    assert.deepEqual(f.store.get(first.id, 'cap').repos, [repo]);
    assert.equal(provisions, 0);
    const ended = await f.store.end(first.id, 'cap');
    assert.equal(ended.state, 'ended');
    assert.equal(removed, 0);
    assert.equal(inspected, 0);
  } finally { f.db.close(); }
});

test('an editing follow-up waits while the workstream is busy', async () => {
  const f = fixture();
  f.deps.busy = async () => true;
  try {
    const w = seedLegacyWorkstream(f.db, { projectId: 'cyndra', name: 'Follow', requestId: 'follow', taskIds: ['T1'] });
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
    const w = seedLegacyWorkstream(f.db, { projectId: 'cyndra', name: 'Existing', requestId: 'adopt', taskIds: ['T1'] });
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

test('End leaves the topic after cleanup, for created and adopted workstreams', async () => {
  const f = fixture();
  try {
    const created = await f.create();
    f.store.attachTask(created.id, 'cap', 'T1');
    const endedCreated = await f.store.end(created.id, 'cap');
    assert.equal(endedCreated.closeTopicRequested, false);
    assert.equal(endedCreated.state, 'ended');
    const adopted = seedLegacyWorkstream(f.db, { projectId: 'cyndra', name: 'Chat', requestId: 'adopt-end', taskIds: ['T2'] });
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
    const w = seedLegacyWorkstream(f.db, { projectId: 'cyndra', name: 'Chat', requestId: 'serial', taskIds: ['T1'] });
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
    const kept = f.store.get(w.id, 'cap').jobs.find((j) => j.id === 'keep')!;
    assert.equal(kept.state, 'failed', 'the failed result stays; only its cleanup waits');
    assert.equal(kept.cleanup, 'kept-unsaved');
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

// Per-repository fold steps over fake Git: each repository has a head; merging moves it to `after`.
function foldGit(repos: string[]) {
  const heads = new Map(repos.map((r) => [r, `${r}-base`]));
  const calls: string[] = [];
  let mergeOutcome = (_repository: string): 'merged' | 'conflict' | 'wait' => 'merged';
  let rollbackOk = true;
  let crashAfterMerge = false;
  const ops: NonNullable<WorkstreamDeps['foldOps']> = {
    plan: async () => ({ steps: repos.map((repository) => ({ repository, hostId: 'h1', workstreamPath: `/ws/${repository}`, checkoutPath: `/task/${repository}`, before: heads.get(repository)!, target: `${repository}-task`, state: 'pending' as const })) }),
    merge: async (_w, step) => {
      calls.push(`merge ${step.repository}`);
      const outcome = mergeOutcome(step.repository);
      if (outcome === 'conflict') return { kind: 'conflict' };
      if (outcome === 'wait') return { kind: 'wait', reason: 'the workstream worktree has local changes in files this fold changes' };
      heads.set(step.repository, `${step.repository}-merged`);
      if (crashAfterMerge) throw new Error('host connection lost');
      return { kind: 'merged', after: `${step.repository}-merged`, files: [`${step.repository}.ts`] };
    },
    inspect: async (_w, step) => {
      const merged = heads.get(step.repository) === `${step.repository}-merged`;
      return { head: heads.get(step.repository)!, hasTarget: merged, files: merged ? [`${step.repository}.ts`] : [] };
    },
    rollback: async (_w, step) => {
      calls.push(`undo ${step.repository}`);
      if (!rollbackOk) return false;
      heads.set(step.repository, step.before);
      return true;
    },
  };
  return {
    ops, heads, calls,
    set: (knobs: { merge?: typeof mergeOutcome; rollbackOk?: boolean; crashAfterMerge?: boolean }) => {
      if (knobs.merge) mergeOutcome = knobs.merge;
      if (knobs.rollbackOk !== undefined) rollbackOk = knobs.rollbackOk;
      if (knobs.crashAfterMerge !== undefined) crashAfterMerge = knobs.crashAfterMerge;
    },
  };
}

test('a fold that conflicts in its second repository undoes the first, then tells the same crew', async () => {
  const f = fixture(); const git = foldGit(['one', 'two']); const told: string[] = [];
  f.deps.report = async () => 'All tests passed.';
  f.deps.foldOps = git.ops;
  f.deps.tell = async (_w, job) => { told.push(job.id); };
  try {
    const w = await f.create();
    await f.store.submit(w.id, 'cap', { id: 'crew', editing: true, payload: '{}' });
    git.set({ merge: (r) => (r === 'two' ? 'conflict' : 'merged') });
    f.statuses.set('crew', 'idle');
    await f.store.reconcile();
    assert.deepEqual(git.calls, ['merge one', 'merge two', 'undo one']);
    assert.equal(git.heads.get('one'), 'one-base');
    const job = f.store.get(w.id, 'cap').jobs[0]!;
    assert.equal(job.state, 'running');
    assert.equal(job.fold, undefined);
    assert.deepEqual(told, ['crew']);
  } finally { f.db.close(); }
});

test('an undo that must wait keeps the job folding and holds Ship, then finishes on a later pass', async () => {
  const f = fixture(); const git = foldGit(['one', 'two']); const told: string[] = []; let ships = 0;
  f.deps.report = async () => 'All tests passed.';
  f.deps.foldOps = git.ops;
  f.deps.tell = async (_w, job) => { told.push(job.id); };
  f.deps.ship = async () => { ships++; };
  try {
    const w = await f.create();
    await f.store.submit(w.id, 'cap', { id: 'crew', editing: true, payload: '{}' });
    git.set({ merge: (r) => (r === 'two' ? 'conflict' : 'merged'), rollbackOk: false });
    f.statuses.set('crew', 'idle');
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').jobs[0]!.state, 'folding');
    assert.match(f.store.get(w.id, 'cap').jobs[0]!.note ?? '', /undo waits/);
    assert.equal((await f.store.ship(w.id, 'cap', 'tap')).ship.state, 'queued');
    assert.equal(ships, 0);
    assert.deepEqual(told, [], 'the crew hears about the conflict only once the undo landed');
    git.set({ rollbackOk: true });
    await f.store.reconcile();
    assert.equal(git.heads.get('one'), 'one-base');
    assert.equal(f.store.get(w.id, 'cap').jobs[0]!.state, 'running');
    assert.deepEqual(told, ['crew']);
    assert.equal(f.store.get(w.id, 'cap').ship.state, 'complete');
  } finally { f.db.close(); }
});

test('a restart finishes a fold that landed in every repository and undoes one that landed in some', async () => {
  const f = fixture(); const git = foldGit(['one', 'two']); let restarts = 0;
  f.deps.report = async () => '12 passed';
  f.deps.foldOps = git.ops;
  f.deps.restartDev = async () => { restarts++; };
  try {
    const w = await f.create();
    await f.store.devLink(w.id, 'cap');
    await f.store.submit(w.id, 'cap', { id: 'all', editing: true, payload: '{}' });
    git.set({ crashAfterMerge: true });
    f.statuses.set('all', 'idle');
    await f.store.reconcile();
    const saved = f.store.get(w.id, 'cap').jobs[0]!;
    assert.equal(saved.state, 'folding');
    assert.equal(saved.fold?.state, 'merging');
    git.heads.set('two', 'two-merged');
    git.set({ crashAfterMerge: false });
    const reloaded = createWorkstreams(f.db, f.deps);
    await reloaded.reconcile();
    assert.equal(reloaded.get(w.id, 'cap').jobs[0]!.state, 'folded', 'both repositories hold the task commit');
    assert.deepEqual(git.calls.filter((c) => c.startsWith('undo')), []);
    assert.equal(restarts, 0, 'no package or settings file changed');

    const g = fixture(); const partial = foldGit(['one', 'two']);
    g.deps.report = async () => '12 passed';
    g.deps.foldOps = partial.ops;
    const v = await g.create();
    await g.store.submit(v.id, 'cap', { id: 'some', editing: true, payload: '{}' });
    partial.set({ crashAfterMerge: true });
    g.statuses.set('some', 'idle');
    await g.store.reconcile();
    partial.set({ crashAfterMerge: false });
    const again = createWorkstreams(g.db, g.deps);
    partial.set({ merge: () => 'wait' });
    await again.reconcile();
    assert.equal(partial.heads.get('one'), 'one-base', 'the repository that merged is undone');
    const job = again.get(v.id, 'cap').jobs[0]!;
    assert.equal(job.state, 'finished');
    assert.equal(job.fold, undefined);
    g.db.close();
  } finally { f.db.close(); }
});

test('a fold that must wait for the workstream worktree is retried and never reaches the crew', async () => {
  const f = fixture(); const git = foldGit(['one']); const told: string[] = [];
  f.deps.report = async () => 'All tests passed.';
  f.deps.foldOps = git.ops;
  f.deps.tell = async (_w, job) => { told.push(job.id); };
  try {
    const w = await f.create();
    await f.store.submit(w.id, 'cap', { id: 'crew', editing: true, payload: '{}' });
    git.set({ merge: () => 'wait' });
    f.statuses.set('crew', 'idle');
    await f.store.reconcile();
    const waiting = f.store.get(w.id, 'cap').jobs[0]!;
    assert.equal(waiting.state, 'finished');
    assert.match(waiting.note ?? '', /^waiting: the workstream worktree has local changes/);
    assert.deepEqual(told, []);
    git.set({ merge: () => 'merged' });
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').jobs[0]!.state, 'folded');
    const unplanned = fixture();
    unplanned.deps.report = async () => 'All tests passed.';
    unplanned.deps.foldOps = { ...git.ops, plan: async () => ({ wait: 'the task checkout is not recorded yet' }) };
    const u = await unplanned.create();
    await unplanned.store.submit(u.id, 'cap', { id: 'crew', editing: true, payload: '{}' });
    unplanned.statuses.set('crew', 'idle');
    await unplanned.store.reconcile();
    assert.equal(unplanned.store.get(u.id, 'cap').jobs[0]!.note, 'waiting: the task checkout is not recorded yet');
    unplanned.db.close();
  } finally { f.db.close(); }
});

test('Ship takes only work folded when it starts; later folds go out with the next Ship', async () => {
  const f = fixture(); const snapshots: string[][] = [];
  f.deps.report = async () => 'All tests passed.';
  f.deps.fold = async () => ({ ok: true, conflict: false, files: ['a.ts'] });
  f.deps.ship = async (w) => { snapshots.push([...(w.ship.snapshot?.jobs ?? [])]); };
  try {
    const w = await f.create();
    await f.store.submit(w.id, 'cap', { id: 'first', editing: true, payload: '{}', taskId: 'T1' });
    await f.store.submit(w.id, 'cap', { id: 'second', editing: true, payload: '{}', taskId: 'T2' });
    f.statuses.set('first', 'idle');
    await f.store.ship(w.id, 'cap', 'one');
    assert.deepEqual(snapshots, [['first']]);
    assert.deepEqual(f.store.get(w.id, 'cap').ship.snapshot?.taskIds, ['T1']);
    f.statuses.set('second', 'idle');
    await f.store.reconcile();
    await f.store.ship(w.id, 'cap', 'two');
    assert.deepEqual(snapshots, [['first'], ['second']]);
    assert.equal(f.store.get(w.id, 'cap').jobs.find((j) => j.id === 'first')!.shipped, 'one');
  } finally { f.db.close(); }
});

test('a dropped task archives a started crew; a queued one has nothing to clean', async () => {
  const f = fixture(); const archived: string[] = [];
  let free = MEMORY_GUARD_BYTES - 1;
  f.deps.memAvailable = async () => free;
  f.deps.archive = async (_w, job) => { archived.push(job.id); };
  const states = new Map([['T1', 'working'], ['T2', 'working']]);
  f.deps.taskState = (id) => states.get(id);
  try {
    const w = await f.create();
    free = MEMORY_GUARD_BYTES;
    await f.store.submit(w.id, 'cap', { id: 'started', editing: true, payload: '{}', taskId: 'T1' });
    free = MEMORY_GUARD_BYTES - 1;
    await f.store.submit(w.id, 'cap', { id: 'queued', editing: true, payload: '{}', taskId: 'T2' });
    states.set('T1', 'dropped'); states.set('T2', 'dropped');
    await f.store.reconcile();
    const jobs = f.store.get(w.id, 'cap').jobs;
    assert.deepEqual(archived, ['started']);
    assert.deepEqual(jobs.map((j) => [j.id, j.state, j.cleanup]), [['started', 'dropped', 'done'], ['queued', 'dropped', 'done']]);
  } finally { f.db.close(); }
});

test('an archive that keeps the crew, or fails, leaves cleanup pending until a later pass succeeds', async () => {
  const f = fixture();
  let outcome: 'kept' | 'fail' | 'ok' = 'kept';
  f.deps.report = async () => 'All tests passed.';
  f.deps.fold = async () => ({ ok: true, conflict: false, files: ['a.ts'] });
  f.deps.archive = async () => {
    if (outcome === 'fail') throw new Error('archive refused');
    if (outcome === 'kept') return { kept: 'its captain is in a turn' };
  };
  try {
    const w = await f.create();
    await f.store.submit(w.id, 'cap', { id: 'crew', editing: true, payload: '{}' });
    f.statuses.set('crew', 'idle');
    await f.store.reconcile();
    assert.deepEqual([f.store.get(w.id, 'cap').jobs[0]!.cleanup, f.store.get(w.id, 'cap').jobs[0]!.note], ['pending', 'cleanup waits: its captain is in a turn']);
    outcome = 'fail';
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').jobs[0]!.cleanup, 'pending');
    await assert.rejects(f.store.end(w.id, 'cap'), /task cleanup/);
    outcome = 'ok';
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').jobs[0]!.cleanup, 'done');
  } finally { f.db.close(); }
});

test('compact view shows the latest job of each task once', async () => {
  const f = fixture();
  f.deps.report = async () => 'All tests passed.';
  f.deps.fold = async () => ({ ok: true, conflict: false, files: ['a.ts'] });
  try {
    const w = await f.create();
    await f.store.submit(w.id, 'cap', { id: 'first', editing: true, payload: '{}', taskId: 'T3', title: 'Restyle' });
    f.statuses.set('first', 'idle');
    await f.store.reconcile();
    await f.store.submit(w.id, 'cap', { id: 'second', editing: true, payload: '{}', taskId: 'T3', title: 'Restyle', followUpOf: 'first' });
    assert.deepEqual(f.store.view(w.id, 'cap').split('\n'), ['T3 Restyle default working']);
  } finally { f.db.close(); }
});

test('a finished adopted editor, and one saved before task worktrees, close under the old rule so End works', async () => {
  const f = fixture();
  try {
    const adopted = seedLegacyWorkstream(f.db, { projectId: 'cyndra', name: 'Adopted', requestId: 'adopt-end', taskIds: ['T1'] });
    await f.store.submit(adopted.id, 'cap', { id: 'editor', editing: true, payload: '{}' });
    assert.equal(f.store.get(adopted.id, 'cap').jobs[0]!.isolated, undefined);
    f.statuses.set('editor', 'idle');
    await f.store.reconcile();
    assert.equal(f.store.get(adopted.id, 'cap').jobs[0]!.state, 'finished');
    assert.equal(f.store.get(adopted.id, 'cap').state, 'ended', 'automatic End runs once every task is Live');
  } finally { f.db.close(); }
});

test('an editor saved before task worktrees waits for the running editor, as it did then', async () => {
  const f = fixture();
  try {
    const w = await f.create();
    await f.store.submit(w.id, 'cap', { id: 'task', editing: true, payload: '{}' });
    const saved = f.store.get(w.id, 'cap');
    saved.jobs.push({ id: 'legacy', editing: true, payload: '{}', state: 'queued', threadId: null });
    f.db.prepare('UPDATE firstmate_workstream SET record=? WHERE id=?').run(JSON.stringify(saved), w.id);
    await f.store.reconcile();
    assert.deepEqual(f.started, ['task'], 'the shared workstream worktree has one editor at a time');
    f.statuses.set('task', 'idle');
    await f.store.reconcile();
    assert.ok(f.started.includes('legacy'));
    assert.equal(f.store.get(w.id, 'cap').jobs.find((j) => j.id === 'legacy')!.isolated, undefined);
  } finally { f.db.close(); }
});
