import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createOwnerTasks } from './lib/owner-tasks.ts';
import { stubProviderCatalog } from './test/provider-catalog.mjs';
import { manifestSkillIds } from './scripts/plugin-skill-fixture.mjs';

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

test('workstreams RPC lists trial IDs and refuses creation outside Cyndra before any host command', async () => {
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: manifestSkillIds(new URL('.', import.meta.url).pathname) });
  await host.bb.storage.kv.set('captain-project:cap', 'cyndra');
  await plugin(host.bb); stubProviderCatalog(host);
  host.harness.sdk.stub('threads.getPluginMetadata', async () => ({ captain: 'true' }));
  host.harness.sdk.stub('threads.get', async () => makeThreadResponse({ id: 'cap', projectId: 'cyndra' }));
  host.harness.sdk.stub('projects.list', async () => [{ id: 'cyndra', name: 'Cyndra SaaS' }, { id: 'safi', name: 'Safi' }]);
  host.harness.sdk.stub('projects.get', async ({ projectId }: { projectId: string }) => ({ id: projectId, name: projectId === 'safi' ? 'Safi' : 'Cyndra SaaS', sources: [] }));
  try {
    const listed = await host.harness.behavior.callRpc('workstreams.list', { threadId: 'cap' });
    assert.deepEqual(listed, { workstreams: [], trialProjectIds: ['cyndra'] });
    await assert.rejects(host.harness.behavior.callRpc('workstreams.create', { threadId: 'cap', projectId: 'safi', name: 'Design', requestId: 'tap1' }), /trial/);
    assert.ok(host.harness.inspection.registrations.agentTools.some((t) => t.name === 'firstmate_workstream'));
  } finally { await host.harness.lifecycle.dispose(); }
});

test('fake BB: two editing tasks share the saved environment in order while a scout can run', async () => {
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
    const one = await dispatch.execute({task:'First edit',taskId:'editor-one',workstreamId:w.id,origin:{kind:'captain',reason:'approved workstream'},providerId:'codex',model:'gpt-6.1-sol'},ctx);
    assert.match(text(one),/Dispatched/);
    const two = await dispatch.execute({task:'Second edit',taskId:'editor-two',workstreamId:w.id,origin:{kind:'captain',reason:'approved workstream'},providerId:'codex',model:'gpt-6.1-sol'},ctx);
    assert.match(text(two),/Queued crew/);
    await assert.rejects(host.harness.behavior.callRpc("workstreams.ship",{threadId:"cap",workstreamId:w.id,requestId:"tap-while-editing"}),/Ship waits/);
    const scout = await dispatch.execute({task:'Read the diff',taskId:'read-only',shape:'scout',role:'lookup',workstreamId:w.id,origin:{kind:'captain',reason:'approved workstream'},providerId:'codex',model:'gpt-6.1-sol'},ctx);
    assert.match(text(scout),/Dispatched/);
    assert.equal(spawned.length,2);
    for (const call of spawned) {
      const metadata = call.pluginMetadata as Record<string,unknown>;
      const dir = `/repo/.firstmate-workstream-reports/${w.id}/${metadata.crewId}`;
      assert.equal(metadata.reportDir,dir);
      assert.equal(String(call.prompt).split("Production approval:").length - 1,1);
      assert.ok(String(call.prompt).includes(`${dir}/report.md`),'the brief names the persisted report path');
      assert.ok(String(call.prompt).includes(`create the report directory '${dir}'`));
    }
    assert.ok(String(spawned[1]!.prompt).includes('Read-only repository: do not change repository files or Git state.'));
    for (const call of spawned) assert.deepEqual(call.environment,{type:'reuse',environmentId:'env_ws'});
    assert.equal((spawned[0]!.pluginMetadata as Record<string,unknown>).deliveryRequirement,'pr','an editing crew delivers its PR; Ship owns merging');
    statuses.set('worker1','idle');
    await host.harness.behavior.runSchedule('workstreams');
    assert.equal(spawned.length,3);
    assert.deepEqual(spawned[2]!.environment,{type:'reuse',environmentId:'env_ws'});
    const listed = await host.harness.behavior.callRpc('workstreams.list',{threadId:'cap'}) as {workstreams:Array<{taskIds:string[]}>};
    assert.equal(listed.workstreams[0]!.taskIds.length,3);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('adopt RPC groups open tasks without provisioning; a retry of the same requestId is a no-op', async () => {
  const { host, open } = await adoptHost();
  try {
    const one = open('Cyndra web chat restyle');
    const two = open('Composer tokens');
    const first = await host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'cyndra', name: 'Cyndra web chat restyle', requestId: 'adopt-chat', taskIds: [one.id, two.id] }) as { workstream: { id: string; taskIds: string[]; repos: unknown[]; provisioned: boolean } };
    assert.deepEqual(first.workstream.taskIds, [one.id, two.id]);
    assert.equal(first.workstream.provisioned, true);
    assert.deepEqual(first.workstream.repos, []);
    const retry = await host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'cyndra', name: 'Renamed', requestId: 'adopt-chat', taskIds: [one.id, two.id] }) as { workstream: { id: string } };
    assert.equal(retry.workstream.id, first.workstream.id);
    const listed = await host.harness.behavior.callRpc('workstreams.list', { threadId: 'cap' }) as { workstreams: unknown[] };
    assert.equal(listed.workstreams.length, 1);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('adopt refuses another project, a closed task, a held task, a trial miss and missing fields; nothing is created', async () => {
  const { host, tasks, open } = await adoptHost();
  try {
    const cyndra = open('Chat restyle');
    const safi = open('Apple redesign', { project: 'Safi', projectId: 'safi' });
    await assert.rejects(host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'cyndra', name: 'Mix', requestId: 'mix', taskIds: [cyndra.id, safi.id] }), /another project/);
    assert.equal((await host.harness.behavior.callRpc('workstreams.list', { threadId: 'cap' }) as { workstreams: unknown[] }).workstreams.length, 0);
    const closed = open('Closed line');
    tasks.move(closed.id, 'cap', { to: 'dropped', reason: 'the owner said drop it', ref: 'tg:42:9' }, Date.now());
    await assert.rejects(host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'cyndra', name: 'Closed', requestId: 'closed', taskIds: [closed.id] }), /closed/);
    await assert.rejects(host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'safi', name: 'Safi', requestId: 'safi', taskIds: [safi.id] }), /trial/);
    await assert.rejects(host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'cyndra', name: 'Empty', requestId: 'empty', taskIds: [] }), /rpc input validation failed/);
    const missing = await host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_workstream')!.execute({ action: 'adopt', projectId: 'cyndra', name: 'Empty', requestId: 'empty' }, cap);
    assert.match(typeof missing === 'string' ? missing : JSON.stringify(missing), /Adopt needs taskIds/);
    const held = await host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'cyndra', name: 'Held', requestId: 'held', taskIds: [cyndra.id] }) as { workstream: { id: string } };
    const extra = open('Second chat');
    await assert.rejects(host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'cyndra', name: 'Other', requestId: 'other', taskIds: [cyndra.id, extra.id] }), /already belongs to a workstream/);
    const listed = await host.harness.behavior.callRpc('workstreams.list', { threadId: 'cap' }) as { workstreams: Array<{ id: string }> };
    assert.deepEqual(listed.workstreams.map((w) => w.id), [held.workstream.id]);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('CLI --task adopt, captain tool text, dispatch on an adopted stream does not stamp workstreamId, End refuses a running attached crew', async () => {
  const { host, open } = await adoptHost({ thr_run: 'active' });
  try {
    const tool = host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_workstream')!;
    assert.match(tool.description, /propose the grouping in one firstmate_ask card \(kind question\), then adopt after the answer/);
    const one = open('Cyndra web chat restyle');
    const two = open('Composer tokens');
    const cli = await host.harness.behavior.runCli(['workstream', 'adopt', '--project', 'cyndra', '--name', 'Cyndra web chat restyle', '--request-id', 'cli-adopt', '--task', one.id, '--task', two.id], cap) as { exitCode: number; stdout: string; stderr?: string };
    assert.equal(cli.exitCode, 0, cli.stderr ?? cli.stdout);
    const adopted = JSON.parse(cli.stdout) as { workstream: { id: string; taskIds: string[]; repos: unknown[] } };
    assert.deepEqual(adopted.workstream.taskIds, [one.id, two.id]);
    assert.deepEqual(adopted.workstream.repos, []);
    const spawned: Array<Record<string, unknown>> = [];
    host.harness.sdk.stub('threads.spawn', async (args: Record<string, unknown>) => { spawned.push(args); return { id: `worker${spawned.length}` }; });
    await host.harness.behavior.setSettings({ signInCheck: false, fmHome: '', maxActiveCrews: 0 });
    const dispatch = host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_dispatch')!;
    const text = (result: unknown) => typeof result === 'string' ? result : JSON.stringify(result);
    const sent = await dispatch.execute({ task: 'Follow-up edit', taskId: 'follow-1', workstreamId: adopted.workstream.id, origin: { kind: 'captain', reason: 'approved workstream' }, providerId: 'codex', model: 'gpt-6.1-sol' }, cap);
    assert.match(text(sent), /Dispatched/);
    assert.equal(spawned.length, 1);
    const metadata = spawned[0]!.pluginMetadata as Record<string, unknown>;
    assert.equal(metadata.workstreamId, undefined);
    const crews = await host.bb.storage.kv.get('crews') as Array<{ id: string; workstreamId?: string }>;
    assert.equal(crews.find((c) => c.id === 'follow-1')?.workstreamId, undefined);
    const follow = createOwnerTasks(host.bb.storage.database()).list('cap').find((task) => task.crewIds.includes('follow-1'));
    const listed = await host.harness.behavior.callRpc('workstreams.list', { threadId: 'cap' }) as { workstreams: Array<{ taskIds: string[] }> };
    assert.ok(follow && listed.workstreams[0]!.taskIds.includes(follow.id), `attached after dispatch: ${listed.workstreams[0]!.taskIds.join(',')}`);
    await host.bb.storage.kv.set('crews', [crewRow('run1', 'thr_run')]);
    const running = open('Running line', { crewId: 'run1' });
    const busy = await host.harness.behavior.callRpc('workstreams.adopt', { threadId: 'cap', projectId: 'cyndra', name: 'Busy', requestId: 'busy', taskIds: [running.id] }) as { workstream: { id: string } };
    await assert.rejects(host.harness.behavior.callRpc('workstreams.end', { threadId: 'cap', workstreamId: busy.workstream.id }), /active crews/);
  } finally { await host.harness.lifecycle.dispose(); }
});
