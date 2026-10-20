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

// Checker round 1 for PR #174 (findings 1, 8, 9, 10): realistic managed environments, CLI dispatch and a folded-task follow-up.
test('B174: task environments stay off the workstream, CLI tasks reach the card, follow-ups carry the earlier brief and show once', async () => {
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
  const statuses = new Map<string,string>();
  host.harness.sdk.stub('threads.getPluginMetadata',async ({threadId}:{threadId:string}) => threadId === 'cap' ? {captain:'true'} : {});
  host.harness.sdk.stub('threads.get',async ({threadId}:{threadId:string}) => ({...makeThreadResponse({id:threadId,projectId:'cyndra',status:statuses.get(threadId) ?? 'active'}),environmentId:threadId === 'cap' ? 'env_main' : `env_${threadId}`}));
  host.harness.sdk.stub('threads.list',async () => []);
  host.harness.sdk.stub('projects.get',async () => ({id:'cyndra',name:'Cyndra SaaS',kind:'repo',sources:[{hostId:'h1',path:'/repo/main',isDefault:true}]}));
  host.harness.sdk.stub('projects.list',async () => [{id:'cyndra',name:'Cyndra SaaS'}]);
  host.harness.sdk.stub('environments.list',async () => [{id:'env_main',hostId:'h1',path:'/repo/main',status:'ready',isWorktree:false}]);
  host.harness.sdk.stub('environments.get',async ({environmentId}:{environmentId:string}) => ({id:environmentId,hostId:'h1',path:environmentId.startsWith('env_worker') ? `/repo/${environmentId}` : environmentId === 'env_ws' ? '/repo/ws' : '/repo/main',branchName:environmentId.startsWith('env_worker') ? `task/${environmentId}` : undefined,status:'ready',isWorktree:environmentId.startsWith('env_worker')}));
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
    assert.deepEqual(spawned[2]!.environment,{type:'host',hostId:'h1',workspace:{type:'unmanaged',path:'/repo/ws'}});
    assert.equal((spawned[0]!.pluginMetadata as Record<string,unknown>).deliveryRequirement,'pr','an editing crew delivers its PR; Ship owns merging');
    assert.ok(cards.length >= 1);
    assert.equal(typeof cards[0]!.revision, 'number');
    await new Promise((resolve) => setImmediate(resolve));
    const cardTasks = cards.map((card) => (card.tasks as Array<{ task: string; state: string }>));
    assert.ok(cardTasks.flat().every((task) => /^T\d+$/.test(task.task)), 'the live connector refuses a card with a crew id in place of T<n>');
    assert.deepEqual(cardTasks.at(-1)!.map((task) => `${task.task}:${task.state}`), ['T1:working', 'T2:working', 'T3:working']);
    assert.ok(cards.every((card, index) => index === 0 || (card.revision as number) > (cards[index - 1]!.revision as number)));
    const current = seeded.get(w.id,'cap');
    assert.equal(current.repos[0]!.environmentId,null);
    const cli = await host.harness.behavior.runCli(['dispatch','--task-id','cli-probe','--workstream-id',w.id,'--provider','codex','--model','gpt-6.1-sol','--','CLI edit'],ctx);
    assert.equal(cli.exitCode,0,cli.stderr);
    const cliJob = seeded.get(w.id,'cap').jobs.find(j=>j.id==='cli-probe');
    assert.ok(cliJob);
    assert.equal(cliJob.taskId,'T4');
    await new Promise((resolve)=>setImmediate(resolve));
    assert.ok((cards.at(-1)!.tasks as Array<{task:string}>).some(t=>t.task==='T4'));
    const view = await host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_workstream')!.execute({ action: 'view', workstreamId: w.id }, ctx);
    assert.match(typeof view === 'string' ? view : JSON.stringify(view), /working|folded|queued/);
    const listed = await host.harness.behavior.callRpc('workstreams.list',{threadId:'cap'}) as {workstreams:Array<{taskIds:string[]}>};
    assert.equal(listed.workstreams[0]!.taskIds.length,4);
    seeded.noteJob(w.id,'cap','editor-one',{state:'folded',report:'Earlier report: tests passed; input validation fixed.'});
    const follow = await dispatch.execute({task:'Now make that blue',taskId:'follow-probe',taskRef:'T1',workstreamId:w.id,origin:{kind:'captain',reason:'approved follow-up'},providerId:'codex',model:'gpt-6.1-sol'},ctx);
    assert.match(text(follow),/Dispatched/);
    const prompt=String(spawned.at(-1)!.prompt);
    assert.ok(prompt.includes('Earlier report:'));
    assert.ok(prompt.includes('First edit'));
    await new Promise((resolve)=>setImmediate(resolve));
    const lineView=seeded.view(w.id,'cap');
    assert.equal(lineView.split('\n').filter(line=>line.startsWith('T1 ')).length,1);
    const finalRows=(cards.at(-1)!.tasks as Array<{task:string}>);
    assert.equal(finalRows.filter(t=>t.task==='T1').length,1);
  } finally { await host.harness.lifecycle.dispose(); }
});
