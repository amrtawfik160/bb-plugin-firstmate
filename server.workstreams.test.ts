import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createOwnerTasks } from './lib/owner-tasks.ts';
import { stubProviderCatalog } from './test/provider-catalog.mjs';
import { manifestSkillIds } from './scripts/plugin-skill-fixture.mjs';
import { approveAdopt, stubHostGit } from './test/workstream-adopt-fixtures.mjs';

const skills = manifestSkillIds(new URL('.', import.meta.url).pathname);
const cap = { threadId: 'cap', projectId: 'cyndra' } as never;
const crewRow = (id: string, threadId: string, extra: Record<string, unknown> = {}) => ({
  id, task: 'x', title: id, projectId: 'cyndra', threadId, parentThreadId: 'cap', nativeHome: '', worktree: true,
  shape: 'ship', posture: 'direct-PR', createdAt: '2026-10-19T00:00:00.000Z', providerId: null, model: null, reasoningLevel: null, ...extra,
});

async function adoptHost(status: Record<string, string> = {}) {
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: skills });
  await host.bb.storage.kv.set('captain-project:cap', 'cyndra');
  await plugin(host.bb); stubProviderCatalog(host);
  host.harness.sdk.stub('threads.getPluginMetadata', async ({ threadId }: { threadId: string }) => (threadId === 'cap' ? { captain: 'true' } : {}));
  host.harness.sdk.stub('threads.get', async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: 'cyndra', status: status[threadId] ?? 'active' }));
  host.harness.sdk.stub('threads.list', async () => []);
  host.harness.sdk.stub('projects.list', async () => [{ id: 'cyndra', name: 'Cyndra SaaS' }, { id: 'safi', name: 'Safi' }]);
  host.harness.sdk.stub('projects.get', async ({ projectId }: { projectId: string }) => ({
    id: projectId, name: projectId === 'safi' ? 'Safi' : 'Cyndra SaaS', kind: 'repo',
    sources: projectId === 'cyndra' ? [{ hostId: 'h1', path: '/repo/main', isDefault: true }] : [],
  }));
  host.harness.sdk.stub('environments.list', async () => [{ id: 'env_main', hostId: 'h1', path: '/repo/main', status: 'ready', isWorktree: false }]);
  host.harness.sdk.stub('environments.get', async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: 'h1', path: '/repo/main', status: 'ready', isWorktree: false }));
  host.harness.sdk.stub('threads.send', async () => ({}));
  host.harness.sdk.stub('threadSections.list', async () => []);
  host.harness.sdk.stub('threadSections.create', async () => ({ id: 'sec' }));
  host.harness.sdk.stub('threads.defaultExecutionOptions', async () => ({ model: 'gpt-6.1-sol', reasoningLevel: 'high' }));
  host.harness.sdk.stub('plugins.callRpc', async () => ({ ok: true, queued: 1, duplicate: false }));
  const tasks = createOwnerTasks(host.bb.storage.database());
  const open = (title: string, extra: { project?: string | null; projectId?: string | null; crewId?: string } = {}) =>
    tasks.open({ captain: 'cap', project: extra.project === undefined ? 'Cyndra SaaS' : extra.project, projectId: extra.projectId === undefined ? 'cyndra' : extra.projectId, title, sourceRefs: [`tg:42:${title.length}`], crewId: extra.crewId, at: Date.now() });
  return { host, tasks, open };
}

function stubCrewWorktrees(host: Awaited<ReturnType<typeof adoptHost>>['host'], status: Record<string, string>, threads: Record<string, { envId: string; path: string; branch: string }>) {
  host.harness.sdk.stub('threads.get', async ({ threadId }: { threadId: string }) => makeThreadResponse({
    id: threadId, projectId: 'cyndra', status: status[threadId] ?? 'active',
    environmentId: threads[threadId]?.envId,
  }));
  host.harness.sdk.stub('environments.get', async ({ environmentId }: { environmentId: string }) => {
    const spec = Object.values(threads).find((row) => row.envId === environmentId);
    if (spec) return { id: spec.envId, hostId: 'h1', path: spec.path, status: 'ready', isWorktree: true, branchName: spec.branch };
    return { id: environmentId, hostId: 'h1', path: '/repo/main', status: 'ready', isWorktree: false };
  });
}

test('workstreams RPC lists every project, and creation is not limited to Cyndra', async () => {
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: manifestSkillIds(new URL('.', import.meta.url).pathname) });
  await host.bb.storage.kv.set('captain-project:cap', 'cyndra');
  await plugin(host.bb); stubProviderCatalog(host);
  host.harness.sdk.stub('threads.getPluginMetadata', async () => ({ captain: 'true' }));
  host.harness.sdk.stub('threads.get', async () => makeThreadResponse({ id: 'cap', projectId: 'cyndra' }));
  host.harness.sdk.stub('projects.list', async () => [{ id: 'cyndra', name: 'Cyndra SaaS' }, { id: 'safi', name: 'Safi' }]);
  host.harness.sdk.stub('projects.get', async ({ projectId }: { projectId: string }) => ({ id: projectId, name: projectId === 'safi' ? 'Safi' : 'Cyndra SaaS', sources: [] }));
  try {
    const listed = await host.harness.behavior.callRpc('workstreams.list', { threadId: 'cap' });
    assert.deepEqual(listed, { workstreams: [], trialProjectIds: ['cyndra', 'safi'] });
    // Safi has no checkout on this fake host, so creation stops there, never at a project gate.
    const refusal = await host.harness.behavior.callRpc('workstreams.create', { threadId: 'cap', projectId: 'safi', name: 'Design', requestId: 'tap1' }).then(() => '', (error: unknown) => String(error));
    assert.doesNotMatch(refusal, /trial/);
    assert.ok(host.harness.inspection.registrations.agentTools.some((t) => t.name === 'firstmate_workstream'));
  } finally { await host.harness.lifecycle.dispose(); }
});
test('fake BB: two created editing tasks start together on their own worktrees while a scout reuses the workstream', async () => {
  const { createWorkstreams } = await import('./lib/workstreams.ts');
  const host = createFakePluginHost({ pluginId:'firstmate', agentSkillIds:manifestSkillIds(new URL('.',import.meta.url).pathname) });
  const seeded = createWorkstreams(host.bb.storage.database(), {
    now:()=>0, provision:async () => [{repository:'cyndra-ai/cyndra-saas',projectId:'cyndra',hostId:'h1',path:'/repo/ws',sourcePath:'/repo/main',branch:'workstream/ws-test',environmentId:'env_ws'}],
    start:async () => 'unused',status:async () => 'unknown',startDev:async () => '',stopDev:async () => {},unsaved:async () => [],remove:async () => {},ship:async () => {},taskState:()=> 'working',
  });
  const w = await seeded.create({threadId:'cap',projectId:'cyndra',name:'Design',requestId:'create'});
  await plugin(host.bb); stubProviderCatalog(host);
  await host.harness.behavior.setSettings({transport:'real',signInCheck:false,fmHome:'',maxActiveCrews:0});
  await host.bb.storage.kv.set('captain-project:cap','cyndra');
  const spawned: Array<Record<string,unknown>> = [];
  const statuses = new Map<string,string>();
  host.harness.sdk.stub('threads.getPluginMetadata',async ({threadId}:{threadId:string}) => threadId === 'cap' ? {captain:'true'} : {});
  host.harness.sdk.stub('threads.get',async ({threadId}:{threadId:string}) => ({...makeThreadResponse({id:threadId,projectId:'cyndra',status:statuses.get(threadId) ?? 'active'}),environmentId:threadId === 'cap' ? 'env_main' : 'env_ws'}));
  host.harness.sdk.stub('threads.list',async () => []);
  host.harness.sdk.stub('projects.get',async () => ({id:'cyndra',name:'Cyndra SaaS',kind:'repo',sources:[{hostId:'h1',path:'/repo/main',isDefault:true}]}));
  host.harness.sdk.stub('projects.list',async () => [{id:'cyndra',name:'Cyndra SaaS'}]);
  host.harness.sdk.stub('environments.list',async () => [{id:'env_main',hostId:'h1',path:'/repo/main',status:'ready',isWorktree:false}]);
  host.harness.sdk.stub('environments.get',async ({environmentId}:{environmentId:string}) => ({id:environmentId,hostId:'h1',path:environmentId === 'env_ws' ? '/repo/ws' : '/repo/main',status:'ready',isWorktree:false}));
  host.harness.sdk.stub('threads.spawn',async (args:Record<string,unknown>) => { spawned.push(args); return {id:`worker${spawned.length}`}; });
  host.harness.sdk.stub('threads.defaultExecutionOptions',async () => ({model:'gpt-6.1-sol',reasoningLevel:'high'}));
  host.harness.sdk.stub('threads.send',async () => ({}));
  host.harness.sdk.stub('threadSections.list',async () => []);
  host.harness.sdk.stub('threadSections.create',async () => ({id:'sec'}));
  host.harness.sdk.stub('plugins.callRpc',async () => ({ok:true,queued:1,duplicate:false}));
  const dispatch = host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_dispatch')!;
  const ctx = {threadId:'cap',projectId:'cyndra'} as never;
  const text = (result:unknown) => typeof result === 'string' ? result : JSON.stringify(result);
  try {
    const cards: Array<Record<string, unknown>> = [];
    host.harness.sdk.stub('plugins.callRpc', async (args: { method?: string; input?: Record<string, unknown> }) => {
      if (args.method === 'workstreamCard') { cards.push(args.input ?? {}); return { ok: true }; }
      return { ok: true, queued: 1, duplicate: false };
    });
    const one = await dispatch.execute({task:'First edit',taskId:'editor-one',workstreamId:w.id,origin:{kind:'captain',reason:'approved workstream'},providerId:'codex',model:'gpt-6.1-sol'},ctx);
    assert.match(text(one),/Dispatched/);
    const two = await dispatch.execute({task:'Second edit',taskId:'editor-two',workstreamId:w.id,origin:{kind:'captain',reason:'approved workstream'},providerId:'codex',model:'gpt-6.1-sol'},ctx);
    assert.match(text(two),/Dispatched/);
    const ship = await host.harness.behavior.callRpc("workstreams.ship",{threadId:"cap",workstreamId:w.id,requestId:"tap-while-editing"}).catch((error: unknown) => String(error));
    assert.equal(typeof ship === 'string' && /Ship waits/.test(ship), false);
    const scout = await dispatch.execute({task:'Read the diff',taskId:'read-only',shape:'scout',role:'lookup',workstreamId:w.id,origin:{kind:'captain',reason:'approved workstream'},providerId:'codex',model:'gpt-6.1-sol'},ctx);
    assert.match(text(scout),/Dispatched/);
    assert.equal(spawned.length,3);
    for (const call of spawned) {
      const metadata = call.pluginMetadata as Record<string,unknown>;
      const dir = `/repo/.firstmate-workstream-reports/${w.id}/${metadata.crewId}`;
      assert.equal(metadata.reportDir,dir);
      assert.equal(String(call.prompt).split("Production approval:").length - 1,1);
      assert.ok(String(call.prompt).includes(`${dir}/report.md`),'the brief names the persisted report path');
      assert.ok(String(call.prompt).includes(`create the report directory '${dir}'`));
    }
    assert.ok(String(spawned[2]!.prompt).includes('Read-only repository: do not change repository files or Git state.'));
    assert.deepEqual(spawned[0]!.environment,{type:'host',hostId:'h1',workspace:{type:'managed-worktree',baseBranch:{kind:'named',name:'workstream/ws-test'}}});
    assert.deepEqual(spawned[1]!.environment,{type:'host',hostId:'h1',workspace:{type:'managed-worktree',baseBranch:{kind:'named',name:'workstream/ws-test'}}});
    assert.deepEqual(spawned[2]!.environment,{type:'reuse',environmentId:'env_ws'});
    assert.equal((spawned[0]!.pluginMetadata as Record<string,unknown>).deliveryRequirement,'pr','an editing crew delivers its PR; Ship owns merging');
    assert.ok(cards.length >= 1);
    assert.equal(typeof cards[0]!.revision, 'number');
    await new Promise((resolve) => setImmediate(resolve));
    const cardTasks = cards.map((card) => (card.tasks as Array<{ task: string; state: string }>));
    assert.ok(cardTasks.flat().every((task) => /^T\d+$/.test(task.task)), 'the live connector refuses a card with a crew id in place of T<n>');
    assert.deepEqual(cardTasks.at(-1)!.map((task) => `${task.task}:${task.state}`), ['T1:working', 'T2:working', 'T3:working']);
    assert.ok(cards.every((card, index) => index === 0 || (card.revision as number) > (cards[index - 1]!.revision as number)));
    const view = await host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_workstream')!.execute({ action: 'view', workstreamId: w.id }, ctx);
    assert.match(typeof view === 'string' ? view : JSON.stringify(view), /working|folded|queued/);
    const listed = await host.harness.behavior.callRpc('workstreams.list',{threadId:'cap'}) as {workstreams:Array<{taskIds:string[]}>};
    assert.equal(listed.workstreams[0]!.taskIds.length,3);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('adopt RPC shows one owner card first; his Approve adopts with a new workstream branch; a retry returns the same workstream', async () => {
  const { host, open } = await adoptHost();
  try {
    stubCrewWorktrees(host, { thr_one: 'idle', thr_two: 'idle' }, {
      thr_one: { envId: 'env_one', path: '/wt/one', branch: 'fm/one' },
      thr_two: { envId: 'env_two', path: '/wt/two', branch: 'fm/two' },
    });
    const commands = stubHostGit(host);
    await host.bb.storage.kv.set('crews', [crewRow('one', 'thr_one'), crewRow('two', 'thr_two')]);
    const one = open('Cyndra web chat restyle', { crewId: 'one' });
    const two = open('Composer tokens', { crewId: 'two' });
    const input = { threadId: 'cap', projectId: 'cyndra', name: 'Cyndra web chat restyle', requestId: 'adopt-chat', taskIds: [one.id, two.id] };
    const card = await host.harness.behavior.callRpc('workstreams.adopt', input) as { workstream?: unknown; card: { askId: string; text: string } };
    assert.equal(card.workstream, undefined);
    assert.match(card.card.text, new RegExp(`${one.id} .*: folds now \\(fm/one\\)`));
    assert.equal(commands.some((c) => c.includes('worktree add')), false);
    const { workstream } = await approveAdopt(host, input) as { workstream: { id: string; taskIds: string[]; repos: Array<{ repository: string; existing?: boolean; branch: string }>; provisioned: boolean; jobs: Array<{ id: string; adopted?: boolean }> } };
    assert.deepEqual(workstream.taskIds, [one.id, two.id]);
    assert.equal(workstream.provisioned, true);
    assert.deepEqual(workstream.repos.map((repo) => [repo.repository, repo.existing, repo.branch]), [['cyndra-ai/cyndra-saas', undefined, `workstream/${workstream.id}`]]);
    assert.deepEqual(workstream.jobs.map((job) => [job.id, job.adopted]), [['one', true], ['two', true]]);
    const retry = await host.harness.behavior.callRpc('workstreams.adopt', input) as { workstream: { id: string } };
    assert.equal(retry.workstream.id, workstream.id);
    await assert.rejects(host.harness.behavior.callRpc('workstreams.adopt', { ...input, name: 'Renamed' }), /changed its original/);
    const listed = await host.harness.behavior.callRpc('workstreams.list', { threadId: 'cap' }) as { workstreams: unknown[] };
    assert.equal(listed.workstreams.length, 1);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('adopt refuses another project, a closed task, a held task and missing fields; nothing is created', async () => {
  const { host, tasks, open } = await adoptHost();
  try {
    stubCrewWorktrees(host, { thr_held: 'idle', thr_extra: 'idle' }, {
      thr_held: { envId: 'env_held', path: '/wt/held', branch: 'fm/held' },
      thr_extra: { envId: 'env_extra', path: '/wt/extra', branch: 'fm/extra' },
    });
    await host.bb.storage.kv.set('crews', [crewRow('held', 'thr_held'), crewRow('extra', 'thr_extra')]);
    const cyndra = open('Chat restyle', { crewId: 'held' });
    const safi = open('Apple redesign', { project: 'Safi', projectId: 'safi' });
    await assert.rejects(host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'cyndra', name: 'Mix', requestId: 'mix', taskIds: [cyndra.id, safi.id] }), /another project/);
    assert.equal((await host.harness.behavior.callRpc('workstreams.list', { threadId: 'cap' }) as { workstreams: unknown[] }).workstreams.length, 0);
    const closed = open('Closed line');
    tasks.move(closed.id, 'cap', { to: 'dropped', reason: 'the owner said drop it', ref: 'tg:42:9' }, Date.now());
    await assert.rejects(host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'cyndra', name: 'Closed', requestId: 'closed', taskIds: [closed.id] }), /closed/);
    await assert.rejects(host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'cyndra', name: 'Empty', requestId: 'empty', taskIds: [] }), /rpc input validation failed/);
    const missing = await host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_workstream')!.execute({ action: 'adopt', projectId: 'cyndra', name: 'Empty', requestId: 'empty' }, cap);
    assert.match(typeof missing === 'string' ? missing : JSON.stringify(missing), /Adopt needs taskIds/);
    stubHostGit(host);
    const held = await approveAdopt(host, { projectId: 'cyndra', name: 'Held', requestId: 'held', taskIds: [cyndra.id] }) as { workstream: { id: string } };
    const extra = open('Second chat', { crewId: 'extra' });
    await assert.rejects(host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'cyndra', name: 'Other', requestId: 'other', taskIds: [cyndra.id, extra.id] }), /already belongs to a workstream/);
    const listed = await host.harness.behavior.callRpc('workstreams.list', { threadId: 'cap' }) as { workstreams: Array<{ id: string }> };
    assert.deepEqual(listed.workstreams.map((w) => w.id), [held.workstream.id]);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('CLI --task adopt, captain tool text, dispatch on an adopted stream keeps workstreamId, End refuses a running attached crew', async () => {
  const { host, open } = await adoptHost({ thr_run: 'active' });
  try {
    const tool = host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_workstream')!;
    assert.match(tool.description, /call propose: it groups open tasks per project/);
    assert.match(tool.description, /adopt shows the owner one card listing its tasks, and his Approve adopts it/);
    stubCrewWorktrees(host, { thr_one: 'idle', thr_two: 'idle', thr_run: 'active' }, {
      thr_one: { envId: 'env_one', path: '/wt/one', branch: 'fm/one' },
      thr_two: { envId: 'env_two', path: '/wt/two', branch: 'fm/two' },
      thr_run: { envId: 'env_run', path: '/wt/run', branch: 'fm/run' },
    });
    await host.bb.storage.kv.set('crews', [crewRow('one', 'thr_one'), crewRow('two', 'thr_two')]);
    const one = open('Cyndra web chat restyle', { crewId: 'one' });
    const two = open('Composer tokens', { crewId: 'two' });
    stubHostGit(host);
    const cli = await host.harness.behavior.runCli(['workstream', 'adopt', '--project', 'cyndra', '--name', 'Cyndra web chat restyle', '--request-id', 'cli-adopt', '--task', one.id, '--task', two.id, '--repo', `${two.id}=cyndra-ai/cyndra-saas`], cap) as { exitCode: number; stdout: string; stderr?: string };
    assert.equal(cli.exitCode, 0, cli.stderr ?? cli.stdout);
    const card = JSON.parse(cli.stdout) as { card: { askId: string } };
    assert.ok(card.card.askId, 'the CLI adopt shows the owner card first');
    const adopted = await approveAdopt(host, { projectId: 'cyndra', name: 'Cyndra web chat restyle', requestId: 'cli-adopt', taskIds: [one.id, two.id], tasks: [{ taskId: two.id, repository: 'cyndra-ai/cyndra-saas' }] }) as { workstream: { id: string; taskIds: string[]; repos: Array<{ repository: string; existing?: boolean; branch: string }> } };
    assert.deepEqual(adopted.workstream.taskIds, [one.id, two.id]);
    assert.deepEqual(adopted.workstream.repos.map((repo) => [repo.existing, repo.branch]), [[undefined, `workstream/${adopted.workstream.id}`]]);
    const spawned: Array<Record<string, unknown>> = [];
    host.harness.sdk.stub('threads.spawn', async (args: Record<string, unknown>) => { spawned.push(args); return { id: `worker${spawned.length}` }; });
    await host.harness.behavior.setSettings({ signInCheck: false, fmHome: '', maxActiveCrews: 0 });
    const dispatch = host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_dispatch')!;
    const text = (result: unknown) => typeof result === 'string' ? result : JSON.stringify(result);
    const sent = await dispatch.execute({ task: 'Follow-up edit', taskId: 'follow-1', workstreamId: adopted.workstream.id, origin: { kind: 'captain', reason: 'approved workstream' }, providerId: 'codex', model: 'gpt-6.1-sol' }, cap);
    assert.match(text(sent), /Dispatched/);
    assert.equal(spawned.length, 1);
    const metadata = spawned[0]!.pluginMetadata as Record<string, unknown>;
    assert.equal(metadata.workstreamId, adopted.workstream.id);
    // A task in an adopted workstream gets its own worktree, cut from the workstream branch.
    assert.deepEqual(spawned[0]!.environment, { type: 'host', hostId: 'h1', workspace: { type: 'managed-worktree', baseBranch: { kind: 'named', name: `workstream/${adopted.workstream.id}` } } });
    const crews = await host.bb.storage.kv.get('crews') as Array<{ id: string; workstreamId?: string }>;
    assert.equal(crews.find((c) => c.id === 'follow-1')?.workstreamId, adopted.workstream.id);
    const follow = createOwnerTasks(host.bb.storage.database()).list('cap').find((task) => task.crewIds.includes('follow-1'));
    const listed = await host.harness.behavior.callRpc('workstreams.list', { threadId: 'cap' }) as { workstreams: Array<{ taskIds: string[] }> };
    assert.ok(follow && listed.workstreams[0]!.taskIds.includes(follow.id), `attached after dispatch: ${listed.workstreams[0]!.taskIds.join(',')}`);
    await host.bb.storage.kv.set('crews', [crewRow('run1', 'thr_run')]);
    host.harness.sdk.stub('threads.get', async ({ threadId }: { threadId: string }) => makeThreadResponse({
      id: threadId, projectId: 'cyndra', status: threadId === 'thr_run' ? 'active' : 'active',
      environmentId: threadId === 'thr_run' ? 'env_run' : undefined,
    }));
    host.harness.sdk.stub('environments.get', async ({ environmentId }: { environmentId: string }) => (
      environmentId === 'env_run'
        ? { id: 'env_run', hostId: 'h1', path: '/wt/run', status: 'ready', isWorktree: true, branchName: 'fm/run' }
        : { id: environmentId, hostId: 'h1', path: '/repo/main', status: 'ready', isWorktree: false }
    ));
    const running = open('Running line', { crewId: 'run1' });
    const busy = await approveAdopt(host, { projectId: 'cyndra', name: 'Busy', requestId: 'busy', taskIds: [running.id] }) as { workstream: { id: string } };
    await assert.rejects(host.harness.behavior.callRpc('workstreams.end', { threadId: 'cap', workstreamId: busy.workstream.id }), /active crews/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('fake BB: a failed task retries in its kept worktree, or from its retained branch once that worktree is gone, from both dispatch paths', async () => {
  const { createWorkstreams } = await import('./lib/workstreams.ts');
  const host = createFakePluginHost({ pluginId:'firstmate', agentSkillIds:manifestSkillIds(new URL('.',import.meta.url).pathname) });
  const seeded = createWorkstreams(host.bb.storage.database(), {
    now:()=>0, provision:async () => [{repository:'cyndra-ai/cyndra-saas',projectId:'cyndra',hostId:'h1',path:'/repo/ws',sourcePath:'/repo/main',branch:'workstream/ws-test',environmentId:null}],
    start:async () => 'unused',status:async () => 'unknown',startDev:async () => '',stopDev:async () => {},unsaved:async () => [],remove:async () => {},ship:async () => {},taskState:()=> 'working',
  });
  const w = await seeded.create({threadId:'cap',projectId:'cyndra',name:'Design',requestId:'create'});
  await plugin(host.bb); stubProviderCatalog(host);
  await host.harness.behavior.setSettings({transport:'real',signInCheck:false,fmHome:'',maxActiveCrews:0});
  await host.bb.storage.kv.set('captain-project:cap','cyndra');
  const spawned: Array<Record<string,unknown>> = [];
  host.harness.sdk.stub('threads.getPluginMetadata',async ({threadId}:{threadId:string}) => threadId === 'cap' ? {captain:'true'} : {});
  host.harness.sdk.stub('threads.get',async ({threadId}:{threadId:string}) => ({...makeThreadResponse({id:threadId,projectId:'cyndra',status:'active'}),environmentId:threadId === 'cap' ? 'env_main' : `env_${threadId}`}));
  host.harness.sdk.stub('threads.list',async () => []);
  host.harness.sdk.stub('projects.get',async () => ({id:'cyndra',name:'Cyndra SaaS',kind:'repo',sources:[{hostId:'h1',path:'/repo/main',isDefault:true}]}));
  host.harness.sdk.stub('projects.list',async () => [{id:'cyndra',name:'Cyndra SaaS'}]);
  host.harness.sdk.stub('environments.list',async () => [{id:'env_main',hostId:'h1',path:'/repo/main',status:'ready',isWorktree:false}]);
  host.harness.sdk.stub('environments.get',async ({environmentId}:{environmentId:string}) => ({id:environmentId,hostId:'h1',path:environmentId.startsWith('env_worker') ? `/repo/${environmentId}` : '/repo/main',branchName:environmentId.startsWith('env_worker') ? `task/${environmentId}` : undefined,status:'ready',isWorktree:environmentId.startsWith('env_worker')}));
  host.harness.sdk.stub('threads.spawn',async (args:Record<string,unknown>) => { spawned.push(args); return {id:`worker${spawned.length}`}; });
  host.harness.sdk.stub('threads.defaultExecutionOptions',async () => ({model:'gpt-6.1-sol',reasoningLevel:'high'}));
  host.harness.sdk.stub('threads.send',async () => ({}));
  host.harness.sdk.stub('threadSections.list',async () => []);
  host.harness.sdk.stub('threadSections.create',async () => ({id:'sec'}));
  host.harness.sdk.stub('plugins.callRpc',async () => ({ok:true,queued:1,duplicate:false}));
  const dispatch = host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_dispatch')!;
  const ctx = {threadId:'cap',projectId:'cyndra'} as never;
  try {
    await dispatch.execute({task:'First edit',taskId:'editor-one',workstreamId:w.id,origin:{kind:'captain',reason:'approved workstream'},providerId:'codex',model:'gpt-6.1-sol'},ctx);
    const first = seeded.get(w.id,'cap').jobs.find((j) => j.id === 'editor-one')!;
    assert.deepEqual([first.taskId,first.environmentId,first.branch,first.repos?.[0]?.hostId],['T1','env_worker1','task/env_worker1','h1'],'the task records its own BB-managed checkout');
    seeded.noteJob(w.id,'cap','editor-one',{state:'failed',failedAt:0});
    await dispatch.execute({task:'Try again',taskId:'editor-retry',taskRef:'T1',workstreamId:w.id,providerId:'codex',model:'gpt-6.1-sol'},ctx);
    assert.deepEqual(spawned[1]!.environment,{type:'reuse',environmentId:'env_worker1'},'a retry continues in the kept worktree');
    assert.match(String(spawned[1]!.prompt),/First edit[\s\S]*Try again/);
    assert.equal(seeded.get(w.id,'cap').jobs.find((j) => j.id === 'editor-one')!.supersededBy,'editor-retry');
    seeded.noteJob(w.id,'cap','editor-retry',{state:'failed',failedAt:0,cleanup:'done'});
    const cli = await host.harness.behavior.runCli(['dispatch','--task-id','editor-third','--workstream-id',w.id,'--task-ref','T1','--provider','codex','--model','gpt-6.1-sol','--','Third try'],ctx);
    assert.equal(cli.exitCode,0,cli.stderr);
    assert.deepEqual(spawned[2]!.environment,{type:'host',hostId:'h1',workspace:{type:'managed-worktree',baseBranch:{kind:'named',name:'task/env_worker2'}}},'once the worktree is gone, a retry starts from the retained branch');
    const third = seeded.get(w.id,'cap').jobs.find((j) => j.id === 'editor-third')!;
    assert.equal(third.taskId,'T1','the CLI joins the task it continues');
    assert.equal(third.followUpOf,'editor-retry');
    assert.deepEqual(seeded.get(w.id,'cap').taskIds,['T1']);
    const refused = await host.harness.behavior.runCli(['dispatch','--task-ref','T1','--','No workstream'],ctx);
    assert.equal(refused.exitCode,1);
    assert.match(refused.stderr,/--workstream-id/);
  } finally { await host.harness.lifecycle.dispose(); }
});
