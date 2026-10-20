// A folded workstream task's crew is archived only after every fact is read again under its lifecycle lock:
// never while it or its captain works, has child threads, shares its worktree, is held by another open task,
// or holds unsaved work. An archive that fails leaves cleanup pending, never done.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createOwnerTasks } from './lib/owner-tasks.ts';
import { createWorkstreams } from './lib/workstreams.ts';
import { stubProviderCatalog } from './test/provider-catalog.mjs';
import { manifestSkillIds } from './scripts/plugin-skill-fixture.mjs';

type Row = Record<string, unknown>;

async function foldedTask() {
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: manifestSkillIds(new URL('.', import.meta.url).pathname) });
  const seeded = createWorkstreams(host.bb.storage.database(), {
    now: () => 0, provision: async () => [{ repository: 'cyndra-ai/cyndra-saas', projectId: 'cyndra', hostId: 'h1', path: '/repo/ws', sourcePath: '/repo/main', branch: 'workstream/ws-test', environmentId: 'env_ws' }],
    start: async () => 'thr_task', status: async () => 'active', startDev: async () => '', stopDev: async () => {}, unsaved: async () => [], remove: async () => {}, ship: async () => {}, taskState: () => 'working',
  });
  const w = await seeded.create({ threadId: 'cap', projectId: 'cyndra', name: 'Design', requestId: 'create' });
  await seeded.submit(w.id, 'cap', { id: 'crew1', editing: true, payload: '{"task":"First edit"}', repository: 'cyndra-ai/cyndra-saas' });
  const tasks = createOwnerTasks(host.bb.storage.database());
  const task = tasks.open({ captain: 'cap', project: 'Cyndra SaaS', projectId: 'cyndra', title: 'First edit', sourceRefs: ['tg:42:1'], crewId: 'crew1', at: Date.now() });
  seeded.noteJob(w.id, 'cap', 'crew1', {
    state: 'folded', cleanup: 'pending', taskId: task.id, threadId: 'thr_task', environmentId: 'env_task', path: '/repo/task', branch: 'task/one',
    repos: [{ repository: 'cyndra-ai/cyndra-saas', path: '/repo/task', branch: 'task/one', environmentId: 'env_task', hostId: 'h1' }],
  });
  await plugin(host.bb); stubProviderCatalog(host);
  await host.harness.behavior.setSettings({ signInCheck: false, fmHome: '', maxActiveCrews: 0 });
  await host.bb.storage.kv.set('captain-project:cap', 'cyndra');
  const threads = new Map<string, Row>([
    ['cap', { status: 'idle' }],
    ['thr_task', { status: 'idle', environmentId: 'env_task', parentThreadId: 'cap' }],
  ]);
  const lists = { occupants: new Map<string, Row[]>([['env_task', [{ id: 'thr_task', archivedAt: null, status: 'idle' }]]]), children: [] as Row[], project: [] as Row[] };
  const archived: string[] = [];
  const unarchived: string[] = [];
  const stopped: string[] = [];
  const commands: string[] = [];
  // What BB does inside the archive call; by default it archives just this thread.
  let onArchive: (threadId: string) => string[] = (threadId) => [threadId];
  let unsaved = 'FM_UNSAVED checked';
  let duringCheck: () => void = () => {};
  let archiveError: Error | undefined;
  host.harness.sdk.stub('threads.getPluginMetadata', async ({ threadId }: { threadId: string }) => (threadId === 'cap' ? { captain: 'true' } : {}));
  host.harness.sdk.stub('threads.get', async ({ threadId }: { threadId: string }) => ({
    ...makeThreadResponse({ id: threadId, projectId: 'cyndra', status: String(threads.get(threadId)?.status ?? 'idle') }),
    archivedAt: null, ...threads.get(threadId),
  }));
  host.harness.sdk.stub('threads.list', async (args: { environmentId?: string; parentThreadId?: string; sourceThreadId?: string; projectId?: string }) => {
    if (args.environmentId) return lists.occupants.get(args.environmentId) ?? [];
    if (args.parentThreadId) return args.parentThreadId === 'thr_task' ? lists.children : [];
    if (args.sourceThreadId) return [];
    if (args.projectId) return lists.project;
    return [];
  });
  host.harness.sdk.stub('environments.get', async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: 'h1', path: environmentId === 'env_task' ? '/repo/task' : '/repo/ws', status: 'ready', isWorktree: true }));
  host.harness.sdk.stub('hosts.exec', async ({ command }: { command: string }) => {
    commands.push(command);
    if (command.includes('echo present')) return { exitCode: 0, stdout: 'present' };
    if (command.includes(' check ')) { duringCheck(); return { exitCode: 0, stdout: unsaved }; }
    return { exitCode: 0, stdout: '' };
  });
  host.harness.sdk.stub('threads.archive', async ({ threadId }: { threadId: string }) => {
    if (archiveError) throw archiveError;
    archived.push(threadId);
    return { ok: true, archivedThreadIds: onArchive(threadId) };
  });
  host.harness.sdk.stub('threads.unarchive', async ({ threadId }: { threadId: string }) => { unarchived.push(threadId); return { ok: true }; });
  host.harness.sdk.stub('threads.stop', async ({ threadId }: { threadId: string }) => { stopped.push(threadId); return { ok: true }; });
  host.harness.sdk.stub('plugins.callRpc', async () => ({ ok: true, queued: 1, duplicate: false }));
  const job = () => seeded.get(w.id, 'cap').jobs.find((j) => j.id === 'crew1')!;
  return {
    host, tasks, task, threads, lists, archived, unarchived, stopped, commands, job,
    whenArchived: (fn: (threadId: string) => string[]) => { onArchive = fn; },
    pass: () => host.harness.behavior.runSchedule('workstreams'),
    set: (knobs: { unsaved?: string; duringCheck?: () => void; archiveError?: Error }) => {
      if (knobs.unsaved !== undefined) unsaved = knobs.unsaved;
      if (knobs.duringCheck) duringCheck = knobs.duringCheck;
      archiveError = knobs.archiveError;
    },
  };
}

test('a clean idle folded crew is archived, its task branch is deleted, and cleanup is done', async () => {
  const f = await foldedTask();
  try {
    await f.pass();
    assert.deepEqual(f.archived, ['thr_task']);
    assert.equal(f.job().cleanup, 'done');
    assert.equal(f.job().state, 'folded');
    assert.ok(f.commands.some((c) => c.includes('task/one') && c.includes('branch -D')), 'the task branch is deleted after the fold');
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('each reason to keep a crew leaves cleanup pending and archives nothing', async () => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof foldedTask>>) => void, RegExp]> = [
    ['running turn', (f) => f.threads.set('thr_task', { ...f.threads.get('thr_task'), status: 'active' }), /still working/],
    ['background command', (f) => f.threads.set('thr_task', { ...f.threads.get('thr_task'), activity: { activeBackgroundCommandCount: 1 } }), /still working/],
    ['captain in a turn', (f) => f.threads.set('cap', { status: 'active' }), /captain/],
    ['child thread', (f) => { f.lists.children = [{ id: 'thr_child', archivedAt: null }]; }, /child threads/],
    ['lifecycle dependent', (f) => { f.lists.project = [{ id: 'thr_dep', archivedAt: null, lifecycleOwnerThreadId: 'thr_task' }]; }, /child threads/],
    ['shared worktree', (f) => f.lists.occupants.set('env_task', [{ id: 'thr_task', archivedAt: null, status: 'idle' }, { id: 'thr_retry', archivedAt: null, status: 'idle' }]), /shared with thr_retry/],
    ['another open task', (f) => {
      const other = f.tasks.open({ captain: 'cap', project: 'Cyndra SaaS', projectId: 'cyndra', title: 'Other', sourceRefs: ['tg:42:2'], at: Date.now() });
      f.tasks.attach(other.id, 'cap', { crewId: 'crew1', sourceRefs: [], project: { id: 'cyndra', label: 'Cyndra SaaS' }, at: Date.now() });
    }, /still used by task T2/],
  ];
  for (const [name, arrange, reason] of cases) {
    const f = await foldedTask();
    try {
      arrange(f);
      await f.pass();
      assert.deepEqual(f.archived, [], name);
      assert.equal(f.job().cleanup, 'pending', name);
      assert.match(f.job().note ?? '', reason, name);
    } finally { await f.host.harness.lifecycle.dispose(); }
  }
});

test('a crew that starts a turn during the Git check is kept, and archived on a later pass', async () => {
  const f = await foldedTask();
  try {
    f.set({ duringCheck: () => f.threads.set('thr_task', { ...f.threads.get('thr_task'), status: 'active' }) });
    await f.pass();
    assert.deepEqual(f.archived, []);
    assert.equal(f.job().cleanup, 'pending');
    f.set({ duringCheck: () => {} });
    f.threads.set('thr_task', { ...f.threads.get('thr_task'), status: 'idle' });
    await f.pass();
    assert.deepEqual(f.archived, ['thr_task']);
    assert.equal(f.job().cleanup, 'done');
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('unsaved work keeps the worktree, and an archive failure leaves cleanup pending', async () => {
  const f = await foldedTask();
  try {
    f.set({ unsaved: 'FM_UNSAVED uncommitted 2\nFM_UNSAVED checked' });
    await f.pass();
    assert.equal(f.job().cleanup, 'kept-unsaved');
    assert.match(f.job().note ?? '', /2 uncommitted file\(s\)/);
    f.set({ unsaved: 'FM_UNSAVED checked', archiveError: new Error('BB refused the archive') });
    await f.pass();
    assert.equal(f.job().cleanup, 'pending');
    assert.match(f.job().note ?? '', /archive failed \(BB refused the archive\); archive undone/);
    assert.deepEqual(f.unarchived, ['thr_task'], 'an archive request that may have reached BB is undone');
    f.set({});
    await f.pass();
    assert.equal(f.job().cleanup, 'done');
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('a turn started just before the archive keeps running: the archive is undone within the grace and logged once', async () => {
  const f = await foldedTask();
  try {
    // BB accepts the archive although a turn started after the last read; its grace keeps the turn running.
    f.whenArchived((threadId) => { f.threads.set(threadId, { ...f.threads.get(threadId), status: 'active' }); return [threadId]; });
    await f.pass();
    assert.deepEqual(f.archived, ['thr_task']);
    assert.deepEqual(f.unarchived, ['thr_task']);
    assert.deepEqual(f.stopped, [], 'the new turn is never stopped');
    assert.equal(f.threads.get('thr_task')!.status, 'active', 'the turn keeps running');
    assert.equal(f.job().cleanup, 'pending');
    assert.match(f.job().note ?? '', /work started while archiving; archive undone/);
    f.threads.set('thr_task', { ...f.threads.get('thr_task'), status: 'idle' });
    await f.pass();
    assert.deepEqual(f.unarchived, ['thr_task', 'thr_task']);
    const undoLogs = f.host.harness.inspection.logEntries.filter((entry) => entry.level === 'warn' && entry.message.includes('workstream task cleanup: thr_task'));
    assert.equal(undoLogs.length, 1, 'a repeated undo is logged once');
    f.threads.set('thr_task', { ...f.threads.get('thr_task'), status: 'idle' });
    f.whenArchived((threadId) => [threadId]);
    await f.pass();
    assert.equal(f.job().cleanup, 'done');
    assert.deepEqual(f.unarchived, ['thr_task', 'thr_task']);
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('an archive that BB widened to other threads, or one that work started beside, is undone for every thread it took', async () => {
  const f = await foldedTask();
  try {
    f.whenArchived((threadId) => [threadId, 'thr_hidden_source']);
    await f.pass();
    assert.deepEqual(f.unarchived, ['thr_task', 'thr_hidden_source'], 'the crew thread first, then the rest');
    assert.match(f.job().note ?? '', /BB also archived thr_hidden_source; archive undone/);
    assert.equal(f.job().cleanup, 'pending');
    const g = await foldedTask();
    try {
      g.whenArchived((threadId) => { g.lists.occupants.set('env_task', [{ id: threadId, archivedAt: 1 }, { id: 'thr_late', archivedAt: null, status: 'active' }]); return [threadId]; });
      await g.pass();
      assert.deepEqual(g.unarchived, ['thr_task']);
      assert.match(g.job().note ?? '', /work started while archiving/);
    } finally { await g.host.harness.lifecycle.dispose(); }
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('End archives the crew threads in the workstream worktree one by one under the same rules, then removes it', async () => {
  for (const busy of [true, false]) {
    const f = await foldedTask();
    try {
      const db = f.host.bb.storage.database();
      const saved = db.prepare('SELECT id,record FROM firstmate_workstream').all()[0] as { id: string; record: string };
      const w = JSON.parse(saved.record); w.jobs[0].cleanup = 'done';
      db.prepare('UPDATE firstmate_workstream SET record=? WHERE id=?').run(JSON.stringify(w), saved.id);
      f.tasks.move(f.task.id, 'cap', { to: 'dropped', reason: 'the owner ended this fixture task', ref: 'tg:42:1' }, Date.now());
      await f.host.bb.storage.kv.set('crews', [{ id: 'scout1', task: 'read', projectId: 'cyndra', threadId: 'thr_scout', parentThreadId: 'cap', workstreamId: saved.id, nativeHome: '', worktree: false, shape: 'scout', posture: 'scout', createdAt: '2026-10-19T00:00:00.000Z', providerId: null, model: null, reasoningLevel: null }]);
      f.threads.set('thr_scout', { status: 'idle', environmentId: 'env_ws', parentThreadId: 'cap', ...(busy ? { activity: { activeBackgroundAgentCount: 1 } } : {}) });
      f.lists.occupants.set('env_ws', [{ id: 'thr_scout', status: 'idle', archivedAt: null }]);
      const bulk: string[] = [];
      f.host.harness.sdk.stub('environments.archiveThreads', async ({ environmentId }: { environmentId: string }) => { bulk.push(environmentId); return { archivedThreadIds: [] }; });
      const end = f.host.harness.behavior.callRpc('workstreams.end', { threadId: 'cap', workstreamId: saved.id }) as Promise<{ workstream: { state: string } }>;
      if (busy) {
        await assert.rejects(end, /Workstream worktree kept: a crew thread is still working/);
        assert.deepEqual(f.archived, []);
      } else {
        assert.equal((await end).workstream.state, 'ended');
        assert.deepEqual(f.archived, ['thr_scout']);
        assert.ok(f.commands.some((c) => c.includes('worktree remove') && c.includes('/repo/ws')));
      }
      assert.deepEqual(bulk, [], 'never an environment-wide archive');
    } finally { await f.host.harness.lifecycle.dispose(); }
  }
});
