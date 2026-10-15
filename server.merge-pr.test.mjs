import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost,makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries } from './lib/pr-delivery.ts';

process.env.FM_MERGEABLE_POLL_MS='0';

// The 14 Oct case: crew 9ceeb10f had nine open PRs, the captain meant 2371, and the merge landed 2391.
const CREW='9ceeb10f';
const OPEN=[2368,2371,2373,2380,2381,2384,2387,2389,2391];
const url=n=>`https://github.com/Cyndra-AI/cyndra-saas/pull/${n}`;
const title=n=>`Change ${n}`;
const branch=n=>`fm/${CREW}-change-${n}`;
const ctx={threadId:'thr_cap',projectId:'proj_1'};
const crew={id:CREW,task:'review fixes',projectId:'proj_1',threadId:'thr_crew',parentThreadId:'thr_cap',nativeHome:'/native',providerId:null,model:null,reasoningLevel:null,worktree:true,shape:'ship',posture:'direct-PR',createdAt:'2026-10-14T00:00:00.000Z'};
const heads=new Map();
const head=n=>heads.get(n) ?? String(n).repeat(10).slice(0,40);
const prNumber=command=>Number(/\/pull\/(\d+)/.exec(command)?.[1] ?? /gh pr view '?(\d+)/.exec(command)?.[1]);

function hostCommands(host,answer) {
 const commands=[];const byId=new Map();let n=0;
 host.harness.sdk.stub('terminals.create',async args=>{const id=`term${++n}`;byId.set(id,args.start.command);commands.push(args.start.command);return{id};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{const command=byId.get(terminalId);const out=answer(command);const captured=command.includes('FM_HOST_CAPTURE_V1');const payload=captured?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:out.code??0,stdout:out.payload??'',stderr:out.stderr??''}):out.payload??'';return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:${captured?0:out.code ?? 0}\n`).toString('base64')}]};});
 return commands;
}
// GitHub as it stood: every listed PR open on its crew branch; 2400 belongs to another crew; 2350 is closed.
function forge(command) {
 if(command.includes('fm-pr-merge.sh')){const n=prNumber(command);return{payload:`verified: ${url(n)} is merged (state=MERGED, merged=true, isInMergeQueue=false)`};}
 if(command.includes('gh pr view')){
  const n=prNumber(command);
  const ref=n===2400?'fm/other-crew-fix':branch(n);
  return{payload:JSON.stringify({number:n,url:url(n),title:title(n),headRefName:ref,headRefOid:head(n),state:n===2350?'CLOSED':'OPEN',mergeable:'MERGEABLE'})};
 }
 return{code:0};
}
const seen=n=>({headSha:head(n),state:'open',draft:false,checks:'passing',review:'approved',reviewHeadSha:head(n),mergeCommitSha:null,mergeable:'mergeable'});
async function deck(open=OPEN,{verified=true}={}) {
 heads.clear();
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain'],settings:{fmHome:'/native',fmHostId:'host_1'}});await plugin(host.bb);
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('environments.get',async()=>({id:'env_wt',hostId:'host_1',status:'ready',isWorktree:true,path:'/wt',branchName:branch(2391)}));
 // BB's environment points at the crew's newest PR, the one the old merge picked by itself.
 host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'available',pullRequest:{url:url(2391),state:'open'}}));
 host.harness.sdk.stub('threads.output',async()=>({output:''}));
 host.harness.sdk.stub('threads.events.list',async()=>[]);
 host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));
 await host.bb.storage.kv.set('crews',[crew]);
 const store=createDeliveries(host.bb.storage.database());
 for(const n of open){
  const r=store.register({url:url(n),taskId:CREW,projectId:'proj_1',owner:'thr_cap',home:'/native',worker:'thr_crew',requirement:'merged',title:title(n)});
  store.observe(r.id,seen(n),true);
  if(verified) store.verify(r.id,'thr_cap',head(n),`Drove change ${n} in the staging app; it works`);
 }
 return {host,store,commands:hostCommands(host,forge)};
}
const tool=(host,name)=>host.harness.inspection.registrations.agentTools.find(t=>t.name===name);
const text=out=>typeof out==='string'?out:out?.content?.[0]?.text ?? JSON.stringify(out);
const merges=commands=>commands.filter(c=>c.includes('fm-pr-merge.sh'));

test('a merge without pr on a crew with nine open PRs is refused before anything happens, and names every PR',async()=>{
 const {host,commands}=await deck();try {
  const cli=await host.harness.behavior.runCli(['merge',CREW,'--yes'],ctx);
  assert.equal(cli.exitCode,1);
  for(const n of OPEN){assert.match(cli.stderr,new RegExp(`#${n} ${title(n)} \\[${branch(n)}\\]`));}
  assert.match(cli.stderr,/--pr/);
  const viaTool=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true},ctx));
  assert.match(viaTool,/9 open PRs/);assert.match(viaTool,/pass pr/);assert.match(viaTool,/#2371 Change 2371/);
  assert.deepEqual(merges(commands),[],'nothing reached the merge script');
  assert.equal((await host.bb.storage.kv.get('crews')).length,1,'the crew is untouched');
 }finally{await host.harness.lifecycle.dispose();}
});

test('a merge with pr 2371 lands 2371, not the crew newest PR, and names it first',async()=>{
 const {host,store,commands}=await deck();try {
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2371},ctx));
  assert.match(out,/^Merged #2371 Change 2371\n/);
  const sent=merges(commands);
  assert.equal(sent.length,1);assert.ok(sent[0].includes(`'${url(2371)}'`),sent[0]);assert.ok(!sent[0].includes('2391'),sent[0]);
  assert.match(out,/8 other open PR\(s\)/,'the crew is kept for the other eight');
  assert.equal(store.get('cyndra-ai/cyndra-saas#2391').status==='complete',false);
 }finally{await host.harness.lifecycle.dispose();}
});

test('the CLI takes --pr as a URL and lands that exact PR',async()=>{
 const {host,commands}=await deck();try {
  const cli=await host.harness.behavior.runCli(['merge',CREW,'--yes','--pr',url(2384)],ctx);
  assert.equal(cli.exitCode,0,cli.stderr);assert.match(cli.stdout,/^Merged #2384 Change 2384\n/);
  assert.ok(merges(commands)[0].includes(`'${url(2384)}'`));
 }finally{await host.harness.lifecycle.dispose();}
});

test('a pr that is not this crew PR, or is not open, is refused before the merge script runs',async()=>{
 const {host,commands}=await deck();try {
  const foreign=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:url(2400)},ctx));
  assert.match(foreign,/#2400 is not a PR of crew 9ceeb10f/);
  const closed=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:url(2350)},ctx));
  assert.match(closed,/#2350 is closed, not open/);
  const junk=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:'latest'},ctx));
  assert.match(junk,/pr must be a PR number or a GitHub PR link/);
  assert.deepEqual(merges(commands),[]);
 }finally{await host.harness.lifecycle.dispose();}
});

test('with exactly one open PR, pr stays optional and that PR is merged',async()=>{
 const {host,commands}=await deck([2391]);try {
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true},ctx));
  assert.match(out,/^Merged #2391 Change 2391\n/);
  assert.ok(merges(commands)[0].includes(`'${url(2391)}'`));
 }finally{await host.harness.lifecycle.dispose();}
});

// 15 Oct: Cyndra PR 2315 merged with its verify step pending and no verification record.
test('a merge of a PR without a verification record for its head is refused and says what is missing',async()=>{
 const {host,commands}=await deck([2391],{verified:false});try {
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391},ctx));
  assert.match(out,new RegExp(`^Refusing: #2391 has no verification record for its current head ${head(2391).slice(0,7)}; nothing was merged\\.`));
  assert.match(out,/CI and unit tests are not verification/);
  assert.match(out,/firstmate_deliveries action=verify id=cyndra-ai\/cyndra-saas#2391 commitSha=2391239/);
  assert.match(out,/allowUnverified="<the owner's own words>"/);
  const cli=await host.harness.behavior.runCli(['merge',CREW,'--yes','--pr','2391'],ctx);
  assert.equal(cli.exitCode,1);assert.match(cli.stderr,/no verification record/);assert.match(cli.stderr,/--allow-unverified/);
  assert.deepEqual(merges(commands),[],'nothing reached the merge script');
 }finally{await host.harness.lifecycle.dispose();}
});

test('a verification record for an older head does not cover the current head',async()=>{
 const {host,commands}=await deck([2391]);try {
  heads.set(2391,'f'.repeat(40));
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391},ctx));
  assert.match(out,/^Refusing: #2391's verification record covers 2391239, not its current head fffffff; nothing was merged\./);
  assert.deepEqual(merges(commands),[]);
 }finally{await host.harness.lifecycle.dispose();}
});

test('the owner waiver in words merges an unverified PR and is recorded with the merge',async()=>{
 const {host,store,commands}=await deck([2391],{verified:false});try {
  const short=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391,allowUnverified:'yes'},ctx));
  assert.match(short,/allowUnverified must be the owner's own words/);
  assert.deepEqual(merges(commands),[]);
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391,allowUnverified:'merge it, I will test Telegram myself'},ctx));
  assert.match(out,/^Merged #2391 Change 2391\nhttps:\/\/github\.com\/Cyndra-AI\/cyndra-saas\/pull\/2391\nNot verified: the owner waived verification for head 2391239 in these words: "merge it, I will test Telegram myself"\n/);
  assert.equal(merges(commands).length,1);
  const row=store.get('cyndra-ai/cyndra-saas#2391');
  assert.equal(row.unverifiedMerge.words,'merge it, I will test Telegram myself');assert.equal(row.unverifiedMerge.headSha,head(2391));assert.equal(row.unverifiedMerge.actor,'thr_cap');
 }finally{await host.harness.lifecycle.dispose();}
});

test('the CLI takes the owner waiver as --allow-unverified',async()=>{
 const {host,commands}=await deck([2391],{verified:false});try {
  const cli=await host.harness.behavior.runCli(['merge',CREW,'--yes','--pr','2391','--allow-unverified','the owner said merge it now'],ctx);
  assert.equal(cli.exitCode,0,cli.stderr);assert.match(cli.stdout,/Not verified: the owner waived verification/);
  assert.equal(merges(commands).length,1);
 }finally{await host.harness.lifecycle.dispose();}
});
