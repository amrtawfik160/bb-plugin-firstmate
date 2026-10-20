import { createOwnerGate } from './lib/owner-gate.ts';
import { writeFileSync } from 'node:fs';
import { approvePr } from './test/production-approval.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost,makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries, ownerWorksHeadTap } from './lib/pr-delivery.ts';
import { createLaunches } from './lib/launch.ts';
import { createOwnerTasks } from './lib/owner-tasks.ts';
import { testEvidenceDir } from './test/approval-telegram-checkout.ts';

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

const probeEvidence = testEvidenceDir();
function observeStatusPosts(c,{failFirst=false}={}) {
 const byId=new Map();let n=0;const posts=[];
 c.host.harness.sdk.stub('terminals.create',async({start})=>{
  const id='combined'+(++n);byId.set(id,start.command);c.commands.push(start.command);
  if(start.command.includes('/statuses/'))posts.push({command:start.command,record:c.store.get(c.id)});
  return{id};
 });
 c.host.harness.sdk.stub('terminals.output',async({terminalId})=>{
  const command=byId.get(terminalId);const status=command.includes('/statuses/');
  const out=status&&failFirst&&posts.length===1?{code:1,payload:'GitHub status temporarily unavailable'}:forge(command);
  const captured=command.includes('FM_HOST_CAPTURE_V1');const payload=captured?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:out.code??0,stdout:out.payload??'',stderr:''}):out.payload??'';
  return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:${captured?0:out.code??0}\n`).toString('base64')}]};
 });
 return posts;
}
for(const failure of [false,true])test('R12 final-record status retry runs after '+(failure?'a temporary tree-read failure':'successful same-tree proof'),async()=>{
 const c=await worksTapThenMerge();try{
  const gate=createOwnerGate(c.host.bb.storage.database());gate.needStatusPost(c.id,head(130),'earlier transport failure',Date.now());
  const posts=observeStatusPosts(c);if(failure)commitTrees.set(head(130),null);observations.set(130,mergedForge());
  await deliveries(c.host,{action:'reconcile',id:c.id},'thr_cap');
  const result=c.store.get(c.id);assert.equal(posts.length,1);assert.equal(posts[0].record.status,failure?'merged-needs-verification':'complete');
  assert.equal(gate.statusPostNeeded(c.id,head(130)),false);
  assert.equal(result.verifiedCommitSha,failure?head(130):MERGE_SHA);
  writeFileSync(probeEvidence+'170-combined-'+(failure?'tree-failure':'success')+'-12.json',JSON.stringify({posts,result},null,2));
 }finally{commitTrees.clear();observations.clear();await c.host.harness.lifecycle.dispose();}
});

test('R12 a failed approval status post after proof completion retries on the next reconcile',async()=>{
 const c=await worksTapThenMerge();try{
  const gate=createOwnerGate(c.host.bb.storage.database());gate.needStatusPost(c.id,head(130),'earlier transport failure',Date.now());
  const posts=observeStatusPosts(c,{failFirst:true});observations.set(130,mergedForge());
  await deliveries(c.host,{action:'reconcile',id:c.id},'thr_cap');
  assert.equal(c.store.get(c.id).status,'complete');assert.equal(posts.length,1);assert.equal(gate.statusPostNeeded(c.id,head(130)),true);
  await deliveries(c.host,{action:'reconcile',id:c.id},'thr_cap');
  const retryStillNeeded=gate.statusPostNeeded(c.id,head(130));
  writeFileSync(probeEvidence+'170-combined-failed-status-retry-12.json',JSON.stringify({posts,retryStillNeeded,result:c.store.get(c.id),retryRows:c.host.bb.storage.database().prepare('SELECT * FROM production_status_retry').all()},null,2));
  assert.equal(posts.length,2,'completed same-tree proof suppresses the pending status retry');
  assert.equal(retryStillNeeded,false);
 }finally{commitTrees.clear();observations.clear();await c.host.harness.lifecycle.dispose();}
});
