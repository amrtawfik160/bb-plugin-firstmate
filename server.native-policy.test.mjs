import {manifestSkillIds} from './scripts/plugin-skill-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,rmSync,cpSync,symlinkSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createFakePluginHost,makeThreadResponse,makePluginAgentConfigurationContext} from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import {createDeliveries,parseForge,deliveryLine} from './lib/pr-delivery.ts';
import {createLaunches} from './lib/launch.ts';
import {FIRSTMATE_ROUTINE_MARKER} from './lib/timeline-noise.ts';
import {runtimeFixture} from './scripts/native-runtime-fixture.mjs';
import {fixture,pins,scaffold,render,run,ok} from './scripts/prompt-fixture.mjs';
const ctx={threadId:'thr_cap',projectId:'proj_1'};
const manifest=JSON.parse(readFileSync('package.json','utf8'));
const ids=manifestSkillIds(process.cwd());
const hash=text=>createHash('sha256').update(text).digest('hex');
async function hostFor(home) {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:ids,settings:{fmHome:home,fmHostId:'host_1',fullParityOnDeck:false}});await plugin(host.bb);
 await host.bb.storage.kv.set('native-home:thr_cap',home);await host.bb.storage.kv.set('native-home-host:thr_cap','host_1');
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',parentThreadId:threadId==='thr_cap'?null:'thr_cap',environmentId:'env_1'}));
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({captain:'true'}));
 host.harness.sdk.stub('environments.get',async()=>({id:'env_1',hostId:'host_1',path:home+'/test-repository',status:'ready'}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_1',hostId:'host_1',path:home+'/test-repository',status:'ready',isWorktree:false}]);
 host.harness.sdk.stub('files.read',async({path})=>({content:readFileSync(path,'utf8'),sizeBytes:readFileSync(path).length}));
 const fakebin=join(home,'test-cli');mkdirSync(fakebin);writeFileSync(join(fakebin,'bb'),'#!/bin/sh\nexit 97\n',{mode:0o755});
 const output=new Map();let n=0;const commands=[];
 host.harness.sdk.stub('terminals.create',async({start})=>{
   assert.ok(Buffer.byteLength(start.command)<=10000,'fully composed host command budget');
   const match=/^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(start.command);assert.ok(match,start.command);
   const command=match[1].replace(/'\\''/g,"'");commands.push(command);
   const result=spawnSync('bash',['--noprofile','--norc','-c',command],{stdio:['ignore','pipe','pipe'],encoding:'utf8',env:{...process.env,HOME:home,PATH:fakebin+':'+process.env.PATH},timeout:30000,maxBuffer:4*1024*1024});
   const id='term'+(++n);output.set(id,(result.stdout??'')+(result.stderr??'')+`\n__FM_HOST_RC:${result.status??2}\n`);return{id};
 });
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>({nextSeq:1,chunks:[{dataBase64:Buffer.from(output.get(terminalId)).toString('base64')}]}));
 return{host,commands};
}
for(const pin of pins)test(`selected ${pin.slice(0,8)} native policy and complete contract through registered CLI/tool, composed with transport only`,async()=>{
 const home=fixture(pin),f=await hostFor(home);try {
  const tool=f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_skill');
  for (const [name,reference] of [['ship-landing',undefined],['harness-adapters','references/harness/codex.md']]) {
    const path=join(home,'.agents/skills',name,reference??'SKILL.md');
    // Pick one actual reference from the pinned inventory if names differ.
    if(reference)continue;
    const expected=readFileSync(path,'utf8');
    const cli=await f.host.harness.behavior.runCli(['skill',name],ctx);assert.equal(cli.exitCode,0,cli.stderr);assert.ok(cli.stdout.includes(expected));assert.ok(cli.stdout.includes(pin));
    const result=await tool.execute({name},ctx);assert.ok(typeof result==='string',JSON.stringify(result));assert.ok(result.includes(expected));assert.ok(result.includes(pin));
  }
  const contract=await f.host.harness.behavior.runCli(['contract'],ctx);assert.equal(contract.exitCode,0,contract.stderr);
  const native=readFileSync(join(home,'AGENTS.md'),'utf8');assert.ok(contract.stdout.includes(native));assert.doesNotMatch(contract.stdout,/Calm reporting|captain-methods|worker-methods|report editor/);
  const paths=ok(run('git',['-C',home,'ls-tree','-r','--name-only','HEAD','--','.agents/skills'])).trim().split('\n').filter(p=>p.endsWith('/SKILL.md'));
  assert.equal((contract.stdout.match(/^### \.agents\/skills\//gm)??[]).length,paths.length,'complete selected native trigger inventory');
  for(const path of paths){
    const text=readFileSync(join(home,path),'utf8'),frontmatter=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1];
    assert.ok(contract.stdout.includes(frontmatter),'complete verbatim trigger frontmatter: '+path);
    assert.ok(contract.stdout.includes(hash(text)),'verified native trigger hash: '+path);
  }
  const maintenance=readFileSync(join(home,'.agents/skills/agent-skill-trigger-index/SKILL.md'),'utf8').split(/\n---\n/)[1];
  assert.ok(!contract.stdout.includes(maintenance),'maintenance-only skill body must not load');
  assert.match(contract.stdout,/no-mistakes alone owns review/);assert.match(contract.stdout,/without adding an independent reviewer/);assert.match(contract.stdout,/captain-approved `yolo`/);assert.match(contract.stdout,/After an autonomous merge.*full-URL/);
  for(const meta of [{captain:'true',nativeHome:home},{crew:'true',captain:'true'}]) {
    const cfg=await f.host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({pluginMetadata:meta}));
    assert.ok(!cfg.skills.some(name=>['captain-methods','worker-methods','calm','catch-up'].includes(name)));
    const allow=JSON.parse(readFileSync('docs/verification/native-transport-allowlist.v1.json','utf8'));
    assert.equal(hash(cfg.instructions),allow.dynamic[meta.crew?'crew':'captain'].sha256,'any added default instruction requires explicit transport review');
    for(const [path,entry] of Object.entries(allow.renderer))assert.equal(hash(readFileSync(path)),entry.sha256,'rendered transport changes require explicit review: '+path);
    for(const [path,entry] of Object.entries(allow.captainTransport))assert.equal(hash(readFileSync(path)),entry.sha256,'captain transport changes require explicit review: '+path);
    if(meta.crew)assert.deepEqual(cfg.tools,[]);
    else {
      assert.ok(cfg.tools.some(t=>t.name==='firstmate_skill'));
      const composed=[cfg.instructions,...Object.keys(allow.captainTransport).map(path=>readFileSync(path,'utf8')),contract.stdout].join('\n');
      assert.doesNotMatch(composed,/captain-methods|worker-methods|Calm reporting|report editor/);
      assert.ok(composed.includes(native),'complete selected native contract must survive composition');
      assert.match(composed,/standing `yolo`/);assert.match(composed,/must stand alone/);assert.match(composed,/firstmate_skill/);
    }
  }
  for(const [kind,mode] of [['ship','direct-PR'],['ship','no-mistakes'],['ship','local-only'],['scout','']]) {
    const id=kind+'-'+(mode||'read'),source=scaffold(home,id,kind,mode),prompt=ok(render(home,source.source,kind,id,mode));
    const cfg=await f.host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({pluginMetadata:{crew:'true'}}));
    const composed=prompt+'\n'+cfg.instructions;
    assert.ok(composed.includes(source.task));assert.ok(composed.includes(source.spec));assert.doesNotMatch(composed,/Read worker-methods|captain-methods|Calm reporting/);
    assert.match(composed,/exact key/);assert.match(composed,/--ack 001\.msg/);assert.match(composed,/HARD SAFETY GATE/);assert.match(composed,/no-mistakes daemon|worktree pool/);assert.match(composed,/no-delegation|Do not delegate|do not delegate/);
    if(kind==='ship')assert.ok(composed.includes(`Delivery contract: mode=${mode}`));
    if(mode==='direct-PR') {assert.match(composed,/not a draft/);assert.match(composed,/latest commit/);}
    if(mode==='no-mistakes')assert.match(composed,/NEVER pass `--yes`/);
    assert.equal(readFileSync(source.source,'utf8'),source.text);
  }
  assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(f.host.harness.sdk.callsTo('threads.send').length,0);
  assert.equal(f.host.harness.sdk.callsTo('terminals.create').length,f.host.harness.sdk.callsTo('terminals.close').length);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});

test('unknown policy, changed bytes, traversal and foreign references refuse without fallback or execution',async()=>{
 const home=fixture(),f=await hostFor(home);try{
  const request=args=>f.host.harness.behavior.runCli(['skill',...args],ctx);
  for(const args of [['ship-landing','../../../../AGENTS.md'],['../other'],['missing-skill']])assert.equal((await request(args)).exitCode,1);
  const path=join(home,'.agents/skills/ship-landing/SKILL.md');writeFileSync(path,readFileSync(path,'utf8')+'\nInjected policy\n');
  const changed=await request(['ship-landing']);assert.equal(changed.exitCode,1);assert.match(changed.stderr,/differ from selected Git snapshot/);
  ok(run('git',['-C',home,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-am','unsupported policy']));
  const unknown=await request(['ship-landing']);assert.equal(unknown.exitCode,1);assert.match(unknown.stderr,/Unknown native policy revision/);
  assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});

for(const pin of pins)test(`native relative references ${pin.slice(0,8)} resolve complete tracked documents and nested source links`,async()=>{
 const home=fixture(pin),f=await hostFor(home);try{
  const tool=f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_skill');
  const cases=[
    {name:'stuck-crewmate-recovery',reference:'../../../docs/configuration.md#crew-hosted-lavish-review-boards',path:'docs/configuration.md'},
    {name:'stuck-crewmate-recovery',reference:'../../../docs/agent-control.md',path:'docs/agent-control.md'},
    {name:'harness-adapters',source:'.agents/skills/harness-adapters/references/harness/codex.md',reference:'../../../../../docs/supervision-host.md',path:'docs/supervision-host.md'},
  ];
  for(const {path,...request} of cases){
    const source=readFileSync(join(home,request.source??`.agents/skills/${request.name}/SKILL.md`),'utf8');
    assert.ok(source.includes(request.reference),'actual pinned native reference link');
    const expected=readFileSync(join(home,path),'utf8');
    const args=['skill',request.name,request.reference,...(request.source?['--source',request.source]:[])];
    const cli=await f.host.harness.behavior.runCli(args,ctx);assert.equal(cli.exitCode,0,cli.stderr);
    assert.ok(cli.stdout.endsWith(expected),'complete document through registered CLI, including tail');
    const result=await tool.execute(request,ctx);assert.ok(result.endsWith(expected+FIRSTMATE_ROUTINE_MARKER),'complete document through registered tool, including tail');
    assert.ok(result.includes(pin));assert.ok(result.includes(path));
    if(path==='docs/configuration.md')assert.ok(Buffer.byteLength(expected)>200000,'real document exceeds replaced limit');
  }
  const fragment=await tool.execute({name:'stuck-crewmate-recovery',source:'docs/configuration.md',reference:'#crew-hosted-lavish-review-boards'},ctx);
  assert.ok(fragment.endsWith(readFileSync(join(home,'docs/configuration.md'),'utf8')+FIRSTMATE_ROUTINE_MARKER));
  assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(f.host.harness.sdk.callsTo('threads.send').length,0);
  assert.equal(f.host.harness.sdk.callsTo('terminals.create').length,f.host.harness.sdk.callsTo('terminals.close').length);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});

test('trigger catalog stays complete and isolated to each selected captain runtime; corruption refuses completion',async()=>{
 const one=fixture(pins[0]),two=fixture(pins[1]),f=await hostFor(one);try{
  await f.host.bb.storage.kv.set('native-home:thr_second',two);await f.host.bb.storage.kv.set('native-home-host:thr_second','host_1');
  const expected=home=>ok(run('git',['-C',home,'ls-tree','-r','--name-only','HEAD','--','.agents/skills'])).trim().split('\n').filter(p=>p.endsWith('/SKILL.md'));
  for(const [captain,home,pin] of [['thr_cap',one,pins[0]],['thr_second',two,pins[1]]]){
    const result=await f.host.harness.behavior.runCli(['contract'],{...ctx,threadId:captain});assert.equal(result.exitCode,0,result.stderr);
    assert.match(result.stdout,new RegExp('trigger catalog @ '+pin),'catalog must match selected home revision');
    assert.ok(result.stdout.includes(home));assert.ok(!result.stdout.includes(home===one?two:one),'foreign selected home must never provide catalog');
    for(const path of expected(home))assert.ok(result.stdout.includes(/^---\n([\s\S]*?)\n---/.exec(readFileSync(join(home,path),'utf8'))[1]));
  }
  const path=join(two,'.agents/skills/stuck-crewmate-recovery/SKILL.md');writeFileSync(path,readFileSync(path,'utf8')+'\nForeign policy\n');
  const bad=await f.host.harness.behavior.runCli(['contract'],{...ctx,threadId:'thr_second'});
  assert.equal(bad.exitCode,1);assert.match(bad.stderr,/differ from selected Git snapshot/);assert.ok(!bad.stdout.includes('read is now complete'));
  const unaffected=await f.host.harness.behavior.runCli(['contract'],ctx);assert.equal(unaffected.exitCode,0,unaffected.stderr);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(one,{recursive:true,force:true});rmSync(two,{recursive:true,force:true});}
});

test('unbound captain cannot consume the global policy root even in compatibility mode',async()=>{
 const home=fixture(),f=await hostFor(home);try{
  const missing={...ctx,threadId:'thr_unbound'};
  const result=await f.host.harness.behavior.runCli(['contract'],missing);
  assert.equal(result.exitCode,1);assert.match(result.stderr,/No bound captain home/);
  const tool=f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_contract');
  const response=await tool.execute({},missing);assert.equal(response.isError,true);assert.match(JSON.stringify(response),/shared-home fallback refused/);
  assert.equal(f.host.harness.sdk.callsTo('files.read').length,0);assert.equal(f.host.harness.sdk.callsTo('terminals.create').length,0);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});

test('reference escapes, symlinks, changed source/target and truncated SDK transfers cannot report a complete policy read',async()=>{
 const home=fixture(),f=await hostFor(home);try{
  const request=(reference,source)=>f.host.harness.behavior.runCli(['skill','stuck-crewmate-recovery',reference,...(source?['--source',source]:[])],ctx);
  for(const [reference,source] of [['../../../../etc/passwd'],['/etc/passwd'],['https://example.com'],['..\\secret'],['../../../docs/configuration.md','../foreign/SKILL.md'],['../../etc/passwd','docs/configuration.md']]){
    const calls=f.host.harness.sdk.callsTo('terminals.create').length;
    const result=await request(reference,source);assert.equal(result.exitCode,1);
    assert.equal(f.host.harness.sdk.callsTo('terminals.create').length,calls,'escaping/invalid paths refuse before host execution');
  }
  const target=join(home,'docs/agent-control.md'),original=readFileSync(target);
  rmSync(target);symlinkSync(join(home,'docs/configuration.md'),target);
  let result=await request('../../../docs/agent-control.md');assert.equal(result.exitCode,1);assert.match(result.stderr,/symlinked/);
  rmSync(target);writeFileSync(target,Buffer.concat([original,Buffer.from('\nChanged target\n')]));
  result=await request('../../../docs/agent-control.md');assert.equal(result.exitCode,1);assert.match(result.stderr,/differ from selected Git snapshot/);
  writeFileSync(target,original);
  const base=join(home,'.agents/skills/stuck-crewmate-recovery/SKILL.md'),source=readFileSync(base);
  writeFileSync(base,Buffer.concat([source,Buffer.from('\nChanged source\n')]));
  result=await request('../../../docs/agent-control.md');assert.equal(result.exitCode,1);assert.match(result.stderr,/differ from selected Git snapshot/);
  rmSync(base);symlinkSync(join(home,'.agents/skills/ship-landing/SKILL.md'),base);
  result=await request('../../../docs/agent-control.md');assert.equal(result.exitCode,1);assert.match(result.stderr,/symlinked/);
  rmSync(base);writeFileSync(base,source);
  f.host.harness.sdk.stub('files.read',async({path})=>({content:readFileSync(path,'utf8').slice(0,-1),sizeBytes:readFileSync(path).length}));
  result=await request('../../../docs/agent-control.md');assert.equal(result.exitCode,1);assert.match(result.stderr,/truncated during file transfer/);
  assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(f.host.harness.sdk.callsTo('threads.send').length,0);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});

test('policy staging failure never reads a target or claims completed trigger inventory',async()=>{
 const home=fixture(),f=await hostFor(home);try{
  f.host.harness.sdk.stub('terminals.create',async()=>{throw new Error('INJECTED_POLICY_STAGE_FAILURE');});
  let result=await f.host.harness.behavior.runCli(['skill','ship-landing'],ctx);
  assert.equal(result.exitCode,1);assert.match(result.stderr,/INJECTED_POLICY_STAGE_FAILURE/);
  assert.equal(f.host.harness.sdk.callsTo('files.read').length,0,'target transfer requires successful verification');
  result=await f.host.harness.behavior.runCli(['contract'],ctx);
  assert.equal(result.exitCode,1);assert.match(result.stderr,/INJECTED_POLICY_STAGE_FAILURE/);assert.ok(!result.stdout.includes('read is now complete'));
  assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(f.host.harness.sdk.callsTo('threads.send').length,0);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});

test('registered CLI help describes actual dispatch and queue execution/gates; parser carries the complete spec',async()=>{
 const home=fixture(),f=await hostFor(home);try{
  const registration=f.host.harness.registrations.cli;
  // Exercise registered help metadata: core BB renders subcommand --help from it.
  const subcommands=f.host.harness.inspection.registrations.cli.commands;
  for(const name of ['dispatch','queue']){
    const help=subcommands.find(c=>c.name===name).usage;
    const actual=await f.host.harness.behavior.runCli([name,'--help'],ctx);assert.equal(actual.exitCode,0,actual.stderr);assert.equal(actual.stdout,help);
    for(const flag of ['--project','--provider','--model','--reasoning-level','--mode','--delivery-requirement','--shape'])assert.ok(help.includes(flag),name+':'+flag);
    for(const value of ['ultra','none','ultracode','merged-and-verified','local-only'])assert.ok(help.includes(value));
  }
  const qHelp=subcommands.find(c=>c.name==='queue').usage;for(const flag of ['--after','--wait-until','--detail'])assert.ok(qHelp.includes(flag));
  const dHelp=subcommands.find(c=>c.name==='dispatch').usage;for(const flag of ['--task-id','--override-owner','--permission-mode'])assert.ok(dHelp.includes(flag));
  const general=await f.host.harness.behavior.runCli(['help'],ctx);assert.ok(general.stdout.includes(dHelp));assert.ok(general.stdout.includes(qHelp));
  f.host.harness.sdk.stub('providers.list',async()=>[{id:'requested',available:true}]);
  const result=await f.host.harness.behavior.runCli(['queue','add','--project','proj_1','--provider','requested','--model','selected','--reasoning-level','xhigh','--mode','direct-PR','--delivery-requirement','pr','--shape','ship','--after','dependency','--wait-until','2030-01-01T00:00:00Z','--detail','Full task text','--json','--','Exact task'],ctx);
  assert.equal(result.exitCode,0,result.stderr);const row=JSON.parse(result.stdout);
  for(const [key,value] of Object.entries({title:'Exact task',detail:'Full task text',providerId:'requested',model:'selected',reasoningLevel:'xhigh',mode:'direct-PR',deliveryRequirement:'pr',shape:'ship',parentThreadId:'thr_cap'}))assert.equal(row[key],value);
  assert.deepEqual(row.blockedBy,['dependency']);
  const gated=await f.host.harness.behavior.runCli(['queue','dispatch',row.id],ctx);assert.equal(gated.exitCode,1);assert.match(gated.stderr,/gated/);
  const invalid=await f.host.harness.behavior.runCli(['dispatch','--mode','made-up','--','task'],ctx);assert.equal(invalid.exitCode,1);assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});

for(const pin of pins)test(`native posture ${pin.slice(0,8)} remains intake context and standing authority with legacy provenance visible`,async()=>{
 const home=fixture(pin);ok(run('python3',['overlay/install-bb-backend.py','--home',home]));const f=await hostFor(home);try{
  let result=await f.host.harness.behavior.runCli(['posture','--json'],ctx);assert.equal(result.exitCode,0,result.stderr);let context=JSON.parse(result.stdout);assert.equal(context.native.mode,'no-mistakes');assert.equal(context.native.yolo,false);assert.equal(context.native.registered,false);
  mkdirSync(join(home,'data'),{recursive:true});writeFileSync(join(home,'data/projects.md'),'- test-repository [direct-PR +yolo] - fixture\n');
  // A task-specific mode does not silently turn registered yolo off. Stop at
  // the fake spawn boundary: no model or native worker executes this test.
  f.host.harness.sdk.stub('threads.spawn',async input=>{assert.equal(input.pluginMetadata.yolo,true);assert.equal(input.pluginMetadata.posture,'local-only');throw new Error('FIXTURE_NO_WORKER');});
  const explicit=await f.host.harness.behavior.runCli(['dispatch','--task-id','intake-explicit','--mode','local-only','--','Exact user task with an explicit delivery mode'],ctx);
  assert.equal(explicit.exitCode,1);assert.match(explicit.stderr,/FIXTURE_NO_WORKER/);
  const launch=createLaunches(f.host.bb.storage.database()).list('thr_cap')[0];assert.equal(launch.yolo,true);assert.equal(launch.deliveryMode,'local-only');
  assert.equal(readFileSync(join(home,'data/projects.md'),'utf8'),'- test-repository [direct-PR +yolo] - fixture\n');
  await f.host.bb.storage.kv.set('postures',{proj_1:{mode:'direct-PR',yolo:true}});
  result=await f.host.harness.behavior.runCli(['posture','--json'],ctx);assert.equal(result.exitCode,0,result.stderr);context=JSON.parse(result.stdout);
  assert.equal(context.native.mode,'direct-PR');assert.equal(context.native.yolo,true);assert.equal(context.authority.status,'legacy-unverified');assert.match(context.precedence,/fresh merge request is not required/);assert.match(context.precedence,/Only an actual user hold/);
  assert.deepEqual(await f.host.bb.storage.kv.get('postures'),{proj_1:{mode:'direct-PR',yolo:true}});
  const changed=await f.host.harness.behavior.runCli(['posture','set','--mode','local-only'],ctx);assert.equal(changed.exitCode,1);assert.match(changed.stderr,/requires.*override/);
  const approved=await f.host.harness.behavior.runCli(['posture','set','--yolo','on','--reason','Recorded explicit standing approval','--json'],ctx);assert.equal(approved.exitCode,0,approved.stderr);assert.equal(JSON.parse(approved.stdout).provenance.actor,'thr_cap');
  const held=await f.host.harness.behavior.runCli(['posture','set','--yolo','off','--reason','User hold','--json'],ctx);assert.equal(held.exitCode,0);assert.equal(JSON.parse(held.stdout).yolo,false);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});


test('bundled policy skill and references use the selected immutable runtime, not an external repository',async()=>{
 const fixture=runtimeFixture(),root=fixture.ready();const f=await hostFor(fixture.home);try {
  await f.host.bb.storage.kv.set('native-runtime:thr_cap',{root});
  const skill=await f.host.harness.behavior.runCli(['skill','ask-user-authority'],ctx);assert.equal(skill.exitCode,0,skill.stderr);
  assert.ok(skill.stdout.includes(readFileSync(join(root,'.agents/skills/ask-user-authority/SKILL.md'),'utf8')));
  const contract=await f.host.harness.behavior.runCli(['contract'],ctx);assert.equal(contract.exitCode,0,contract.stderr);assert.ok(contract.stdout.includes(readFileSync(join(root,'AGENTS.md'),'utf8')));
  const reference="references/common/dispatch.md";
  const selected=await f.host.harness.behavior.runCli(['skill','harness-adapters',reference],ctx);assert.equal(selected.exitCode,0,selected.stderr);assert.ok(selected.stdout.includes(readFileSync(join(root,'.agents/skills/harness-adapters',reference),'utf8')));
  assert.ok(f.commands.every(c=>!c.includes('/root/firstmate')&&!c.includes('/root/github_projects/firstmate')));
  assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(f.host.harness.sdk.callsTo('threads.send').length,0);
 }finally{await f.host.harness.lifecycle.dispose();fixture.clean();}
});
