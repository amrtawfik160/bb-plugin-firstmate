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

for(const mode of ['thread-gone','thread-read-error','thread-no-environment','environment-deleted','environment-read-error','environment-no-branch','environment-is-source'])test(`round3 ${mode} refuses all adoption without creating anything`,async()=>{
 const f=await realistic();try{
  const before=await f.host.harness.behavior.callRpc('workstreams.list',{threadId:'cap'});
  const notices:any[]=[];f.host.harness.sdk.stub('plugins.callRpc',async(a:any)=>{notices.push(a);return{ok:true,queued:1,duplicate:false}});
  if(mode.startsWith('thread-'))f.host.harness.sdk.stub('threads.get',async({threadId}:{threadId:string})=>{
   if(threadId==='thr_one'){
    if(mode==='thread-gone')throw Error('HTTP 404: thread gone');
    if(mode==='thread-read-error')throw Error('BB thread read failed');
    return makeThreadResponse({id:threadId,projectId:'cyndra',status:'idle',environmentId:null});
   }
   return makeThreadResponse({id:threadId,projectId:'cyndra',status:'active',environmentId:'env_main'});
  });
  else f.host.harness.sdk.stub('environments.get',async()=>{
   if(mode==='environment-deleted')throw Error('HTTP 404: environment deleted');
   if(mode==='environment-read-error')throw Error('BB environment read failed');
   return{id:'env_one',hostId:'h1',path:mode==='environment-is-source'?'/repo/main':'/wt/one',status:'ready',isWorktree:mode!=='environment-is-source',...(mode==='environment-no-branch'?{}:{branchName:'fm/one'})};
  });
  const result=await f.adopt().then(r=>({accepted:r}),e=>({refusal:String(e)}));
  console.log('LOCATION REFUSAL',JSON.stringify({mode,result}));
  assert.ok('refusal' in result,'an unresolved task must refuse, not use source/main');
  assert.match(result.refusal!,/task|worktree|environment|thread/i);
  assert.deepEqual(await f.host.harness.behavior.callRpc('workstreams.list',{threadId:'cap'}),before);assert.deepEqual(notices,[]);
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round3 mixed valid and missing crew thread refuses every task atomically',async()=>{
 const f=await realistic({two:true});try{
  f.host.harness.sdk.stub('threads.get',async({threadId}:{threadId:string})=>{if(threadId==='thr_two')throw Error('HTTP 404: thread gone');return makeThreadResponse({id:threadId,projectId:'cyndra',status:'idle',environmentId:threadId==='thr_one'?'env_one':'env_main'})});
  await assert.rejects(f.adopt(),/task|worktree|environment|thread/i);
  assert.equal((await f.host.harness.behavior.callRpc('workstreams.list',{threadId:'cap'}) as any).workstreams.length,0);
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round3 task with no PR retains real environment and branch without a main entry',async()=>{
 const f=await realistic({noPr:true});try{
  const r=await f.adopt();assert.deepEqual(r.workstream.repos.map((r:any)=>({path:r.path,branch:r.branch,environmentId:r.environmentId})),[{path:'/wt/one',branch:'fm/one',environmentId:'env_one'}]);
  assert.deepEqual(f.tasks.get(f.opened[0]!.id)!.prs,[]);
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round3 second task branch keeps its own builder and PR during Ship',async()=>{
 const f=await realistic({two:true});try{
  const r=await f.adopt();const cmds:string[]=[];
  f.host.harness.sdk.stub('hosts.exec',async({command}:{command:string})=>{
   cmds.push(command);if(command.includes('gh pr list'))return{exitCode:0,stdout:JSON.stringify([{url:`https://github.com/cyndra-ai/cyndra-saas/pull/${command.includes('fm/one')?'101':'102'}`,state:command.includes('fm/one')?'MERGED':'OPEN',headRefOid:'a'.repeat(40)}])};
   if(command.includes('git rev-parse HEAD'))return{exitCode:0,stdout:'a'.repeat(40)};
   return{exitCode:0,stdout:''};
  });
  const shipped=await f.host.harness.behavior.callRpc('workstreams.ship',{threadId:'cap',workstreamId:r.workstream.id,requestId:'own-pr'}) as any;
  const crews=await f.host.bb.storage.kv.get('crews') as any[];
  console.log('PER BRANCH PR',JSON.stringify({state:shipped.workstream.ship,crews:crews.map(c=>({id:c.id,pr:c.prUrl,thread:c.threadId})),taskPrs:f.opened.map(t=>({id:t.id,prs:f.tasks.get(t.id)?.prs}))}));
  assert.equal(crews.find(c=>c.id==='one')?.prUrl,'https://github.com/cyndra-ai/cyndra-saas/pull/101','Ship for branch two must not overwrite branch one builder PR');
  assert.equal(crews.find(c=>c.id==='two')?.prUrl,'https://github.com/cyndra-ai/cyndra-saas/pull/102');
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round3 queued Ship tells once and resumes same request after service reconstruction',async()=>{
 const f=await realistic({active:true});try{
  const r=await f.adopt();const notices:any[]=[];const commands:any[]=[];
  f.host.harness.sdk.stub('plugins.callRpc',async(a:any)=>{notices.push(a);return{ok:true,queued:1,duplicate:false}});
  f.host.harness.sdk.stub('hosts.exec',async(a:any)=>{commands.push(a);throw Error('capture-resumed-normal-ship-loop')});
  const ship=()=>f.host.harness.behavior.callRpc('workstreams.ship',{threadId:'cap',workstreamId:r.workstream.id,requestId:'waiting-restart'}) as Promise<any>;
  assert.equal((await ship()).workstream.ship.state,'queued');await ship();
  assert.equal(commands.length,0);assert.equal(notices.filter(a=>a.method==='alert'&&a.input.text.includes('Ship waits')).length,1);
  const {createWorkstreams}=await import('./lib/workstreams.ts');
  const reloaded=createWorkstreams(f.host.bb.storage.database(),{
   now:Date.now,provision:async()=>{throw Error('unexpected provision')},start:async()=>{throw Error('unexpected editor')},status:async()=> 'idle',startDev:async()=>'',stopDev:async()=>{},unsaved:async()=>[],remove:async()=>{},taskState:id=>f.tasks.get(id)?.state,
   editorBusy:async()=>f.statuses.get('thr_one')==='active',waiting:async()=>{throw Error('duplicate notice after restart')},
   ship:async()=>{const resumed=await ship();if(resumed.workstream.ship.state==='blocked')throw Error(resumed.workstream.ship.error)},
  });
  assert.equal(reloaded.get(r.workstream.id,'cap').ship.state,'queued');await reloaded.reconcile();assert.equal(commands.length,0);
  f.statuses.set('thr_one','idle');await reloaded.reconcile();
  console.log('WAIT RESTART',JSON.stringify({state:reloaded.get(r.workstream.id,'cap').ship,commands,notices:notices.filter(a=>a.method==='alert')}));
  assert.equal(commands.length,1);assert.ok(commands[0].command.includes('/wt/one'));assert.ok(commands[0].command.includes('fm/one'));assert.equal(notices.filter(a=>a.method==='alert'&&a.input.text.includes('Ship waits')).length,1);
 }finally{await f.host.harness.lifecycle.dispose()}
});
