// A folded workstream task's crew is archived only after every fact is read again under its lifecycle lock:
// never while it or its captain works, has child threads, shares its worktree, is held by another open task,
// or holds unsaved work. An archive that fails leaves cleanup pending, never done.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createOwnerTasks } from './lib/owner-tasks.ts';
import { createDeliveries } from './lib/pr-delivery.ts';
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
  // GitHub as gh answers on the host: the open PRs of each head branch, one PR's head and commits, and
  // which commits the workstream branch holds.
  const gh = {
    open: new Map<string, string[]>(),
    pr: { state: 'OPEN', headRefName: 'task/one', headRefOid: 'c2', commits: [{ oid: 'c1' }, { oid: 'c2' }] },
    inWorkstream: new Set<string>(),
  };
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
    const head = /gh pr list --head (?:'\\'')?'?([^'\\]+)/.exec(command)?.[1]; // plain or nested in ghReadCommand's quotes
    if (head) return { exitCode: 0, stdout: JSON.stringify((gh.open.get(head) ?? []).map((url) => ({ url }))) };
    if (command.includes('gh pr view')) return { exitCode: 0, stdout: JSON.stringify(gh.pr) };
    if (command.includes('merge-base --is-ancestor')) {
      const shas = [...gh.pr.commits.map((c) => c.oid), gh.pr.headRefOid].filter((sha) => command.includes(sha));
      return { exitCode: 0, stdout: shas.map((sha) => `${gh.inWorkstream.has(sha) ? 'FM_IN' : 'FM_OUT'} ${sha}`).join('\n') };
    }
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
    host, tasks, task, threads, lists, archived, unarchived, stopped, commands, job, gh,
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

// 20 Oct, Cyndra PR 2581: the task crew opened its own PR, the fold deleted its branch, GitHub closed the PR,
// and its delivery waited for the owner although the workstream branch held every commit of it.
const PR = 'https://github.com/cyndra-ai/cyndra-saas/pull/2581';
const PR_ID = 'cyndra-ai/cyndra-saas#2581';
const OPEN_READ = { headSha: 'c2', state: 'open', draft: false, checks: 'passing', review: 'unknown', reviewHeadSha: null, mergeCommitSha: null, mergeable: 'mergeable' } as const;

test('a fold closes the task branch\'s open PR with a note and ends its delivery, only when the workstream branch holds every commit', async () => {
  for (const [name, inWorkstream, workstreamPr] of [['one commit outside', ['c1'], null], ['all in, no workstream PR yet', ['c1', 'c2'], null], ['all in', ['c1', 'c2'], 'https://github.com/cyndra-ai/cyndra-saas/pull/2600']] as const) {
    const f = await foldedTask();
    try {
      const store = createDeliveries(f.host.bb.storage.database());
      store.register({ url: PR, taskId: 'crew1', projectId: 'cyndra', owner: 'cap', home: '', worker: 'thr_task', requirement: 'pr' });
      store.observe(PR_ID, OPEN_READ, false);
      f.gh.open.set('task/one', [PR]);
      if (workstreamPr) f.gh.open.set('workstream/ws-test', [workstreamPr]);
      f.gh.inWorkstream = new Set(inWorkstream);
      await f.pass();
      assert.equal(f.job().cleanup, 'done', name);
      const close = f.commands.findIndex((c) => c.includes('gh pr close'));
      const remove = f.commands.findIndex((c) => c.includes('push origin --delete'));
      if (inWorkstream.length < 2) {
        assert.equal(close, -1, `${name}: the PR stays open`);
        assert.equal(remove, -1, `${name}: the branch stays`);
        assert.match(f.job().note ?? '', /branch task\/one kept: .*pull\/2581 stays open: 1 of 2 commits are not in the workstream branch/, name);
        assert.equal(store.get(PR_ID)!.status, 'pr-delivered', `${name}: the delivery is untouched`);
        continue;
      }
      const note = `Folded into workstream Design; its commits ship in the workstream PR ${workstreamPr ?? 'when it is opened'}.`;
      assert.ok(close >= 0 && f.commands[close]!.includes(PR) && f.commands[close]!.includes(note), `${name}: the PR is closed with the note`);
      assert.ok(remove > close, `${name}: the branch goes after the PR is closed`);
      const row = store.get(PR_ID)!;
      assert.equal(row.status, 'explicitly-abandoned', name);
      assert.equal(row.disposition?.reason, note, name);
      assert.equal(row.notification.desired, null, `${name}: nothing goes to the captain`);
      assert.equal(f.job().note, undefined, name);
    } finally { await f.host.harness.lifecycle.dispose(); }
  }
});

test('an already closed PR of a folded task ends on its next read with no notice, only when the workstream branch holds every commit', async () => {
  for (const [name, inWorkstream, headRefName] of [['all in', ['c1', 'c2'], 'task/one'], ['one commit outside', ['c2'], 'task/one'], ['the head is not the task branch', ['c1', 'c2'], 'workstream/ws-test']] as const) {
    const f = await foldedTask();
    try {
      const store = createDeliveries(f.host.bb.storage.database());
      store.register({ url: PR, taskId: 'crew1', projectId: 'cyndra', owner: 'cap', home: '', worker: 'thr_task', requirement: 'pr' });
      store.observe(PR_ID, OPEN_READ, false);
      const closed = store.observe(PR_ID, { ...OPEN_READ, state: 'closed' }, false);
      // The captain already heard about the close once, as for PR 2581.
      store.save({ ...closed, notification: { ...closed.notification, delivered: closed.notification.desired, queued: closed.notification.desired } });
      f.gh.pr = { ...f.gh.pr, state: 'CLOSED', headRefName };
      f.gh.inWorkstream = new Set(inWorkstream);
      const sent: string[] = [];
      f.host.harness.sdk.stub('threads.send', async (args: Row) => { sent.push(JSON.stringify(args)); return { delivery: 'queued' }; });
      f.host.harness.sdk.stub('environments.list', async () => [{ id: 'env_main', hostId: 'h1', status: 'ready', isWorktree: false, path: '/repo/main' }]);
      const terminals = new Map<string, string>();
      f.host.harness.sdk.stub('terminals.create', async (args: { start: { command: string } }) => { const id = `term${terminals.size + 1}`; terminals.set(id, args.start.command); return { id }; });
      f.host.harness.sdk.stub('terminals.get', async () => ({ status: 'running' }));
      f.host.harness.sdk.stub('terminals.close', async () => ({}));
      f.host.harness.sdk.stub('terminals.output', async ({ terminalId }: { terminalId: string }) => {
        const command = terminals.get(terminalId) ?? '';
        const stdout = command.includes('gh pr view') ? JSON.stringify({ state: 'CLOSED', headRefOid: 'c2', isDraft: false, statusCheckRollup: [], reviewDecision: '', reviews: [], mergeable: 'UNKNOWN', mergeCommit: null, title: 'Fix the dashboard', comments: [], labels: [], commits: [] }) : '';
        const payload = command.includes('FM_HOST_CAPTURE_V1') ? JSON.stringify({ protocol: 'FM_HOST_CAPTURE_V1', exitCode: 0, stdout, stderr: '' }) : stdout;
        return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${payload}\n__FM_HOST_RC:0\n`).toString('base64') }] };
      });
      const tool = f.host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_deliveries')!;
      await tool.execute({ action: 'reconcile', id: PR_ID }, { threadId: 'cap', projectId: 'cyndra' });
      const row = store.get(PR_ID)!;
      assert.deepEqual(sent.filter((m) => m.includes('FM_DELIVERY_NOTICE')), [], `${name}: no notice goes to the captain`);
      assert.ok(!f.commands.some((c) => c.includes('gh pr close') || c.includes('gh pr comment')), `${name}: nothing is written on GitHub`);
      if (name !== 'all in') {
        assert.equal(row.status, 'closed-needs-disposition', name);
        assert.equal(row.disposition, null, name);
        continue;
      }
      assert.equal(row.status, 'explicitly-abandoned', name);
      assert.equal(row.disposition?.reason, 'Folded into workstream Design; its commits ship in the workstream PR when it is opened.', name);
      assert.equal(row.notification.desired, null, name);
    } finally { await f.host.harness.lifecycle.dispose(); }
  }
});
