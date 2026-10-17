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
const head=n=>heads.get(n) ?? String(n).repeat(10).slice(0,40);
const crewRow=(id,threadId,extra)=>({id,task:'x',projectId:'proj_1',threadId,parentThreadId:'thr_cap',nativeHome:'/native',worktree:true,shape:'ship',posture:'direct-PR',createdAt:'2026-10-17T00:00:00.000Z',reasoningLevel:null,dispatchVersion:2,...extra});
const CREWS=[
 crewRow(BUILDER,'thr_crew',{title:'Fix dropped Telegram messages',providerId:'claude-code',model:'claude-opus-5-5'}),
 crewRow('chk1','thr_chk',{title:'Check PR 2391',providerId:'codex',model:'gpt-6-astra',role:'checker'}),
];

function hostCommands(host,{delayMs=0}={}) {
 const byId=new Map();let n=0;const gh={inFlight:0,maxInFlight:0,reads:0};
 host.harness.sdk.stub('terminals.create',async args=>{const tid=`term${++n}`;byId.set(tid,args.start.command);return{id:tid};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{
  const command=byId.get(terminalId);const isRead=command.includes('gh pr view');
  if(isRead){gh.reads++;gh.inFlight++;gh.maxInFlight=Math.max(gh.maxInFlight,gh.inFlight);await new Promise(r=>setTimeout(r,delayMs));gh.inFlight--;}
  const out=forge(command);const captured=command.includes('FM_HOST_CAPTURE_V1');
  const payload=captured?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:out.code??0,stdout:out.payload??'',stderr:''}):out.payload??'';
  return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:${captured?0:out.code ?? 0}\n`).toString('base64')}]};
 });
 return gh;
}
function forge(command) {
 const n=Number(/\/pull\/(\d+)/.exec(command)?.[1]);
 if(command.includes('gh pr view'))return{payload:JSON.stringify({number:n,url:url(n),title:`Change ${n}`,headRefName:`fm/${BUILDER}-change-${n}`,headRefOid:head(n),state:'OPEN',isDraft:false,mergeable:'MERGEABLE',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}],reviewDecision:'APPROVED',reviews:[]})};
 return{code:0};
}
async function deck(prs,{delayMs=0}={}) {
 heads.clear();
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

test('one follow-up cycle reads every due PR, a few at a time',async()=>{
 const prs=Array.from({length:50},(_,i)=>3000+i);
 const {host,store,gh}=await deck(prs,{delayMs:20});try {
  for(const n of prs){const r=store.get(id(n));store.save({...r,nextCheckAt:0});}
  const due=()=>store.list({due:Date.now(),limit:100}).length;
  assert.equal(due(),50);
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  assert.equal(due(),0,`${due()} PRs still due after one cycle (${gh.reads} GitHub reads)`);
  assert.ok(gh.maxInFlight>1,`reads ran one at a time (${gh.maxInFlight} in flight at most)`);
  assert.ok(gh.maxInFlight<=8,`${gh.maxInFlight} GitHub reads in flight at once`);
 }finally{await host.harness.lifecycle.dispose();}
});
