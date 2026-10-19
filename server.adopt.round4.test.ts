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

function fakeShip(f:any,three=false){
 const commands:string[]=[];
 f.host.harness.sdk.stub('hosts.exec',async({command}:{command:string})=>{
  commands.push(command);
  if(command.includes('gh pr list')){
   if(command.includes('fm/three'))return{exitCode:0,stdout:'[]'};
   return{exitCode:0,stdout:JSON.stringify([{url:`https://github.com/cyndra-ai/cyndra-saas/pull/${command.includes('fm/one')?'101':'102'}`,state:three||command.includes('fm/one')?'MERGED':'OPEN',headRefOid:'a'.repeat(40)}])};
  }
  if(command.includes('git rev-parse HEAD'))return{exitCode:0,stdout:'a'.repeat(40)};
  if(command.includes('git log --reverse')&&command.includes('/wt/three'))return{exitCode:0,stdout:'1000'};
  if(command.includes('gh pr create'))return{exitCode:0,stdout:'https://github.com/cyndra-ai/cyndra-saas/pull/103'};
  return{exitCode:0,stdout:''};
 });return commands;
}
test('round4 old adopted entries without ownership refuse or preserve correct task and builder',async()=>{
 const f=await realistic({two:true});try{
  const r=await f.adopt();for(const repo of r.workstream.repos){delete repo.taskId;delete repo.crewId;}
  f.host.bb.storage.database().prepare('UPDATE firstmate_workstream SET record=? WHERE id=?').run(JSON.stringify(r.workstream),r.workstream.id);
  const commands=fakeShip(f);
  const result=await f.host.harness.behavior.callRpc('workstreams.ship',{threadId:'cap',workstreamId:r.workstream.id,requestId:'old-owner-fields'}).catch((e:unknown)=>({refusal:String(e)}));
  const crews=await f.host.bb.storage.kv.get('crews') as any[];
  console.log('OLD ADOPTED OWNERS',JSON.stringify({result,crews:crews.map(c=>({id:c.id,pr:c.prUrl})),taskPrs:f.opened.map(t=>({id:t.id,prs:f.tasks.get(t.id)?.prs})),commands}));
  assert.equal(crews.find(c=>c.id==='one')?.prUrl,'https://github.com/cyndra-ai/cyndra-saas/pull/101','legacy entries must refuse or resolve exact owner, not guess');
  assert.deepEqual(f.tasks.get(f.opened[0]!.id)?.prs,['https://github.com/cyndra-ai/cyndra-saas/pull/101']);
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round4 three tasks keep independent owners when third branch has no PR yet',async()=>{
 const f=await realistic({two:true});try{
  const crews=await f.host.bb.storage.kv.get('crews') as any[];crews.push(crewRow('three','thr_three'));await f.host.bb.storage.kv.set('crews',crews);
  const third=f.tasks.open({captain:'cap',project:'Cyndra SaaS',projectId:'cyndra',title:'Third, no PR yet',sourceRefs:['tg:42:303'],crewId:'three',at:Date.now()});
  f.host.harness.sdk.stub('threads.get',async({threadId}:{threadId:string})=>makeThreadResponse({id:threadId,projectId:'cyndra',status:'idle',environmentId:threadId==='cap'?'env_main':`env_${threadId.slice(4)}`}));
  f.host.harness.sdk.stub('environments.get',async({environmentId}:{environmentId:string})=>({id:environmentId,hostId:'h1',path:environmentId==='env_main'?'/repo/main':`/wt/${environmentId.slice(4)}`,branchName:environmentId==='env_main'?'main':`fm/${environmentId.slice(4)}`,isWorktree:environmentId!=='env_main',status:'ready'}));
  const ids=[...f.opened.map(t=>t.id),third.id];
  const r=await f.host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId:'cyndra',name:'Three task branches',requestId:'three-branches',taskIds:ids}) as any;
  assert.deepEqual(r.workstream.repos.map((x:any)=>({taskId:x.taskId,crewId:x.crewId,branch:x.branch})),ids.map((taskId,i)=>({taskId,crewId:['one','two','three'][i],branch:`fm/${['one','two','three'][i]}`})));
  const commands=fakeShip(f,true);
  const result=await f.host.harness.behavior.callRpc('workstreams.ship',{threadId:'cap',workstreamId:r.workstream.id,requestId:'three-ship'}) as any;
  const after=await f.host.bb.storage.kv.get('crews') as any[];
  console.log('THREE TASK SHIP',JSON.stringify({state:result.workstream.ship,crews:after.map(c=>({id:c.id,pr:c.prUrl})),taskPrs:ids.map(id=>({id,prs:f.tasks.get(id)?.prs})),created:commands.filter(c=>c.includes('gh pr create'))}));
  assert.equal(after.find(c=>c.id==='one')?.prUrl,'https://github.com/cyndra-ai/cyndra-saas/pull/101');assert.equal(after.find(c=>c.id==='two')?.prUrl,'https://github.com/cyndra-ai/cyndra-saas/pull/102');assert.equal(after.find(c=>c.id==='three')?.prUrl,'https://github.com/cyndra-ai/cyndra-saas/pull/103');
  for(let i=0;i<ids.length;i++)assert.deepEqual(f.tasks.get(ids[i]!)?.prs,[`https://github.com/cyndra-ai/cyndra-saas/pull/${101+i}`]);
  assert.ok(commands.some(c=>c.includes('gh pr create')&&c.includes('fm/three')));
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round4 adoption with no crew must not start editing in source main',async()=>{
 const f=await realistic();try{
  const t=f.tasks.open({captain:'cap',project:'Cyndra SaaS',projectId:'cyndra',title:'Open task awaiting a crew',sourceRefs:['tg:42:401'],at:Date.now()});
  const adopted=await f.host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId:'cyndra',name:'Pending task',requestId:'pending-edit',taskIds:[t.id]}).catch((e:unknown)=>({refusal:String(e)})) as any;
  if(adopted.refusal)return;
  const spawned:any[]=[];f.host.harness.sdk.stub('threads.spawn',async(a:any)=>{spawned.push(a);return{id:'thr_pending_follow'}});
  const dispatch=f.host.harness.inspection.registrations.agentTools.find(x=>x.name==='firstmate_dispatch')!;
  const result=await dispatch.execute({task:'Edit the adopted task',taskId:'pending-follow',workstreamId:adopted.workstream.id,origin:{kind:'captain',reason:'owner follow-up'},providerId:'codex',model:'gpt-6.1-sol'},cap);
  console.log('EMPTY ADOPT FOLLOWUP',JSON.stringify({repos:adopted.workstream.repos,result,spawned:spawned.map(a=>({environment:a.environment,metadata:a.pluginMetadata}))}));
  assert.ok(!spawned.some(a=>a.environment?.type==='reuse'&&a.environment.environmentId==='env_main'),'empty adopted record must not reuse the source environment for editing');
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round4 adoption with no crew must not skip repository work and spawn a release',async()=>{
 const f=await realistic();try{
  const t=f.tasks.open({captain:'cap',project:'Cyndra SaaS',projectId:'cyndra',title:'Open task awaiting implementation',sourceRefs:['tg:42:402'],at:Date.now()});
  const adopted=await f.host.harness.behavior.callRpc('workstreams.adopt',{threadId:'cap',projectId:'cyndra',name:'Pending task',requestId:'pending-ship',taskIds:[t.id]}).catch((e:unknown)=>({refusal:String(e)})) as any;
  if(adopted.refusal)return;
  const spawned:any[]=[];const commands:any[]=[];f.host.harness.sdk.stub('threads.spawn',async(a:any)=>{spawned.push(a);return{id:'thr_pending_release'}});f.host.harness.sdk.stub('hosts.exec',async(a:any)=>{commands.push(a);throw Error('unexpected source command')});
  const result=await f.host.harness.behavior.callRpc('workstreams.ship',{threadId:'cap',workstreamId:adopted.workstream.id,requestId:'pending-release'}).catch((e:unknown)=>({refusal:String(e)}));
  console.log('EMPTY ADOPT SHIP',JSON.stringify({repos:adopted.workstream.repos,result,commands,spawned:spawned.map(a=>({environment:a.environment,metadata:a.pluginMetadata}))}));
  assert.ok(!spawned.some(a=>String(a.pluginMetadata?.task).includes('Prepare the release of merged workstream')),'an unimplemented adopted task must not reach a release crew');
 }finally{await f.host.harness.lifecycle.dispose()}
});
