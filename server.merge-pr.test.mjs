import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost,makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries } from './lib/pr-delivery.ts';
import { createOwnerAsks } from './lib/owner-asks.ts';
import { createProductionApprovals } from './lib/production-approval.ts';

process.env.FM_MERGEABLE_POLL_MS='0';

// The 14 Oct case: crew 9ceeb10f had nine open PRs, the captain meant 2371, and the merge landed 2391.
const CREW='9ceeb10f';
const OPEN=[2368,2371,2373,2380,2381,2384,2387,2389,2391];
const url=n=>`https://github.com/Cyndra-AI/cyndra-saas/pull/${n}`;
const title=n=>`Change ${n}`;
const branch=n=>`fm/${CREW}-change-${n}`;
const ctx={threadId:'thr_cap',projectId:'proj_1'};
// babysit: the fix rounds on open PRs; the bug-fix and feature pipeline gates have their own tests.
const crew={id:CREW,task:'review fixes',playbook:'babysit',projectId:'proj_1',threadId:'thr_crew',parentThreadId:'thr_cap',nativeHome:'/native',providerId:null,model:null,reasoningLevel:null,worktree:true,shape:'ship',posture:'direct-PR',createdAt:'2026-10-14T00:00:00.000Z'};
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
 if(command.includes('gh pr checks'))return{code:1,payload:JSON.stringify([{name:'build',bucket:'pass'},{name:'lint',bucket:'pass'},{name:'e2e',bucket:'fail'}])};
 if(command.includes('gh pr view')){
  const n=prNumber(command);
  const ref=n===2400?'fm/other-crew-fix':branch(n);
  return{payload:JSON.stringify({number:n,url:url(n),title:title(n),headRefName:ref,headRefOid:head(n),state:n===2350?'CLOSED':'OPEN',mergeable:'MERGEABLE',files:[{path:`docs/change-${n}.md`}]})};
 }
 return{code:0};
}
const seen=n=>({headSha:head(n),state:'open',draft:false,checks:'passing',review:'approved',reviewHeadSha:head(n),mergeCommitSha:null,mergeable:'mergeable'});
async function deck(open=OPEN,{verified=true,approved=true}={}) {
 heads.clear();
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain'],settings:{fmHome:'/native',fmHostId:'host_1'}});await plugin(host.bb);
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('environments.get',async()=>({id:'env_wt',hostId:'host_1',status:'ready',isWorktree:true,path:'/wt',branchName:branch(2391)}));
 // Retirement inspects the crew worktree first; this one is clean.
 host.harness.sdk.stub('environments.diffFiles',async()=>({files:[]}));
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
  if(verified) store.verify(r.id,'thr_cap',head(n),{driven:`change ${n} in the staging app`,seen:`it works`});
 }
 if(approved) approve(host,open);
 return {host,store,commands:hostCommands(host,forge)};
}
function approve(host, prs, {source='owner',resolution='Approve',state='answered',captain='thr_cap',kind='approval'}={}) {
 const asks=createOwnerAsks(host.bb.storage.database());
 const bindings=createProductionApprovals(host.bb.storage.database());
 const ask=asks.create({captain,kind,text:`Merge ${prs.map(n=>`cyndra-ai/cyndra-saas#${n}`).join(', ')}?`,options:[{label:'Approve',value:'approve'},{label:'No',value:'no'}],createdAt:Date.now()});
 for(const n of prs) bindings.bind(ask.id,`cyndra-ai/cyndra-saas#${n}`,head(n));
 if(state!=='open') asks.resolve(ask.id,captain,state,resolution,Date.now(),source==='owner'?'owner':undefined);
 return ask;
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

// PR 129 review: with one verified PR and a failed `gh pr view`, the merge trusted the
// delivery row's cached head and reached the merge script.
test('a merge whose current head cannot be read on GitHub is refused, even with a record or a waiver',async()=>{
 const {host,commands}=await deck([2391]);try {
  hostCommands(host,c=>c.includes('gh pr view')?{code:1,payload:'forge unavailable'}:forge(c));
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true},ctx));
  assert.match(out,/^Refusing: cannot read the current head of #2391 on GitHub, so its verification record cannot be checked; nothing was merged\./);
  const waived=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,allowUnverified:'merge it, I will test Telegram myself'},ctx));
  assert.match(waived,/^Refusing: cannot read the current head of #2391/);
  assert.deepEqual(merges(commands),[]);
 }finally{await host.harness.lifecycle.dispose();}
});

// PR 129 review: the waiver was saved before the merge ran, so a refused merge left it behind.
test('a merge that does not land records no owner waiver',async()=>{
 const {host,store}=await deck([2391],{verified:false});try {
  hostCommands(host,c=>c.includes('fm-pr-merge.sh')?{code:1,payload:'merge failed: required check missing'}:forge(c));
  await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391,allowUnverified:'merge it, I will test Telegram myself'},ctx);
  assert.equal(store.get('cyndra-ai/cyndra-saas#2391').unverifiedMerge ?? null,null);
 }finally{await host.harness.lifecycle.dispose();}
});

// PR 129 review: the release crew drove PRs it did not own and could not record them;
// only the owning captain could.
test('a crew records verification for a PR it drove; the record keeps its crew id, the head and the evidence',async()=>{
 const {host,store,commands}=await deck([2391],{verified:false});try {
  await host.bb.storage.kv.set('crews',[crew,{...crew,id:'rel00001',task:'release the green PRs',threadId:'thr_release',parentThreadId:'thr_other'}]);
  const evidence=['--driven','sent hello to the staging bot at 2391239','--seen','the reply arrived in 2 s','--surface','web'];
  const stranger=await host.harness.behavior.runCli(['deliveries','verify','cyndra-ai/cyndra-saas#2391','--commit',head(2391),...evidence],{threadId:'thr_stranger',projectId:'proj_1'});
  assert.equal(stranger.exitCode,1);assert.match(stranger.stderr,/Refusing: only a crew records verification/);
  const cli=await host.harness.behavior.runCli(['deliveries','verify','cyndra-ai/cyndra-saas#2391','--commit',head(2391).slice(0,7),...evidence],{threadId:'thr_release',projectId:'proj_1'});
  assert.equal(cli.exitCode,0,cli.stderr);
  const row=store.get('cyndra-ai/cyndra-saas#2391');
  assert.equal(row.verifiedCommitSha,head(2391));
  assert.deepEqual({...row.verification,at:0},{crewId:'rel00001',actor:'thr_release',commitSha:head(2391),driven:'sent hello to the staging bot at 2391239',seen:'the reply arrived in 2 s',surface:'web',at:0});
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391},ctx));
  assert.match(out,/^Merged #2391 Change 2391\n/);assert.equal(merges(commands).length,1);
 }finally{await host.harness.lifecycle.dispose();}
});

// PR 129 repair: a release crew's merge of another crew's PR was refused as foreign,
// even with its own verification record for the head.
test('a crew of the same captain merges another crew\'s PR once its head is verified; another captain\'s crew is still refused',async()=>{
 const {host,commands}=await deck([2391],{verified:false});try {
  const release={...crew,id:'rel00001',task:'release the green PRs',threadId:'thr_release'};
  const stranger={...crew,id:'rel00002',task:'release other PRs',threadId:'thr_rel_other',parentThreadId:'thr_other'};
  await host.bb.storage.kv.set('crews',[crew,release,stranger]);
  await host.bb.storage.kv.set('captain-project:thr_cap','proj_1');
  await host.bb.storage.kv.set('captain-project:thr_other','proj_1');
  const merge=threadId=>host.harness.behavior.runCli(['merge',CREW,'--yes','--pr','2391'],{threadId,projectId:'proj_1'});
  const unverified=await merge('thr_release');
  assert.equal(unverified.exitCode,1);assert.match(unverified.stderr,/is the PR of crew 9ceeb10f/);
  const recorded=await host.harness.behavior.runCli(['deliveries','verify','cyndra-ai/cyndra-saas#2391','--commit',head(2391),'--driven','sent hello to the staging bot','--seen','the reply arrived','--surface','web'],{threadId:'thr_release',projectId:'proj_1'});
  assert.equal(recorded.exitCode,0,recorded.stderr);
  const other=await merge('thr_rel_other');
  assert.equal(other.exitCode,1);assert.match(other.stderr,/is the PR of crew 9ceeb10f/);
  assert.deepEqual(merges(commands),[]);
  const cli=await merge('thr_release');
  assert.equal(cli.exitCode,0,cli.stderr);assert.match(cli.stdout,/Merged #2391 Change 2391/);
  assert.equal(merges(commands).length,1);
 }finally{await host.harness.lifecycle.dispose();}
});

// 15 Oct: `merge <crew> --pr <n>` without --yes, meant as a probe, merged Cyndra 2450 and 2449
// because the project had a standing yolo posture; 2449 landed before its backend deploy.
test('without --yes a merge never happens, whatever the posture; it previews the PR, head, checks, record and the command',async()=>{
 const {host,commands}=await deck([2391]);try {
  await host.bb.storage.kv.set('postures',{proj_1:{mode:'direct-PR',yolo:true,provenance:{source:'captain-instruction',actor:'thr_cap',at:'2026-10-05T00:00:00Z',reason:'standing green merges'}}});
  const cli=await host.harness.behavior.runCli(['merge',CREW,'--pr','2391'],ctx);
  assert.equal(cli.exitCode,0,cli.stderr);
  assert.equal(cli.stdout.split('\n')[0],'Not merged: this is a preview. A merge needs --yes (yes=true), whatever the posture.');
  assert.match(cli.stdout,/^PR: #2391 Change 2391 https:\/\/github\.com\/Cyndra-AI\/cyndra-saas\/pull\/2391 \(open\)$/m);
  assert.ok(cli.stdout.includes(`Head: ${head(2391)}`));
  assert.match(cli.stdout,/^Checks: 2 passing, 1 failing \(e2e\), 0 pending$/m);
  assert.match(cli.stdout,/^Verification record: covers the current head; driven: change 2391 in the staging app; seen: it works$/m);
  assert.match(cli.stdout,/^To merge: bb firstmate merge 9ceeb10f --pr 2391 --yes$/m);
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,pr:2391},ctx));
  assert.match(out,/^Not merged: this is a preview/);
  assert.deepEqual(merges(commands),[]);
  assert.equal((await host.bb.storage.kv.get('crews')).length,1,'a preview retires no crew');
 }finally{await host.harness.lifecycle.dispose();}
});

// PR 129 verdict 2: a release crew on an old brief (no --yes) aimed at another crew's
// unverified PR got the ownership refusal, not the preview with its next command.
test('without --yes the preview comes before any refusal, names every reason --yes would refuse, and gives the next steps',async()=>{
 const {host,commands}=await deck([2391],{verified:false});try {
  const release={...crew,id:'rel00001',task:'release the green PRs',threadId:'thr_release'};
  const stranger={...crew,id:'rel00002',task:'release other PRs',threadId:'thr_rel_other',parentThreadId:'thr_other'};
  await host.bb.storage.kv.set('crews',[crew,release,stranger]);
  await host.bb.storage.kv.set('captain-project:thr_cap','proj_1');
  await host.bb.storage.kv.set('captain-project:thr_other','proj_1');
  const sha=head(2391).slice(0,7);
  for(const threadId of ['thr_release','thr_rel_other']){
   const cli=await host.harness.behavior.runCli(['merge',CREW,'--pr','2391'],{threadId,projectId:'proj_1'});
   assert.equal(cli.exitCode,0,cli.stderr);
   assert.equal(cli.stdout.split('\n')[0],'Not merged: this is a preview. A merge needs --yes (yes=true), whatever the posture.');
   assert.match(cli.stdout,/^With --yes now, the merge would be refused:$/m);
   assert.match(cli.stdout,/^- Refusing: https:\/\/github\.com\/Cyndra-AI\/cyndra-saas\/pull\/2391 is the PR of crew 9ceeb10f/m);
   assert.match(cli.stdout,new RegExp(`^- Refusing: #2391 has no verification record for its current head ${sha}\\.$`,'m'));
   assert.match(cli.stdout,/^- Refusing: checks failing \(failed 1, pending 0\)/m);
   assert.match(cli.stdout,new RegExp(`^1\\. Drive the changed surface at head ${sha}, then record what you drove and saw: bb firstmate deliveries verify cyndra-ai/cyndra-saas#2391 --commit ${sha} --driven "<what you drove>" --seen "<what you saw>"$`,'m'));
   assert.match(cli.stdout,/^2\. Checks: get them green, or name the one red check to waive with --allow-red '<check>'\.$/m);
   assert.match(cli.stdout,/^3\. Ownership: only if the owning captain told you to land it, add --override-owner\.$/m);
   assert.match(cli.stdout,/^To merge: bb firstmate merge 9ceeb10f --pr 2391 --yes$/m);
  }
  const viaTool=text(await tool(host,'firstmate_merge').execute({crewId:CREW,pr:2391},{threadId:'thr_release',projectId:'proj_1'}));
  assert.match(viaTool,/^Not merged: this is a preview/);
  const refused=await host.harness.behavior.runCli(['merge',CREW,'--pr','2391','--yes'],{threadId:'thr_release',projectId:'proj_1'});
  assert.equal(refused.exitCode,1);assert.match(refused.stderr,/is the PR of crew 9ceeb10f/,'with --yes the ownership refusal still comes first');
  assert.deepEqual(merges(commands),[]);
 }finally{await host.harness.lifecycle.dispose();}
});

// PR 129 verdict 3: the preview took every PR as mergeable, so a verified, green PR with a
// merge conflict previewed clean and --yes then refused CONFLICTING.
test('the preview reads the PR mergeable state and names a conflict that --yes would refuse',async()=>{
 const {host,commands}=await deck([2391]);try {
  hostCommands(host,c=>c.includes('gh pr checks')?{payload:JSON.stringify([{name:'build',bucket:'pass'}])}
   :c.includes('gh pr view')&&c.includes('--json state,mergeable')?{payload:JSON.stringify({state:'OPEN',mergeable:'CONFLICTING'})}:forge(c));
  const conflict=/^- Refusing: PR not mergeable \(CONFLICTING\)\.$/m;
  const native=await host.harness.behavior.runCli(['merge',CREW,'--pr','2391'],ctx);
  assert.equal(native.exitCode,0,native.stderr);assert.match(native.stdout,conflict);
  assert.match(native.stdout,/^1\. Conflict: have the crew rebase or resolve it, push, then verify the new head\.$/m);
  await host.bb.storage.kv.set('crews',[{...crew,nativeHome:''}]);
  host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'available',pullRequest:{url:url(2391),number:2391,state:'open',checks:{state:'passing',passedCount:2,failedCount:0,pendingCount:0},mergeability:{mergeable:'CONFLICTING'}}}));
  const bbPath=await host.harness.behavior.runCli(['merge',CREW,'--pr','2391'],ctx);
  assert.equal(bbPath.exitCode,0,bbPath.stderr);assert.match(bbPath.stdout,conflict);
  const yes=await host.harness.behavior.runCli(['merge',CREW,'--pr','2391','--yes'],ctx);
  assert.equal(yes.exitCode,1);assert.match(yes.stderr,/PR not mergeable \(CONFLICTING\)/);
  assert.deepEqual(merges(commands),[]);assert.equal(host.harness.sdk.callsTo('environments.mergePullRequest').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});

test('production merge without an owner approval card is refused',async()=>{
 const {host,commands}=await deck([2391],{approved:false});try {
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391},ctx));
  assert.match(out,/Refusing:.*owner approval card/);
  assert.deepEqual(merges(commands),[]);
 }finally{await host.harness.lifecycle.dispose();}
});

for(const [name,prs,options] of [
 ['another PR',[2371],{}],['unanswered card',[2391],{state:'open'}],
 ['No answer',[2391],{resolution:'No'}],['captain answer',[2391],{source:'captain'}],
 ['another captain',[2391],{captain:'thr_other'}],['question card',[2391],{kind:'question'}],
]) test(`production merge refuses ${name}`,async()=>{
 const {host,commands}=await deck([2391],{approved:false});try {
  approve(host,prs,options);
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391,overrideOwner:true},ctx));
  assert.match(out,/Refusing:.*owner approval card/);assert.deepEqual(merges(commands),[]);
 }finally{await host.harness.lifecycle.dispose();}
});

for(const baseMerge of [false,true]) test(`approved PR ${baseMerge?'allows a proven base merge':'refuses a new author commit'}`,async()=>{
 const {host,store}=await deck([2391]);try {
  const approved=head(2391),newHead='f'.repeat(40),base='b'.repeat(40);
  heads.set(2391,newHead);
  store.observe('cyndra-ai/cyndra-saas#2391',seen(2391),true);
  store.verify('cyndra-ai/cyndra-saas#2391','thr_cap',newHead,{driven:'staging app',seen:'the change works'});
  const commands=hostCommands(host,c=>{
   if(c.includes('gh api')) {
    if(c.includes('/pulls/')) return {payload:JSON.stringify({head:{sha:newHead},base:{sha:base}})};
    if(c.includes(`${base}...${base}`)) return {payload:JSON.stringify({status:'identical',total_commits:0,merge_base_commit:{sha:base},commits:[]})};
    return {payload:JSON.stringify({status:'ahead',total_commits:1,merge_base_commit:{sha:approved},commits:[{sha:newHead,parents:[{sha:approved},...(baseMerge?[{sha:base}]:[])]}]})};
   }
   return forge(c);
  });
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391},ctx));
  assert.match(out,baseMerge?/^Merged/:/Refusing:.*owner approval card/);
  assert.equal(merges(commands).length,baseMerge?1:0);
 }finally{await host.harness.lifecycle.dispose();}
});

test('raw native merge commands cannot bypass the approval gate',async()=>{
 const {host,commands}=await deck([2391],{approved:false});try {
  const out=text(await tool(host,'firstmate_fm').execute({script:'pr-merge',args:[CREW,url(2391)]},ctx));
  assert.match(out,/Refusing: use firstmate_merge/);
  const cli=await host.harness.behavior.runCli(['fm','pr-merge','--',CREW,url(2391)],ctx);
  assert.equal(cli.exitCode,1); assert.match(cli.stderr,/Refusing: use firstmate_merge/);
  assert.deepEqual(merges(commands),[]);
 }finally{await host.harness.lifecycle.dispose();}
});

test('approval card creation binds the named PR and only the owner RPC grants permission',async()=>{
 const {host,commands}=await deck([2391],{approved:false});try {
  host.harness.sdk.stub('threads.getPluginMetadata',async()=>({captain:'true'}));
  const asked=text(await tool(host,'firstmate_ask').execute({kind:'approval',question:'Merge cyndra-ai/cyndra-saas#2391 to production? Undo: revert the PR.',project:'Cyndra',options:[{label:'Approve'},{label:'No'}]},ctx));
  assert.match(asked,/Ask|card/);
  const asks=createOwnerAsks(host.bb.storage.database());
  const ask=asks.listOpen('thr_cap')[0];assert.ok(ask,asked);
  await tool(host,'firstmate_resolve_ask').execute({id:ask.id,resolution:'Approve'},ctx);
  let out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391},ctx));
  assert.match(out,/owner approval card/);assert.deepEqual(merges(commands),[]);
  host.harness.sdk.stub('plugins.callRpc',async()=>({answer:'Approve',ok:true}));
  const answered=await host.harness.behavior.callRpc('resolveAsk',{threadId:'thr_cap',id:ask.id,resolution:'Approve'});
  assert.equal(answered.ok,true);
  out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391},ctx));
  assert.match(out,/^Merged/);assert.equal(merges(commands).length,1);
 }finally{await host.harness.lifecycle.dispose();}
});

test('Ship refuses the workstream PR without an owner approval card',async()=>{
 const { createWorkstreams }=await import('./lib/workstreams.ts');
 const {host,commands}=await deck([2391],{approved:false});try {
  const seed=createWorkstreams(host.bb.storage.database(),{
   now:Date.now,provision:async()=>[{repository:'cyndra-ai/cyndra-saas',projectId:'proj_1',hostId:'host_1',path:'/wt',sourcePath:'/repo',branch:branch(2391),environmentId:'env_wt'}],
   start:async()=>'',status:async()=> 'idle',startDev:async()=>'',stopDev:async()=>{},unsaved:async()=>[],remove:async()=>{},ship:async()=>{},taskState:()=> 'working',
  });
  const w=await seed.create({threadId:'thr_cap',projectId:'proj_1',name:'Design',requestId:'create'});
  await host.bb.storage.kv.set('crews',[{...crew,workstreamId:w.id,workstreamRepo:'cyndra-ai/cyndra-saas'}]);
  host.harness.sdk.stub('threads.getPluginMetadata',async()=>({captain:'true'}));
  const invoked=hostCommands(host,c=>{
   if(c.includes('gh pr list')) return {payload:JSON.stringify([{url:url(2391),state:'OPEN',headRefOid:head(2391)}])};
   if(c.includes('git rev-parse HEAD')) return {payload:head(2391)};
   return forge(c);
  });
  const result=await host.harness.behavior.callRpc('workstreams.ship',{threadId:'thr_cap',workstreamId:w.id,requestId:'ship'});
  assert.equal(result.workstream.ship.state,'blocked');
  assert.match(result.workstream.ship.error,/owner approval card/);
  assert.deepEqual(merges([...commands,...invoked]),[]);
  assert.equal(host.harness.sdk.callsTo('environments.mergePullRequest').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a plain resolveAsk RPC cannot impersonate the owner of an approval card',async()=>{
 const {host,commands}=await deck([2391],{approved:false});try {
  host.harness.sdk.stub('threads.getPluginMetadata',async()=>({captain:'true'}));
  host.harness.sdk.stub('plugins.callRpc',async()=>({answer:null,ok:true}));
  const ask=approve(host,[2391],{state:'open'});
  await host.harness.behavior.callRpc('resolveAsk',{threadId:'thr_cap',id:ask.id,resolution:'Approve'});
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391},ctx));
  assert.match(out,/Refusing:.*owner approval card/);assert.deepEqual(merges(commands),[]);
 }finally{await host.harness.lifecycle.dispose();}
});

for(const approved of [false,true]) test(`environment merge ${approved?'pins the owner-approved head':'refuses without an owner card'}`,async()=>{
 const {host,commands}=await deck([2391],{approved});try {
  await host.harness.behavior.setSettings({fmHome:''});
  host.harness.sdk.stub('threads.stop',async()=>({}));
  host.harness.sdk.stub('threads.archive',async()=>({}));
  host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'available',pullRequest:{url:url(2391),state:'open',checks:{state:'passing',failedCount:0,pendingCount:0,passedCount:2},mergeability:{mergeable:'MERGEABLE'}}}));
  await host.bb.storage.kv.set('crews',[{...crew,nativeHome:''}]);
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391},ctx));
  assert.match(out,approved?/^Merged/:/Refusing:.*owner approval card/);
  const direct=commands.filter(c=>c.includes('gh pr merge'));
  assert.equal(direct.length,approved?1:0);
  if(approved) assert.ok(direct[0].includes('--match-head-commit') && direct[0].includes(head(2391)));
  assert.equal(host.harness.sdk.callsTo('environments.mergePullRequest').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a newer No answer cannot be bypassed with an older approval for the same PR',async()=>{
 const {host,commands}=await deck([2391]);try {
  approve(host,[2391],{resolution:'No'});
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,yes:true,pr:2391},ctx));
  assert.match(out,/Refusing:.*owner approval card/);assert.deepEqual(merges(commands),[]);
 }finally{await host.harness.lifecycle.dispose();}
});
