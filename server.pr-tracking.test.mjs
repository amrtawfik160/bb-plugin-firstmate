import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost,makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries } from './lib/pr-delivery.ts';
import { createLaunches,launchKey } from './lib/launch.ts';

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
// The scan lists open PRs through the REST API, which has its own rate budget.
const isOpenList=command=>command.includes('gh api') && command.includes('pulls?state=open');
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
   if(isOpenList(command)){sweeps.push(command);return{payload:JSON.stringify(openPrs)};}
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
  assert.equal(sweeps.length,2,'one open-PR list call per supervision cycle');
  assert.match(sweeps[0],/pulls\?state=open/);
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
   if(isOpenList(command))return{payload:JSON.stringify(openPrs)};
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

// Oct 9: after a merged PR retired crews 698172dd and others, the PR notice wrote a
// new state/<id>.status note and a wake pointer, waking the captain about a gone crew.
test('a PR notice for a retired crew writes no status note and no wake, but still reaches the captain',async()=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[crew('live1','thr_live1','thr_cap')]);
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle'}));
  const sent=[];host.harness.sdk.stub('threads.send',async args=>{sent.push(JSON.stringify(args.input));return{delivery:'queued'};});
  const store=createDeliveries(host.bb.storage.database());
  store.register({url:'https://github.com/acme/repo/pull/30',taskId:'gone1',projectId:'proj_1',owner:'thr_cap',home:'/fm',worker:'thr_gone1',requirement:'pr'});
  store.register({url:'https://github.com/acme/repo/pull/31',taskId:'live1',projectId:'proj_1',owner:'thr_cap',home:'/fm',worker:'thr_live1',requirement:'pr'});
  const wakes=[];
  hostCommands(host,command=>{
   if(command.includes('gh pr view'))return{payload:JSON.stringify(forge('MERGED'))};
   if(command.includes('fm_wake_append_locked')){
    // The host has no .meta for the retired crew; the script must stop before the note.
    if(command.includes('/fm/state/gone1.meta'))return{payload:'FM_BB_WAKE_SKIPPED=retired'};
    wakes.push(command);return{payload:'FM_BB_WAKE_SEQ=1'};
   }
   return{code:0};
  });
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.equal(wakes.filter(c=>c.includes('gone1.status')).length,0,'no status note or wake for a retired crew');
  assert.equal(wakes.filter(c=>c.includes('live1.status')).length,1,'a live crew still gets its status note and wake');
  assert.ok(sent.some(s=>s.includes('FM_DELIVERY_NOTICE=acme/repo#30')),'the retired crew notice still reaches the captain directly');
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

// 13 Oct: captain thr_pse43vv6tn had open crew PRs with no delivery row. Each test below is one of those gaps.
const pr=(n,head,updatedAt='2026-10-13T14:00:00Z')=>({number:n,url:`https://github.com/acme/repo/pull/${n}`,title:`PR ${n}`,headRefName:head,createdAt:'2026-10-13T14:00:00Z',updatedAt});
const launch=(taskId,threadId,owner,extra={})=>({key:launchKey('proj_1',owner,'/fm',taskId),taskId,projectId:'proj_1',owner,home:'/fm',generation:1,shape:'ship',deliveryMode:'direct-PR',deliveryRequirement:'pr',state:'running',threadId,hostId:'host_1',path:`/wt/${threadId}`,updatedAt:Date.now(),...extra});
function sweepHost(host,{prs,current='',checkedOut='',lists=[]}) {
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:`env_${threadId}`}));
 host.harness.sdk.stub('environments.get',async({environmentId})=>({id:environmentId,hostId:'host_1',status:'ready',isWorktree:true,path:`/wt/${environmentId.replace('env_','')}`,branchName:`bb/ship-some-task-${environmentId.replace('env_','')}`}));
 return hostCommands(host,command=>{
  if(isOpenList(command)){lists.push(command);return{payload:JSON.stringify(typeof prs==='function'?prs():prs)};}
  if(command.includes('gh pr list'))return{payload:'[]'};
  if(command.includes('gh pr view'))return{payload:JSON.stringify(forge('OPEN'))};
  if(command.includes('checkout: moving from'))return{payload:checkedOut};
  if(command.includes('branch --show-current'))return{payload:current};
  return{code:0};
 });
}
const rows=host=>createDeliveries(host.bb.storage.database()).list({includeComplete:true}).map(r=>[r.id,r.owner,r.taskId]).sort();

// #2337: crew c7c70edb opened three PRs on fm/c7c70edb, -agents and -workflows. It left
// fm/c7c70edb-workflows 75 seconds after opening the PR, so no scan ever saw that branch checked out.
test('every PR on a branch named after the crew is tracked, whatever branch the crew has checked out now',async()=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[crew('c7c70edb','thr_w1','thr_cap')]);
  sweepHost(host,{prs:[pr(2333,'fm/c7c70edb'),pr(2336,'fm/c7c70edb-agents'),pr(2337,'fm/c7c70edb-workflows')],current:'fm/c7c70edb-agents\n'});
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.deepEqual(rows(host),[['acme/repo#2333','thr_cap','c7c70edb'],['acme/repo#2336','thr_cap','c7c70edb'],['acme/repo#2337','thr_cap','c7c70edb']]);
 }finally{await host.harness.lifecycle.dispose();}
});

// #2339: crew e64881c8 was dispatched as a scout and opened a PR anyway.
test('a PR opened by a scout is tracked for its captain',async()=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[{...crew('e64881c8','thr_s1','thr_cap'),shape:'scout'}]);
  sweepHost(host,{prs:[pr(2339,'fm/e64881c8-protected-test-tools')]});
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.deepEqual(rows(host),[['acme/repo#2339','thr_cap','e64881c8']]);
  assert.equal(createDeliveries(host.bb.storage.database()).get('acme/repo#2339').requirement,'merged','a scout PR is never taken as delivered just because it is open');
 }finally{await host.harness.lifecycle.dispose();}
});

test('a PR opened after the crew was retired is still tracked for the captain that launched it',async()=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[]);
  createLaunches(host.bb.storage.database()).save(launch('1b4f6b8b','thr_w2','thr_cap'));
  sweepHost(host,{prs:[pr(2349,'fm/1b4f6b8b-copy')]});
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.deepEqual(rows(host),[['acme/repo#2349','thr_cap','1b4f6b8b']]);
  assert.equal(createDeliveries(host.bb.storage.database()).get('acme/repo#2349').requirement,'pr','the launch keeps the agreed delivery contract');
 }finally{await host.harness.lifecycle.dispose();}
});

test('a PR on a branch with any name is tracked when that branch was checked out in a crew worktree',async()=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[crew('c9','thr_w9','thr_cap')]);
  sweepHost(host,{prs:[pr(2096,'fix/runtime-crash'),pr(13,'docs/turn-transport')],checkedOut:'/wt/thr_w9\tfix/runtime-crash\n/somewhere/else\tdocs/turn-transport\n'});
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.deepEqual(rows(host),[['acme/repo#2096','thr_cap','c9']],'a PR from a worktree that is no crew stays untracked');
 }finally{await host.harness.lifecycle.dispose();}
});

test('a new PR gets its row in the next cycle, with one open-PR list call per repository per cycle',async()=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[crew('aa11','thr_w1','thr_cap'),{...crew('bb22','thr_w2','thr_cap'),projectId:'proj_2'}]);
  let open=[pr(1,'fm/aa11')];const lists=[];
  sweepHost(host,{prs:[]});
  hostCommands(host,command=>{
   if(command.includes('remote get-url'))return{payload:'git@github.com:acme/repo.git\n'};
   if(isOpenList(command)){lists.push(command);return{payload:JSON.stringify(open)};}
   if(command.includes('gh pr list'))return{payload:'[]'};
   if(command.includes('gh pr view'))return{payload:JSON.stringify(forge('OPEN'))};
   return{code:0};
  });
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.equal(lists.length,1,'two projects on one repository share one list call');
  open=[...open,pr(2,'fm/bb22-second')];
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.equal(lists.length,2);
  assert.deepEqual(rows(host),[['acme/repo#1','thr_cap','aa11'],['acme/repo#2','thr_cap','bb22']]);
 }finally{await host.harness.lifecycle.dispose();}
});

test('an open PR nobody touched for 24 hours is put to the captain for a decision, one line per PR, once per day',async(t)=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[crew('aa11','thr_w1','thr_cap')]);
  createLaunches(host.bb.storage.database()).save(launch('aa11','thr_w1','thr_cap'));
  const sent=[];host.harness.sdk.stub('threads.send',async args=>{sent.push(JSON.stringify(args.input));return{delivery:'queued'};});
  const start=Date.parse('2026-10-13T17:00:00Z');let now=start-25*60*60_000;t.mock.method(Date,'now',()=>now);
  sweepHost(host,{prs:[pr(538,'fm/aa11','2026-10-10T09:00:00Z'),pr(539,'fm/aa11-fresh','2026-10-13T16:00:00Z')]});
  const asks=()=>sent.filter(s=>s.includes('Decide for each'));
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.ok(sent.some(s=>s.includes('FM_DELIVERY_NOTICE=acme/repo#538')),'the captain is told about the new row');
  assert.equal(asks().length,0,'a PR the captain just heard about is not asked about again the same day');
  now=start;await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.equal(asks().length,1);
  const text=JSON.parse(asks()[0]).map(part=>part.text ?? '').join('\n');
  const lines=text.split('\n').filter(line=>line.includes('/pull/'));
  assert.equal(lines.length,1,'one line per PR, and a PR touched today is left out');
  assert.match(lines[0],/https:\/\/github\.com\/acme\/repo\/pull\/538/);assert.match(lines[0],/3 days/);
  assert.match(text,/merge, fix or close/);
  now=start+60*60_000;await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.equal(asks().length,1,'not repeated the same day');
  now=start+24*60*60_000+60_000;await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.equal(asks().length,2,'asked again the next day while the PR stays open and untouched');
 }finally{await host.harness.lifecycle.dispose();}
});

test('bb firstmate prs lists open PRs with their tracking status and marks the untracked ones',async()=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[crew('aa11','thr_w1','thr_cap')]);
  await host.bb.storage.kv.set('captain-project:thr_cap','proj_1');
  sweepHost(host,{prs:[pr(1,'fm/aa11'),pr(2096,'fix/opened-outside-any-crew','2026-10-06T19:09:05Z')]});
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  const before=rows(host);
  const result=await host.harness.behavior.runCli(['prs','--json'],{threadId:'thr_cap',projectId:'proj_1'});
  assert.equal(result.exitCode,0,result.stderr);
  const listed=JSON.parse(result.stdout);
  assert.deepEqual(listed.map(p=>[p.number,p.tracked,p.crewId ?? null]),[[2096,false,null],[1,true,'aa11']],'untracked first');
  const text=(await host.harness.behavior.runCli(['prs'],{threadId:'thr_cap',projectId:'proj_1'})).stdout;
  assert.match(text,/UNTRACKED.*https:\/\/github\.com\/acme\/repo\/pull\/2096/);
  assert.match(text,/1 of 2 open PRs untracked/);
  assert.deepEqual(rows(host),before,'the command is read-only');
 }finally{await host.harness.lifecycle.dispose();}
});

// Found on the live host after #121: project bb-plugin-firstmate had only retired crews whose worktrees were removed, so its open PRs were never listed.
test('open PRs are listed from the project main checkout when every crew worktree of the project is gone',async()=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[]);
  createLaunches(host.bb.storage.database()).save(launch('dead1','thr_gone','thr_cap',{path:'/wt/removed'}));
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle'}));
  hostCommands(host,command=>{
   // Only the main checkout still exists on the host.
   if(isOpenList(command))return /cd \S*\/repo\b/.test(command) ? {payload:JSON.stringify([pr(7,'fm/dead1-late'),pr(8,'docs/no-crew')])} : {code:3};
   if(command.includes('gh pr view'))return{payload:JSON.stringify(forge('OPEN'))};
   return{code:0};
  });
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.deepEqual(rows(host),[['acme/repo#7','thr_cap','dead1']]);
  const listed=JSON.parse((await host.harness.behavior.runCli(['prs','--json'],{threadId:'thr_cap',projectId:'proj_1'})).stdout);
  assert.deepEqual(listed.map(p=>[p.number,p.tracked]),[[8,false],[7,true]]);
 }finally{await host.harness.lifecycle.dispose();}
});

// 13 Oct 17:30 UTC: after #121 the scan ran a GitHub search every minute per repository and
// helped exhaust the search budget the whole fleet shares. The plain list API has its own budget.
test('the open-PR scan does not use GitHub search, counts only PRs of the signed-in account, and lists a project with no live crew every ten minutes',async(t)=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[]);
  createLaunches(host.bb.storage.database()).save(launch('aa11','thr_w1','thr_cap'));
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle'}));
  const start=Date.now();let now=start;t.mock.method(Date,'now',()=>now);
  const lists=[],all=[];
  hostCommands(host,command=>{
   all.push(command);
   if(command.includes('gh api user'))return{payload:'me\n'};
   if(isOpenList(command)){lists.push(command);return{payload:JSON.stringify([{...pr(1,'fm/aa11'),author:'me'},{...pr(2,'fm/aa11-by-someone-else'),author:'other'}])};}
   if(command.includes('gh pr view'))return{payload:JSON.stringify(forge('OPEN'))};
   return{code:0};
  });
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.deepEqual(rows(host),[['acme/repo#1','thr_cap','aa11']]);
  assert.equal(all.some(c=>c.includes('gh pr list') && c.includes('--author')),false,'no search query');
  now=start+5*60_000;await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.equal(lists.length,1,'a project with only retired crews is not listed again within ten minutes');
  now=start+10*60_000+1000;await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.equal(lists.length,2);
 }finally{await host.harness.lifecycle.dispose();}
});
