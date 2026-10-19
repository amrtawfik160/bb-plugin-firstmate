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

test('independent refusal matrix: no storage, Telegram or BB side effects', async () => {
 const {host,tasks,open}=await adoptHost();
 try {
  const tool=host.harness.inspection.registrations.agentTools.find(t=>t.name==='firstmate_workstream')!;
  assert.match(tool.description,/propose the grouping in one firstmate_ask card \(kind question\), then adopt after the answer/);
  const calls: unknown[]=[]; host.harness.sdk.stub('plugins.callRpc',async(a:unknown)=>{calls.push(a);return {ok:true}});
  const good=open('Good'); const foreign=open('Foreign',{project:'Safi',projectId:'safi'}); const closed=open('Closed');
  tasks.move(closed.id,'cap',{to:'dropped',reason:'owner dropped',ref:'tg:42:88'},Date.now());
  const invoke=(ids:string[],requestId='refuse')=>host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId:'cyndra',name:'Review',requestId,taskIds:ids});
  for(const ids of [[good.id,foreign.id],[good.id,closed.id],[good.id,'T999999'],[]]) {
   await assert.rejects(invoke(ids));
   assert.equal((await host.harness.behavior.callRpc('workstreams.list',{threadId:'cap'}) as any).workstreams.length,0); assert.equal(calls.length,0);
  }
  const held=await invoke([good.id],'held') as any; const extra=open('Extra');calls.length=0;
  await assert.rejects(invoke([extra.id,good.id],'collision'));
  const list=await host.harness.behavior.callRpc('workstreams.list',{threadId:'cap'}) as any;
  assert.equal(list.workstreams.length,1);assert.deepEqual(list.workstreams[0].taskIds,[good.id]);assert.equal(calls.length,0);
 } finally {await host.harness.lifecycle.dispose()}
});
test('independent adoption preserves running crew identity and makes no host action', async()=>{
 const {host,open}=await adoptHost({thr_run:'active'});
 try{
  stubCrewWorktrees(host,{thr_run:'active'},{thr_run:{envId:'env_original',path:'/wt/original',branch:'feat/original'}});
  const original=[crewRow('builder','thr_run',{environmentId:'env_original',branch:'feat/original',prUrl:'https://github.com/example/repo/pull/1',devLink:'https://original.getbb.app'})];
  await host.bb.storage.kv.set('crews',original);
  const invoked:string[]=[];
  for(const method of ['threads.spawn','threads.interrupt','environments.create','environments.delete']) host.harness.sdk.stub(method as never,async()=>{invoked.push(method);throw Error('unexpected '+method)});
  const t=open('Running',{crewId:'builder'});
  await host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId:'cyndra',name:'Running',requestId:'run',taskIds:[t.id]});
  assert.deepEqual(await host.bb.storage.kv.get('crews'),original);assert.deepEqual(invoked,[]);
 }finally{await host.harness.lifecycle.dispose()}
});
test('independent adopted dev link can use existing repository',async()=>{
 const {host,open}=await adoptHost();try{
  stubCrewWorktrees(host,{},{thr_dev:{envId:'env_dev',path:'/wt/dev',branch:'fm/dev'}});
  await host.bb.storage.kv.set('crews',[crewRow('dev','thr_dev')]);
  const t=open('Dev',{crewId:'dev'});const r=await host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId:'cyndra',name:'Dev',requestId:'dev',taskIds:[t.id]}) as any;
  await host.harness.behavior.callRpc('workstreams.devLink',{threadId:'cap',workstreamId:r.workstream.id});
 }finally{await host.harness.lifecycle.dispose()}
});
test('independent adopted Ship must inspect existing task PR before release',async()=>{
 const {host,tasks,open}=await adoptHost({thr_builder:'idle'});try{
  stubCrewWorktrees(host,{thr_builder:'idle'},{thr_builder:{envId:'env_builder',path:'/wt/builder',branch:'fm/builder'}});
  const original=crewRow('builder','thr_builder',{prUrl:'https://github.com/example/repo/pull/88'});await host.bb.storage.kv.set('crews',[original]);
  const t=open('Ready',{crewId:'builder'});tasks.linkPr(t.id,'cap','https://github.com/example/repo/pull/88',Date.now());
  const spawned:any[]=[];const commands:any[]=[];
  host.harness.sdk.stub('threads.spawn',async(a:any)=>{spawned.push(a);return{id:'fake_release'}});
  host.harness.sdk.stub('hosts.exec',async(a:any)=>{commands.push(a);throw Error('captured host command')});
  await host.harness.behavior.setSettings({signInCheck:false,fmHome:'',maxActiveCrews:0});
  const r=await host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId:'cyndra',name:'Ship',requestId:'ship',taskIds:[t.id]}) as any;
  const shipped=await host.harness.behavior.callRpc('workstreams.ship',{threadId:'cap',workstreamId:r.workstream.id,requestId:'tap'}) as any;
  console.log('SHIP OBSERVATION',JSON.stringify({state:shipped.workstream.ship,hostCommands:commands.length,spawned:spawned.map(a=>({task:a.task,input:a.input,environmentId:a.environmentId,metadata:a.pluginMetadata}))}));
  assert.ok(commands.length>0,'Ship did not inspect or merge the attached task PR before creating a release crew');
 }finally{await host.harness.lifecycle.dispose()}
});
test('independent End keeps topic and trial exclusion is clean',async()=>{
 const {host,tasks,open}=await adoptHost();try{
  const t=open('End');const r=await host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId:'cyndra',name:'End',requestId:'end',taskIds:[t.id]}) as any;
  await host.harness.behavior.callRpc('workstreams.bindTopic',{threadId:'cap',workstreamId:r.workstream.id,chatId:'42',topicId:500});
  tasks.move(t.id,'cap',{to:'dropped',reason:'owner dropped',ref:'tg:42:88'},Date.now());
  const calls:any[]=[];host.harness.sdk.stub('plugins.callRpc',async(a:any)=>{calls.push(a);return{ok:true}});
  const ended=await host.harness.behavior.callRpc('workstreams.end',{threadId:'cap',workstreamId:r.workstream.id}) as any;
  assert.equal(ended.workstream.state,'ended');assert.equal(ended.workstream.closeTopicRequested,false);assert.deepEqual(ended.workstream.topic,{chatId:'42',topicId:500});assert.ok(!calls.some(a=>/closeForumTopic|reopenForumTopic/.test(a.method)));
  const other=open('Dr Woo',{project:'Dr Woo',projectId:'drwoo'});
  await assert.rejects(host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId:'drwoo',name:'Dr Woo',requestId:'drwoo',taskIds:[other.id]}),/trial/);
  assert.equal((await host.harness.behavior.callRpc('workstreams.list',{threadId:'cap',includeEnded:true}) as any).workstreams.length,1);
 }finally{await host.harness.lifecycle.dispose()}
});

test('independent restart after record save or partial attach completes same workstream',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const {createWorkstreams}=await import('./lib/workstreams.ts');
 for(const checkpoint of ['after-record','partial-attach']){
  const db=new DatabaseSync(':memory:');let fail=false;let writes=0;
  const proxy={exec:(sql:string)=>db.exec(sql),prepare:(sql:string)=>{const q=db.prepare(sql);return{all:(...args:any[])=>q.all(...args),run:(...args:any[])=>{const ret=q.run(...args);if(fail&&sql.startsWith('INSERT')){writes++;if(writes===1)throw Error('crash after record');}return ret}}}};
  const deps={now:()=>100,provision:async()=>{throw Error('must not provision')},start:async()=>{throw Error('must not spawn')},status:async()=>'active',startDev:async()=>'',stopDev:async()=>{},unsaved:async()=>[],remove:async()=>{},ship:async()=>{},taskState:()=>'working'};
  let store=createWorkstreams(proxy,deps);const input={threadId:'cap',projectId:'cyndra',name:'Restart',requestId:'stable',taskIds:['T1','T2']};
  fail=true;await assert.rejects(store.adopt(input),/crash/);fail=false;
  const first=store.list('cap')[0]!;
  if(checkpoint==='partial-attach'){first.taskIds=['T1'];db.prepare('UPDATE firstmate_workstream SET record=? WHERE id=?').run(JSON.stringify(first),first.id);}
  store=createWorkstreams(proxy,deps);const retry=await store.adopt(input);
  assert.equal(retry.id,first.id);assert.deepEqual(retry.taskIds,['T1','T2']);assert.equal(store.list('cap').length,1);db.close();
 }
});

test('independent adopted follow-up reuses original worktree',async()=>{
 const {host,open}=await adoptHost({thr_run:'active'});try{
  stubCrewWorktrees(host,{thr_run:'active'},{thr_run:{envId:'env_original',path:'/wt/original',branch:'feat/original'}});
  await host.bb.storage.kv.set('crews',[crewRow('original','thr_run',{environmentId:'env_original'})]);const t=open('Existing',{crewId:'original'});
  const r=await host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId:'cyndra',name:'Follow',requestId:'follow',taskIds:[t.id]}) as any;
  const spawned:any[]=[];host.harness.sdk.stub('threads.spawn',async(a:any)=>{spawned.push(a);return{id:'fake_follow'}});
  await host.harness.behavior.setSettings({signInCheck:false,fmHome:'',maxActiveCrews:0});
  const dispatch=host.harness.inspection.registrations.agentTools.find(t=>t.name==='firstmate_dispatch')!;
  const result=await dispatch.execute({task:'Follow-up in same workstream',taskId:'independent-follow',workstreamId:r.workstream.id,origin:{kind:'captain',reason:'owner wants follow-up'},providerId:'codex',model:'gpt-6.1-sol'},cap);
  console.log('FOLLOWUP OBSERVATION',JSON.stringify({result,environment:spawned[0]?.environment,metadata:spawned[0]?.pluginMetadata}));
  assert.equal(spawned.length,0,'follow-up editor must wait for existing active crew, not spawn another managed worktree');
 }finally{await host.harness.lifecycle.dispose()}
});

test('independent real project setting resolves Dr Woo and RunAnts; unlabeled Coss task refuses atomically',async()=>{
 const {host,open}=await adoptHost();try{
  host.harness.sdk.stub('projects.list',async()=>[{id:'cyndra',name:'Cyndra SaaS'},{id:'proj_wwm6pj4tq5',name:'woo-app'},{id:'proj_c92bh29baq',name:'RunAnts'}]);
  host.harness.sdk.stub('projects.get',async({projectId}:{projectId:string})=>({id:projectId,name:projectId==='proj_wwm6pj4tq5'?'woo-app':projectId==='proj_c92bh29baq'?'RunAnts':'Cyndra SaaS',kind:'repo',sources:[]}));
  const woo=open('Dr Woo',{project:'woo-app',projectId:'proj_wwm6pj4tq5'});const run=open('Coss',{project:'RunAnts',projectId:'proj_c92bh29baq'});const missing=open('Coss without project',{project:null,projectId:null});
  const invoke=(projectId:string,ids:string[])=>host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId,name:'Adopt',requestId:projectId,taskIds:ids});
  await assert.rejects(invoke('proj_wwm6pj4tq5',[woo.id]),/trial/);await assert.rejects(invoke('proj_c92bh29baq',[run.id]),/trial/);
  await host.harness.behavior.setSettings({workstreamProjects:JSON.stringify(['Cyndra','Dr Woo','RunAnts'])});
  assert.deepEqual((await host.harness.behavior.callRpc('workstreams.list',{threadId:'cap'}) as any).trialProjectIds,['cyndra','proj_wwm6pj4tq5','proj_c92bh29baq']);
  await invoke('proj_wwm6pj4tq5',[woo.id]);await assert.rejects(invoke('proj_c92bh29baq',[run.id,missing.id]),/another project/);
  assert.equal((await host.harness.behavior.callRpc('workstreams.list',{threadId:'cap'}) as any).workstreams.length,1);
  await invoke('proj_c92bh29baq',[run.id]);
 }finally{await host.harness.lifecycle.dispose()}
});
