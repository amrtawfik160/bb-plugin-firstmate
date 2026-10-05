import assert from 'node:assert/strict';
import test from 'node:test';
import {inflateSync} from 'node:zlib';
import {mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pins,fixture,run,ok,overlay} from './scripts/prompt-fixture.mjs';
import {createFakePluginHost,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';

const captain='thr_mhk69hwvxe', projectId='proj_5s59gfpfqq';
const reportedHome='/root/firstmate-bb-homes/thr_mhk69hwvxe';
function unwrap(command) {
 const match=/^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(command);
 assert.ok(match,'actual host wrapper');return match[1].replace(/'\\''/g,"'");
}
const quote=text=>`'${text.replace(/'/g,"'\\''")}'`;
async function factory(home=reportedHome,options={},replacement) {
 const host=replacement??createFakePluginHost({pluginId:'firstmate',settings:{fmHome:home,fmHostId:'host_m4jkvpkw67'}});
 if(!replacement) await plugin(host.bb);await host.bb.storage.kv.set(`native-home:${captain}`,home);
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId,environmentId:'env_cap'}));
 host.harness.sdk.stub('environments.get',async()=>({id:'env_cap',hostId:'host_m4jkvpkw67'}));
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({captain:'true',nativeHome:home}));
 const commands=new Map(),files=new Map(),scripts=[],seen=[],actions=[];let n=0;
 host.harness.sdk.stub('terminals.create',async({start})=>{
  assert.ok(start.command.length<=10000,`full command length ${start.command.length}`);
  if(options.throwOnAppend && unwrap(start.command).startsWith("printf '%s' ")) throw new Error('HTTP 504: staging transport unavailable');
  const id=`terminal_${++n}`;commands.set(id,unwrap(start.command));seen.push(start.command);return{id};
 });
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{
  const cmd=commands.get(terminalId);let match;
  const failed=options.failAt==='init'&&cmd.startsWith('mkdir -p ') || options.failAt==='append'&&cmd.startsWith("printf '%s' ") || options.failAt==='rename'&&cmd.startsWith('base64 -d ');
  if(failed) return{nextSeq:1,chunks:[{dataBase64:Buffer.from('injected stage-write failure\n__FM_HOST_RC:1\n').toString('base64')}]};
  if(options.realRoot) {
   if((match=/^bash '(\/tmp\/\.fm-receipt-[^']+)'$/.exec(cmd))) scripts.push(readFileSync(match[1],'utf8'));
   const r=spawnSync('bash',['-c',cmd],{cwd:options.realRoot,encoding:'utf8',timeout:30000});
   return{nextSeq:1,chunks:[{dataBase64:Buffer.from((r.stdout??'')+(r.stderr??'')+`\n__FM_HOST_RC:${r.status??1}\n`).toString('base64')}]};
  }
  if((match=/^mkdir -p '[^']*' && : > '([^']+)'$/.exec(cmd))) files.set(match[1],'');
  if((match=/^printf '%s' '([^']*)' >> '([^']+)'$/.exec(cmd))) files.set(match[2],(files.get(match[2])??'')+match[1]);
  if((match=/^base64 -d '([^']+)' > '([^']+)' && mv -f '[^']+' '([^']+)'$/.exec(cmd))) {
   files.set(match[3],Buffer.from(files.get(match[1])??'','base64').toString());
   options.abortAfterRename?.abort(new Error('cancelled after staged publication'));
  }
  if(cmd.startsWith('rm -f ')) for(const path of files.keys()) if(cmd.includes(quote(path)) || [...cmd.matchAll(/'(\/tmp\/\.fm-receipt-[^']+\.sh)'\.fm-/g)].some(m=>path.startsWith(m[1]+'.fm-'))) files.delete(path);
  let output='';
  if((match=/^bash '(\/tmp\/\.fm-receipt-[^']+)'$/.exec(cmd))) {
   const script=files.get(match[1]);assert.ok(script);scripts.push(script);
   const action=/ '(receive|inspect|begin-action|mark-success|complete|legacy-ack)' '([^']*)' "\$FM_BINDIR\/fm-wake-drain.sh"/.exec(script);assert.ok(action);actions.push({action:action[1],id:action[2],script});
   output='FM_BB_RECEIPT='+JSON.stringify({id:'a'.repeat(32),phase:'ready',report:'retained report',path:home+'/state/report',replayed:false,truncated:false})+'\n';
  }
  return{nextSeq:1,chunks:[{dataBase64:Buffer.from(output+'\n__FM_HOST_RC:0\n').toString('base64')}]};
 });
 const f={host,files,scripts,seen,actions,ctx:{threadId:captain,projectId}};
 f.tool=name=>f.host.harness.inspection.registrations.agentTools.find(t=>t.name===name);
 return f;
}

test('reported captain wake command fits the full host limit before any receipt execution',async()=>{
 const f=await factory();try {
  const result=await f.tool('firstmate_wake').execute({},f.ctx);
  if(typeof result!=='string') {assert.equal(f.seen.length,0,'pre-fix cap must fail before any native/host execution');assert.equal(f.scripts.length,0);}
  assert.equal(typeof result,'string',JSON.stringify(result));assert.match(result,/WAKE_RECEIPT/);
  assert.equal(f.scripts.length,1);assert.ok(f.seen.length>1,'receipt is staged before execution');
 }finally{await f.host.harness.lifecycle.dispose();}
});

test('receipt callers retain actions, IDs, guards and per-captain state with long quoted home',async()=>{
 const home='/fixture '+"'quoted $() ; "+'long-path/'.repeat(190);
 const f=await factory(home);try {
  const read=await f.tool('firstmate_wake').execute({},f.ctx);assert.equal(typeof read,'string',JSON.stringify(read));
  const id='a'.repeat(32);
  const success=await f.tool('firstmate_memory').execute({action:'show',handledWake:id},f.ctx);assert.equal(typeof success,'string',JSON.stringify(success));
  const completed=await f.tool('firstmate_wake').execute({handledWake:id},f.ctx);assert.equal(typeof completed,'string',JSON.stringify(completed));
  const legacy=await f.tool('firstmate_wake').execute({ackThrough:123,recoveryGeneration:'generation_'+ 'x'.repeat(900)},f.ctx);assert.equal(typeof legacy,'string',JSON.stringify(legacy));
  const generic=await f.tool('firstmate_fm').execute({script:'wake-drain',args:[]},f.ctx);assert.equal(typeof generic,'string',JSON.stringify(generic));
  const cli=await f.host.harness.behavior.runCli(['wake'],{...f.ctx,threadId:'thr_otherCaptain'});assert.equal(cli.exitCode,0,cli.stderr);
  assert.deepEqual(f.actions.map(row=>row.action),['receive','begin-action','mark-success','complete','complete','legacy-ack','receive','receive']);
  for(const row of f.actions) {
   assert.match(row.script,/FM_MIRROR_STALE/);assert.match(row.script,/expected=json.loads/);
   assert.ok(row.script.includes(quote(home)));assert.ok(row.script.length>10000,'full composition requires staging');
   assert.ok(inflateSync(Buffer.from(/base64.b64decode\("([A-Za-z0-9+/=]+)"\)/.exec(row.script)[1],'base64')).toString().includes('class Journal'));
  }
  assert.ok(f.actions.slice(0,-1).every(row=>row.script.includes(quote(home+'/state'))));
  assert.ok(f.actions.at(-1).script.includes(quote(home+'/state/cap-thr_otherCaptain')));
  assert.ok(!f.actions.at(-1).script.includes(quote(home+'/state')));
  assert.ok(f.actions.filter(row=>['begin-action','mark-success','complete'].includes(row.action)).every(row=>row.id===id));
  assert.equal(f.actions.find(row=>row.action==='legacy-ack').id,'123:generation_'+ 'x'.repeat(900));
  assert.equal(f.files.size,0,'staged command and writer scratch files are cleaned');
 }finally{await f.host.harness.lifecycle.dispose();}
});

for(const failAt of ['init','append','rename']) test(`receipt ${failAt} stage-write failure executes and acknowledges nothing`,async()=>{
 const f=await factory(reportedHome,{failAt});try {
  const result=await f.tool('firstmate_wake').execute({handledWake:'a'.repeat(32)},f.ctx);
  assert.equal(result.isError,true);assert.match(JSON.stringify(result),/Failed to stage wake receipt command/);
  assert.equal(f.actions.length,0);assert.equal(f.scripts.length,0);assert.equal(f.files.size,0);
  assert.equal(f.host.harness.sdk.callsTo('threads.send').length,0);
 }finally{await f.host.harness.lifecycle.dispose();}
});

test('cancel after staged command publication cleans receipt files without executing or acknowledging',async()=>{
 const controller=new AbortController(),f=await factory(reportedHome,{abortAfterRename:controller});try {
  const result=await f.tool('firstmate_wake').execute({handledWake:'a'.repeat(32)},{...f.ctx,signal:controller.signal});
  assert.equal(result.isError,true);assert.equal(f.actions.length,0);assert.equal(f.scripts.length,0);assert.equal(f.files.size,0);
 }finally{await f.host.harness.lifecycle.dispose();}
});

test('staging transport error retains its cause without running a receipt',async()=>{
 const f=await factory(reportedHome,{throwOnAppend:true});try {
  const result=await f.tool('firstmate_wake').execute({},f.ctx);assert.equal(result.isError,true);
  assert.match(JSON.stringify(result),/HTTP 504: staging transport unavailable/);assert.equal(f.actions.length,0);assert.equal(f.files.size,0);
 }finally{await f.host.harness.lifecycle.dispose();}
});

for(const pin of pins) test(`actual guarded receipt transport ${pin.slice(0,8)} preserves reports and captain isolation across reload`,async()=>{
 const original=fixture(pin),root=original+'-receipt';mkdirSync(root);
 const home=join(root,"quoted ' $(touch injected) ; home",...Array.from({length:7},(_,i)=>`${i}-`+'long-source-'.repeat(12)));
 mkdirSync(dirname(home),{recursive:true});renameSync(original,home);
 ok(run('python3',[join(overlay,'install-bb-backend.py'),'--home',home]));
 let f=await factory(home,{realRoot:root});try {
  const state=join(home,'state'),other=join(home,'state/cap-thr_otherCaptain');mkdirSync(state,{recursive:true});mkdirSync(other,{recursive:true});
  const append=(dir,text)=>ok(run('bash',['-c','. "$1"; fm_wake_append signal worker.status "$2"','fixture',join(home,'bin/fm-wake-lib.sh'),text],{FM_HOME:home,FM_ROOT_OVERRIDE:home,FM_STATE_OVERRIDE:dir}));
  append(state,'first retained native report');append(other,'another captain report');
  const otherBefore=readFileSync(join(other,'.wake-queue'),'utf8');const queueBefore=readFileSync(join(state,'.wake-queue'),'utf8');
  const first=await f.tool('firstmate_wake').execute({},f.ctx);assert.equal(typeof first,'string',JSON.stringify(first));assert.match(first,/first retained native report/);
  const id=/WAKE_RECEIPT: ([a-f0-9]+)/.exec(first)[1];const journal=join(state,'.bb-wake-receipt.json');assert.equal(JSON.parse(readFileSync(journal)).id,id);
  assert.equal(readFileSync(join(state,'.wake-queue'),'utf8'),queueBefore,'presentation is not acknowledgement');
  assert.equal(readFileSync(join(other,'.wake-queue'),'utf8'),otherBefore);
  const failedTransport=await factory(home,{realRoot:root,failAt:'rename'});try {
   const failed=await failedTransport.tool('firstmate_wake').execute({handledWake:id},failedTransport.ctx);assert.equal(failed.isError,true);
   assert.equal(failedTransport.scripts.length,0);assert.equal(readFileSync(join(state,'.wake-queue'),'utf8'),queueBefore);assert.equal(JSON.parse(readFileSync(journal)).phase,'ready');
   assert.equal(readFileSync(join(other,'.wake-queue'),'utf8'),otherBefore);
  }finally{await failedTransport.host.harness.lifecycle.dispose();}
  // Exercise inspect through the exact full guarded script rendered by the
  // actual factory. Inspect has no public caller today; no test-only API is added.
  const inspectedScript=f.scripts[0].replace(" 'receive' '' ",` 'inspect' '${id}' `);assert.notEqual(inspectedScript,f.scripts[0]);
  const inspectPath=join(root,'inspect.sh');writeFileSync(inspectPath,inspectedScript);
  const inspected=ok(run('bash',[inspectPath]));assert.equal(JSON.parse(inspected.slice('FM_BB_RECEIPT='.length)).id,id);
  assert.equal(readFileSync(join(state,'.wake-queue'),'utf8'),queueBefore);
  const beforeReloadCommands=[...f.seen];f=await factory(home,{realRoot:root},await f.host.harness.lifecycle.reload(plugin));
  const replay=await f.tool('firstmate_wake').execute({},f.ctx);assert.match(replay,new RegExp(`WAKE_RECEIPT: ${id} \\(replayed\\)`));
  append(state,'later unhandled native report');
  const success=await f.tool('firstmate_memory').execute({action:'show',handledWake:id},f.ctx);assert.equal(typeof success,'string',JSON.stringify(success));assert.doesNotMatch(success,/completion is unconfirmed/);assert.match(success,/later unhandled native report/);
  const remaining=readFileSync(join(state,'.wake-queue'),'utf8');assert.match(remaining,/later unhandled native report/);assert.doesNotMatch(remaining,/first retained native report/);
  const successor=JSON.parse(readFileSync(journal));assert.notEqual(successor.id,id);assert.equal(successor.phase,'ready');
  const rejected=await f.tool('firstmate_wake').execute({ackThrough:0,recoveryGeneration:'wrong'},f.ctx);assert.equal(rejected.isError,true);assert.equal(readFileSync(join(state,'.wake-queue'),'utf8'),remaining);
  const legacy=await f.tool('firstmate_fm').execute({script:'wake-drain',args:['--ack-through',String(successor.pair.through),'--recovery-generation',successor.pair.generation]},f.ctx);assert.equal(typeof legacy,'string',JSON.stringify(legacy));assert.equal(readFileSync(join(state,'.wake-queue'),'utf8'),'');
  assert.equal(readFileSync(join(other,'.wake-queue'),'utf8'),otherBefore);assert.equal(existsSync(join(root,'injected')),false,'quoted home cannot execute its contents');
  assert.ok([...beforeReloadCommands,...f.seen].every(cmd=>cmd.length<=10000));assert.ok(f.scripts.every(cmd=>cmd.length>10000));
  for(const method of ['threads.spawn','threads.send','threads.retry']) assert.equal(f.host.harness.sdk.callsTo(method).length,0);
  for(const cmd of [...beforeReloadCommands,...f.seen]) {const inner=unwrap(cmd);const match=/^bash '([^']+)'$/.exec(inner);if(match) assert.equal(existsSync(match[1]),false,'receipt temp script cleaned');}
 }finally{await f.host.harness.lifecycle.dispose();rmSync(root,{recursive:true,force:true});}
});
