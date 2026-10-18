import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { stubProviderCatalog } from './test/provider-catalog.mjs';
import { manifestSkillIds } from './scripts/plugin-skill-fixture.mjs';

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
