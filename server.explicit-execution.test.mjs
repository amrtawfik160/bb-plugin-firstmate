import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createFakePluginHost,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import {createLaunches} from './lib/launch.ts';
import {createDeliveries} from './lib/pr-delivery.ts';
import {replacementFixture} from './lib/replacement.fixture.mjs';
import {pins,run,ok} from './scripts/prompt-fixture.mjs';
const ctx={threadId:'thr_cap',projectId:'proj_1'};
const originalTask='Preserve the saved skill and continue the exact task.\n'.repeat(60);
const crew=(home='',relaunches=1)=>({id:'c1',task:originalTask,projectId:'proj_1',threadId:'thr_old',parentThreadId:'thr_cap',providerId:'codex',model:'old-model',reasoningLevel:'high',worktree:true,shape:'ship',posture:'direct-PR',nativeHome:home,relaunches,priorThreadIds:['thr_original'],createdAt:'2026-09-18T00:00:00.000Z',deliveryRequirement:'merged-and-verified'});
const change=(model='grok-4.6')=>['retry','c1','--intent','execution-change','--reason','User explicitly requested this execution change','--provider','acp-grok','--model',model,'--reasoning-level','xhigh'];
function commands(host,real=false) {
 const outputs=new Map(),seen=[];let n=0;
 host.harness.sdk.stub('terminals.create',async({start})=>{const id=`term${++n}`;seen.push(start.command);let output='';let code=0;
  if(real){const match=/^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(start.command);assert.ok(match);const inner=match[1].replace(/'\\''/g,"'");const result=spawnSync('bash',['-c',inner],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});code=result.status??2;output=(result.stdout??'')+(result.stderr??'');}
  outputs.set(id,output+`\n__FM_HOST_RC:${code}\n`);return{id};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));host.harness.sdk.stub('terminals.close',async()=>({}));host.harness.sdk.stub('terminals.output',async({terminalId})=>({nextSeq:1,chunks:[{dataBase64:Buffer.from(outputs.get(terminalId)).toString('base64')}]}));return seen;
}
function stubs(host,state,f) {
 host.harness.sdk.stub('threads.list',async()=>[]);host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>state.meta.get(threadId)??{});
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',parentThreadId:threadId==='thr_cap'?null:'thr_cap',status:'idle',providerId:state.execution.get(threadId)?.providerId??'codex',environmentId:'env_wt',archivedAt:state.archived.has(threadId)?1:null}));
 host.harness.sdk.stub('threads.defaultExecutionOptions',async({threadId})=>({permissionMode:'accept-edits',model:state.execution.get(threadId)?.model??'old-model',reasoningLevel:state.execution.get(threadId)?.reasoningLevel??'high'}));
 host.harness.sdk.stub('environments.get',async()=>({id:'env_wt',hostId:'host_1',status:'ready',isWorktree:true,path:f?.wt??'/wt'}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:f?.repo??'/repo'}]);
 host.harness.sdk.stub('providers.list',async()=>[{id:'codex',available:true,reasoningLevels:[{id:'high'},{id:'xhigh'}]},{id:'acp-grok',available:true,reasoningLevels:[{id:'xhigh'}]}]);
 host.harness.sdk.stub('providers.models',async({providerId})=>({models:(providerId==='acp-grok'?['grok-4.6','next-model']:['old-model']).map(id=>({id}))}));
 host.harness.sdk.stub('threads.stop',async()=>({}));host.harness.sdk.stub('threads.archive',async({threadId})=>{state.archived.add(threadId);return{};});
 host.harness.sdk.stub('threads.output',async()=>({output:'DONE: saved skill'}));host.harness.sdk.stub('threads.events.list',async()=>[]);
 host.harness.sdk.stub('threads.spawn',async input=>{
  const id=`thr_new${++state.n}`;assert.equal(input.environment.type,'reuse');assert.equal(input.environment.environmentId,'env_wt');assert.equal(input.permissionMode,'accept-edits');assert.equal(input.pluginMetadata.deliveryRequirement,'merged-and-verified');
  state.meta.set(id,input.pluginMetadata);state.execution.set(id,{providerId:input.providerId,model:input.model,reasoningLevel:input.reasoningLevel});return{id};
 });
}
async function factory(relaunches=1,f,previous,state={n:0,execution:new Map(),meta:new Map(),archived:new Set()}) {
 const host=previous??createFakePluginHost({pluginId:'firstmate',settings:f?{fmHome:f.home,fmHostId:'host_1'}:{}});if(!previous){await plugin(host.bb);await host.bb.storage.kv.set('crews',[crew(f?.home,relaunches)]);}
 stubs(host,state,f);return{host,state};
}
test('second user-directed execution change preserves same environment/task/contract and conservative legacy failure count',async()=>{
 const {host,state}=await factory();try {
 const pr=createDeliveries(host.bb.storage.database()).register({url:'https://github.com/o/r/pull/42',owner:'thr_cap',projectId:'proj_1',taskId:'c1',worker:'thr_old',home:'',requirement:'merged-and-verified'});
 const first=await host.harness.behavior.runCli(change(),ctx);assert.equal(first.exitCode,0,first.stderr);
 let saved=(await host.bb.storage.kv.get('crews'))[0];assert.equal(saved.relaunches,1);assert.equal(saved.replacementGeneration,3);assert.equal(saved.createdAt,crew().createdAt);assert.equal(saved.deliveryRequirement,'merged-and-verified');assert.equal(saved.nativeHome,'');
 const retry=host.harness.registrations.agentTools.find(t=>t.name==='firstmate_retry');const second=await retry.execute({crewId:'c1',intent:'execution-change',reason:'User requested the next explicit change',providerId:'acp-grok',model:'next-model',reasoningLevel:'xhigh'},ctx);assert.equal(typeof second,'string',JSON.stringify(second));
 saved=(await host.bb.storage.kv.get('crews'))[0];assert.equal(saved.relaunches,1);assert.equal(saved.replacementGeneration,4);assert.deepEqual(saved.priorThreadIds,['thr_original','thr_old','thr_new1']);assert.equal(saved.launchKey,createLaunches(host.bb.storage.database()).forTask('proj_1','thr_cap','c1').key);
 for(const args of host.harness.sdk.callsTo('threads.spawn').map(c=>c[0]))assert.ok(args.prompt.includes(originalTask));
 assert.equal(createDeliveries(host.bb.storage.database()).get(pr.id).requirement,'merged-and-verified');assert.equal(createDeliveries(host.bb.storage.database()).get(pr.id).owner,'thr_cap');
 const ordinary=await host.harness.behavior.runCli(['retry','c1','--model','another'],ctx);assert.equal(ordinary.exitCode,1);assert.match(ordinary.stderr,/second failure/);assert.equal(state.n,2);
 }finally{await host.harness.lifecycle.dispose();}
});
test('execution changes do not consume new failure allowance; ordinary recovery retains one replacement maximum',async()=>{
 const {host,state}=await factory(0);try {
 assert.equal((await host.harness.behavior.runCli(change(),ctx)).exitCode,0);
 assert.equal((await host.bb.storage.kv.get('crews'))[0].relaunches,0);
 const ordinary=await host.harness.behavior.runCli(['retry','c1','--model','next-model'],ctx);assert.equal(ordinary.exitCode,0,ordinary.stderr);assert.equal((await host.bb.storage.kv.get('crews'))[0].relaunches,1);assert.equal((await host.bb.storage.kv.get('crews'))[0].replacementGeneration,3);
 const last=await host.harness.behavior.runCli(['retry','c1','--model','third'],ctx);assert.equal(last.exitCode,1);assert.equal(state.n,2);
 }finally{await host.harness.lifecycle.dispose();}
});
for(const [name,args,context,pattern] of [
 ['missing intent',['retry','c1','--model','grok-4.6'],ctx,/second failure/],
 ['missing reason',['retry','c1','--intent','execution-change','--model','grok-4.6'],ctx,/user-directed reason/],
 ['no override',['retry','c1','--intent','execution-change','--reason','User change'],ctx,/explicit.*override/],
 ['unchanged',['retry','c1','--intent','execution-change','--reason','User change','--provider','codex','--model','old-model','--reasoning-level','high'],ctx,/actual.*change/],
 ['wrong owner',change(),{threadId:'thr_other',projectId:'proj_1'},/owning captain|No crew/],
 ['invalid provider',change().map(value=>value==='acp-grok'?'unknown':value),ctx,/Unknown provider/],
 ['invalid model',change('unknown'),ctx,/not in.*catalog/],
 ['invalid reasoning',change().map(value=>value==='xhigh'?'none':value),ctx,/does not advertise/],
 ['capacity override',[...change(),'--over-cap'],ctx,/capacity override/],
])test(`${name} refuses before source stop/archive or work changes`,async()=>{
 const {host}=await factory();try {const result=await host.harness.behavior.runCli(args,context);assert.equal(result.exitCode,1);assert.match(result.stderr,pattern);for(const method of ['threads.spawn','threads.stop','threads.archive','threads.send'])assert.equal(host.harness.sdk.callsTo(method).length,0);assert.equal((await host.bb.storage.kv.get('crews'))[0].threadId,'thr_old');}finally{await host.harness.lifecycle.dispose();}
});
test('concurrent execution changes and durable uncertain reload reconcile one exact generation without a duplicate or repeated stop',async()=>{
 let {host,state}=await factory();try {
 let metadata;host.harness.sdk.stub('threads.spawn',async input=>{metadata=input.pluginMetadata;state.meta.set('thr_late',metadata);state.execution.set('thr_late',{providerId:'acp-grok',model:'grok-4.6',reasoningLevel:'xhigh'});throw new Error('504 after creation');});
 const outcomes=await Promise.all([1,2].map(()=>host.harness.behavior.runCli(change(),ctx)));assert.ok(outcomes.every(r=>r.exitCode===1));assert.equal(host.harness.sdk.callsTo('threads.spawn').length,1);assert.equal(host.harness.sdk.callsTo('threads.stop').length,1);assert.equal(host.harness.sdk.callsTo('threads.archive').length,1);
 const reservation=createLaunches(host.bb.storage.database()).forTask('proj_1','thr_cap','c1');assert.equal(reservation.generation,3);assert.equal(reservation.state,'uncertain');assert.equal(reservation.replacement.intent,'execution-change');
 host=await host.harness.lifecycle.reload(plugin);stubs(host,state);host.harness.sdk.stub('threads.list',async()=>[makeThreadResponse({id:'thr_late',projectId:'proj_1',parentThreadId:'thr_cap'})]);
 const wrong=await host.harness.behavior.runCli(change('next-model'),ctx);assert.equal(wrong.exitCode,1);assert.match(wrong.stderr,/immutable request/);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);
 const repaired=await host.harness.behavior.runCli(change(),ctx);assert.equal(repaired.exitCode,0,repaired.stderr);const saved=(await host.bb.storage.kv.get('crews'))[0];assert.equal(saved.threadId,'thr_late');assert.equal(saved.relaunches,1);assert.equal(saved.replacementGeneration,3);assert.equal(saved.deliveryRequirement,'merged-and-verified');
 assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(host.harness.sdk.callsTo('threads.stop').length,0);assert.equal(host.harness.sdk.callsTo('threads.archive').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});
for(const pin of pins) for(const [shape,mode] of [['ship','direct-PR'],['ship','no-mistakes'],['ship','local-only'],['scout','direct-PR']])test(`real native ${pin.slice(0,8)} ${shape}/${mode} preserves branch/work/contract during explicit replacement`,async()=>{
 const f=replacementFixture(pin,shape,mode);let host;try {
 ({host}=await factory(1,f));const original=crew(f.home);await host.bb.storage.kv.set('crews',[{...original,task:f.task,shape,posture:mode}]);const seen=commands(host,true);const before=f.invariant();
 const result=await host.harness.behavior.runCli(change(),ctx);assert.equal(result.exitCode,0,result.stderr);assert.deepEqual(f.invariant(),before);
 const meta=readFileSync(join(f.home,'state/c1.meta'),'utf8');assert.match(meta,/^bb_thread_id=thr_new1$/m);assert.match(meta,/^spawn_gen=bb-r3$/m);assert.match(meta,/^native_extra=keep$/m);if(shape==='ship'){assert.match(meta,/^branch=fm\/c1$/m);assert.ok(meta.includes(`mode=${mode}`));assert.match(meta,/^yolo=off$/m);}
 const spawned=host.harness.sdk.callsTo('threads.spawn')[0][0];assert.equal(spawned.environment.environmentId,'env_wt');assert.ok(spawned.prompt.includes(f.task));assert.equal(spawned.pluginMetadata.shape,shape);assert.equal(spawned.pluginMetadata.nativeHome,f.home);
 assert.equal(seen.filter(c=>c.includes('/fm-worker-rebind.sh') && (c.includes('--check')||c.includes('--publish'))).length,2);assert.equal(host.harness.sdk.callsTo('threads.send').length,0);assert.equal(host.harness.sdk.callsTo('environments.remove').length,0);
 }finally{if(host)await host.harness.lifecycle.dispose();f.clean();}
});
test('unreadable execution catalogs refuse before source mutation',async()=>{
 const {host}=await factory();try {
 host.harness.sdk.stub('providers.list',async()=>{throw new Error('catalog unavailable');});const result=await host.harness.behavior.runCli(change(),ctx);assert.equal(result.exitCode,1);assert.match(result.stderr,/catalog unreadable/);assert.equal(host.harness.sdk.callsTo('threads.stop').length,0);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});
test('native publication plus failed crew cache write recovers across reload without stopping or replacing again',async()=>{
 const f=replacementFixture();let {host,state}=await factory(1,f);try {
 await host.bb.storage.kv.set('crews',[{...crew(f.home),task:f.task}]);commands(host,true);const before=f.invariant();
 const set=host.bb.storage.kv.set;let injected=false;host.bb.storage.kv.set=async(key,value)=>{if(key==='crews' && value.some(c=>c.threadId==='thr_new1') && !injected){injected=true;throw new Error('cache publication failure');}return set(key,value);};
 const failure=await host.harness.behavior.runCli(change(),ctx);assert.equal(failure.exitCode,1);assert.match(failure.stderr,/cache publication failure/);assert.equal(state.n,1);assert.deepEqual(f.invariant(),before);assert.match(readFileSync(join(f.home,'state/c1.meta'),'utf8'),/^bb_thread_id=thr_new1$/m);assert.equal(createLaunches(host.bb.storage.database()).forTask('proj_1','thr_cap','c1').state,'provisioning');
 await host.bb.storage.kv.set('crews',[]);host=await host.harness.lifecycle.reload(plugin);stubs(host,state,f);commands(host,true);host.harness.sdk.stub('threads.list',async()=>[makeThreadResponse({id:'thr_new1',projectId:'proj_1',parentThreadId:'thr_cap'})]);
 const recovered=await host.harness.behavior.runCli(change(),ctx);assert.equal(recovered.exitCode,0,recovered.stderr);assert.equal(state.n,1);assert.equal(host.harness.sdk.callsTo('threads.stop').length,0);assert.equal(host.harness.sdk.callsTo('threads.archive').length,0);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);assert.deepEqual(f.invariant(),before);assert.equal((await host.bb.storage.kv.get('crews'))[0].replacementGeneration,3);assert.equal(createLaunches(host.bb.storage.database()).forTask('proj_1','thr_cap','c1').replacement.published,true);
 }finally{await host.harness.lifecycle.dispose();f.clean();}
});
for(const pin of pins)for(const intent of ['execution-change','failure-recovery'])test(`final replacement journal write fault resumes exact ${intent} after cache publication/reload on ${pin.slice(0,8)}`,async()=>{
 const f=replacementFixture(pin);let {host,state}=await factory(intent==='execution-change'?1:0,f);try {
 const source={...crew(f.home,intent==='execution-change'?1:0),task:f.task};await host.bb.storage.kv.set('crews',[source]);commands(host,true);const before=f.invariant();
 const args=change().map(v=>v==='execution-change'?intent:v);const db=host.bb.storage.database();
 db.exec("CREATE TRIGGER reject_final BEFORE UPDATE ON launches WHEN json_extract(NEW.record,'$.replacement.published')=1 BEGIN SELECT RAISE(ABORT,'final publication fault'); END");
 const failed=await host.harness.behavior.runCli(args,ctx);assert.equal(failed.exitCode,1);assert.match(failed.stderr,/final publication fault/);assert.equal(state.n,1);
 const cached=(await host.bb.storage.kv.get('crews'))[0];assert.equal(cached.threadId,'thr_new1');assert.equal(cached.relaunches,1);
 const pending=createLaunches(db).forTask('proj_1','thr_cap','c1');assert.equal(pending.state,'provisioning');assert.notEqual(pending.replacement.published,true);assert.equal(pending.replacement.sourceThreadId,'thr_old');assert.deepEqual(pending.replacement.sourceCrew,{...source,taskSpilled:false});assert.deepEqual(f.invariant(),before);assert.match(readFileSync(join(f.home,'state/c1.meta'),'utf8'),/^branch=fm\/c1$/m);
 db.exec('DROP TRIGGER reject_final');host=await host.harness.lifecycle.reload(plugin);stubs(host,state,f);commands(host,true);
 const changed=await host.harness.behavior.runCli(args.map(v=>v==='grok-4.6'?'next-model':v),ctx);assert.equal(changed.exitCode,1);assert.match(changed.stderr,/immutable request/);
 const retry=host.harness.registrations.agentTools.find(t=>t.name==='firstmate_retry');const result=await retry.execute({crewId:'c1',intent,reason:'User explicitly requested this execution change',providerId:'acp-grok',model:'grok-4.6',reasoningLevel:'xhigh'},ctx);assert.equal(typeof result,'string',JSON.stringify(result));
 const completed=createLaunches(host.bb.storage.database()).forTask('proj_1','thr_cap','c1');assert.equal(completed.state,'running');assert.equal(completed.replacement.published,true);assert.equal(completed.key,pending.key);assert.equal(completed.generation,pending.generation);assert.deepEqual(completed.replacement.sourceCrew,pending.replacement.sourceCrew);assert.equal(completed.replacement.sourceThreadId,'thr_old');
 const saved=(await host.bb.storage.kv.get('crews'))[0];assert.equal(saved.threadId,'thr_new1');assert.equal(saved.createdAt,source.createdAt);assert.equal(saved.deliveryRequirement,'merged-and-verified');assert.equal(saved.relaunches,1);assert.deepEqual(saved.priorThreadIds,['thr_original','thr_old']);assert.deepEqual(f.invariant(),before);assert.match(readFileSync(join(f.home,'state/c1.meta'),'utf8'),/^branch=fm\/c1$/m);
 assert.equal(state.n,1);for(const method of ['threads.spawn','threads.stop','threads.archive','threads.send','threads.retry','environments.remove'])assert.equal(host.harness.sdk.callsTo(method).length,0,method);
 }finally{await host.harness.lifecycle.dispose();f.clean();}
});
test('native rebind refuses branch collision and a primary checkout before publication, leaving every source byte/work intact',()=>{
 const f=replacementFixture();try {
 const before=f.invariant();const plan={home:f.home,owner:'thr_cap',taskId:'c1',sourceThreadId:'thr_old',threadId:'thr_new',worktree:f.wt,project:f.repo,shape:'ship',mode:'direct-PR',generation:3,providerId:'acp-grok',model:'grok-4.6',reasoningLevel:'xhigh'};
 const invoke=p=>spawnSync('bash',[join(f.home,'bin-bb/fm-worker-rebind.sh'),'--publish'],{input:JSON.stringify(p),encoding:'utf8',env:{...process.env,FM_HOME:f.home,FM_BACKEND:'bb'},timeout:15000});
 const metaPath=join(f.home,'state/c1.meta');writeFileSync(metaPath,f.meta.replace('branch=fm/c1\n','branch=fm/c1-disclosures\n'));const collision=invoke(plan);assert.notEqual(collision.status,0);assert.match(collision.stderr,/immutable source branch conflict/);assert.deepEqual(f.invariant(),before);assert.equal(readFileSync(metaPath,'utf8'),f.meta.replace('branch=fm/c1\n','branch=fm/c1-disclosures\n'));
 writeFileSync(metaPath,f.meta.replace(`worktree=${f.wt}\n`,`worktree=${f.repo}\n`));const primary=invoke({...plan,worktree:f.repo});assert.notEqual(primary.status,0);assert.match(primary.stderr,/isolation guard/);assert.deepEqual(f.invariant(),before);
 }finally{f.clean();}
});
test('cache loss recovers current seeded replacement with full task and bounded recovery history, never its archived source',async()=>{
 let {host,state}=await factory();try {
 const first=await host.harness.behavior.runCli(change(),ctx);assert.equal(first.exitCode,0,first.stderr);await host.bb.storage.kv.set('crews',[]);
 host=await host.harness.lifecycle.reload(plugin);stubs(host,state);host.harness.sdk.stub('threads.list',async()=>[makeThreadResponse({id:'thr_old',projectId:'proj_1',parentThreadId:'thr_cap'}),makeThreadResponse({id:'thr_new1',projectId:'proj_1',parentThreadId:'thr_cap'})]);
 state.meta.set('thr_old',{crew:'true',crewId:'c1',task:originalTask.slice(0,500),nativeHome:'',shape:'ship',posture:'direct-PR',worktree:true});
 const inspect=await host.harness.behavior.runCli(['crew','c1'],ctx);assert.equal(inspect.exitCode,0,inspect.stderr);const current=(await host.bb.storage.kv.get('crews'))[0];assert.equal(current.threadId,'thr_new1');assert.equal(current.relaunches,1);assert.equal(current.replacementGeneration,3);assert.equal(current.createdAt,crew().createdAt);assert.deepEqual(current.priorThreadIds,['thr_original','thr_old']);
 const next=await host.harness.behavior.runCli(change('next-model'),ctx);assert.equal(next.exitCode,0,next.stderr);assert.ok(host.harness.sdk.callsTo('threads.spawn')[0][0].prompt.includes(originalTask));assert.equal((await host.bb.storage.kv.get('crews'))[0].replacementGeneration,4);
 }finally{await host.harness.lifecycle.dispose();}
});
test('authoritative deletion after creation refuses native rebind and keeps the source cache/work intact',async()=>{
 const f=replacementFixture();const {host,state}=await factory(1,f);try {
 await host.bb.storage.kv.set('crews',[{...crew(f.home),task:f.task}]);const seen=commands(host,true);const before=f.invariant();
 host.harness.sdk.stub('threads.defaultExecutionOptions',async({threadId})=>{
  if(threadId==='thr_new1'){createLaunches(host.bb.storage.database()).workerDeleted(threadId);return{permissionMode:'accept-edits',model:'grok-4.6',reasoningLevel:'xhigh'};}
  return{permissionMode:'accept-edits',model:'old-model',reasoningLevel:'high'};
 });
 const failed=await host.harness.behavior.runCli(change(),ctx);assert.equal(failed.exitCode,1);assert.match(failed.stderr,/Replacement was deleted/);assert.equal(state.n,1);assert.equal((await host.bb.storage.kv.get('crews'))[0].threadId,'thr_old');assert.deepEqual(f.invariant(),before);assert.equal(readFileSync(join(f.home,'state/c1.meta'),'utf8'),f.meta);assert.equal(seen.filter(c=>c.includes('/fm-worker-rebind.sh') && c.includes('--publish')).length,0);
 }finally{await host.harness.lifecycle.dispose();f.clean();}
});
