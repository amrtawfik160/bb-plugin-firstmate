import {manifestSkillIds} from './scripts/plugin-skill-fixture.mjs';
import assert from 'node:assert/strict';
import { DISPATCH_TRANSPORT } from './lib/dispatch-intake.ts';
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
import {CAPTAIN_ROLE_INSTRUCTIONS,NATIVE_CAPTAIN_ROLE} from './lib/captain-role.ts';
import {runtimeFixture} from './scripts/native-runtime-fixture.mjs';
import {fixture,pins,scaffold,render,run,ok} from './scripts/prompt-fixture.mjs';
const ctx={threadId:'thr_cap',projectId:'proj_1'};
const manifest=JSON.parse(readFileSync('package.json','utf8'));
const ids=manifestSkillIds(process.cwd());
const hash=text=>createHash('sha256').update(text).digest('hex');
async function hostFor(home,extraSettings={}) {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:ids,settings:{fmHome:home,fmHostId:'host_1',fullParityOnDeck:false,...extraSettings}});await plugin(host.bb);
 await host.bb.storage.kv.set('native-home:thr_cap',home);await host.bb.storage.kv.set('native-home-host:thr_cap','host_1');
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',parentThreadId:threadId==='thr_cap'?null:'thr_cap',environmentId:'env_1'}));
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({captain:'true'}));
 host.harness.sdk.stub('environments.get',async()=>({id:'env_1',hostId:'host_1',path:home+'/test-repository',status:'ready'}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_1',hostId:'host_1',path:home+'/test-repository',status:'ready',isWorktree:false}]);
 host.harness.sdk.stub('files.read',async({path})=>({content:readFileSync(path,'utf8'),sizeBytes:readFileSync(path).length}));
 const fakebin=join(home,'test-cli');mkdirSync(fakebin,{recursive:true});writeFileSync(join(fakebin,'bb'),'#!/bin/sh\nexit 97\n',{mode:0o755});
 const output=new Map();let n=0;const commands=[];
 host.harness.sdk.stub('terminals.create',async({start})=>{
   assert.ok(Buffer.byteLength(start.command)<=10000,'fully composed host command budget');
   const match=/^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(start.command);assert.ok(match,start.command);
   const command=match[1].replace(/'\\''/g,"'");commands.push(command);
   const result=spawnSync('bash',['--noprofile','--norc','-c',command],{stdio:['ignore','pipe','pipe'],encoding:'utf8',env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('BB_'))),HOME:home,TYPESAFE_API_KEY:'',PATH:fakebin+':'+process.env.PATH},timeout:30000,maxBuffer:4*1024*1024});
   const id='term'+(++n);output.set(id,(result.stdout??'')+(result.stderr??'')+`\n__FM_HOST_RC:${result.status??2}\n`);return{id};
 });
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>({nextSeq:1,chunks:[{dataBase64:Buffer.from(output.get(terminalId)).toString('base64')}]}));
 return{host,commands};
}
async function completeSkill(tool,request,context=ctx){
 let text='',cursor;
 do{
  const page=await tool.execute(cursor?{cursor}:request,context);assert.equal(typeof page,'string',JSON.stringify(page));
  assert.ok(Buffer.byteLength(page)<12000,'bounded native skill response');
  const body=/\nBEGIN_PAGE\n([\s\S]*)\nEND_PAGE\n/.exec(page);assert.ok(body);text+=body[1];
  cursor=/firstmate_skill \{"cursor":"([A-Za-z0-9_-]+)"\}/.exec(page)?.[1];
  if(!cursor)assert.match(page,/END OF NATIVE SKILL TRANSPORT/);
 }while(cursor);
 return text;
}
test('cold-entry tool instructions retain exact native supervisor role across binding and later turns, excluding workers',async()=>{
 for(const pin of ['1f3e7696','2d833ff1']){
  const native=readFileSync(`native-snapshot/${pin}/AGENTS.md`,'utf8');
  assert.equal(NATIVE_CAPTAIN_ROLE,native.slice(native.indexOf('## 1. Identity'),native.indexOf('You may maintain')).trimEnd(),'role excerpt must preserve every native exception and authority rule');
 }
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:ids});await plugin(host.bb);
 try{
  const deck=host.harness.registrations.agentTools.find(t=>t.name==='firstmate_deck');
  assert.equal(deck.instructions,CAPTAIN_ROLE_INSTRUCTIONS);
  const allow=JSON.parse(readFileSync('docs/verification/native-transport-allowlist.v1.json','utf8'));
  assert.equal(hash(deck.instructions),allow.toolUsage.firstmate_deck.sha256,'persistent tool instructions require explicit transport review');
  assert.ok(deck.instructions.length<=4096,'public SDK tool usage limit');
  assert.match(deck.instructions,/Before binding, this conditional role does not apply/);
  assert.match(deck.instructions,/project task belongs to worker intake/);
  assert.match(deck.instructions,/concrete captain-approved project operation/);
  for(const metadata of [{},{captain:'true'},{captain:'true'}]){
   const cfg=await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({pluginMetadata:metadata}));
   // BB appends this supported usage snippet when the tool is selected. The
   // cold session already contains it before metadata changes (no hot update).
   assert.equal(cfg.tools.find(t=>t.name===deck.name)?.instructions,CAPTAIN_ROLE_INSTRUCTIONS);
   assert.ok(deck.instructions.includes(NATIVE_CAPTAIN_ROLE));
  }
  for(const metadata of [{crew:'true'},{crew:'true',captain:'true'}]){
   const cfg=await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({pluginMetadata:metadata}));
   assert.ok(!cfg.tools.some(t=>t.name===deck.name));assert.deepEqual(cfg.skills,[]);
  }
  assert.equal(host.harness.sdk.callsTo('threads.update').length,0,'role configuration changes no model or thread settings');
  assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});
for(const pin of pins)test(`bounded registered contract pages ${pin.slice(0,8)} survive ACP preview and restart with exact captain isolation`,async()=>{
 const home=fixture(pin);let f=await hostFor(home);
 try{
  const full=await f.host.harness.behavior.runCli(['contract'],ctx);assert.equal(full.exitCode,0,full.stderr);
  let body='',cursor,count=0;
  do{
   const tool=f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_contract');
   const page=await tool.execute(cursor?{cursor}:{},ctx);assert.equal(typeof page,'string',JSON.stringify(page));
   assert.ok(Buffer.byteLength(page)<19500,'all actual tool bytes fit observed Grok preview');
   const preview=Buffer.from(page).subarray(0,19500).toString('utf8');
   const match=/\nBEGIN_PAGE\n([\s\S]*)\nEND_PAGE\n/.exec(preview);assert.ok(match);body+=match[1];
   cursor=/firstmate_contract \{"cursor":"([A-Za-z0-9_-]+)"\}/.exec(preview)?.[1];
   if(count++===0){
    assert.ok(cursor);
    const cli=await f.host.harness.behavior.runCli(['contract','--paged'],ctx);assert.equal(cli.exitCode,0,cli.stderr);assert.ok(cli.stdout.includes(match[1]));
    await f.host.bb.storage.kv.set('native-home:thr_other',home);await f.host.bb.storage.kv.set('native-home-host:thr_other','host_1');
    const wrong=await tool.execute({cursor},{...ctx,threadId:'thr_other'});assert.equal(wrong.isError,true);assert.match(JSON.stringify(wrong),/another captain/);
    await f.host.harness.lifecycle.dispose();f=await hostFor(home);
    const resumed=await f.host.harness.behavior.runCli(['contract','--cursor',cursor],ctx);assert.equal(resumed.exitCode,0,resumed.stderr);assert.match(resumed.stdout,/FIRSTMATE_CONTRACT_PAGE 2\//);
   }
   assert.ok(count<30);
  }while(cursor);
  assert.ok(count>1);assert.ok(body.startsWith(readFileSync(join(home,'AGENTS.md'),'utf8')));
  assert.ok(full.stdout.includes(body),'complete native text/catalog/adaptations must equal operator full read');
  assert.match(body,/Selected native skill trigger catalog/);assert.match(body,/BB runtime adaptations/);
  assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(f.host.harness.sdk.callsTo('threads.send').length,0);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});
for(const pin of pins)test(`bounded native skill reads ${pin.slice(0,8)} preserve large bytes through tool and CLI continuation after reload`,async()=>{
 const home=fixture(pin);let f=await hostFor(home);
 try{
  const full=await f.host.harness.behavior.runCli(['skill','afk'],ctx);assert.equal(full.exitCode,0,full.stderr);
  assert.ok(Buffer.byteLength(full.stdout)>19500,'real native skill exceeds observed incident preview');
  let body='',cursor,count=0;
  do{
   const tool=f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_skill');
   const page=await tool.execute(cursor?{cursor}:{name:'afk'},ctx);
   assert.equal(typeof page,'string',JSON.stringify(page));
   assert.ok(Buffer.byteLength(page)<12000,'bounded public payload including instructions and marker');
   const content=/\nBEGIN_PAGE\n([\s\S]*)\nEND_PAGE\n/.exec(page);assert.ok(content,'explicit native page envelope');body+=content[1];
   cursor=/firstmate_skill \{"cursor":"([A-Za-z0-9_-]+)"\}/.exec(page)?.[1];
   if(count++===0){
    assert.ok(cursor);
    const cli=await f.host.harness.behavior.runCli(['skill','afk','--paged'],ctx);assert.equal(cli.exitCode,0,cli.stderr);assert.ok(cli.stdout.includes(content[1]));
    const other=await tool.execute({name:'stow',cursor},ctx);assert.equal(other.isError,true);assert.match(JSON.stringify(other),/resource differs/);
    await f.host.bb.storage.kv.set('native-home:thr_other',home);await f.host.bb.storage.kv.set('native-home-host:thr_other','host_1');
    const wrong=await tool.execute({cursor},{...ctx,threadId:'thr_other'});assert.equal(wrong.isError,true);assert.match(JSON.stringify(wrong),/another captain/);
    await f.host.harness.lifecycle.dispose();f=await hostFor(home);
    const resumed=await f.host.harness.behavior.runCli(['skill','--cursor',cursor],ctx);assert.equal(resumed.exitCode,0,resumed.stderr);assert.match(resumed.stdout,/FIRSTMATE_SKILL_PAGE 2\//);
   }
   if(!cursor)assert.match(page,/END OF NATIVE SKILL TRANSPORT/);
   assert.ok(count<20);
  }while(cursor);
  assert.equal(body,full.stdout,'all native text and identity headers survive in exact order');
  const tool=f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_skill');
  const first=await tool.execute({name:'afk'},ctx),pending=/firstmate_skill \{"cursor":"([A-Za-z0-9_-]+)"\}/.exec(first)[1];
  const path=join(home,'.agents/skills/afk/SKILL.md');writeFileSync(path,readFileSync(path,'utf8')+'\nChanged native file\n');
  const changed=await tool.execute({cursor:pending},ctx);assert.equal(changed.isError,true);assert.match(JSON.stringify(changed),/differ from selected Git snapshot/);
  assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(f.host.harness.sdk.callsTo('threads.send').length,0);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});
test('public diagnostic inventory preserves folded native descriptions and all trigger branches without becoming role policy',async()=>{
 const home=fixture(),f=await hostFor(home);
 try{
  const result=await f.host.harness.behavior.runCli(['skill','--list','--json'],ctx);assert.equal(result.exitCode,0,result.stderr);
  const inventory=JSON.parse(result.stdout);
  assert.equal(inventory.diagnostic,true);assert.equal(inventory.commit,pins[1]);assert.equal(inventory.skills.length,28);
  const afk=inventory.skills.find(s=>s.name==='afk');
  assert.ok(afk.description.startsWith('Enter the away posture when the captain invokes /afk, says they are going afk,'));
  assert.ok(afk.description.endsWith('on the first unmarked message renders the return brief from durable records before ordinary work resumes.'));
  assert.ok(afk.description.length>160,'description preserves all branches beyond old 160-character cutoff');
  assert.ok(afk.description.includes('on Pi the supervision branch acts on the words by its own judgment'));
  const maintenance=inventory.skills.find(s=>s.name==='agent-skill-trigger-index');assert.equal(maintenance.description,'Load only when auditing or maintaining the complete agent-only skill trigger index.');
  const tool=f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_skill');
  const text=await completeSkill(tool,{list:true});assert.deepEqual(JSON.parse(text),inventory);
  const cfg=await f.host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({pluginMetadata:{captain:'true',nativeHome:home}}));
  assert.ok(!cfg.instructions.includes(afk.description),'diagnostic inventory is not a competing role trigger policy');
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});
test('oversized Unicode reference identity refuses an unusable cursor without shortening the operator document',async()=>{
 const home=fixture(),f=await hostFor(home);try{
  const reference='SKILL.md#'+'界'.repeat(990);
  const tool=f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_skill');
  const result=await tool.execute({name:'afk',reference},ctx);assert.equal(result.isError,true,'cannot publish a cursor larger than the continuation parser accepts');
  assert.match(JSON.stringify(result),/identity.*bytes.*omit.*fragment/);
  const full=await f.host.harness.behavior.runCli(['skill','afk',reference],ctx);assert.equal(full.exitCode,0,full.stderr);
  assert.ok(full.stdout.endsWith(readFileSync(join(home,'.agents/skills/afk/SKILL.md'),'utf8')));
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});
for(const pin of pins)test(`native dispatch intake ${pin.slice(0,8)} writes branch brief then resolves then owns backlog before attempted guarded BB spawn`,async()=>{
 const home=fixture(pin),f=await hostFor(home,{transport:'real',queueOwner:'real'}),repo=join(home,'test-repository');
 try{
  ok(run('python3',['overlay/install-bb-backend.py','--home',home]));mkdirSync(repo);
  ok(run('git',['init','--quiet',repo]));ok(run('git',['-C',repo,'config','user.name','Fixture']));ok(run('git',['-C',repo,'config','user.email','fixture@example.invalid']));
  writeFileSync(join(repo,'proof.txt'),'owned baseline\n');ok(run('git',['-C',repo,'add','proof.txt']));ok(run('git',['-C',repo,'commit','--quiet','-m','owned baseline']));
  const head=ok(run('git',['-C',repo,'rev-parse','HEAD']));
  f.host.harness.sdk.stub('providers.list',async()=>[{id:'fixture-provider',available:true}]);
  const task='Create a tiny local module on the assigned branch. No push, PR or merge.';
  const r=await f.host.harness.behavior.runCli(['dispatch','--task-id','owned-intake','--project','proj_1','--mode','local-only','--branch-prefix','work/','--provider','fixture-provider','--',''+task],ctx);
  // Native may refuse at a dependency/BB endpoint guard. It must never fall back
  // to an SDK/model spawn. Prior native brief/resolver/backlog stages are real.
  assert.equal(r.exitCode,1,'the fake BB executable cannot launch a worker');
  const brief=readFileSync(join(home,'data/owned-intake/brief.md'),'utf8');
  assert.ok(brief.includes(task));assert.match(brief,/Ship branch: `?work\/owned-intake/);assert.match(brief,/local-only/);
  const briefIndex=f.commands.findIndex(c=>c.includes('FM_INTENT=')),resolveIndex=f.commands.findIndex(c=>c.includes('fm-dispatch-resolve.sh')),backlogIndex=f.commands.findIndex(c=>c.includes('fm-tasks-axi.sh')&&c.includes("'add'")),spawnIndex=f.commands.findIndex(c=>c.includes('fm-spawn.sh'));
  assert.ok(briefIndex>=0 && resolveIndex>briefIndex && backlogIndex>resolveIndex && spawnIndex>backlogIndex,JSON.stringify(f.commands));
  assert.ok(f.commands[spawnIndex].includes("'--branch-prefix' 'work/'"));assert.ok(f.commands[spawnIndex].includes("FM_BB_DELIVERY_REQUIREMENT='branch'"));
  const launch=JSON.parse((await f.host.harness.behavior.runCli(['launches','--json'],ctx)).stdout).find(r=>r.taskId==='owned-intake');
  assert.equal(launch.deliveryRequirement,'branch');assert.equal(launch.branchPrefix,'work/');
  const artifacts=readdirSync(join(home,'data/owned-intake')).filter(n=>n.startsWith('dispatch-resolution-'));assert.equal(artifacts.length,1);assert.match(readFileSync(join(home,'data/owned-intake',artifacts[0]),'utf8'),/dispatch-resolve: off/);
  assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(ok(run('git',['-C',repo,'rev-parse','HEAD'])),head);
  const wrapper=await f.host.harness.behavior.runCli(['fm','brief','--help'],ctx);assert.equal(wrapper.exitCode,0);assert.match(wrapper.stdout,/fm brief -- --help/);
  const help=await f.host.harness.behavior.runCli(['fm','brief','--','--help'],ctx);assert.equal(help.exitCode,0,help.stderr);assert.match(help.stdout,/fm-brief.sh <task-id>/);assert.match(help.stdout,/local-only/);
  const tool=f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_dispatch');assert.match(tool.description,/brief→dispatch-resolve→backlog/);assert.match(tool.description,/providerId\/model\/reasoningLevel choose the BB worker/);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});
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
    assert.equal(hash(DISPATCH_TRANSPORT),allow.dispatchTransport.sha256,'dispatch transport mapping requires explicit review');
    assert.equal(hash(cfg.instructions),allow.dynamic[meta.crew?'crew':'captain'].sha256,'any added default instruction requires explicit transport review');
    for(const [path,entry] of Object.entries(allow.renderer))assert.equal(hash(readFileSync(path)),entry.sha256,'rendered transport changes require explicit review: '+path);
    for(const [path,entry] of Object.entries(allow.captainTransport))assert.equal(hash(readFileSync(path)),entry.sha256,'captain transport changes require explicit review: '+path);
    if(meta.crew)assert.deepEqual(cfg.tools,[]);
    else {
      assert.ok(cfg.tools.some(t=>t.name==='firstmate_skill'));
      const composed=[cfg.instructions,...Object.keys(allow.captainTransport).map(path=>readFileSync(path,'utf8')),contract.stdout].join('\n');
      assert.doesNotMatch(composed,/captain-methods|worker-methods|Calm reporting|report editor/);
      assert.ok(composed.includes(native),'complete selected native contract must survive composition');
      assert.ok(contract.stdout.includes(DISPATCH_TRANSPORT),'complete managed-dispatch mapping in required native contract read');
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
    const result=await completeSkill(tool,request);assert.ok(result.endsWith(expected),'complete document through registered tool, including tail');
    assert.ok(result.includes(pin));assert.ok(result.includes(path));
    if(path==='docs/configuration.md')assert.ok(Buffer.byteLength(expected)>200000,'real document exceeds replaced limit');
  }
  const fragment=await completeSkill(tool,{name:'stuck-crewmate-recovery',source:'docs/configuration.md',reference:'#crew-hosted-lavish-review-boards'});
  assert.ok(fragment.endsWith(readFileSync(join(home,'docs/configuration.md'),'utf8')));
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
  const contractHelp=await f.host.harness.behavior.runCli(['contract','--help'],ctx);assert.equal(contractHelp.exitCode,0,contractHelp.stderr);for(const flag of ['--paged','--cursor','--json'])assert.ok(contractHelp.stdout.includes(flag));
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

for(const pin of pins)test(`accepted dispatch intent and specification ${pin.slice(0,8)} reach real native briefs and rendered workers without tail loss`,async()=>{
 const home=fixture(pin),f=await hostFor(home,{transport:'real',queueOwner:'real'}),repo=join(home,'test-repository');
 try{
  ok(run('python3',['overlay/install-bb-backend.py','--home',home]));mkdirSync(repo);
  ok(run('git',['init','--quiet',repo]));ok(run('git',['-C',repo,'config','user.name','Fixture']));ok(run('git',['-C',repo,'config','user.email','fixture@example.invalid']));
  writeFileSync(join(repo,'proof.txt'),'owned baseline\n');ok(run('git',['-C',repo,'add','proof.txt']));ok(run('git',['-C',repo,'commit','--quiet','-m','owned baseline']));
  f.host.harness.sdk.stub('providers.list',async()=>[{id:'fixture-provider',available:true}]);
  const intent='Audit only. '+ 'x'.repeat(3030)+'\n```text\n## quoted heading\n```\nTAIL_NO_PRODUCT_EDITS';
  const spec='Implement bounded verification. '+'x'.repeat(3020)+'\nTAIL_SPEC_CONDITION';
  const tool=f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_dispatch');
  for(const [id,task,expectedIntent,expectedSpec,kind] of [
   ['full-intent',intent,intent,null,'cli'],
   ['full-spec',"## Captain's intent\nAudit only.\n## Firstmate spec\n"+spec,'Audit only.',spec,'tool'],
   ['unicode-intent','Audit only. '+'😀'.repeat(1500)+' TAIL_UNICODE','Audit only. '+'😀'.repeat(1500)+' TAIL_UNICODE',null,'cli'],
  ]){
   assert.ok(task.length<4000);
   const result=kind==='cli'?await f.host.harness.behavior.runCli(['dispatch','--task-id',id,'--shape','scout','--provider','fixture-provider','--',task],ctx):await tool.execute({task,taskId:id,shape:'scout',providerId:'fixture-provider'},ctx);
   const brief=readFileSync(join(home,`data/${id}/brief.md`),'utf8');
   assert.ok(brief.includes(expectedIntent),'all accepted intent bytes reach the authoritative native brief');
   if(expectedSpec)assert.ok(brief.includes(expectedSpec),'all accepted specification bytes reach the authoritative native brief');
   const rendered=ok(render(home,join(home,`data/${id}/brief.md`),'scout',id));
   assert.ok(rendered.includes(expectedIntent),'worker renderer retains the same intent');
   if(expectedSpec)assert.ok(rendered.includes(expectedSpec),'worker renderer retains the same specification');
   assert.ok(f.commands.some(c=>c.includes('fm-spawn.sh')&&c.includes(id)),JSON.stringify(result));
  }
  assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0,'fake BB endpoint cannot launch a model');
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});

for(const pin of pins)test(`worker CLI exact inbox and native status notification ${pin.slice(0,8)} remain callable while foreign task and supervisor bridge refuse`,async()=>{
 const home=fixture(pin),f=await hostFor(home),worker={...ctx,threadId:'thr_worker'};
 try{
  ok(run('python3',['overlay/install-bb-backend.py','--home',home]));
  f.host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>threadId==='thr_worker'?{crew:'true',crewId:'owned-task',nativeHome:home}:{});
  mkdirSync(join(home,'state/owned-task.inbox'));writeFileSync(join(home,'state/owned-task.inbox/001.msg'),'schema=fm-task-inbox.v1\nat=2026-10-05T00:00:00Z\n--\nExact pending steering body\n');writeFileSync(join(home,'state/owned-task.status'),'done: preserved handoff\n');
  const inbox=await f.host.harness.behavior.runCli(['fm','--home',home,'inbox-take','--','owned-task'],worker);assert.equal(inbox.exitCode,0,inbox.stderr);assert.match(inbox.stdout,/001.msg/);assert.match(inbox.stdout,/Exact pending steering body/);
  const ack=await f.host.harness.behavior.runCli(['fm','--home',home,'inbox-take','--','owned-task','--ack','001.msg'],worker);assert.equal(ack.exitCode,0,ack.stderr);assert.equal(readFileSync(join(home,'state/owned-task.inbox/handled/001.msg'),'utf8'),'schema=fm-task-inbox.v1\nat=2026-10-05T00:00:00Z\n--\nExact pending steering body\n');
  const status=await f.host.harness.behavior.runCli(['fm','--home',home,'fleet-ledger','--','appended',join(home,'config'),join(home,'state/owned-task.status')],worker);assert.equal(status.exitCode,0,status.stderr);assert.equal(readFileSync(join(home,'state/owned-task.status'),'utf8'),'done: preserved handoff\n');
  const count=f.commands.length;
  for(const argv of [['fm','--home',home+'-foreign','inbox-take','--','owned-task'],['fm','--home',home,'inbox-take','--','owned-task','--ack'],['fm','--home',home,'inbox-take','--','another-task'],['fm','--home',home,'fleet-ledger','--','appended',join(home,'config'),join(home,'state/another.status')],['fm','--home',home,'spawn','--','owned-task','proj_1']]){
   const denied=await f.host.harness.behavior.runCli(argv,worker);assert.equal(denied.exitCode,1);assert.match(denied.stderr,/worker caller/);
  }
  assert.equal(f.commands.length,count,'refusal occurs before host mutation');assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});

for(const pin of pins)test(`secondmate public dispatch ${pin.slice(0,8)} carries exact child intake independently of supervisor execution through native child brief`,async()=>{
 const home=fixture(pin),f=await hostFor(home,{transport:'real',queueOwner:'real'}),repo=join(home,'test-repository');
 try{
  ok(run('python3',['overlay/install-bb-backend.py','--home',home]));mkdirSync(repo);
  ok(run('git',['init','--quiet',repo]));ok(run('git',['-C',repo,'config','user.name','Fixture']));ok(run('git',['-C',repo,'config','user.email','fixture@example.invalid']));writeFileSync(join(repo,'proof.txt'),'baseline\n');ok(run('git',['-C',repo,'add','.']));ok(run('git',['-C',repo,'commit','--quiet','-m','baseline']));
  f.host.harness.sdk.stub('providers.list',async()=>[{id:'requested-provider',available:true,reasoningLevels:[{id:'high'}],models:[{id:'requested-model'}]}]);
  f.host.harness.sdk.stub('threads.defaultExecutionOptions',async()=>({model:'supervisor-model',reasoningLevel:'low',permissionMode:'accept-edits'}));
  f.host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',providerId:'supervisor-provider',environmentId:'env_1'}));
  await f.host.bb.storage.kv.set('native-home:thr_mate',home);await f.host.bb.storage.kv.set('native-home-host:thr_mate','host_1');
  await f.host.bb.storage.kv.set('postures',{proj_1:{mode:'direct-PR',yolo:true,provenance:{source:'captain-instruction',actor:'thr_cap',at:'2026-10-05T00:00:00Z',reason:'Existing approved standing posture'}}});
  await f.host.bb.storage.kv.set('secondmates',[{projectId:'proj_1',threadId:'thr_mate',scope:'subscription',projects:[],createdAt:'2026-10-05T00:00:00Z'}]);
  let handed;
  f.host.harness.sdk.stub('threads.send',async({threadId,input})=>{assert.equal(threadId,'thr_mate');handed=input[0].text;return{};});
  const task='Audit subscription. Preserve user words and scope.';
  const result=await f.host.harness.behavior.runCli(['dispatch','--task-id','routed-intake','--project','proj_1','--mode','direct-PR','--delivery-requirement','pr','--provider','requested-provider','--model','requested-model','--reasoning-level','high','--branch-prefix','audit/','--dispatch-profile-reason','Explicit native intake selection','--hidden','--',task],ctx);
  assert.equal(result.exitCode,0,result.stderr);
  const match=/BEGIN_FIRSTMATE_ROUTED_INTAKE\n([\s\S]*?)\nEND_FIRSTMATE_ROUTED_INTAKE/.exec(handed);assert.ok(match,'handoff must expose the exact structured child request');
  const envelope=JSON.parse(match[1]);assert.equal(envelope.schema,1);assert.equal(envelope.origin.captainId,'thr_cap');assert.equal(envelope.origin.home,home);
  const child=envelope.dispatch;
  assert.equal(child.task,task);assert.equal(child.projectId,'proj_1');assert.equal(child.taskId,'routed-intake');assert.equal(child.providerId,'requested-provider');assert.equal(child.model,'requested-model');assert.equal(child.reasoningLevel,'high');assert.equal(child.branchPrefix,'audit/');assert.equal(child.dispatchProfileReason,'Explicit native intake selection');assert.equal(child.mode,'direct-PR');assert.equal(child.deliveryRequirement,'pr');assert.equal(child.visible,false);assert.equal(child.worktree,true);
  assert.equal(envelope.posture.yolo,true);assert.equal(envelope.posture.provenance.actor,'thr_cap');
  const rows=JSON.parse((await f.host.harness.behavior.runCli(['crews','--json'],ctx)).stdout);const routed=rows.find(c=>c.id==='routed-intake');
  assert.equal(routed.providerId,'requested-provider');assert.equal(routed.model,'requested-model');assert.equal(routed.reasoningLevel,'high');assert.deepEqual(routed.routedIntake,envelope);
  const launches=JSON.parse((await f.host.harness.behavior.runCli(['launches','--json'],ctx)).stdout);assert.deepEqual(launches.find(r=>r.taskId==='routed-intake').routedIntake,envelope);
  const retry=await f.host.harness.behavior.runCli(['dispatch','--task-id','routed-intake','--project','proj_1','--mode','direct-PR','--delivery-requirement','pr','--provider','requested-provider','--model','requested-model','--reasoning-level','high','--branch-prefix','audit/','--dispatch-profile-reason','Explicit native intake selection','--hidden','--',task],ctx);assert.equal(retry.exitCode,0,retry.stderr);assert.equal(f.host.harness.sdk.callsTo('threads.send').length,1,'idempotent route preserves one handoff');
  const native=await f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_dispatch').execute(child,{...ctx,threadId:'thr_mate'});
  const brief=readFileSync(join(home,'data/routed-intake/brief.md'),'utf8');assert.ok(brief.includes(task),JSON.stringify(native));assert.match(brief,/Ship branch: `?audit\/routed-intake/);assert.match(brief,/Delivery contract: mode=direct-PR/);
  const commands=f.commands.filter(c=>c.includes('fm-spawn.sh'));assert.equal(commands.length,1);assert.ok(commands[0].includes("FM_BB_PROVIDER='requested-provider'"));assert.ok(commands[0].includes("FM_BB_MODEL='requested-model'"));assert.ok(commands[0].includes("FM_BB_REASONING='high'"));assert.ok(commands[0].includes("FM_BB_DELIVERY_REQUIREMENT='pr'"));
  assert.equal(f.host.harness.sdk.callsTo('threads.update').length,0,'routing changes no supervisor execution');assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0,'real native endpoint refusal cannot fall back to SDK spawn');
 }finally{await f.host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});
