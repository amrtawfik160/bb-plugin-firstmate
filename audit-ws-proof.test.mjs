import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost,makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries } from './lib/pr-delivery.ts';

process.env.FM_MERGEABLE_POLL_MS='0';

// Owner decisions Q4 and Q8 (16-17 Oct): a code PR needs its report's proof step before
// its verification record, and a PR that reaches production needs a pass verdict from a
// checker crew on a different model before it merges.
const BUILDER='9ceeb10f';
const ctx={threadId:'thr_cap',projectId:'proj_1'};
const url=n=>`https://github.com/Cyndra-AI/cyndra-saas/pull/${n}`;
const id=n=>`cyndra-ai/cyndra-saas#${n}`;
const heads=new Map();
const head=n=>heads.get(n) ?? String(n).repeat(10).slice(0,40);
const FILES={2391:['apps/web/src/telegram.ts','apps/web/src/telegram.test.ts'],2392:['docs/runbook.md']};
// dispatchVersion 2: dispatched under the code pipeline and checker rule. A crew without it keeps the old rules.
const crewRow=(id,threadId,extra)=>({id,task:'x',projectId:'proj_1',threadId,parentThreadId:'thr_cap',nativeHome:'/native',worktree:true,shape:'ship',posture:'direct-PR',createdAt:'2026-10-17T00:00:00.000Z',reasoningLevel:null,dispatchVersion:2,...extra});
const CREWS=[
 crewRow(BUILDER,'thr_crew',{title:'Fix dropped Telegram messages',providerId:'claude-code',model:'claude-opus-5-5'}),
 crewRow('chk1','thr_chk',{title:'Check PR 2391',providerId:'codex',model:'gpt-6-astra',role:'checker'}),
 crewRow('chk2','thr_chk2',{title:'Check PR 2391 again',providerId:'claude-code',model:'claude-opus-5-5',role:'checker'}),
];
const PROVEN_LINES=[
 '✓ P1 Diagnose: the inbox ack ran before the write',
 '✓ P2 Failing test: keeps an unwritten message (commit abc1234)',
 '✓ P3 Fix at the root: ack after the write (commit def5678)',
 `✓ P4 Prove on the real surface for cyndra-ai/cyndra-saas#2391 at ${'2391'.repeat(10).slice(0,7)}: driven a message to the staging bot across a restart; seen it answered after the restart`,
 '✓ P5 Blast radius: the reply path shares the ack; its test passes',
 '✓ P6 No comments: none',
 '✓ P7 PR: '+url(2391),
];
const PROVEN=PROVEN_LINES.join('\n');

function hostCommands(host) {
 const commands=[];const byId=new Map();let n=0;
 host.harness.sdk.stub('terminals.create',async args=>{const tid=`term${++n}`;byId.set(tid,args.start.command);commands.push(args.start.command);return{id:tid};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{const command=byId.get(terminalId);const out=forge(command);const captured=command.includes('FM_HOST_CAPTURE_V1');const payload=captured?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:out.code??0,stdout:out.payload??'',stderr:''}):out.payload??'';return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:${captured?0:out.code ?? 0}\n`).toString('base64')}]};});
 return commands;
}
function forge(command) {
 const n=Number(/\/pull\/(\d+)/.exec(command)?.[1]);
 if(command.includes('fm-pr-merge.sh'))return{payload:`verified: ${url(n)} is merged (state=MERGED, merged=true, isInMergeQueue=false)`};
 if(command.includes('gh pr checks'))return{code:0,payload:JSON.stringify([{name:'build',bucket:'pass'}])};
 if(command.includes('gh pr view'))return{payload:JSON.stringify({number:n,url:url(n),title:`Change ${n}`,headRefName:`fm/${BUILDER}-change-${n}`,headRefOid:head(n),state:'OPEN',mergeable:'MERGEABLE',files:(FILES[n]??[]).map(path=>({path}))})};
 return{code:0};
}
async function deck({report=PROVEN,crews=CREWS,files={},output='DONE: PR open'}={}) {
 heads.clear();
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain'],settings:{fmHome:'/native',fmHostId:'host_1'}});await plugin(host.bb);
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('environments.get',async()=>({id:'env_wt',hostId:'host_1',status:'ready',isWorktree:true,path:'/wt',branchName:`fm/${BUILDER}-change-2391`}));
 host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'unavailable'}));
 host.harness.sdk.stub('threads.output',async()=>({output}));
 host.harness.sdk.stub('threads.events.list',async()=>[]);
 host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));
 const reads=[];
 const disk={...(report===null?{}:{'report.md':report}),...files};
 host.harness.sdk.stub('files.read',async({path})=>{reads.push(path);if(disk[path]!==undefined)return{content:disk[path]};const name=path.startsWith(`/native/data/${BUILDER}/`)?path.slice(`/native/data/${BUILDER}/`.length):'';if(disk[name]!==undefined)return{content:disk[name]};throw new Error('ENOENT');});
 await host.bb.storage.kv.set('crews',crews);
 const store=createDeliveries(host.bb.storage.database());
 for(const n of [2391,2392]){
  const r=store.register({url:url(n),taskId:BUILDER,projectId:'proj_1',owner:'thr_cap',home:'/native',worker:'thr_crew',requirement:'merged',title:`Change ${n}`});
  store.observe(r.id,{headSha:head(n),state:'open',draft:false,checks:'passing',review:'approved',reviewHeadSha:head(n),mergeCommitSha:null,mergeable:'mergeable'},true);
 }
 return {host,store,reads,commands:hostCommands(host)};
}
const tool=(host,name)=>host.harness.inspection.registrations.agentTools.find(t=>t.name===name);
const text=out=>typeof out==='string'?out:out?.content?.[0]?.text ?? JSON.stringify(out);
const merges=commands=>commands.filter(c=>c.includes('fm-pr-merge.sh'));
// Owner decisions Q5 and Q6: the crew records verification, from the project's proof surface (Cyndra: the web page).
const verify=(host,n,as='thr_crew')=>tool(host,'firstmate_deliveries').execute({action:'verify',id:id(n),commitSha:head(n).slice(0,7),driven:'a message to the staging bot across a restart',seen:'it was answered',surface:'web'},{threadId:as,projectId:'proj_1'});
const check=(host,n,as,verdict='pass',findings)=>tool(host,'firstmate_deliveries').execute({action:'check',id:id(n),commitSha:head(n).slice(0,7),verdict,findings,notes:'read the diff; drove a restart on staging; the message was answered'},{threadId:as,projectId:'proj_1'});


test('checker: ordinary pipeline proof is recordable',async()=>{
 const {host,store}=await deck();try{
 const result=text(await verify(host,2391));
 assert.equal(store.get(id(2391)).verifiedCommitSha,head(2391),result);
 }finally{await host.harness.lifecycle.dispose();}
});
test('checker: workstream pipeline proof is recordable from its report',async()=>{
 const {host,store}=await deck({crews:CREWS.map(c=>c.id===BUILDER?{...c,workstreamId:'ws-audit',worktree:false}:c)});try{
 const result=text(await verify(host,2391));console.log('OBSERVED_WORKSTREAM_PROOF',result);
 assert.equal(store.get(id(2391)).verifiedCommitSha,head(2391),result);
 }finally{await host.harness.lifecycle.dispose();}
});


test('workstream verification reads only the persisted report directory named in its brief',async()=>{
 const reportDir='/reports/ws-audit/builder';
 const {host,store,reads}=await deck({report:null,files:{[`${reportDir}/report.md`]:PROVEN},crews:CREWS.map(c=>c.id===BUILDER?{...c,workstreamId:'ws-audit',worktree:false,reportDir}:c)});
 try {
  const result=text(await verify(host,2391));
  assert.equal(store.get(id(2391)).verifiedCommitSha,head(2391),result);
  assert.ok(reads.includes(`${reportDir}/report.md`));
  assert.ok(!reads.includes(`/native/data/${BUILDER}/report.md`));
 }finally{await host.harness.lifecycle.dispose();}
});

for(const [name,report,files] of [
 ['missing report despite proof in chat',null,{}],
 ['proof only in final-report.md',null,{'final-report.md':PROVEN}],
 ['proof for another head',PROVEN.replace('at 2391239:', 'at aaaaaaa:'),{}],
])test(`workstream verification keeps surface-proof gate: ${name}`,async()=>{
 const {host,store}=await deck({report,files,output:PROVEN,crews:CREWS.map(c=>c.id===BUILDER?{...c,workstreamId:'ws-audit',worktree:false}:c)});
 try {
  assert.match(text(await verify(host,2391)),/Refusing to record verification/);
  assert.equal(store.get(id(2391)).verifiedCommitSha,null);
 }finally{await host.harness.lifecycle.dispose();}
});
