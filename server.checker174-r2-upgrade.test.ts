// Checker round 2 for PR #174 (finding 4). The defect assertion states the safe outcome.
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

test('round2 upgrade: a main-saved queued job keeps the shared workstream worktree it was saved for', async () => {
  const { createWorkstreams } = await import('./lib/workstreams.ts');
  const host = createFakePluginHost({ pluginId:'firstmate', agentSkillIds:manifestSkillIds(new URL('.',import.meta.url).pathname) });
  const seeded = createWorkstreams(host.bb.storage.database(), {
    now:()=>0, provision:async () => [{repository:'cyndra-ai/cyndra-saas',projectId:'cyndra',hostId:'h1',path:'/repo/ws',sourcePath:'/repo/main',branch:'workstream/ws-test',environmentId:null}],
    start:async () => 'unused',status:async () => 'unknown',startDev:async () => '',stopDev:async () => {},unsaved:async () => [],remove:async () => {},ship:async () => {},taskState:()=> 'working',
  });
  const w = await seeded.create({threadId:'cap',projectId:'cyndra',name:'Design',requestId:'create'});
  const oldJob={id:'legacy-queued',editing:true,payload:JSON.stringify({task:'Queued before upgrade',projectId:'cyndra',parentThreadId:'cap',workstreamId:w.id,providerId:'codex',model:'gpt-6.1-sol',providerNamed:true,shape:'ship',mode:'direct-PR',worktree:false,visible:true}),state:'queued',threadId:null};
  w.jobs=[oldJob as never];w.repos[0]!.environmentId='env_ws';
  host.bb.storage.database().prepare('UPDATE firstmate_workstream SET record=? WHERE id=?').run(JSON.stringify(w),w.id);
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
  try {
    await host.harness.behavior.runSchedule('workstreams');
    assert.equal(spawned.length,1);
    assert.deepEqual(spawned[0]!.environment,{type:'reuse',environmentId:'env_ws'});
    let job=seeded.get(w.id,'cap').jobs[0]!;assert.equal(job.isolated,undefined);assert.equal(job.path,undefined);
    statuses.set('worker1','idle');await host.harness.behavior.runSchedule('workstreams');job=seeded.get(w.id,'cap').jobs[0]!;
    assert.equal(job.state,'finished');assert.equal(job.isolated,undefined);assert.equal(job.foldedAt,undefined);
    const dispatch=host.harness.inspection.registrations.agentTools.find(t=>t.name==='firstmate_dispatch')!;const refused=await dispatch.execute({task:'Change both repos',taskId:'two-repo-refusal',workstreamId:w.id,workstreamRepo:'cyndra-ai/cyndra-saas, example/second',origin:{kind:'captain',reason:'fixture'},providerId:'codex',model:'gpt-6.1-sol'},{threadId:'cap',projectId:'cyndra'} as never);assert.match(typeof refused==='string'?refused:JSON.stringify(refused),/repository does not belong/);assert.equal(spawned.length,1);assert.equal(seeded.get(w.id,'cap').jobs.length,1);
  }finally{await host.harness.lifecycle.dispose()}
});
