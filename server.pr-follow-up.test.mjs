import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost,makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries } from './lib/pr-delivery.ts';

// 17 Oct: the follow-up loop read 10 PRs a minute while 71 came due every minute, so a
// ledger head lagged GitHub by minutes and a checker verdict for a just-pushed head was
// refused as not the current head.
const BUILDER='9ceeb10f';
const url=n=>`https://github.com/Cyndra-AI/cyndra-saas/pull/${n}`;
const id=n=>`cyndra-ai/cyndra-saas#${n}`;
const heads=new Map();
let metas='';
let ghStderr='';
let probeStderr='';
const states=new Map();
const head=n=>heads.get(n) ?? String(n).repeat(10).slice(0,40);
const crewRow=(id,threadId,extra)=>({id,task:'x',projectId:'proj_1',threadId,parentThreadId:'thr_cap',nativeHome:'/native',worktree:true,shape:'ship',posture:'direct-PR',createdAt:'2026-10-17T00:00:00.000Z',reasoningLevel:null,dispatchVersion:2,...extra});
const CREWS=[
 crewRow(BUILDER,'thr_crew',{title:'Fix dropped Telegram messages',providerId:'claude-code',model:'claude-opus-5-5'}),
 crewRow('chk1','thr_chk',{title:'Check PR 2391',providerId:'codex',model:'gpt-6-astra',role:'checker'}),
];

function hostCommands(host,{delayMs=0}={}) {
 const byId=new Map();let n=0;const gh={inFlight:0,maxInFlight:0,reads:0,commands:[]};
 host.harness.sdk.stub('terminals.create',async args=>{const tid=`term${++n}`;byId.set(tid,args.start.command);gh.commands.push(args.start.command);return{id:tid};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{
  const command=byId.get(terminalId);const isRead=command.includes('gh pr view');
  if(isRead){gh.reads++;gh.inFlight++;gh.maxInFlight=Math.max(gh.maxInFlight,gh.inFlight);await new Promise(r=>setTimeout(r,delayMs));gh.inFlight--;}
  const out=forge(command);const captured=command.includes('FM_HOST_CAPTURE_V1');
  const payload=captured?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:out.code??0,stdout:out.payload??'',stderr:isRead?ghStderr:command.includes('rateLimit')?probeStderr:''}):out.payload??'';
  return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:${captured?0:out.code ?? 0}\n`).toString('base64')}]};
 });
 return gh;
}
function forge(command) {
 const n=Number(/\/pull\/(\d+)/.exec(command)?.[1]);
 if(command.includes('/state/*.meta'))return{payload:metas};
 if(command.includes('gh pr view'))return{payload:JSON.stringify({number:n,url:url(n),title:`Change ${n}`,headRefName:`fm/${BUILDER}-change-${n}`,headRefOid:head(n),state:states.get(n) ?? 'OPEN',mergeCommit:states.get(n)==='MERGED'?{oid:'m'.repeat(40)}:null,isDraft:false,mergeable:'MERGEABLE',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}],reviewDecision:'APPROVED',reviews:[]})};
 return{code:0};
}
async function deck(prs,{delayMs=0}={}) {
 heads.clear();metas='';states.clear();ghStderr='';probeStderr='';
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain'],settings:{fmHome:'/native',fmHostId:'host_1'}});await plugin(host.bb);
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('environments.get',async()=>({id:'env_wt',hostId:'host_1',status:'ready',isWorktree:true,path:'/wt'}));
 host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'unavailable'}));
 host.harness.sdk.stub('threads.output',async()=>({output:'DONE: PR open'}));
 host.harness.sdk.stub('threads.events.list',async()=>[]);
 host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));
 host.harness.sdk.stub('threads.queuedMessages.list',async()=>[]);
 host.harness.sdk.stub('files.read',async()=>{throw new Error('ENOENT');});
 await host.bb.storage.kv.set('crews',CREWS);
 const store=createDeliveries(host.bb.storage.database());
 for(const n of prs){
  const r=store.register({url:url(n),taskId:BUILDER,projectId:'proj_1',owner:'thr_cap',home:'/native',worker:'thr_crew',requirement:'pr',title:`Change ${n}`});
  store.observe(r.id,{headSha:head(n),state:'open',draft:false,checks:'passing',review:'approved',reviewHeadSha:head(n),mergeCommitSha:null,mergeable:'mergeable'},true);
 }
 return {host,store,gh:hostCommands(host,{delayMs})};
}
const tool=(host,name)=>host.harness.inspection.registrations.agentTools.find(t=>t.name===name);
const text=out=>typeof out==='string'?out:out?.content?.[0]?.text ?? JSON.stringify(out);
const check=(host,n,sha)=>tool(host,'firstmate_deliveries').execute({action:'check',id:id(n),commitSha:sha.slice(0,7),verdict:'pass',notes:'read the diff; drove a restart on staging; the message was answered'},{threadId:'thr_chk',projectId:'proj_1'});

test('a checker verdict for a head pushed after the last observation is accepted against the live head',async()=>{
 const {host,store}=await deck([2391]);try {
  const old=head(2391);heads.set(2391,'f'.repeat(40));
  assert.equal(store.get(id(2391)).headSha,old,'the ledger still holds the pushed-over head');
  text(await check(host,2391,'f'.repeat(40)));
  assert.equal(store.get(id(2391)).check?.commitSha,'f'.repeat(40));
  assert.equal(store.get(id(2391)).headSha,'f'.repeat(40));
 }finally{await host.harness.lifecycle.dispose();}
});

test('a checker verdict for a head GitHub has moved past is refused, though the ledger still holds it',async()=>{
 const {host,store}=await deck([2391]);try {
  const old=head(2391);heads.set(2391,'e'.repeat(40));
  assert.match(text(await check(host,2391,old)),/does not match the current head eeeeeee/);
  assert.equal(store.get(id(2391)).check ?? null,null);
 }finally{await host.harness.lifecycle.dispose();}
});

test('one follow-up cycle reads the oldest due PRs up to its paced budget, a few at a time',async()=>{
 const prs=Array.from({length:50},(_,i)=>3000+i);
 const {host,store,gh}=await deck(prs,{delayMs:20});try {
  for(const n of prs){const r=store.get(id(n));store.save({...r,nextCheckAt:0});}
  const due=()=>store.list({due:Date.now(),limit:100}).length;
  assert.equal(due(),50);
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  // Paced: a cycle reads up to the burst of the hourly allowance, oldest due first.
  assert.ok(gh.reads>=5&&gh.reads<=10,`${gh.reads} GitHub reads in one cycle`);
  assert.ok(gh.maxInFlight>1,`reads ran one at a time (${gh.maxInFlight} in flight at most)`);
  assert.ok(gh.maxInFlight<=8,`${gh.maxInFlight} GitHub reads in flight at once`);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a crew forgotten with its PR open has its native record retired once every delivery of it ends, and only then',async()=>{
 const {host,store,gh}=await deck([]);try {
  const archived=new Set(['thr_c9','thr_c8','thr_c7','thr_crew']);
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt',archivedAt:archived.has(threadId)?1:null}));
  const deliver=(task,thread,n,status)=>{const r=store.register({url:url(n),taskId:task,projectId:'proj_1',owner:'thr_cap',home:'/native',worker:thread,requirement:'pr',continuation:crewRow(task,thread,{backlogRow:true,providerId:null,model:null})});
   store.save({...store.get(r.id),status,nextCheckAt:Date.now()+3_600_000});};
  for(const n of [5001,5002,5003,5005,5006]) states.set(n,'MERGED');
  deliver('c9','thr_c9',5001,'complete');deliver('c9','thr_c9',5002,'merged-unverified');
  deliver('c8','thr_c8',5003,'complete');deliver('c8','thr_c8',5004,'pr-delivered');
  deliver('c5','thr_c5',5005,'complete');
  deliver(BUILDER,'thr_crew',5006,'complete');
  metas=['c9\tthr_c9','c8\tthr_c8','c7\tthr_c7','c5\tthr_c5',`${BUILDER}\tthr_crew`].join('\n')+'\n';
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  const removed=gh.commands.flatMap(c=>/rm -f \S*\/native\/state\/([A-Za-z0-9_-]+)\.meta\b/.exec(c)?.slice(1) ?? []);
  assert.deepEqual(removed,['c9'],'only the forgotten crew whose deliveries all ended loses its record');
 }finally{await host.harness.lifecycle.dispose();}
});

async function sweepDeck() {
 const d=await deck([]);
 d.host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt',archivedAt:1}));
 d.deliver=(task,thread,n,status)=>{const r=d.store.register({url:url(n),taskId:task,projectId:'proj_1',owner:'thr_cap',home:'/native',worker:thread,requirement:'pr',continuation:crewRow(task,thread,{backlogRow:true,providerId:null,model:null})});
  d.store.save({...d.store.get(r.id),status,nextCheckAt:Date.now()+3_600_000});};
 d.removed=()=>d.gh.commands.flatMap(c=>/rm -f \S*\/native\/state\/([A-Za-z0-9_-]+)\.meta\b/.exec(c)?.slice(1) ?? []);
 return d;
}

test('a forgotten task keeps its record while a delivery of another worker on that task is still open',async()=>{
 const d=await sweepDeck();try {
  states.set(5101,'MERGED');
  d.deliver('c9','thr_c9',5101,'complete');d.deliver('c9','thr_other',5102,'pr-delivered');
  metas='c9\tthr_c9\n';
  await d.host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.deepEqual(d.removed(),[]);
 }finally{await d.host.harness.lifecycle.dispose();}
});

test('a PR reopened since its delivery was abandoned is read fresh, and its task keeps the record',async()=>{
 const d=await sweepDeck();try {
  d.deliver('c4','thr_c4',5201,'explicitly-abandoned');
  metas='c4\tthr_c4\n';
  await d.host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.ok(d.gh.commands.some(c=>c.includes('/pull/5201')),'the reopened PR was read from GitHub before retirement');
  assert.deepEqual(d.removed(),[]);
 }finally{await d.host.harness.lifecycle.dispose();}
});

test('background reads stay inside an hourly allowance however many PRs come due, leaving the rest of the quota to merges and checks',async()=>{
 const prs=Array.from({length:100},(_,i)=>6000+i);
 const {host,store,gh}=await deck(prs);try {
  for(let cycle=0;cycle<8;cycle++){
   for(const n of prs){const r=store.get(id(n));store.save({...r,nextCheckAt:0});}
   await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  }
  assert.ok(gh.reads<=500,`${gh.reads} background GitHub reads within one hour`);
  assert.ok(gh.reads>=5,`only ${gh.reads} reads`);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a checker refresh that overlaps the follow-up read of the same PR shares that read when it covers the head',async()=>{
 const {host,store,gh}=await deck([2391],{delayMs:300});try {
  store.save({...store.get(id(2391)),nextCheckAt:0});
  const cycle=host.harness.behavior.runSchedule('pr-delivery-follow-up');
  await new Promise(r=>setTimeout(r,100));
  text(await check(host,2391,head(2391)));
  await cycle;
  assert.equal(gh.reads,1,'one GitHub read served both');
  assert.equal(store.get(id(2391)).check?.commitSha,head(2391));
 }finally{await host.harness.lifecycle.dispose();}
});

test('retirement reads wait while the GraphQL headers of the last PR read show the reserve reached',async()=>{
 const d=await sweepDeck();try {
  states.set(5301,'MERGED');
  d.deliver('c9','thr_c9',5301,'complete');
  const r=d.store.register({url:url(5302),taskId:BUILDER,projectId:'proj_1',owner:'thr_cap',home:'/native',worker:'thr_crew',requirement:'pr'});d.store.save({...d.store.get(r.id),nextCheckAt:0});
  ghStderr=`< X-Ratelimit-Remaining: 150\n< X-Ratelimit-Reset: ${Math.floor(Date.now()/1000)+600}\n< X-Ratelimit-Resource: graphql\n`;
  metas='c9\tthr_c9\n';
  await d.host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.ok(!d.gh.commands.some(c=>c.includes('/pull/5301')),'no retirement read with 150 points left');
  assert.deepEqual(d.removed(),[]);
 }finally{await d.host.harness.lifecycle.dispose();}
});

test('every background GitHub request, reads, discovery lookups and branch lists, counts against one hourly allowance, and a spent allowance reads nothing',async(t)=>{
 // A frozen clock: nothing refills, so a spent allowance must stay at zero requests.
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const prs=Array.from({length:100},(_,i)=>7000+i);
 const {host,store,gh}=await deck(prs);try {
  const crews=[...CREWS,...Array.from({length:20},(_,i)=>crewRow(`d${i}`,`thr_d${i}`,{providerId:null,model:null}))];
  await host.bb.storage.kv.set('crews',crews);
  host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'unavailable'}));
  const requests=()=>gh.reads+gh.commands.filter(c=>c.includes('gh pr list')).length+host.harness.sdk.callsTo('environments.pullRequest').length;
  const perCycle=[];
  for(let cycle=0;cycle<10;cycle++){
   for(const n of prs){const r=store.get(id(n));store.save({...r,nextCheckAt:0});}
   const before=requests();await host.harness.behavior.runSchedule('pr-delivery-follow-up');perCycle.push(requests()-before);
  }
  assert.ok(requests()<=500,`${requests()} background GitHub requests in one hour (${perCycle.join(',')})`);
  assert.deepEqual(perCycle.slice(-2),[0,0],'a spent allowance makes no request at all');
 }finally{await host.harness.lifecycle.dispose();}
});

test('retirement reads count against the hourly allowance and stop when it is spent',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const d=await sweepDeck();try {
  const prs=Array.from({length:100},(_,i)=>8000+i);
  for(const n of prs){const r=d.store.register({url:url(n),taskId:BUILDER,projectId:'proj_1',owner:'thr_cap',home:'/native',worker:'thr_crew',requirement:'pr'});d.store.save({...d.store.get(r.id),nextCheckAt:0});}
  for(let cycle=0;cycle<6;cycle++){for(const n of prs) d.store.save({...d.store.get(id(n)),nextCheckAt:0});await d.host.harness.behavior.runSchedule('pr-delivery-follow-up');}
  states.set(5401,'MERGED');d.deliver('c9','thr_c9',5401,'complete');metas='c9\tthr_c9\n';
  // The sweep runs once every 10 minutes; the hourly allowance is still spent 11 minutes on.
  t.mock.timers.tick(11*60_000);
  await d.host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.ok(d.gh.commands.some(c=>c.includes('/state/*.meta')),'the sweep ran again');
  assert.ok(!d.gh.commands.some(c=>c.includes('/pull/5401')),'no retirement read once the hourly allowance is spent');
 }finally{await d.host.harness.lifecycle.dispose();}
});

test('the hourly allowance is spread across the hour, and a PR the open list shows changed is read before the routine backlog',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const prs=Array.from({length:100},(_,i)=>9000+i);
 const {host,store,gh}=await deck(prs);try {
  for(const n of prs) store.save({...store.get(id(n)),nextCheckAt:Date.now()-1000});
  const perMinute=[];
  for(let minute=0;minute<5;minute++){
   const before=gh.reads,from=gh.commands.length;
   if(minute===3) store.save({...store.get(id(9099)),nextCheckAt:0});
   await host.harness.behavior.runSchedule('pr-delivery-follow-up');
   perMinute.push(gh.reads-before);
   if(minute===3) assert.ok(gh.commands.slice(from).some(c=>c.includes('gh pr view')&&c.includes('/pull/9099')),'the changed PR was read in the cycle after the change');
   t.mock.timers.tick(60_000);
  }
  assert.ok(perMinute[0]<=20,`first minute read ${perMinute[0]} of a 100-PR backlog`);
  assert.ok(perMinute.slice(1).every(n=>n<=10),`later minutes read ${perMinute.slice(1)}: more than 500/60 a minute`);
 }finally{await host.harness.lifecycle.dispose();}
});

test('concurrent PR reads reserve their GraphQL point at the request itself, so 1,002 points left allows two reads, not four',async()=>{
 const prs=Array.from({length:20},(_,i)=>9500+i);
 const {host,store,gh}=await deck(prs,{delayMs:200});try {
  await host.bb.storage.kv.set('crews',[]);
  for(const n of prs) store.save({...store.get(id(n)),nextCheckAt:0});
  probeStderr=`< X-Ratelimit-Remaining: 1002\n< X-Ratelimit-Reset: ${Math.floor(Date.now()/1000)+600}\n< X-Ratelimit-Resource: graphql\n`;
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.ok(gh.commands.some(c=>c.includes('rateLimit')),'the quota was probed');
  assert.equal(gh.reads,2,`${gh.reads} PR reads with 1,002 points left and a 1,000-point reserve`);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a late response header cannot raise the GraphQL meter: GitHub stays at or above the reserve when early reads answer last',async()=>{
 const prs=Array.from({length:20},(_,i)=>9700+i);
 const {host,store,gh}=await deck(prs);try {
  await host.bb.storage.kv.set('crews',[]);
  for(const n of prs) store.save({...store.get(id(n)),nextCheckAt:0});
  // GitHub counts a read when it serves it and reports that count; the first read of
  // each batch answers last, so its higher count arrives after lower ones.
  let github=1005,served=0;const reset=Math.floor(Date.now()/1000)+600;
  const byId=new Map();let t=0;
  host.harness.sdk.stub('terminals.create',async args=>{const tid=`late${++t}`;byId.set(tid,args.start.command);gh.commands.push(args.start.command);return{id:tid};});
  host.harness.sdk.stub('terminals.output',async({terminalId})=>{
   const command=byId.get(terminalId);let stdout='',stderr='',code=0;
   if(command.includes('rateLimit')){stdout='{}';stderr=`< X-Ratelimit-Remaining: ${github}\n< X-Ratelimit-Reset: ${reset}\n< X-Ratelimit-Resource: graphql\n`;}
   else if(command.includes('gh pr view')){gh.reads++;github--;const seen=github,order=served++;await new Promise(r=>setTimeout(r,order%4===0?600:50));
    stdout=forge(command).payload;stderr=`< X-Ratelimit-Remaining: ${seen}\n< X-Ratelimit-Reset: ${reset}\n< X-Ratelimit-Resource: graphql\n`;}
   const captured=command.includes('FM_HOST_CAPTURE_V1');
   const payload=captured?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:code,stdout,stderr}):stdout;
   return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:${captured?0:code}\n`).toString('base64')}]};
  });
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.ok(github>=1000,`GitHub ended at ${github} points after ${gh.reads} reads; the reserve is 1,000`);
 }finally{await host.harness.lifecycle.dispose();}
});
