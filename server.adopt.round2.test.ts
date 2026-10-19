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



async function realistic(options:{explicit?:boolean;two?:boolean;noPr?:boolean;project?:string;active?:boolean}={}) {
 const {host,tasks,open}=await adoptHost();
 const statuses=new Map<string,string>([['thr_one',options.active?'active':'idle'],['thr_two','idle']]);
 const actualEnv=(id:string)=>({id,hostId:'h1',path:id==='env_one'?'/wt/one':id==='env_two'?'/wt/two':'/repo/main',status:'ready',isWorktree:id!=='env_main',branchName:id==='env_one'?'fm/one':id==='env_two'?'fm/two':'main'});
 host.harness.sdk.stub('threads.get',async({threadId}:{threadId:string})=>makeThreadResponse({id:threadId,projectId:'cyndra',status:statuses.get(threadId)??'active',environmentId:threadId==='thr_one'?'env_one':threadId==='thr_two'?'env_two':'env_main'}));
 host.harness.sdk.stub('environments.get',async({environmentId}:{environmentId:string})=>actualEnv(environmentId));
 if(options.project){host.harness.sdk.stub('projects.list',async()=>[{id:'cyndra',name:options.project}]);host.harness.sdk.stub('projects.get',async()=>({id:'cyndra',name:options.project,kind:'repo',sources:[{hostId:'h1',path:'/repo/main',isDefault:true}],gitRemoteUrl:'https://github.com/example/runants.git'}));await host.harness.behavior.setSettings({workstreamProjects:JSON.stringify([options.project])});}
 const crews=[crewRow('one','thr_one',{...(options.noPr?{}:{prUrl:'https://github.com/cyndra-ai/cyndra-saas/pull/101'}),...(options.explicit?{environmentId:'env_one',branch:'fm/one'}:{})})];
 if(options.two)crews.push(crewRow('two','thr_two',{prUrl:'https://github.com/cyndra-ai/cyndra-saas/pull/102',...(options.explicit?{environmentId:'env_two',branch:'fm/two'}:{})}));
 await host.bb.storage.kv.set('crews',crews);
 const opened=crews.map((c,i)=>open(`Existing ${i}`,{crewId:c.id,project:options.project??'Cyndra SaaS'}));
 if(!options.noPr) for(let i=0;i<opened.length;i++)tasks.linkPr(opened[i]!.id,'cap',crews[i]!.prUrl!,Date.now());
 await host.harness.behavior.setSettings({signInCheck:false,fmHome:'',maxActiveCrews:0});
 const adopt=()=>host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId:'cyndra',name:'Existing work',requestId:'realistic',taskIds:opened.map(t=>t.id)}) as Promise<any>;
 const commands:string[]=[];let n=0;const byId=new Map<string,string>();
 let respond:(s:string)=>string=()=>'';
 host.harness.sdk.stub('terminals.create',async({start}:{start:{command:string}})=>{const id=`terminal${++n}`;commands.push(start.command);byId.set(id,start.command);return{id}});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId}:{terminalId:string})=>{const c=byId.get(terminalId)??'';const data=respond(c);const captured=c.includes('FM_HOST_CAPTURE_V1')?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:0,stdout:data,stderr:''}):data;return{nextSeq:1,chunks:[{dataBase64:Buffer.from(captured + String.fromCharCode(10) + '__FM_HOST_RC:0' + String.fromCharCode(10)).toString('base64')}]}});
 return{host,tasks,opened,crews,statuses,commands,adopt,setResponse:(r:(c:string)=>string)=>{respond=r}};
}
test('round2 actual thread environment and branch survive adoption without new crew fields',async()=>{
 const f=await realistic();try{
  const r=await f.adopt();console.log('NORMAL CREW REPOS',JSON.stringify(r.workstream.repos));
  assert.deepEqual(r.workstream.repos.map((r:any)=>({path:r.path,branch:r.branch,environmentId:r.environmentId})),[{path:'/wt/one',branch:'fm/one',environmentId:'env_one'}]);
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round2 dev startup serves adopted worktree through actual terminal transport',async()=>{
 const f=await realistic();try{
  f.setResponse(c=>c.includes('bb connect expose')?'https://real-fake-share.getbb.app/':'');
  const r=await f.adopt();const d=await f.host.harness.behavior.callRpc('workstreams.devLink',{threadId:'cap',workstreamId:r.workstream.id}) as any;
  console.log('DEV TRANSPORT',JSON.stringify({url:d.url,starts:f.commands.filter(c=>c.includes('systemd-run'))}));
  assert.equal(d.url,'https://real-fake-share.getbb.app/');assert.ok(f.commands.some(c=>c.includes('systemd-run')&&c.includes('/wt/one')),'dev server must start in adopted worktree');
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round2 follow-up waits then reuses real original environment with workstream metadata',async()=>{
 const f=await realistic({active:true});try{
  const r=await f.adopt();const spawned:any[]=[];f.host.harness.sdk.stub('threads.spawn',async(a:any)=>{spawned.push(a);return{id:'thr_new'}});
  const dispatch=f.host.harness.inspection.registrations.agentTools.find(t=>t.name==='firstmate_dispatch')!;
  const result=await dispatch.execute({task:'Continue original work',taskId:'follow-real',workstreamId:r.workstream.id,origin:{kind:'captain',reason:'owner follow-up'},providerId:'codex',model:'gpt-6.1-sol'},cap);
  assert.match(String(result),/Queued/);assert.equal(spawned.length,0);
  f.statuses.set('thr_one','idle');await f.host.harness.behavior.runSchedule('workstreams');
  console.log('FOLLOWUP REAL ENV',JSON.stringify(spawned.map(a=>({environment:a.environment,metadata:a.pluginMetadata}))));
  assert.equal(spawned.length,1);assert.equal(spawned[0].pluginMetadata.workstreamId,r.workstream.id);assert.deepEqual(spawned[0].environment,{type:'reuse',environmentId:'env_one'});
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round2 two tasks in same repository retain exactly their two existing branches',async()=>{
 const f=await realistic({explicit:true,two:true});try{
  const r=await f.adopt();console.log('TWO TASK REPOS',JSON.stringify(r.workstream.repos));
  assert.deepEqual(r.workstream.repos.map((r:any)=>({path:r.path,branch:r.branch})).sort((a:any,b:any)=>a.path.localeCompare(b.path)),[{path:'/wt/one',branch:'fm/one'},{path:'/wt/two',branch:'fm/two'}]);
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round2 Ship waits for original active adopted editor before touching Git',async()=>{
 const f=await realistic({explicit:true,active:true});try{
  const r=await f.adopt();const commands:any[]=[];f.host.harness.sdk.stub('hosts.exec',async(a:any)=>{commands.push(a);throw Error('stop-before-git')});
  const result=await f.host.harness.behavior.callRpc('workstreams.ship',{threadId:'cap',workstreamId:r.workstream.id,requestId:'ship-active'}).catch((e:unknown)=>({error:String(e)}));
  console.log('SHIP ACTIVE',JSON.stringify({result,commands}));assert.equal(commands.length,0,'Ship must wait for existing active editor');
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round2 project with no PR yet never skips directly to release',async()=>{
 const f=await realistic({project:'RunAnts',noPr:true});try{
  const r=await f.adopt();const spawned:any[]=[];f.host.harness.sdk.stub('threads.spawn',async(a:any)=>{spawned.push(a);return{id:'thr_live'}});
  const result=await f.host.harness.behavior.callRpc('workstreams.ship',{threadId:'cap',workstreamId:r.workstream.id,requestId:'no-pr-yet'}).catch((e:unknown)=>({error:String(e)}));
  console.log('NO PR SHIP',JSON.stringify({repos:r.workstream.repos,result,spawned:spawned.map(a=>({environment:a.environment,metadata:a.pluginMetadata}))}));
  assert.ok(!spawned.some(a=>String(a.pluginMetadata.task).includes('Prepare the release of merged workstream')),'task with no PR cannot reach release crew');
  assert.equal(r.workstream.repos.length,1,'resolve actual repository even without a PR');
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round2 changed adopt request is refused with no saved change; exact repeat remains idempotent',async()=>{
 const f=await realistic();try{
  const r=await f.adopt();const before=JSON.stringify((await f.host.harness.behavior.callRpc('workstreams.list',{threadId:'cap'})));
  const same=f.opened[0]!;const extra=f.tasks.open({captain:'cap',project:'Cyndra SaaS',projectId:'cyndra',title:'Same project extra',sourceRefs:['tg:42:78'],at:Date.now()});
  const other=f.tasks.open({captain:'cap',project:'Safi',projectId:'safi',title:'Other project',sourceRefs:['tg:42:77'],at:Date.now()});await f.host.harness.behavior.setSettings({workstreamProjects:'["Cyndra","Safi"]'});
  for(const override of [{name:'Changed'},{projectId:'safi',taskIds:[other.id]},{taskIds:[...r.workstream.taskIds,extra.id]}]) await assert.rejects(f.host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId:'cyndra',name:'Existing work',requestId:'realistic',taskIds:r.workstream.taskIds,...override}));
  await f.host.harness.behavior.setSettings({workstreamProjects:'["Cyndra"]'});
  assert.equal(JSON.stringify(await f.host.harness.behavior.callRpc('workstreams.list',{threadId:'cap'})),before);
  const repeat=await f.adopt();assert.equal(repeat.workstream.id,r.workstream.id);assert.deepEqual(repeat.workstream.taskIds,r.workstream.taskIds);
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round2 Ship addresses original task branch and worktree rather than project main',async()=>{
 const f=await realistic();try{
  const r=await f.adopt();const commands:any[]=[];
  f.host.harness.sdk.stub('hosts.exec',async(a:any)=>{commands.push(a);throw Error('capture-first-git-command')});
  await f.host.harness.behavior.callRpc('workstreams.ship',{threadId:'cap',workstreamId:r.workstream.id,requestId:'actual-task-branch'});
  console.log('SHIP ORIGINAL BRANCH',JSON.stringify(commands));
  assert.ok(commands.length>0);assert.ok(commands[0].command.includes('/wt/one'),'Ship must address task worktree');assert.ok(commands[0].command.includes('fm/one'),'Ship must push task branch');assert.ok(!commands[0].command.includes("HEAD:'main'"),'Ship must not push source main');
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round2 unrelated dirty source checkout does not block Ship of existing adopted branches',async()=>{
 const f=await realistic({explicit:true,two:true});try{
  const r=await f.adopt();const commands:string[]=[];
  f.host.harness.sdk.stub('hosts.exec',async({command}:{command:string})=>{
   commands.push(command);
   if(command.includes("cd -- '/repo/main'") && command.includes('git status')) return {exitCode:1,stdout:'unrelated source checkout is dirty'};
   if(command.includes('gh pr list'))return{exitCode:0,stdout:JSON.stringify([{url:`https://github.com/cyndra-ai/cyndra-saas/pull/${command.includes('fm/one')?'101':'102'}`,state:'MERGED',headRefOid:'a'.repeat(40)}])};
   if(command.includes('git rev-parse HEAD'))return{exitCode:0,stdout:'a'.repeat(40)};
   return{exitCode:0,stdout:''};
  });
  const shipped=await f.host.harness.behavior.callRpc('workstreams.ship',{threadId:'cap',workstreamId:r.workstream.id,requestId:'dirty-unrelated-source'}) as any;
  console.log('PHANTOM SOURCE SHIP',JSON.stringify({state:shipped.workstream.ship,commands}));
  assert.ok(!commands.some(c=>c.includes("cd -- '/repo/main'")),'Ship must not touch unrelated project source checkout');
 }finally{await f.host.harness.lifecycle.dispose()}
});
