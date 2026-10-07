import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost,makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries } from './lib/pr-delivery.ts';

// Answers host terminal commands the way server.launch-delivery.test.mjs does.
function hostCommands(host,answer) {
 const commands=new Map();let n=0;
 host.harness.sdk.stub('terminals.create',async args=>{const id=`term${++n}`;commands.set(id,args.start.command);return{id};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{const command=commands.get(terminalId);const out=answer(command);const captured=command.includes('FM_HOST_CAPTURE_V1');const payload=captured?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:out.code??0,stdout:out.payload??'',stderr:out.stderr??''}):out.payload??'';return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:${captured?0:out.code ?? 0}\n`).toString('base64')}]};});
 return commands;
}
async function base() {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain']});await plugin(host.bb);
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('environments.get',async()=>({id:'env_wt',hostId:'host_1',status:'ready',isWorktree:true,path:'/wt'}));
 host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'unavailable'}));
 host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));
 host.harness.sdk.stub('threads.queuedMessages.list',async()=>[]);
 host.harness.sdk.stub('threads.events.list',async()=>[]);
 return host;
}
const forge=(state,extra={})=>({headRefOid:'sha1',state,isDraft:false,statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}],reviewDecision:'',reviews:[],mergeable:'MERGEABLE',mergeCommit:state==='MERGED'?{oid:'sha-merged'}:null,...extra});
const prNumber=command=>Number(/\/pull\/(\d+)/.exec(command)?.[1]);

test('merged and closed PRs leave the open list even when their captain thread is deleted or archived',async()=>{
 const host=await base();try {
  host.harness.sdk.stub('threads.get',async({threadId})=>{
   if(threadId==='thr_gone')throw new Error('HTTP 404: Thread not found');
   return makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',archivedAt:threadId==='thr_archived'?1:null});
  });
  const store=createDeliveries(host.bb.storage.database());
  for(const [n,owner] of [[1,'thr_gone'],[2,'thr_archived'],[3,'thr_gone']]) store.register({url:`https://github.com/acme/repo/pull/${n}`,taskId:`t${n}`,projectId:'proj_1',owner,home:'',worker:`thr_w${n}`,requirement:'pr'});
  hostCommands(host,command=>command.includes('gh pr view') ? {payload:JSON.stringify(forge(prNumber(command)===3?'CLOSED':'MERGED'))} : {code:0});
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.equal(store.get('acme/repo#1').status,'complete');
  assert.equal(store.get('acme/repo#2').status,'complete');
  assert.equal(store.get('acme/repo#3').status,'closed-needs-disposition');
  assert.equal(store.get('acme/repo#3').ownerNeeded,true,'a lost captain is still shown as needing a new manager');
 }finally{await host.harness.lifecycle.dispose();}
});

test('a live captain keeps its PR in another project, and one lost record does not delay the others',async()=>{
 const host=await base();try {
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle'}));
  const store=createDeliveries(host.bb.storage.database());
  store.register({url:'https://github.com/acme/other/pull/5',taskId:'cross',projectId:'proj_2',owner:'thr_cap',home:'',worker:'thr_w',requirement:'pr'});
  store.register({url:'https://github.com/acme/repo/pull/6',taskId:'same',projectId:'proj_1',owner:'thr_cap',home:'',worker:'thr_w2',requirement:'pr'});
  hostCommands(host,command=>command.includes('gh pr view') ? {payload:JSON.stringify(forge(prNumber(command)===6?'MERGED':'OPEN'))} : {code:0});
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  const cross=store.get('acme/other#5');
  assert.equal(cross.ownerNeeded,false);assert.equal(cross.owner,'thr_cap');assert.equal(cross.forgeState,'open');
  assert.equal(store.get('acme/repo#6').status,'complete');
 }finally{await host.harness.lifecycle.dispose();}
});

test('a PR wrongly marked as needing a manager recovers once its captain is seen alive',async()=>{
 const host=await base();try {
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle'}));
  const store=createDeliveries(host.bb.storage.database());
  store.register({url:'https://github.com/acme/repo/pull/8',taskId:'t8',projectId:'proj_1',owner:'thr_cap',home:'',worker:'thr_w',requirement:'pr'});
  store.ownerLost('thr_cap');
  const marked=store.get('acme/repo#8');marked.nextCheckAt=0;store.save(marked);
  hostCommands(host,command=>command.includes('gh pr view') ? {payload:JSON.stringify(forge('OPEN'))} : {code:0});
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  const r=store.get('acme/repo#8');
  assert.equal(r.ownerNeeded,false);assert.equal(r.forgeState,'open');assert.doesNotMatch(r.notification.desired ?? '',/^owner-needed:/);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a PR whose captain was marked lost is read on GitHub again within ten minutes',async(t)=>{
 const host=await base();try {
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',archivedAt:threadId==='thr_old'?1:null}));
  const store=createDeliveries(host.bb.storage.database());
  store.register({url:'https://github.com/acme/repo/pull/20',taskId:'t20',projectId:'proj_1',owner:'thr_cap',home:'',worker:'thr_w20',requirement:'pr'});
  store.register({url:'https://github.com/acme/repo/pull/21',taskId:'t21',projectId:'proj_1',owner:'thr_old',home:'',worker:'thr_w21',requirement:'pr'});
  let state='OPEN';
  hostCommands(host,command=>command.includes('gh pr view') ? {payload:JSON.stringify(forge(state))} : {code:0});
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.equal(store.get('acme/repo#21').ownerNeeded,true);
  store.ownerLost('thr_cap');
  state='MERGED';
  const start=Date.now();
  t.mock.method(Date,'now',()=>start+10*60_000);
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  const live=store.get('acme/repo#20');
  assert.equal(live.status,'complete','a merged PR of a captain wrongly marked lost completes');
  assert.equal(live.ownerNeeded,false);
  assert.equal(store.get('acme/repo#21').status,'complete','a merged PR of an archived captain completes');
 }finally{await host.harness.lifecycle.dispose();}
});

test('twelve PRs of a deleted captain all complete without one pass pushing the rest back an hour',async()=>{
 const host=await base();try {
  host.harness.sdk.stub('threads.get',async()=>{throw new Error('HTTP 404: Thread not found');});
  const store=createDeliveries(host.bb.storage.database());
  for(let n=1;n<=12;n++) store.register({url:`https://github.com/acme/repo/pull/${n}`,taskId:`t${n}`,projectId:'proj_1',owner:'thr_gone',home:'',worker:`thr_w${n}`,requirement:'pr'});
  hostCommands(host,command=>command.includes('gh pr view') ? {payload:JSON.stringify(forge('MERGED'))} : {code:0});
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.deepEqual(store.list({owner:'thr_gone'}).map(r=>r.id),[]);
 }finally{await host.harness.lifecycle.dispose();}
});

const crew=(id,threadId,owner)=>({id,task:'fix login',projectId:'proj_1',threadId,parentThreadId:owner,providerId:null,model:null,reasoningLevel:null,worktree:true,shape:'ship',posture:'direct-PR',createdAt:'2026-10-07T00:00:00.000Z'});
const openPrs=[
 {number:10,url:'https://github.com/acme/repo/pull/10',title:'Fix the login form',headRefName:'fm/verify',createdAt:'2026-10-07T10:00:00Z'},
 {number:11,url:'https://github.com/acme/repo/pull/11',title:'Show versions in the probe',headRefName:'fm/verify-probe',createdAt:'2026-10-07T11:00:00Z'},
 {number:12,url:'https://github.com/acme/repo/pull/12',title:'Other captain work',headRefName:'fm/verify-extra-1',createdAt:'2026-10-07T11:30:00Z'},
 {number:13,url:'https://github.com/acme/repo/pull/13',title:'Opened outside any crew',headRefName:'docs/turn-transport',createdAt:'2026-10-07T12:00:00Z'},
];

test('open PRs on a crew branch are tracked for that crew captain, and other PRs are not',async()=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[crew('c1','thr_c1','thr_cap'),crew('c2','thr_c2','thr_other')]);
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'active',environmentId:`env_${threadId}`}));
  host.harness.sdk.stub('environments.get',async({environmentId})=>({id:environmentId,hostId:'host_1',status:'ready',isWorktree:true,path:`/wt/${environmentId}`,branchName:environmentId==='env_thr_c1'?'fm/verify':'fm/verify-extra'}));
  const sweeps=[];
  hostCommands(host,command=>{
   if(command.includes('gh pr list') && command.includes('--state open')){sweeps.push(command);return{payload:JSON.stringify(openPrs)};}
   // The older per-crew lookup asks for the single most recent PR on the exact branch.
   if(command.includes('gh pr list')){const head=command.includes('fm/verify-extra')?'fm/verify-extra':'fm/verify';return{payload:JSON.stringify(openPrs.filter(p=>p.headRefName===head).map(p=>({url:p.url})))};}
   if(command.includes('gh pr view'))return{payload:JSON.stringify({...forge('OPEN'),title:openPrs.find(p=>p.number===prNumber(command))?.title})};
   return{code:0};
  });
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  const store=createDeliveries(host.bb.storage.database());
  const tracked=store.list({includeComplete:true}).map(r=>[r.id,r.owner,r.taskId,r.title]).sort();
  assert.deepEqual(tracked,[
   ['acme/repo#10','thr_cap','c1','Fix the login form'],
   ['acme/repo#11','thr_cap','c1','Show versions in the probe'],
   ['acme/repo#12','thr_other','c2','Other captain work'],
  ]);
  assert.equal(sweeps.length,1,'the open-PR sweep runs at most once every five minutes');
  assert.match(sweeps[0],/--author \S*@me/);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a crew PR is tracked when the crew pushed its own fm/ branch, not the worktree branch BB recorded',async()=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[crew('verify','thr_c1','thr_cap')]);
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'active',environmentId:`env_${threadId}`}));
  // On Oct 7 BB still recorded bb/ship-… while the crew's checkout was on fm/<task>, the branch its brief makes it push.
  host.harness.sdk.stub('environments.get',async({environmentId})=>({id:environmentId,hostId:'host_1',status:'ready',isWorktree:true,path:`/wt/${environmentId}`,branchName:'bb/ship-verification-harness-fixes-thr_c1'}));
  hostCommands(host,command=>{
   if(command.includes('branch --show-current'))return{payload:'fm/verify\n'};
   if(command.includes('gh pr list') && command.includes('--state open'))return{payload:JSON.stringify(openPrs)};
   if(command.includes('gh pr list'))return{payload:'[]'};
   if(command.includes('gh pr view'))return{payload:JSON.stringify(forge('OPEN'))};
   return{code:0};
  });
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  const tracked=createDeliveries(host.bb.storage.database()).list({includeComplete:true}).map(r=>[r.id,r.owner,r.taskId]).sort();
  assert.deepEqual(tracked,[
   ['acme/repo#10','thr_cap','verify'],
   ['acme/repo#11','thr_cap','verify'],
   ['acme/repo#12','thr_cap','verify'],
  ]);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a captain can track a PR it opened itself without a crew',async()=>{
 const host=await base();try {
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'active'}));
  const result=await host.harness.behavior.runCli(['deliveries','register','--url','https://github.com/acme/repo/pull/13'],{threadId:'thr_cap',projectId:'proj_1'});
  assert.equal(result.exitCode,0,result.stderr);
  const r=createDeliveries(host.bb.storage.database()).get('acme/repo#13');
  assert.equal(r.owner,'thr_cap');assert.equal(r.requirement,'merged');assert.equal(r.taskId,'captain:acme/repo#13');
 }finally{await host.harness.lifecycle.dispose();}
});
