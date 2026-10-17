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
 const disk={...(report===null?{}:{'report.md':report}),...files};
 host.harness.sdk.stub('files.read',async({path})=>{const name=path.startsWith(`/native/data/${BUILDER}/`)?path.slice(`/native/data/${BUILDER}/`.length):'';if(disk[name]!==undefined)return{content:disk[name]};throw new Error('ENOENT');});
 await host.bb.storage.kv.set('crews',crews);
 const store=createDeliveries(host.bb.storage.database());
 for(const n of [2391,2392]){
  const r=store.register({url:url(n),taskId:BUILDER,projectId:'proj_1',owner:'thr_cap',home:'/native',worker:'thr_crew',requirement:'merged',title:`Change ${n}`});
  store.observe(r.id,{headSha:head(n),state:'open',draft:false,checks:'passing',review:'approved',reviewHeadSha:head(n),mergeCommitSha:null,mergeable:'mergeable'},true);
 }
 return {host,store,commands:hostCommands(host)};
}
const tool=(host,name)=>host.harness.inspection.registrations.agentTools.find(t=>t.name===name);
const text=out=>typeof out==='string'?out:out?.content?.[0]?.text ?? JSON.stringify(out);
const merges=commands=>commands.filter(c=>c.includes('fm-pr-merge.sh'));
// Owner decisions Q5 and Q6: the crew records verification, from the project's proof surface (Cyndra: the web page).
const verify=(host,n,as='thr_crew')=>tool(host,'firstmate_deliveries').execute({action:'verify',id:id(n),commitSha:head(n).slice(0,7),driven:'a message to the staging bot across a restart',seen:'it was answered',surface:'web'},{threadId:as,projectId:'proj_1'});
const check=(host,n,as,verdict='pass',findings)=>tool(host,'firstmate_deliveries').execute({action:'check',id:id(n),commitSha:head(n).slice(0,7),verdict,findings,notes:'read the diff; drove a restart on staging; the message was answered'},{threadId:as,projectId:'proj_1'});

test('verify refuses a bug-fix PR whose crew report has no proof step, and records it once the report has one',async()=>{
 const {host,store}=await deck({report:PROVEN.replace(/^✓ P4 .*$/m,'pending: P4 Prove on the real surface: waiting on CI')});try {
  const refused=text(await verify(host,2391));
  assert.match(refused,/^(?:Error: )?Refusing to record verification for cyndra-ai\/cyndra-saas#2391: crew 9ceeb10f's report has its proof step pending: "P4 Prove on the real surface: waiting on CI"\./);
  assert.match(refused,/✓ P4 Prove on the real surface for cyndra-ai\/cyndra-saas#2391 at 2391239: driven <what>; seen <what>/);
  assert.equal(store.get(id(2391)).verifiedCommitSha,null);
  // The weekly scorecard counts this refused claim once, however often verification is tried.
  await verify(host,2391);
  const card=await host.harness.behavior.runCli(['scorecard','--json'],ctx);
  assert.equal(card.exitCode,0,card.stderr);
  assert.deepEqual(JSON.parse(card.stdout).unproven.map(u=>[u.pr,u.crew,u.run]),[[id(2391),BUILDER,'thr_crew']]);
 }finally{await host.harness.lifecycle.dispose();}
 const ok=await deck();try {
  text(await verify(ok.host,2391));
  assert.equal(ok.store.get(id(2391)).verifiedCommitSha,head(2391));
 }finally{await ok.host.harness.lifecycle.dispose();}
});

test('a missing report refuses verification too',async()=>{
 const {host,store}=await deck({report:null});try {
  assert.match(text(await verify(host,2391)),/report has its proof step missing: no "✓ P4 Prove on the real surface" line/);
  assert.equal(store.get(id(2391)).verifiedCommitSha,null);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a checker verdict is refused from the builder and from a crew on the builder model',async()=>{
 const {host,store}=await deck();try {
  assert.match(text(await check(host,2391,'thr_crew')),/^(?:Error: )?Refusing: crew 9ceeb10f built cyndra-ai\/cyndra-saas#2391, so it cannot check it\. A checker is another crew on a different model\./);
  assert.match(text(await check(host,2391,'thr_chk2')),/^(?:Error: )?Refusing: checker crew chk2 runs claude-opus-5-5, the same model as builder crew 9ceeb10f\. Dispatch the checker on a different model\./);
  assert.match(text(await check(host,2391,'thr_cap')),/^(?:Error: )?Refusing: only a checker crew records a verdict/);
  assert.equal(store.get(id(2391)).check ?? null,null);
  text(await check(host,2391,'thr_chk'));
  const recorded=store.get(id(2391)).check;
  assert.deepEqual({...recorded,at:0},{verdict:'pass',commitSha:head(2391),crewId:'chk1',providerId:'codex',model:'gpt-6-astra',notes:'read the diff; drove a restart on staging; the message was answered',at:0});
 }finally{await host.harness.lifecycle.dispose();}
});

test('a production PR is refused without a pass verdict for its head, and merges with one',async()=>{
 const {host,commands}=await deck();try {
  text(await verify(host,2391));
  const none=text(await tool(host,'firstmate_merge').execute({crewId:BUILDER,yes:true,pr:2391},ctx));
  assert.match(none,/^Refusing: #2391 reaches production \(Cyndra-AI\/cyndra-saas is not listed as internal, and apps\/web\/src\/telegram\.ts is not an internal path\) and has no checker verdict for its head 2391239; nothing was merged\./);
  assert.match(none,/firstmate_dispatch role=checker/);
  const preview=text(await tool(host,'firstmate_merge').execute({crewId:BUILDER,pr:2391},ctx));
  assert.match(preview,/Checker: none for the current head; #2391 reaches production/);
  text(await check(host,2391,'thr_chk','fail'));
  assert.match(text(await tool(host,'firstmate_merge').execute({crewId:BUILDER,yes:true,pr:2391},ctx)),/^Refusing: checker crew chk1 \(gpt-6-astra\) gave #2391 a fail verdict at 2391239: read the diff/);
  assert.deepEqual(merges(commands),[]);
  text(await check(host,2391,'thr_chk'));
  const merged=text(await tool(host,'firstmate_merge').execute({crewId:BUILDER,yes:true,pr:2391},ctx));
  assert.match(merged,/^Merged #2391 Change 2391\n/);
  assert.match(merged,/Checked: crew chk1 \(gpt-6-astra\) passed head 2391239\./);
  assert.equal(merges(commands).length,1);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a checker verdict for an older head does not cover a new push',async()=>{
 const {host,commands,store}=await deck({report:`${PROVEN}\n✓ P4 Prove on the real surface for cyndra-ai/cyndra-saas#2391 at eeeeeee: driven the bot after the new push; seen it answered`});try {
  text(await check(host,2391,'thr_chk'));
  heads.set(2391,'e'.repeat(40));
  store.observe(id(2391),{headSha:head(2391),state:'open',draft:false,checks:'passing',review:'approved',reviewHeadSha:head(2391),mergeCommitSha:null,mergeable:'mergeable'},true);
  text(await verify(host,2391));
  assert.match(text(await tool(host,'firstmate_merge').execute({crewId:BUILDER,yes:true,pr:2391},ctx)),/has no checker verdict for its head eeeeeee/);
  assert.deepEqual(merges(commands),[]);
 }finally{await host.harness.lifecycle.dispose();}
});

test('an internal PR (docs only) self-checks and merges without a checker',async()=>{
 const {host,commands}=await deck({report:`${PROVEN}\n✓ P4 Prove on the real surface for cyndra-ai/cyndra-saas#2392 at ${head(2392).slice(0,7)}: driven the runbook page; seen the new section`});try {
  text(await verify(host,2392));
  const merged=text(await tool(host,'firstmate_merge').execute({crewId:BUILDER,yes:true,pr:2392},ctx));
  assert.match(merged,/^Merged #2392 Change 2392\n/);
  assert.doesNotMatch(merged,/Checked:/);
  assert.equal(merges(commands).length,1);
 }finally{await host.harness.lifecycle.dispose();}
});

async function dispatchHost() {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain']});await plugin(host.bb);
 host.harness.sdk.stub('threadSections.list',async()=>[]);
 host.harness.sdk.stub('threadSections.create',async()=>({id:'sec_crews'}));
 host.harness.sdk.stub('environments.list',async()=>[{hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('threads.spawn',async()=>({id:'thr_new'}));
 host.harness.sdk.stub('threads.get',async()=>makeThreadResponse({id:'thr_new',status:'starting'}));
 host.harness.sdk.stub('providers.list',async()=>[{id:'claude-code',available:true},{id:'codex',available:true},{id:'acp-grok',available:true}]);
 const catalog={'claude-code':['claude-opus-5-5','claude-haiku-5-5','claude-sonnet-5-5'],codex:['gpt-6.1-sol','gpt-6-astra'],'acp-grok':['grok-4.7','grok-4.6']};
 host.harness.sdk.stub('providers.models',async({providerId})=>({modelLoadError:null,models:(catalog[providerId]??[]).map(m=>({id:m,model:m}))}));
 return host;
}
const spawned=host=>host.harness.sdk.callsTo('threads.spawn').map(([args])=>({providerId:args.providerId,model:args.model,reasoningLevel:args.reasoningLevel}));

test('dispatch gives each role its default model, and an owner-named model applies to that crew only',async()=>{
 const host=await dispatchHost();try {
  for(const [args,want] of [
   [{task:'fix login'},{providerId:'claude-code',model:'claude-opus-5-5'}],
   [{task:'check PR 9',role:'checker'},{providerId:'codex',model:'gpt-6-astra'}],
   [{task:'what node version does the repo pin',role:'lookup',shape:'scout'},{providerId:'claude-code',model:'claude-haiku-5-5'}],
   [{task:'fix login logic',providerId:'acp-grok',model:'grok-4.6',reasoningLevel:'xhigh'},{providerId:'acp-grok',model:'grok-4.6',reasoningLevel:'xhigh'}],
   [{task:'fix login again'},{providerId:'claude-code',model:'claude-opus-5-5'}],
  ]){
   const out=await tool(host,'firstmate_dispatch').execute({projectId:'proj_1',...args},{projectId:'proj_1'});
   assert.doesNotMatch(text(out),/Refus|Unknown|FAILED/,text(out));
   const last=spawned(host).at(-1);
   assert.deepEqual({providerId:last.providerId,model:last.model,...(want.reasoningLevel?{reasoningLevel:last.reasoningLevel}:{})},want,args.task);
  }
  const cli=await host.harness.behavior.runCli(['dispatch','--project','proj_1','--role','checker','--','check PR 10'],{projectId:'proj_1'});
  assert.equal(cli.exitCode,0,cli.stderr);
  assert.deepEqual(spawned(host).at(-1),{providerId:'codex',model:'gpt-6-astra',reasoningLevel:undefined});
 }finally{await host.harness.lifecycle.dispose();}
});

// 17 Oct step 2 canary: a Claude model on the Codex provider failed at its first turn.
test('dispatch refuses a model the provider does not offer before anything is spawned',async()=>{
 const host=await dispatchHost();try {
  const out=text(await tool(host,'firstmate_dispatch').execute({projectId:'proj_1',task:'check PR 9',role:'checker',model:'claude-opus-5-5'},{projectId:'proj_1'}));
  assert.match(out,/Provider "codex" does not offer model "claude-opus-5-5"\. It offers: gpt-6\.1-sol, gpt-6-astra\. Nothing was spawned\./);
  const cli=await host.harness.behavior.runCli(['dispatch','--project','proj_1','--provider','codex','--model','claude-opus-5-5','--','fix login'],{projectId:'proj_1'});
  assert.equal(cli.exitCode,1);assert.match(cli.stderr,/does not offer model "claude-opus-5-5"/);
  assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});

// FM138 verdict 1, finding 3: proof for another PR, or for an older head, proves nothing here.
test('verify refuses a P4 line written for another PR or an older head',async()=>{
 for(const line of [`✓ P4 Prove on the real surface for cyndra-ai/cyndra-saas#2392 at ${head(2391).slice(0,7)}: driven x; seen y`,`✓ P4 Prove on the real surface for cyndra-ai/cyndra-saas#2391 at fffffff: driven x; seen y`]){
  const {host,store}=await deck({report:PROVEN.replace(/^✓ P4 .*$/m,line)});try {
   assert.match(text(await verify(host,2391)),new RegExp(`report has its proof step missing: no "✓ P4 Prove on the real surface for cyndra-ai/cyndra-saas#2391 at ${head(2391).slice(0,7)}" line`),line);
   assert.equal(store.get(id(2391)).verifiedCommitSha,null);
  }finally{await host.harness.lifecycle.dispose();}
 }
});

// Migration: a crew dispatched before this version needs no P4 line, because its report
// was written without one. Its production PR still needs a checker before it merges.
test('a crew dispatched before the pipeline version verifies without P4, and its production PR still needs a checker',async()=>{
 const legacy=CREWS.map(c=>{const {dispatchVersion,...rest}=c;return rest;});
 const {host,store,commands}=await deck({report:null,crews:legacy});try {
  text(await verify(host,2391));
  assert.equal(store.get(id(2391)).verifiedCommitSha,head(2391),'no P4 needed');
  assert.match(text(await tool(host,'firstmate_merge').execute({crewId:BUILDER,yes:true,pr:2391},ctx)),/^Refusing: #2391 reaches production .* and has no checker verdict for its head 2391239; nothing was merged\./);
  assert.deepEqual(merges(commands),[]);
  text(await check(host,2391,'thr_chk'));
  const merged=text(await tool(host,'firstmate_merge').execute({crewId:BUILDER,yes:true,pr:2391},ctx));
  assert.match(merged,/^Merged #2391 Change 2391\n/);
  assert.match(merged,/Checked: crew chk1 \(gpt-6-astra\) passed head 2391239\./);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a new dispatch records the pipeline version on its crew',async()=>{
 const host=await dispatchHost();try {
  await tool(host,'firstmate_dispatch').execute({projectId:'proj_1',task:'fix login'},{projectId:'proj_1'});
  const crews=await host.bb.storage.kv.get('crews');
  assert.equal(crews[0].dispatchVersion,2);
 }finally{await host.harness.lifecycle.dispose();}
});

// FM138 verdict 1, finding 4: an unreadable catalog cannot prove a model exists.
test('dispatch refuses when the provider catalog or its model list cannot be read',async()=>{
 for(const [label,stub] of [
  ['empty model list',h=>h.harness.sdk.stub('providers.models',async()=>({modelLoadError:null,models:[]}))],
  ['model load error',h=>h.harness.sdk.stub('providers.models',async()=>({modelLoadError:'offline',models:[]}))],
  ['models call fails',h=>h.harness.sdk.stub('providers.models',async()=>{throw new Error('host offline');})],
  ['provider list fails',h=>h.harness.sdk.stub('providers.list',async()=>{throw new Error('host offline');})],
  ['empty provider list',h=>h.harness.sdk.stub('providers.list',async()=>[])],
 ]){
  const host=await dispatchHost();stub(host);try {
   const out=text(await tool(host,'firstmate_dispatch').execute({projectId:'proj_1',task:'check PR 9',role:'checker',model:'not-a-real-model'},{projectId:'proj_1'}));
   assert.match(out,/cannot be checked against the catalog of provider "codex"[^]*Nothing was spawned\./,label);
   assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0,label);
  }finally{await host.harness.lifecycle.dispose();}
 }
});

// FM138 verdict 2, finding 2: only the crew's current report.md proves P4, and an open line
// there for this PR and head wins over a done one anywhere.
test('verify reads only the crew report.md: a stale done line elsewhere, or a later open line, does not prove P4',async()=>{
 const blocked=`blocked: P4 Prove on the real surface for cyndra-ai/cyndra-saas#2391 at ${head(2391).slice(0,7)}: staging is down`;
 for(const [label,opts,want] of [
  ['report.md blocked, final-report.md done',{report:blocked,files:{'final-report.md':PROVEN}},/proof step blocked: /],
  ['report.md done then blocked',{report:`${PROVEN}\n${blocked}`},/proof step blocked: /],
  ['only final-report.md',{report:null,files:{'final-report.md':PROVEN}},/proof step missing: /],
  ['only the thread output',{report:null,output:PROVEN},/proof step missing: /],
 ]){
  const {host,store}=await deck(opts);try {
   assert.match(text(await verify(host,2391)),want,label);
   assert.equal(store.get(id(2391)).verifiedCommitSha,null,label);
  }finally{await host.harness.lifecycle.dispose();}
 }
});

test('each checker verdict reaches the weekly scorecard with its finding count',async()=>{
 const {host}=await deck();try {
  text(await check(host,2391,'thr_chk','fail',2));
  const card=JSON.parse((await host.harness.behavior.runCli(['scorecard','--json'],ctx)).stdout);
  assert.deepEqual(card.checks.map(c=>[c.pr,c.verdict,c.findings,c.model]),[[id(2391),'fail',2,'gpt-6-astra']]);
  assert.match((await host.harness.behavior.runCli(['scorecard'],ctx)).stdout,/Checker findings: 2 findings in 1 fail verdict on 1 PR\. Source: checker verdicts\./);
 }finally{await host.harness.lifecycle.dispose();}
});
