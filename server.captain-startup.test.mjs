import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {existsSync,lstatSync,mkdirSync,readlinkSync,symlinkSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createFakePluginHost,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import {boundedCaptainStartup} from './lib/captain-startup.ts';
import {fixture,pins,run,ok} from './scripts/prompt-fixture.mjs';
const ctx={threadId:'thr_newcap',projectId:'proj_1'};
function unwrap(command){const m=/^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(command);assert.ok(m,command);return m[1].replace(/'\\''/g,"'");}
async function setup(pin=pins[1],options={}) {
 const base=fixture(pin);ok(run('python3',['overlay/install-bb-backend.py','--home',base]));const runtime=join(base,'test-runtime');mkdirSync(runtime);const cli=join(runtime,'bin');mkdirSync(cli);writeFileSync(join(cli,'bb'),'#!/bin/sh\nprintf "{}\\n"\n',{mode:0o755});writeFileSync(join(base,'state/unrelated.status'),'UNRELATED SENTINEL\n');
 const home=`${base}-bb-homes/${ctx.threadId}`;
 const host=createFakePluginHost({pluginId:'firstmate',settings:{fmHome:base,fmHostId:'host_1'}});await plugin(host.bb);
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',environmentId:'env_cap',providerId:'acp-grok',title:'Captain',pinnedAt:1}));
 host.harness.sdk.stub('environments.get',async()=>({id:'env_cap',hostId:options.host??'host_1',path:'/project',status:'ready',isWorktree:true}));
 host.harness.sdk.stub('threads.list',async()=>{throw new Error('Unrelated inventory must not be scanned');});
 host.harness.sdk.stub('threads.updatePluginMetadata',async()=>({}));host.harness.sdk.stub('threads.update',async()=>({}));host.harness.sdk.stub('threads.pin',async()=>({}));host.harness.sdk.stub('threads.getPluginMetadata',async()=>({captain:'true'}));
 host.harness.sdk.stub('files.read',async({path})=>({content:readFileSync(path,'utf8')}));
 const outputs=new Map(),seen=[];let n=0;
 host.harness.sdk.stub('terminals.create',async({start})=>{
  const command=unwrap(start.command);seen.push(command);let result;
  if(options.fail && options.fail(command))result={status:2,stdout:'injected prerequisite failure',stderr:''};
  else result=spawnSync('bash',['-c',command],{encoding:'utf8',env:{...process.env,HOME:runtime,PATH:`${cli}:${process.env.PATH}`},timeout:30000,maxBuffer:8*1024*1024});
  const id=`term${++n}`;outputs.set(id,(result.stdout??'')+(result.stderr??'')+`\n__FM_HOST_RC:${result.status??2}\n`);return{id};
 });
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));host.harness.sdk.stub('terminals.output',async({terminalId})=>({nextSeq:1,chunks:[{dataBase64:Buffer.from(outputs.get(terminalId)).toString('base64')}]}));host.harness.sdk.stub('terminals.close',async()=>({}));
 const clean=async()=>{await host.harness.lifecycle.dispose();rmSync(`${base}-bb-homes`,{recursive:true,force:true});rmSync(base,{recursive:true,force:true});};
 return{base,home,host,seen,runtime,cli,clean};
}
for(const pin of pins)for(const entry of ['cli','tool'])test(`captain ${entry} first binding and bound resume use only exact home on ${pin.slice(0,8)}`,async()=>{
 const f=await setup(pin);try{
 const call=()=>entry==='cli'?f.host.harness.behavior.runCli(['deck','--json'],ctx):f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_deck').execute({},ctx);
 const first=await call();const text=entry==='cli'?first.stdout:first;assert.equal(typeof text,'string',JSON.stringify(text));if(entry==='cli'){assert.equal(first.exitCode,0,first.stderr);const data=JSON.parse(text);assert.equal(data.ready,false);assert.equal(data.nativeHome,f.home);assert.equal(data.hostId,'host_1');assert.equal(data.requiresAgentShell,true);assert.equal(data.digest,null);assert.ok(data.startupCommand.includes(f.home));assert.match(data.startupCommand,/\$FM_BINDIR\/fm-session-start\.sh/);}
 else {assert.match(text,/ready=false/);assert.ok(text.includes(f.home));assert.match(text,/firstmate_contract or bb firstmate contract/);}
 assert.equal(await f.host.bb.storage.kv.get(`native-home:${ctx.threadId}`),f.home);assert.equal(await f.host.bb.storage.kv.get('fm-watch-captain:host_1'),ctx.threadId);assert.equal(readFileSync(join(f.base,'state/unrelated.status'),'utf8'),'UNRELATED SENTINEL\n');assert.equal(f.seen.filter(c=>c.includes('fm-bearings-snapshot')).length,0);assert.equal(f.host.harness.sdk.callsTo('threads.list').length,0);assert.equal(f.seen.filter(c=>c.includes('/fm-bootstrap.sh')).length,1);
 const prior=f.seen.length;const resumed=await call();if(entry==='cli')assert.equal(resumed.exitCode,0,resumed.stderr);else assert.equal(typeof resumed,'string',JSON.stringify(resumed));
 const second=f.seen.slice(prior);assert.equal(second.filter(c=>c.includes('git clone')).length,0);assert.equal(second.filter(c=>c.startsWith('python3 ')&&c.includes('install-bb-backend.py')&&!c.includes('--verify')&&!c.includes('FM_OVERLAY_LOCAL')).length,0,second.join('\n---\n'));assert.equal(second.filter(c=>c.includes('FM_HEAD=')||c.includes('captain-hooks-ok')).length,0);assert.ok(second.some(c=>c.includes('--verify')));
 const contract=await f.host.harness.behavior.runCli(['contract'],ctx);assert.equal(contract.exitCode,0,contract.stderr);assert.ok(f.host.harness.sdk.callsTo('files.read').every(c=>c[0].path.startsWith(f.home+'/')));
 const startup=await f.host.harness.behavior.runCli(['fm','session-start','--json'],ctx);assert.equal(startup.exitCode,0,startup.stderr);assert.ok(JSON.parse(startup.stdout).command.includes(f.home));assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await f.clean();}
});
test('a changed captain hook file is installed again on the next deck',async()=>{
 const f=await setup();try{
 const deck=async()=>{const r=await f.host.harness.behavior.runCli(['deck','--json'],ctx);assert.equal(r.exitCode,0,r.stderr);};
 await deck();
 const hook=readFileSync('overlay/bin/bb-captain-hook.sh');const installed=join(f.runtime,'.bb-firstmate/bin/bb-captain-hook.sh');
 const key=`captain-adapter-setup:${ctx.threadId}`;const stamp=JSON.parse(await f.host.bb.storage.kv.get(key));
 const at=stamp.indexOf(createHash('sha256').update(hook).digest('hex'));assert.notEqual(at,-1,'the setup stamp records the hook file');
 stamp[at]='hash-of-the-previous-hook';await f.host.bb.storage.kv.set(key,JSON.stringify(stamp));writeFileSync(installed,'previous hook\n');
 const prior=f.seen.length;await deck();
 assert.equal(f.seen.slice(prior).filter(c=>c.includes('captain-hooks-ok')).length,1);assert.deepEqual(readFileSync(installed),hook);
 }finally{await f.clean();}
});
test('a plugin load installs a changed captain hook file on each host that has a registered captain, and nothing else',async()=>{
 const f=await setup();try{
 const deck=await f.host.harness.behavior.runCli(['deck','--json'],ctx);assert.equal(deck.exitCode,0,deck.stderr);
 const hook=readFileSync('overlay/bin/bb-captain-hook.sh');const installed=join(f.runtime,'.bb-firstmate/bin/bb-captain-hook.sh');
 const untouched=['.bb-firstmate/captains/'+ctx.threadId,'.claude/settings.json','.codex/hooks.json'].map(rel=>join(f.runtime,rel));
 const before=untouched.map(path=>readFileSync(path,'utf8'));
 const installLogs=()=>f.host.harness.logEntries.filter(e=>e.level==='info'&&/captain hook file installed/.test(e.message)).map(e=>e.message);
 const load=async(done)=>{const prior=f.seen.length;const run=f.host.harness.behavior.runService('captain-home-watch');const deadline=Date.now()+8000;
  while(!done(f.seen.slice(prior))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  run.controller.abort();await run.done;return f.seen.slice(prior);};
 const checked=seen=>seen.some(c=>c.includes('captain-hook-'));
 writeFileSync(installed,'previous hook\n',{mode:0o755});
 await load(()=>readFileSync(installed).equals(hook));
 assert.deepEqual(readFileSync(installed),hook);assert.equal(lstatSync(installed).mode&0o777,0o755);
 assert.deepEqual(untouched.map(path=>readFileSync(path,'utf8')),before,'marker and user settings are not rewritten');
 assert.deepEqual(installLogs(),['captain hook file installed host=host_1']);
 const again=await load(checked);
 assert.ok(checked(again),'the next load checks the installed file');assert.equal(again.filter(c=>c.includes('bb-captain-hook.sh.tmp')).length,0,'an identical file is not installed again');
 assert.equal(installLogs().length,1);
 rmSync(untouched[0]);writeFileSync(installed,'previous hook\n',{mode:0o755});
 const unregistered=await load(checked);
 assert.ok(checked(unregistered));assert.equal(readFileSync(installed,'utf8'),'previous hook\n','a host without a registered captain marker is left alone');
 }finally{await f.clean();}
});
test('every deck links skill-routing into each installed provider skill folder and repairs a broken link',async()=>{
 const f=await setup();try{
 const deck=async()=>{const r=await f.host.harness.behavior.runCli(['deck','--json'],ctx);assert.equal(r.exitCode,0,r.stderr);};
 const target=join(process.cwd(),'entry-skills/skill-routing');
 mkdirSync(join(f.runtime,'.cursor/skills/skill-routing'),{recursive:true});
 await deck();
 for(const root of ['.claude/skills','.codex/skills'])assert.equal(readlinkSync(join(f.runtime,root,'skill-routing')),target,root);
 assert.ok(lstatSync(join(f.runtime,'.cursor/skills/skill-routing')).isDirectory(),'a real folder is never replaced');
 assert.equal(existsSync(join(f.runtime,'.grok')),false);
 const link=join(f.runtime,'.claude/skills/skill-routing');rmSync(link);symlinkSync(join(f.runtime,'gone'),link);
 const prior=f.seen.length;await deck();
 assert.equal(f.seen.slice(prior).filter(c=>c.includes('captain-hooks-ok')).length,0,'the link step does not wait for a hook reinstall');
 assert.equal(readlinkSync(link),target);
 }finally{await f.clean();}
});
for(const failure of ['clone','bootstrap'])test(`failed ${failure} aborts captain setup without a watcher or claimed readiness`,async()=>{
 const f=await setup(pins[1],{fail:c=>failure==='clone'?c.includes('git clone'):c.includes('/fm-bootstrap.sh')});try{
 const result=await f.host.harness.behavior.runCli(['deck','--json'],ctx);assert.equal(result.exitCode,1);assert.match(result.stderr,/Captain is not ready/);assert.match(result.stderr,/prerequisite|initialization/);assert.equal(await f.host.bb.storage.kv.get('fm-watch-captain:host_1'),undefined);assert.equal(f.seen.some(c=>c.includes('fm-session-start.sh')),false);assert.equal(readFileSync(join(f.base,'state/unrelated.status'),'utf8'),'UNRELATED SENTINEL\n');
 }finally{await f.clean();}
});
test('foreign source host refuses before any native command or captain registration',async()=>{
 const f=await setup(pins[1],{host:'host_foreign'});try{const result=await f.host.harness.behavior.runCli(['deck'],ctx);assert.equal(result.exitCode,1);assert.match(result.stderr,/another host/);assert.equal(f.seen.length,0);assert.equal(f.host.harness.sdk.callsTo('threads.updatePluginMetadata').length,0);}finally{await f.clean();}
});
test('unbound ACP contract/startup entrypoints refuse shared home, with supported deck command',async()=>{
 const f=await setup();try{for(const args of [['contract'],['fm','session-start','--json']]){const r=await f.host.harness.behavior.runCli(args,ctx);assert.equal(r.exitCode,1);assert.match(r.stderr,/bound.*home|No bound captain home/);assert.match(r.stderr,/firstmate deck/);}const tool=f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_fm');const r=await tool.execute({script:'session-start'},ctx);assert.equal(r.isError,true);assert.match(JSON.stringify(r),/bound captain home/);assert.equal(f.seen.length,0);assert.equal(f.host.harness.sdk.callsTo('files.read').length,0);}finally{await f.clean();}
});
test('captain setup cancellation settles registered CLI and closes a late terminal without claiming native startup',async()=>{
 const f=await setup();try {
 let resolve,started;const entered=new Promise(r=>started=r);f.host.harness.sdk.stub('terminals.create',()=>{started();return new Promise(r=>resolve=r);});const controller=new AbortController();const request=f.host.harness.behavior.runCli(['deck'],{...ctx,signal:controller.signal});await entered;controller.abort(new Error('caller stopped setup'));
 const outcome=await Promise.race([request,new Promise((_,reject)=>setTimeout(()=>reject(new Error('setup hung')),1000))]);assert.equal(outcome.exitCode,1);assert.match(outcome.stderr,/caller stopped setup/);assert.equal(await f.host.bb.storage.kv.get('fm-watch-captain:host_1'),undefined);resolve({id:'term_late'});await new Promise(r=>setTimeout(r,20));assert.equal(f.host.harness.sdk.callsTo('terminals.close').filter(c=>c[0].terminalId==='term_late').length,1);assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await f.clean();}
});
test('startup overall deadline names incomplete stage and preserves not-ready result',async()=>{
 const start=Date.now();await assert.rejects(boundedCaptainStartup([],async(signal,stage)=>{stage('native prerequisite');await new Promise(()=>{});},20),/not ready.*native prerequisite.*exceeded/);assert.ok(Date.now()-start<1000);
});
for(const entry of ['cli','tool'])test(`captain ${entry} contract cancellation settles a hung mandatory SDK read`,async()=>{
 const f=await setup();let release;
 try {
  await f.host.bb.storage.kv.set(`native-home:${ctx.threadId}`,f.base);
  await f.host.bb.storage.kv.set(`native-home-host:${ctx.threadId}`,'host_1');
  let entered;const started=new Promise(r=>entered=r);
  f.host.harness.sdk.stub('files.read',()=>{entered();return new Promise(r=>release=r);});
  const controller=new AbortController(),context={...ctx,signal:controller.signal};
  const request=entry==='cli'?f.host.harness.behavior.runCli(['contract'],context):f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_contract').execute({},context);
  await started;controller.abort(new Error('caller cancelled contract'));
  const outcome=await Promise.race([request,new Promise((_,reject)=>setTimeout(()=>reject(new Error('contract read hung')),1000))]);
  if(entry==='cli'){assert.equal(outcome.exitCode,1);assert.match(outcome.stderr,/Native contract read cancelled.*cancelled contract/);}
  else {assert.equal(outcome.isError,true);assert.match(JSON.stringify(outcome),/Native contract read cancelled.*cancelled contract/);}
  assert.equal(f.seen.length,0);assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{release?.({content:'# Fixture native contract',contentEncoding:'utf8',sizeBytes:25});await f.clean();}
});
