import { approvePr } from './test/production-approval.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost,makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries, ownerWorksHeadTap } from './lib/pr-delivery.ts';
import { createLaunches } from './lib/launch.ts';
import { createOwnerTasks } from './lib/owner-tasks.ts';
import { createOwnerAsks } from './lib/owner-asks.ts';

process.env.FM_MERGEABLE_POLL_MS='0';

// Owner decisions Q5 and Q6 (17 Oct). The 15-17 Oct audit: four Dr Woo crews recorded proof
// from web runs while the owner found three iPhone failures; #2523 and dr.woo#124 were
// "verified" by the captain himself; Safi builds 17-21 skipped the "Beta Testers" group.
const ctx={threadId:'thr_cap',projectId:'proj_1'};
const WOO='amrtawfik160/dr.woo';
const CYN='Cyndra-AI/cyndra-saas';
const SAFI='amrtawfik160/Safi';
const url=(repo,n)=>`https://github.com/${repo}/pull/${n}`;
const key=(repo,n)=>`${repo.toLowerCase()}#${n}`;
const head=n=>String(n).repeat(40).slice(0,40);
const crewRow=(id,threadId,extra)=>({id,task:'x',projectId:'proj_1',threadId,parentThreadId:'thr_cap',nativeHome:'/native',worktree:true,shape:'ship',posture:'direct-PR',createdAt:'2026-10-17T00:00:00.000Z',reasoningLevel:null,playbook:'babysit',...extra});
const CREWS=[
 crewRow('woo1','thr_woo',{title:'Fix the photo upload',providerId:'claude-code',model:'claude-opus-5-5'}),
 crewRow('cyn1','thr_cyn',{title:'Fix the Gmail trigger',providerId:'claude-code',model:'claude-opus-5-5'}),
 crewRow('safi1','thr_safi',{title:'Ship build 21',providerId:'claude-code',model:'claude-opus-5-5'}),
 crewRow('chk1','thr_chk',{title:'Check the PR',providerId:'codex',model:'gpt-6-astra',role:'checker'}),
 crewRow('frm1','thr_frm',{title:'Fix the frame export',providerId:'claude-code',model:'claude-opus-5-5'}),
 crewRow('woo2','thr_woo2',{title:'Older Dr Woo change',providerId:'claude-code',model:'claude-opus-5-5'}),
 crewRow('woo3','thr_woo3',{title:'Dr Woo change first seen early',providerId:'claude-code',model:'claude-opus-5-5'}),
 crewRow('woo4','thr_woo4',{title:'Dr Woo change GitHub dated early',providerId:'claude-code',model:'claude-opus-5-5'}),
];
const FRAMED='amrtawfik160/framed';
const PRS=[[WOO,130,'woo1','thr_woo'],[CYN,2523,'cyn1','thr_cyn'],[SAFI,77,'safi1','thr_safi'],[FRAMED,5,'frm1','thr_frm'],[WOO,111,'woo2','thr_woo2'],[WOO,112,'woo3','thr_woo3'],[WOO,113,'woo4','thr_woo4']];
// dr.woo#111 was opened before the strict proof gate went live (owner decision, 18 Oct: option A).
const OPENED={111:'2026-10-10T09:00:00Z'};
const repoOfNumber=n=>PRS.find(p=>p[1]===n)[0];

function hostCommands(host,nativeWorker) {
 const commands=[];const byId=new Map();let n=0;
 host.harness.sdk.stub('terminals.create',async args=>{const tid=`term${++n}`;byId.set(tid,args.start.command);commands.push(args.start.command);return{id:tid};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{const command=byId.get(terminalId);const out=nativeWorker && command.includes("^bb_thread_id=") ? {payload:nativeWorker} : forge(command);const captured=command.includes('FM_HOST_CAPTURE_V1');const payload=captured?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:out.code??0,stdout:out.payload??'',stderr:''}):out.payload??'';return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:${captured?0:out.code ?? 0}\n`).toString('base64')}]};});
 return commands;
}
const MERGE_SHA='ab73ad9242afa06ac55dcb74e279674578d65534';
const SAME_TREE='dcb1515659f1bed7f18973876fedd95f442c18da';
const OTHER_TREE='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** Tests set a commit sha to a tree sha, or null to fail the GitHub read. */
const commitTrees=new Map();
const observations=new Map();
function forge(command) {
 const git=/\/git\/commits\/([0-9a-f]+)/i.exec(command);
 if(git){
  const sha=git[1];
  const hit=[...commitTrees.entries()].find(([k])=>k.toLowerCase().startsWith(sha.toLowerCase())||sha.toLowerCase().startsWith(k.toLowerCase()));
  if(hit&&hit[1]===null)return{code:1,payload:`Not Found: commit ${sha}`};
  return{payload:hit?hit[1]:SAME_TREE};
 }
 const n=Number(/\/pull\/(\d+)/.exec(command)?.[1]);
 if(command.includes('fm-pr-merge.sh'))return{payload:`verified: ${url(repoOfNumber(n),n)} is merged (state=MERGED, merged=true, isInMergeQueue=false)`};
 if(command.includes('gh pr checks'))return{code:0,payload:JSON.stringify([{name:'build',bucket:'pass'}])};
 if(command.includes('gh pr view') && observations.has(n)) return {payload:JSON.stringify(observations.get(n))};
 if(command.includes('gh pr view')){const crew=PRS.find(p=>p[1]===n)[2];return{payload:JSON.stringify({number:n,url:url(repoOfNumber(n),n),title:`Change ${n}`,headRefName:`fm/${crew}-change-${n}`,headRefOid:head(n),state:'OPEN',mergeable:'MERGEABLE',files:[{path:'app/screens/upload.tsx'}],...(OPENED[n]?{createdAt:OPENED[n]}:{})})};}
 return{code:0};
}
async function deck({nativeWorker,requirement="merged"}={}) {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain'],settings:{fmHome:'/native',fmHostId:'host_1'}});
 await host.bb.storage.kv.set('captain-project:thr_cap','proj_1');
 await plugin(host.bb);
 await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: 'on', telegramThreading: 'on' }) });
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>threadId==='thr_cap'?{captain:'true'}:{});
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:`env_${threadId}`}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('environments.get',async({environmentId})=>{const crew=CREWS.find(c=>`env_${c.threadId}`===environmentId);const pr=PRS.find(p=>p[2]===crew?.id);return{id:environmentId,hostId:'host_1',status:'ready',isWorktree:true,path:'/wt',branchName:`fm/${crew?.id}-change-${pr?.[1]}`};});
 // Retirement inspects the crew worktree first; these are clean.
 host.harness.sdk.stub('environments.diffFiles',async()=>({files:[]}));
 host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'unavailable'}));
 host.harness.sdk.stub('threads.output',async()=>({output:'DONE: PR open'}));
 host.harness.sdk.stub('threads.events.list',async()=>[]);
 host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));
 host.harness.sdk.stub('projects.get',async()=>({id:'proj_1',name:'woo-app',kind:'repo'}));
 const rpc=[];
 // The connector records the owner's own taps; ownerAnswer reads them back.
 const ownerTaps=new Map();
 host.harness.sdk.stub('plugins.callRpc',async(call)=>{rpc.push(call);if(call.method==='ownerAnswer')return{answer:ownerTaps.get(call.input.askId)??null};return{ok:true,queued:1,duplicate:false};});
 host.harness.sdk.stub('files.read',async()=>{throw new Error('ENOENT');});
 await host.bb.storage.kv.set('crews',CREWS.map(c=>({...c,deliveryRequirement:requirement})));
 const store=createDeliveries(host.bb.storage.database());
 for(const [repo,n,crew,thread] of PRS){
  approvePr(host.bb.storage.database(),'thr_cap',key(repo,n),head(n));
  const r=store.register({url:url(repo,n),taskId:crew,projectId:'proj_1',owner:'thr_cap',home:'/native',worker:thread,requirement,title:`Change ${n}`});
  store.observe(r.id,{headSha:head(n),state:'open',draft:false,checks:'passing',review:'approved',reviewHeadSha:head(n),mergeCommitSha:null,mergeable:'mergeable',...(OPENED[n]?{openedAt:Date.parse(OPENED[n])}:{})},true);
 }
 const tap=async(id,answer)=>{ownerTaps.set(id,answer);return host.harness.behavior.callRpc('resolveAsk',{threadId:'thr_cap',id,resolution:answer});};
 return {host,store,rpc,tap,commands:hostCommands(host,nativeWorker)};
}
const tool=(host,name)=>host.harness.inspection.registrations.agentTools.find(t=>t.name===name);
const text=out=>typeof out==='string'?out:out?.content?.[0]?.text ?? JSON.stringify(out);
const merges=commands=>commands.filter(c=>c.includes('fm-pr-merge.sh'));
const deliveries=(host,input,as)=>tool(host,'firstmate_deliveries').execute(input,{threadId:as,projectId:'proj_1'});
const verify=(host,repo,n,as,surface)=>deliveries(host,{action:'verify',id:key(repo,n),commitSha:head(n).slice(0,7),driven:'opened the upload screen and sent a photo',seen:'the photo arrived',...(surface?{surface}:{})},as);
const check=(host,repo,n)=>deliveries(host,{action:'check',id:key(repo,n),commitSha:head(n).slice(0,7),verdict:'pass',notes:'read the diff; ran the upload flow'},'thr_chk');
const merge=(host,crewId,pr,extra={})=>tool(host,'firstmate_merge').execute({crewId,yes:true,pr,...extra},ctx);

const mergeObs=(headSha,mergeSha)=>({headSha,state:'merged',draft:false,checks:'passing',review:'approved',reviewHeadSha:headSha,mergeCommitSha:mergeSha,mergeable:'mergeable'});
async function worksTapThenMerge() {
 const ctx=await deck({requirement:'merged-and-verified'});
 const id=key(WOO,130);
 const asked=text(await deliveries(ctx.host,{action:'device-proof',id,commitSha:head(130).slice(0,7),build:'6',link:'https://testflight.apple.com/join/abc',check:'Send a photo'},'thr_woo'));
 const askId=/card (a[0-9a-z]{6})/.exec(asked)?.[1];
 assert.ok(askId,asked);
 await ctx.tap(askId,'Works');
 assert.equal(ctx.store.get(id).verifiedCommitSha,head(130));
 ctx.store.observe(id,mergeObs(head(130),MERGE_SHA),true);
 assert.equal(ctx.store.get(id).status,'merged-needs-verification');
 return {...ctx,id};
}


const treesRead = commands => commands.filter(c=>c.includes('/git/commits/'));
const verifyMerge = (host,id,sha=MERGE_SHA) => deliveries(host,{action:'verify',id,commitSha:sha},'thr_cap');
async function proofCard(ctx) {
 const id=key(WOO,130);
 const out=text(await deliveries(ctx.host,{action:'device-proof',id,commitSha:head(130),build:'probe',link:'https://example.com/probe',check:'Send a photo'},'thr_woo'));
 return /card (a[0-9a-z]{6})/.exec(out)[1];
}
function mergedForge(h=head(130)) {
 return {headRefOid:h,state:'MERGED',isDraft:false,mergeable:'MERGEABLE',mergeCommit:{oid:MERGE_SHA},reviewDecision:'APPROVED',statusCheckRollup:[],createdAt:'2026-10-19T00:00:00Z'};
}

function pauseTrees(c) {
 const commands=new Map();let n=0,release,entered;
 const gate=new Promise(r=>release=r), started=new Promise(r=>entered=r);
 c.host.harness.sdk.stub('terminals.create',async args=>{const id=`probe${++n}`;commands.set(id,args.start.command);c.commands.push(args.start.command);return{id};});
 c.host.harness.sdk.stub('terminals.output',async({terminalId})=>{
  const command=commands.get(terminalId);
  if(command.includes('/git/commits/')){entered();await gate;}
  const out=forge(command),captured=command.includes('FM_HOST_CAPTURE_V1');
  const payload=captured?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:out.code??0,stdout:out.payload??'',stderr:''}):out.payload??'';
  return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:${captured?0:out.code??0}\n`).toString('base64')}]};
 });
 return {release,started};
}
test('round2: cancellation during late-tap tree read must prevent proof',{timeout:10000},async()=>{
 const c=await deck({requirement:'merged-and-verified'});let paused,pending;
 try {
  const ask=await proofCard(c),id=key(WOO,130);
  c.store.observe(id,mergeObs(head(130),MERGE_SHA),true);
  const before=c.store.get(id);
  paused=pauseTrees(c);
  pending=c.tap(ask,'Works');
  await paused.started;
  const out=text(await tool(c.host,'firstmate_resolve_ask').execute({id:ask,resolution:'Build replaced',cancelled:true},ctx));
  assert.doesNotMatch(out,/Refusing/);
  assert.equal(await c.host.bb.storage.kv.get(`device-proof:${ask}`),undefined);
  paused.release();await pending;
  assert.deepEqual(c.store.get(id),before,'a cancelled card must not promote proof after the tree response');
 } finally {paused?.release();await pending?.catch(()=>{});await c.host.harness.lifecycle.dispose();}
});
for(const mode of ['different','first-fails','second-fails','unreadable'])test(`round2: late ${mode} refusal preserves the delivery`,async()=>{
 const c=await deck({requirement:'merged-and-verified'});
 try{
  const ask=await proofCard(c),id=key(WOO,130);
  c.store.observe(id,mergeObs(head(130),MERGE_SHA),true);
  commitTrees.set(head(130),mode==='first-fails'?null:mode==='unreadable'?'short-tree':SAME_TREE);
  commitTrees.set(MERGE_SHA,mode==='second-fails'?null:OTHER_TREE);
  const before=c.store.get(id);
  await c.tap(ask,'Works');
  assert.deepEqual(c.store.get(id),before);
 }finally{commitTrees.clear();await c.host.harness.lifecycle.dispose();}
});
test('round2: late same-tree tap preserves the actual tapped head',async()=>{
 const c=await deck({requirement:'merged-and-verified'});
 try{
  const ask=await proofCard(c),id=key(WOO,130);
  c.store.observe(id,mergeObs(head(130),MERGE_SHA),true);
  await c.tap(ask,'Works');
  const r=c.store.get(id);
  assert.equal(r.status,'complete');
  assert.equal(r.verification.tappedCommitSha,head(130));
  assert.equal(r.verification.commitSha,MERGE_SHA);
  assert.equal(r.verification.treeSha,SAME_TREE);
  assert.equal(r.verification.treesMatched,true);
 }finally{await c.host.harness.lifecycle.dispose();}
});
test('round2: overlapping verification of two PRs shares in-flight commit reads',{timeout:10000},async()=>{
 const c=await worksTapThenMerge();let paused,p1,p2;
 try{
  const other=key(WOO,111);
  c.store.observe(other,{...mergeObs(head(130),null),state:'open'},true);
  const asked=text(await deliveries(c.host,{action:'device-proof',id:other,commitSha:head(130),build:'other',link:'https://example.com/other',check:'Send photo'},'thr_woo2'));
  const ask=/card (a[0-9a-z]{6})/.exec(asked)[1];
  await c.tap(ask,'Works');
  c.store.observe(other,mergeObs(head(130),MERGE_SHA),true);
  paused=pauseTrees(c);
  p1=verifyMerge(c.host,c.id);await paused.started;
  p2=verifyMerge(c.host,other);
  await new Promise(r=>setTimeout(r,50));
  paused.release();await Promise.all([p1,p2]);
  assert.equal(c.store.get(c.id).status,'complete');
  assert.equal(c.store.get(other).status,'complete');
  assert.equal(treesRead(c.commands).length,2);
 }finally{paused?.release();await Promise.allSettled([p1,p2].filter(Boolean));await c.host.harness.lifecycle.dispose();}
});
test('round2: failed commit read retries after the bounded cooldown',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const c=await worksTapThenMerge();
 try{
  commitTrees.set(head(130),null);
  assert.match(text(await verifyMerge(c.host,c.id)),/Refusing/);
  assert.equal(treesRead(c.commands).length,1);
  assert.match(text(await verifyMerge(c.host,c.id)),/Refusing/);
  assert.equal(treesRead(c.commands).length,1);
  t.mock.timers.tick(60001);commitTrees.set(head(130),SAME_TREE);
  assert.doesNotMatch(text(await verifyMerge(c.host,c.id)),/Refusing/);
  assert.equal(c.store.get(c.id).status,'complete');
  assert.equal(treesRead(c.commands).length,3);
 }finally{commitTrees.clear();await c.host.harness.lifecycle.dispose();}
});

test('round2: correcting Works during the tree read must prevent proof',{timeout:10000},async()=>{
 const c=await deck({requirement:'merged-and-verified'});let paused,pending,correction;
 try {
  const ask=await proofCard(c),id=key(WOO,130);
  c.store.observe(id,mergeObs(head(130),MERGE_SHA),true);
  const before=c.store.get(id);
  paused=pauseTrees(c);pending=c.tap(ask,'Works');await paused.started;
  const reopened=text(await tool(c.host,'firstmate_resolve_ask').execute({id:ask,reopen:true,resolution:'Correction'},ctx));
  assert.doesNotMatch(reopened,/Refusing/);
  correction=c.tap(ask,'Does not work');
  const asks=createOwnerAsks(c.host.bb.storage.database());
  for(let i=0;i<50&&asks.get(ask)?.resolution!=='Does not work';i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(asks.get(ask)?.resolution,'Does not work');
  paused.release();await Promise.all([pending,correction]);
  assert.deepEqual(c.store.get(id),before,'a corrected answer must not promote the earlier Works after its tree response');
 } finally {paused?.release();await Promise.allSettled([pending,correction].filter(Boolean));await c.host.harness.lifecycle.dispose();}
});

test('round2: a transient late-tree failure retains durable proof work for retry',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const c=await deck({requirement:'merged-and-verified'});
 try {
  const ask=await proofCard(c),id=key(WOO,130);
  c.store.observe(id,mergeObs(head(130),MERGE_SHA),true);
  const before=c.store.get(id);
  commitTrees.set(head(130),null);
  await c.tap(ask,'Works');
  assert.deepEqual(c.store.get(id),before);
  const bound=await c.host.bb.storage.kv.get(`device-proof:${ask}`);
  const pending=createOwnerAsks(c.host.bb.storage.database()).pendingFollowUps().filter(job=>job.askId===ask&&job.effect==='owner-answered');
  t.mock.timers.tick(60001);commitTrees.set(head(130),SAME_TREE);
  await c.tap(ask,'Works');
  assert.equal(c.store.get(id).status,'complete',`binding retained=${bound!==undefined}; pending proof jobs=${pending.length}; replay after GitHub recovery left ${c.store.get(id).status}`);
 } finally {commitTrees.clear();await c.host.harness.lifecycle.dispose();}
});
