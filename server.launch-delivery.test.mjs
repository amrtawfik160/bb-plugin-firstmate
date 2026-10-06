import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost,makeThreadResponse,makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries } from './lib/pr-delivery.ts';
import { createLaunches } from './lib/launch.ts';
import { rpcContract } from './rpc.ts';
import { UPSTREAM_SKILL_NAMES } from './lib/upstream-surface.ts';
import { runPty,mergedJson } from './lib/host-capture.fixture.mjs';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const row=(n,shape='ship')=>({id:`c${n}`,task:'fix login',projectId:'proj_1',threadId:`thr_c${n}`,parentThreadId:'thr_cap',providerId:null,model:null,reasoningLevel:null,worktree:true,shape,posture:shape==='scout'?'scout':'direct-PR',createdAt:'2026-09-18T00:00:00.000Z'});
const ctx={threadId:'thr_cap',projectId:'proj_1'};
function hostCommands(host,answer) {
 const commands=new Map();let n=0;
 host.harness.sdk.stub('terminals.create',async args=>{const id=`term${++n}`;commands.set(id,args.start.command);return{id};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{const command=commands.get(terminalId);const out=answer(command);const captured=command.includes('FM_HOST_CAPTURE_V1');const payload=captured?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:out.code??0,stdout:out.payload??'',stderr:out.stderr??''}):out.payload??'';return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:${captured?0:out.code ?? 0}\n`).toString('base64')}]};});
 return commands;
}
async function base(settings={}) {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain','skill-routing','calm','catch-up','captain-methods','worker-methods',...UPSTREAM_SKILL_NAMES],settings});await plugin(host.bb);
 commonStubs(host);return host;
}
function commonStubs(host) {
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'active',environmentId:'env_wt'}));
 host.harness.sdk.stub('threads.defaultExecutionOptions',async()=>({permissionMode:'accept-edits',model:'project-model',reasoningLevel:'high'}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('environments.get',async()=>({id:'env_wt',hostId:'host_1',status:'ready',isWorktree:true,path:'/wt'}));
 host.harness.sdk.stub('threads.output',async()=>({output:'DONE: report complete'}));
 host.harness.sdk.stub('threads.events.list',async()=>[]);
}
test('replacement validates reasoning on the reused host before stopping and records actual execution',async()=>{
 const host=await base();try {
 await host.bb.storage.kv.set('crews',[{...row(1),providerId:'selected-provider'}]);
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'error',providerId:'selected-provider',environmentId:'env_wt'}));
 host.harness.sdk.stub('providers.list',async({hostId})=>{assert.equal(hostId,'host_1');return[{id:'selected-provider',available:true,reasoningLevels:[{id:'ultra'}]}];});
 const rejected=await host.harness.behavior.runCli(['retry','c1','--reasoning-level','none'],ctx);
 assert.equal(rejected.exitCode,1);assert.match(rejected.stderr,/does not advertise reasoning/);
 assert.equal(host.harness.sdk.callsTo('threads.stop').length,0);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);
 const actions=[];
 host.harness.sdk.stub('threads.stop',async()=>{actions.push('stop');return{};});
 host.harness.sdk.stub('threads.archive',async()=>{actions.push('archive');return{};});
 host.harness.sdk.stub('threads.spawn',async input=>{actions.push('spawn');assert.equal(input.reasoningLevel,'ultra');assert.equal(input.environment.environmentId,'env_wt');return{id:'thr_replacement'};});
 host.harness.sdk.stub('threads.defaultExecutionOptions',async()=>({permissionMode:'accept-edits',model:'resolved-model',reasoningLevel:'ultra'}));
 const replaced=await host.harness.behavior.runCli(['retry','c1','--reasoning-level','ultra'],ctx);assert.equal(replaced.exitCode,0,replaced.stderr);
 assert.deepEqual(actions,['stop','archive','spawn']);
 const record=createLaunches(host.bb.storage.database()).list('thr_cap')[0];
 assert.equal(record.execution.model,'resolved-model');assert.equal(record.execution.reasoningLevel,'ultra');assert.equal(record.hostId,'host_1');
 }finally{await host.harness.lifecycle.dispose();}
});
test('uncertain replacement reconciles its reserved slot at capacity before any fresh attempt',async()=>{
 const host=await base({maxActiveCrews:1});try {
 await host.bb.storage.kv.set('crews',[row(1)]);
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:threadId==='thr_replacement'?'pending':'error',environmentId:'env_wt'}));
 host.harness.sdk.stub('threads.stop',async()=>({}));host.harness.sdk.stub('threads.archive',async()=>({}));
 let metadata;
 host.harness.sdk.stub('threads.spawn',async input=>{metadata=input.pluginMetadata;throw new Error('HTTP 504 after core created the replacement');});
 const first=await host.harness.behavior.runCli(['retry','c1','--reasoning-level','high'],ctx);assert.equal(first.exitCode,1);
 assert.equal(createLaunches(host.bb.storage.database()).list('thr_cap')[0].state,'uncertain');
 host.harness.sdk.stub('threads.list',async()=>[makeThreadResponse({id:'thr_replacement',projectId:'proj_1',parentThreadId:'thr_cap'})]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>metadata);
 const recovered=await host.harness.behavior.runCli(['retry','c1','--reasoning-level','high'],ctx);assert.equal(recovered.exitCode,0,recovered.stderr);
 assert.equal(host.harness.sdk.callsTo('threads.spawn').length,1);assert.equal(host.harness.sdk.callsTo('threads.stop').length,1);
 assert.equal((await host.bb.storage.kv.get('crews'))[0].threadId,'thr_replacement');
 }finally{await host.harness.lifecycle.dispose();}
});
test('dispatch admission fixes actual concurrent cap probe; finished scout promotion also reserves capacity',async()=>{
 const host=await base();try {
 await host.bb.storage.kv.set('crews',[1,2,3,4,5,6,7,8,9].map(n=>row(n)));
 let spawned=0;host.harness.sdk.stub('threads.spawn',async()=>{spawned++;await new Promise(r=>setTimeout(r,10));return{id:'thr_new'};});
 const results=await Promise.all(['a','b'].map(task=>host.harness.behavior.runCli(['dispatch','--project','proj_1','--',task],ctx)));
 assert.equal(spawned,1);assert.equal(results.filter(r=>r.exitCode===0).length,1);assert.match(results.find(r=>r.exitCode!==0).stderr,/cap reached/);
 await host.bb.storage.kv.set('crews',[...[1,2,3,4,5,6,7,8,9,10].map(n=>row(n)),row(11,'scout')]);
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:threadId==='thr_c11'?'idle':'active'}));
 const promoted=await host.harness.behavior.runCli(['promote','c11'],ctx);assert.equal(promoted.exitCode,1);assert.match(promoted.stderr,/cap reached/);assert.equal(spawned,1);
 }finally{await host.harness.lifecycle.dispose();}
});
test('native bridge seeds role/home/generation before initial configuration and never invokes mark after creation',async()=>{
 const host=await base({fmHome:'/native'});try {
 hostCommands(host,()=>({code:0}));
 host.harness.sdk.stub('files.read',async()=>({content:'Native validated brief',contentEncoding:'utf8',sizeBytes:22}));
 let roleChecked=false;
 host.harness.sdk.stub('threads.spawn',async input=>{
  const configuration=await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({pluginMetadata:input.pluginMetadata}));
  assert.equal(configuration.tools.length,0);assert.deepEqual(configuration.skills,['skill-routing']);
  assert.equal(input.pluginMetadata.nativeHome,'/native');assert.equal(input.pluginMetadata.crewId,'task');assert.equal(input.pluginMetadata.generation,1);
  assert.equal(input.permissionMode,'accept-edits');assert.equal(input.visibility,'hidden');roleChecked=true;return{id:'thr_worker'};
 });
 const argv=['create-worker','--json','--task','task','--shape','ship','--project','proj_1','--home','/native','--host','host_1','--path','/repo','--prompt-file','/tmp/brief','--parent','thr_cap','--native-pid','999','--permission-mode','full','--hidden'];
 const created=await host.harness.behavior.runCli(argv,ctx);assert.equal(created.exitCode,0,created.stderr);assert.equal(roleChecked,true);
 const retry=await host.harness.behavior.runCli(argv,ctx);assert.equal(retry.exitCode,0,retry.stderr);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,1);
 assert.equal(host.harness.sdk.callsTo('threads.updatePluginMetadata').length,0);
 assert.equal(createLaunches(host.bb.storage.database()).list('thr_cap')[0].state,'provisioning','native post-creation isolation guard is not yet attested');
 }finally{await host.harness.lifecycle.dispose();}
});
test('internal bridge refuses without native admission, and unsupported options create no launch records',async()=>{
 const host=await base({fmHome:'/native',transport:'real'});try {
 hostCommands(host,()=>({code:1,payload:'missing native lock'}));
 const rejected=await host.harness.behavior.runCli(['create-worker','--task','task','--project','proj_1','--home','/native','--host','host_1','--path','/repo','--prompt-file','/tmp/brief','--native-pid','999'],ctx);
 assert.equal(rejected.exitCode,1);assert.match(rejected.stderr,/native launch admission proof/);
 for(const flags of [['--shared-env'],['--send-at','1']]) {
  const result=await host.harness.behavior.runCli(['dispatch','--project','proj_1',...flags,'--','fix issue'],ctx);assert.equal(result.exitCode,1);
 }
 assert.equal(createLaunches(host.bb.storage.database()).list().length,0);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});
test('background PR follow-up survives reload, forgotten worker, stale lookup and manager loss with project scoped UI/RPC',async()=>{
 let host=await base();try {
 await host.bb.storage.kv.set('crews',[{...row(1),prUrl:'https://github.com/acme/repo/pull/7'}]);
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
 host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));
 host.harness.sdk.stub('threads.queuedMessages.list',async()=>[]);
 host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'unavailable'}));
 let observation={headRefOid:'sha1',state:'OPEN',isDraft:false,statusCheckRollup:[{status:'IN_PROGRESS',conclusion:''}],reviewDecision:'APPROVED',reviews:[{state:'APPROVED',commit:{oid:'sha1'}}],mergeable:'MERGEABLE'};
 let unavailable=false;
 hostCommands(host,command=>command.includes('gh pr view') ? {payload:JSON.stringify(observation),code:unavailable?1:0} : {code:0});
 await host.harness.behavior.runSchedule('pr-delivery-follow-up');
 let store=createDeliveries(host.bb.storage.database());let r=store.get('acme/repo#7');assert.equal(r.status,'waiting-checks');assert.equal(host.harness.sdk.callsTo('threads.send').length,0);
 await host.bb.storage.kv.set('crews',[]);host=await host.harness.lifecycle.reload(plugin);commonStubs(host);
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
 host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));host.harness.sdk.stub('threads.queuedMessages.list',async()=>[]);
 hostCommands(host,command=>command.includes('gh pr view') ? {payload:JSON.stringify(observation),code:unavailable?1:0} : {code:0});
 store=createDeliveries(host.bb.storage.database());r=store.get(r.id);r.nextCheckAt=0;store.save(r);
 observation.statusCheckRollup=[{status:'COMPLETED',conclusion:'SUCCESS'}];
 await host.harness.behavior.runSchedule('pr-delivery-follow-up');assert.equal(store.get(r.id).status,'waiting-approval');
 assert.equal(host.harness.sdk.callsTo('threads.send').length,1);
 r=store.get(r.id);r.nextCheckAt=0;store.save(r);await host.harness.behavior.runSchedule('pr-delivery-follow-up');assert.equal(host.harness.sdk.callsTo('threads.send').length,1);
 const shown=await host.harness.behavior.runCli(['deliveries','list','--json'],ctx);assert.equal(JSON.parse(shown.stdout).length,1);
 unavailable=true;r=store.get(r.id);r.nextCheckAt=0;store.save(r);await host.harness.behavior.runSchedule('pr-delivery-follow-up');assert.equal(store.get(r.id).freshness,'stale');assert.equal(store.get(r.id).status,'waiting-approval');
 await host.harness.behavior.emitThreadEvent('thread.archived',{thread:makeThreadResponse({id:'thr_cap',projectId:'proj_1',archivedAt:Date.now()})});assert.equal(store.get(r.id).ownerNeeded,true);
 const other=await host.harness.behavior.runCli(['deliveries','list','--json'],{threadId:'thr_other',projectId:'proj_1'});assert.equal(JSON.parse(other.stdout)[0].ownerNeeded,true,'lost manager obligation is visibly project scoped');
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({captain:'true'}));
 const rpc=await host.harness.behavior.callRpc('fleet',{threadId:'thr_cap'});assert.equal(rpc.deliveries[0].id,r.id);assert.equal(rpcContract.fleet.output.safeParse(rpc).success,true);
 host.harness.sdk.stub('threads.update',async()=>({}));
 const handoff=await host.harness.behavior.runCli(['handoff','--from','thr_cap'],{threadId:'thr_new',projectId:'proj_1'});assert.equal(handoff.exitCode,0,handoff.stderr);assert.equal(store.get(r.id).owner,'thr_new');assert.equal(store.get(r.id).ownerNeeded,false);
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'other-project',status:'idle'}));
 const outside=await host.harness.behavior.runCli(['deliveries','list','--all','--json'],{threadId:'outside',projectId:'other-project'});assert.deepEqual(JSON.parse(outside.stdout),[]);
 const theft=await host.harness.behavior.runCli(['deliveries','assign',r.id,'--from','thr_new'],{threadId:'outside',projectId:'other-project'});assert.equal(theft.exitCode,1);

 }finally{await host.harness.lifecycle.dispose();}
});
test('same-task concurrent backlog dispatch creates one worker and preserves its queue identity',async()=>{
 const host=await base();try {
 host.harness.sdk.stub('threads.spawn',async()=>{await new Promise(r=>setTimeout(r,20));return{id:'thr_one'};});
 const added=await host.harness.behavior.runCli(['queue','add','--project','proj_1','--json','--','fix login'],ctx);assert.equal(added.exitCode,0,added.stderr);
 const q=JSON.parse(added.stdout);
 const results=await Promise.all([1,2].map(()=>host.harness.behavior.runCli(['queue','dispatch',q.id,'--json'],ctx)));
 assert.ok(results.some(result=>result.exitCode===0));for(const result of results) if(result.exitCode!==0) assert.match(result.stderr,/status dispatched/);
 assert.equal(host.harness.sdk.callsTo('threads.spawn').length,1);assert.equal(JSON.parse(results.find(result=>result.exitCode===0).stdout).id,q.id);
 assert.equal(createLaunches(host.bb.storage.database()).list('thr_cap')[0].taskId,q.id);
 }finally{await host.harness.lifecycle.dispose();}
});
test('reload during creation reconciles seeded worker identity before retry and never kills a slow worker',async()=>{
 let host=await base();let pending;try {
 let metadata;
 host.harness.sdk.stub('threads.spawn',async args=>{metadata=args.pluginMetadata;return new Promise(()=>{});});
 pending=host.harness.behavior.runCli(['dispatch','--project','proj_1','--task-id','stable','--','fix login'],ctx).catch(error=>({error}));
 while(!metadata) await new Promise(r=>setTimeout(r,1));
 assert.equal(createLaunches(host.bb.storage.database()).list('thr_cap')[0].state,'creating');
 const old=host;host=await host.harness.lifecycle.reload(plugin);commonStubs(host);
 await pending;
 assert.equal(old.harness.sdk.callsTo('threads.stop').length,0);
 host.harness.sdk.stub('threads.list',async()=>[{id:'thr_created'}]);host.harness.sdk.stub('threads.getPluginMetadata',async()=>metadata);
 host.harness.sdk.stub('threads.spawn',async()=>{throw new Error('must not create replacement');});
 const retry=await host.harness.behavior.runCli(['dispatch','--project','proj_1','--task-id','stable','--','fix login'],ctx);
 assert.equal(retry.exitCode,0,retry.stderr);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);
 assert.equal(createLaunches(host.bb.storage.database()).list('thr_cap')[0].threadId,'thr_created');
 }finally{await host.harness.lifecycle.dispose();await pending;}
});
test('forgotten running worker still occupies admission capacity',async()=>{
 const host=await base({maxActiveCrews:1});try {
 const store=createLaunches(host.bb.storage.database());const key='owned-existing';store.save({key,taskId:'forgotten',projectId:'proj_1',owner:'thr_cap',home:'',generation:1,shape:'ship',state:'running',threadId:'thr_old',updatedAt:1});
 const result=await host.harness.behavior.runCli(['dispatch','--project','proj_1','--','new work'],ctx);
 assert.equal(result.exitCode,1);assert.match(result.stderr,/cap reached/);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});
test('promotion stores a complete durable report and preserves the project delivery mode',async()=>{
 let host=await base();try {
 const report='Finding: preserve every acceptance criterion.\n'.repeat(300)+'TAIL-EVIDENCE\nDONE: report complete';
 await host.bb.storage.kv.set('crews',[row(1,'scout')]);
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:threadId==='thr_c1'?'idle':'starting',environmentId:'env_wt'}));
 host.harness.sdk.stub('threads.output',async()=>({output:report}));host.harness.sdk.stub('threads.spawn',async()=>({id:'thr_ship'}));
 await host.harness.behavior.runCli(['posture','set','--project','proj_1','--mode','no-mistakes'],ctx);
 const promoted=await host.harness.behavior.runCli(['promote','c1','--json'],ctx);assert.equal(promoted.exitCode,0,promoted.stderr);
 const request=host.harness.sdk.callsTo('threads.spawn')[0][0];assert.match(request.prompt,/bb firstmate scout-report c1/);assert.equal(request.pluginMetadata.posture,'no-mistakes');
 host=await host.harness.lifecycle.reload(plugin);commonStubs(host);
 const artifact=await host.harness.behavior.runCli(['scout-report','c1'],ctx);assert.equal(artifact.stdout,report);
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'other',status:'idle'}));
 const foreign=await host.harness.behavior.runCli(['scout-report','c1'],{threadId:'foreign',projectId:'other'});assert.equal(foreign.exitCode,1);
 }finally{await host.harness.lifecycle.dispose();}
});
test('native seeded secondmate role and child home exist at initial configuration',async()=>{
 const host=await base({fmHome:'/native'});try {
 hostCommands(host,()=>({code:0}));host.harness.sdk.stub('files.read',async()=>({content:'Native seeded captain brief',contentEncoding:'utf8',sizeBytes:27}));
 host.harness.sdk.stub('environments.get',async()=>({id:'env_child',hostId:'host_1',status:'ready',isWorktree:false,path:'/seeded'}));
 host.harness.sdk.stub('threads.spawn',async input=>{
  assert.equal(input.pluginMetadata.captain,'true');assert.equal(input.pluginMetadata.nativeHome,'/seeded');assert.equal(input.pluginMetadata.nativeParentHome,'/native');
  const configured=await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({pluginMetadata:input.pluginMetadata}));
  assert.ok(configured.tools.some(t=>t.name==='firstmate_dispatch'));assert.equal(input.permissionMode,'accept-edits');
  return{id:'thr_secondmate'};
 });
 const result=await host.harness.behavior.runCli(['create-worker','--json','--task','domain','--shape','secondmate','--project','proj_1','--home','/native','--host','host_1','--path','/seeded','--prompt-file','/tmp/brief','--parent','thr_cap','--native-pid','999'],ctx);
 assert.equal(result.exitCode,0,result.stderr);assert.equal(await host.bb.storage.kv.get('native-home:thr_secondmate'),'/seeded');
 }finally{await host.harness.lifecycle.dispose();}
});
test('owned launch metadata recovers scoped orphan PR references without claiming scout or foreign URLs',async()=>{
 const host=await base();try {
 const launches=createLaunches(host.bb.storage.database());const key=JSON.stringify(['proj_1','thr_cap','','owned',1]);
 const record={key,taskId:'owned',projectId:'proj_1',owner:'thr_cap',home:'',generation:1,shape:'ship',deliveryMode:'direct-PR',deliveryRequirement:'merged',state:'running',threadId:'thr_owned',updatedAt:1};launches.save(record);
 launches.save({...record,key:'foreign',taskId:'foreign',threadId:'thr_foreign'});launches.save({...record,key:'scout',shape:'scout',taskId:'scout',threadId:'thr_scout'});
 host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>threadId==='thr_owned'?{launchKey:key,crewId:'owned',nativeHome:''}:{});
 host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'available',pullRequest:{url:'https://github.com/acme/own/pull/3',state:'open'}}));
 hostCommands(host,()=>({payload:JSON.stringify({headRefOid:'sha',state:'OPEN',isDraft:true,statusCheckRollup:[],reviewDecision:'',mergeable:'UNKNOWN'})}));
 await host.harness.behavior.runSchedule('pr-delivery-follow-up');
 const records=createDeliveries(host.bb.storage.database()).list({owner:'thr_cap',projectId:'proj_1'});assert.equal(records.length,1);assert.equal(records[0].taskId,'owned');assert.equal(records[0].status,'draft');
 }finally{await host.harness.lifecycle.dispose();}
});
test('caller cancellation during external creation persists uncertainty without stopping the worker',async()=>{
 const host=await base();try {
 const abort=new AbortController();host.harness.sdk.stub('threads.spawn',async()=>{abort.abort();return new Promise(()=>{});});
 const result=await host.harness.behavior.runCli(['dispatch','--project','proj_1','--task-id','cancelled','--','fix login'],{...ctx,signal:abort.signal});
 assert.equal(result.exitCode,1);assert.equal(createLaunches(host.bb.storage.database()).list('thr_cap')[0].state,'uncertain');assert.equal(host.harness.sdk.callsTo('threads.stop').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});
test('missed manager deletion is surfaced after restart; inventory failures preserve stale ownership',async()=>{
 const host=await base();try {
 const store=createDeliveries(host.bb.storage.database());const r=store.register({url:'https://github.com/acme/repo/pull/9',taskId:'forgotten',projectId:'proj_1',owner:'thr_missing',home:'',worker:'thr_old'});
 host.harness.sdk.stub('threads.get',async()=>{throw new Error('owner unavailable');});host.harness.sdk.stub('threads.list',async()=>{throw new Error('inventory unavailable');});
 await host.harness.behavior.runSchedule('pr-delivery-follow-up');assert.equal(store.get(r.id).freshness,'stale');assert.equal(store.get(r.id).ownerNeeded,false);
 host.harness.sdk.stub('threads.list',async()=>[]);const again=store.get(r.id);again.nextCheckAt=0;store.save(again);
 await host.harness.behavior.runSchedule('pr-delivery-follow-up');assert.equal(store.get(r.id).ownerNeeded,true);assert.equal(store.get(r.id).owner,'thr_missing');
 }finally{await host.harness.lifecycle.dispose();}
});
const tool=(host,name)=>host.harness.inspection.registrations.agentTools.find(t=>t.name===name);
const turn=()=>new Promise(setImmediate);
async function until(condition) { for(let i=0;i<300;i++){if(condition())return;await turn();}throw new Error('fixture did not reach boundary'); }
const forge=(extra={})=>({headRefOid:'sha1',state:'OPEN',isDraft:false,statusCheckRollup:[],reviewDecision:null,reviews:[],mergeable:'MERGEABLE',...extra});

test('factory metadata adoption and dispatch recovery preserve required verification through discovery and merge',async()=>{
 for(const route of ['metadata','dispatch']) {
  let host=await base();try {
   let metadata;
   host.harness.sdk.stub('threads.spawn',async args=>{metadata=args.pluginMetadata;throw new Error('core created worker but reply was lost');});
   const launch=await host.harness.behavior.runCli(['dispatch','--project','proj_1','--task-id','contract','--delivery-requirement','merged-and-verified','--','fix login'],ctx);
   assert.equal(launch.exitCode,1);assert.equal(metadata.deliveryRequirement,'merged-and-verified');
   host=await host.harness.lifecycle.reload(plugin);commonStubs(host);
   host.harness.sdk.stub('threads.list',async()=>[makeThreadResponse({id:'thr_recovered',projectId:'proj_1',parentThreadId:'thr_cap',status:'idle',environmentId:'env_wt'})]);
   host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>threadId==='thr_recovered'?metadata:{});
   host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
   const adopted=await host.harness.behavior.runCli(route==='metadata'?['crews']:['dispatch','--project','proj_1','--task-id','contract','--','fix login'],ctx);
   assert.equal(adopted.exitCode,0,adopted.stderr);
   const crew=(await host.bb.storage.kv.get('crews'))[0];assert.equal(crew.deliveryRequirement,'merged-and-verified');assert.equal(crew.launchKey,metadata.launchKey);
   host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'available',pullRequest:{url:'https://github.com/acme/recovery/pull/1',state:'merged'}}));
   host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));
   hostCommands(host,()=>({payload:JSON.stringify(forge({state:'MERGED',mergeCommit:{oid:'merge1'}}))}));
   await host.harness.behavior.runSchedule('pr-delivery-follow-up');
   const record=createDeliveries(host.bb.storage.database()).get('acme/recovery#1');assert.equal(record.requirement,'merged-and-verified');assert.equal(record.status,'merged-needs-verification');
  } finally {await host.harness.lifecycle.dispose();}
 }
});
test('CLI and tool registration inherit original contract; queue and promotion carry it to creation',async()=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[{...row(1),deliveryRequirement:'merged-and-verified'}]);
  const cli=await host.harness.behavior.runCli(['deliveries','register','--crew','c1','--url','https://github.com/acme/contracts/pull/1'],ctx);assert.equal(cli.exitCode,0,cli.stderr);
  await tool(host,'firstmate_deliveries').execute({action:'register',crewId:'c1',url:'https://github.com/acme/contracts/pull/2'},ctx);
  const store=createDeliveries(host.bb.storage.database());assert.equal(store.get('acme/contracts#1').requirement,'merged-and-verified');assert.equal(store.get('acme/contracts#2').requirement,'merged-and-verified');
  const changed=await host.harness.behavior.runCli(['deliveries','register','--crew','c1','--url','https://github.com/acme/contracts/pull/1','--requirement','merged','--authorized'],ctx);assert.equal(changed.exitCode,1);
  host.harness.sdk.stub('threads.spawn',async()=>({id:'thr_new'}));
  const add=await host.harness.behavior.runCli(['queue','add','--project','proj_1','--delivery-requirement','merged-and-verified','--json','--','fix login'],ctx);assert.equal(add.exitCode,0,add.stderr);
  const dispatched=await host.harness.behavior.runCli(['queue','dispatch',JSON.parse(add.stdout).id],ctx);assert.equal(dispatched.exitCode,0,dispatched.stderr);
  assert.equal(host.harness.sdk.callsTo('threads.spawn').at(-1)[0].pluginMetadata.deliveryRequirement,'merged-and-verified');
  await host.bb.storage.kv.set('crews',[{...row(9,'scout'),deliveryRequirement:'merged-and-verified'}]);
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
  const promoted=await host.harness.behavior.runCli(['promote','c9'],ctx);assert.equal(promoted.exitCode,0,promoted.stderr);
  assert.equal(host.harness.sdk.callsTo('threads.spawn').at(-1)[0].pluginMetadata.deliveryRequirement,'merged-and-verified');
 }finally{await host.harness.lifecycle.dispose();}
});
test('hung discovery is bounded per item and does not starve other PRs or future registered scans',async t=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[row(1),{...row(2),prUrl:'https://github.com/acme/healthy/pull/2'}]);
  let calls=0;host.harness.sdk.stub('environments.pullRequest',async()=>{calls++;return new Promise(()=>{});});
  hostCommands(host,()=>({payload:JSON.stringify(forge({isDraft:true}))}));
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  const scan=host.harness.behavior.runSchedule('pr-delivery-follow-up');await until(()=>calls===1);t.mock.timers.tick(15001);await scan;
  assert.equal(createDeliveries(host.bb.storage.database()).get('acme/healthy#2').status,'draft');
  // The timed-out item backs off for one minute before the next scan retries it.
  t.mock.timers.tick(60_000);
  const again=host.harness.behavior.runSchedule('pr-delivery-follow-up');await until(()=>calls===2);t.mock.timers.tick(15001);await again;
  assert.equal(calls,2,'followingUp was released after timeout');
 }finally{t.mock.timers.reset();await host.harness.lifecycle.dispose();}
});
test('registered follow-up disposal settles hung discovery and notification recovery reads',async()=>{
 for(const boundary of ['discovery','notification']) {
  const host=await base();let reached=false;try {
   if(boundary==='discovery') {
    await host.bb.storage.kv.set('crews',[row(1)]);
    host.harness.sdk.stub('environments.pullRequest',async()=>{reached=true;return new Promise(()=>{});});
   }else{
    const store=createDeliveries(host.bb.storage.database());let r=store.register({url:'https://github.com/acme/hung/pull/1',taskId:'c1',projectId:'proj_1',owner:'thr_cap',home:'',worker:'thr_c1'});
    r.nextCheckAt=Date.now()+100000;r.notification={desired:'signature',delivered:null,queued:null,retryAt:0,attempted:'signature'};store.save(r);
    host.harness.sdk.stub('threads.queuedMessages.list',async()=>{reached=true;return new Promise(()=>{});});
   }
   const scan=host.harness.behavior.runSchedule('pr-delivery-follow-up').catch(error=>error);await until(()=>reached);
   await Promise.race([host.harness.lifecycle.dispose(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('disposal hung')),1000))]);await scan;
  }finally{await host.harness.lifecycle.dispose();}
 }
});
test('late terminal identity is closed once after disposal with no terminal reads or continuation',async()=>{
 const host=await base();let release;try {
  const store=createDeliveries(host.bb.storage.database());store.register({url:'https://github.com/acme/late/pull/1',taskId:'c1',projectId:'proj_1',owner:'thr_cap',home:'',worker:'thr_c1'});
  host.harness.sdk.stub('terminals.create',async()=>new Promise(r=>{release=r;}));host.harness.sdk.stub('terminals.close',async()=>({}));
  const scan=host.harness.behavior.runSchedule('pr-delivery-follow-up').catch(error=>error);await until(()=>release);
  await host.harness.lifecycle.dispose();await scan;release({id:'term_late'});await until(()=>host.harness.sdk.callsTo('terminals.close').length===1).catch(()=>{});
  assert.equal(host.harness.sdk.callsTo('terminals.close').length,1,'late creation is closed exactly once');
  assert.equal(host.harness.sdk.callsTo('terminals.close')[0][0].terminalId,'term_late');assert.equal(host.harness.sdk.callsTo('terminals.get').length,0);assert.equal(host.harness.sdk.callsTo('terminals.output').length,0);assert.equal(host.harness.sdk.callsTo('threads.send').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});
test('partial handoff preserves failed worker task, launch, decision and PR ownership while transferring orphan obligations',async()=>{
 const host=await base();try {
  await host.bb.storage.kv.set('crews',[row(1),row(2)]);
  await host.bb.storage.kv.set('decisions',[{id:'decision',question:'approve?',options:[],crewId:'c2',parentThreadId:'thr_cap',createdAt:new Date().toISOString(),status:'open'}]);
  const store=createDeliveries(host.bb.storage.database()),launches=createLaunches(host.bb.storage.database());
  for(const n of [1,2,3]) {store.register({url:`https://github.com/acme/handoff/pull/${n}`,taskId:`c${n}`,projectId:'proj_1',owner:'thr_cap',home:'',worker:`thr_c${n}`});launches.save({key:`l${n}`,taskId:`c${n}`,projectId:'proj_1',owner:'thr_cap',home:'',generation:1,shape:'ship',state:'running',threadId:`thr_c${n}`,updatedAt:1});}
  host.harness.sdk.stub('threads.update',async({threadId})=>{if(threadId==='thr_c2')throw new Error('reparent failed');return{};});
  const result=await host.harness.behavior.runCli(['handoff','--from','thr_cap'],{threadId:'thr_new',projectId:'proj_1'});assert.equal(result.exitCode,0,result.stderr);assert.match(result.stdout,/Kept: c2/);
  assert.equal(store.get('acme/handoff#1').owner,'thr_new');assert.equal(store.get('acme/handoff#2').owner,'thr_cap');assert.equal(store.get('acme/handoff#3').owner,'thr_new');assert.equal(launches.get('l2').owner,'thr_cap');
  assert.equal((await host.bb.storage.kv.get('crews')).find(r=>r.id==='c2').parentThreadId,'thr_cap');assert.equal((await host.bb.storage.kv.get('decisions'))[0].parentThreadId,'thr_cap');
 }finally{await host.harness.lifecycle.dispose();}
});
test('forgotten author retains native guarded merge continuation and refuses destructive retirement',async()=>{
 let host=await base({fmHome:'/native',fmHostId:'host_1'});try {
  await host.bb.storage.kv.set('crews',[{...row(1),nativeHome:'/native',prUrl:'https://github.com/acme/retained/pull/1',deliveryRequirement:'merged-and-verified'}]);
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
  host.harness.sdk.stub('threads.stop',async()=>({}));host.harness.sdk.stub('threads.archive',async()=>({}));
  host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'unavailable'}));
  const commands=hostCommands(host,command=>command.includes('gh pr view')?{payload:JSON.stringify(forge())}:{code:0});
  const refusal=await host.harness.behavior.runCli(['forget','c1','--stop','--force'],ctx);assert.equal(refusal.exitCode,1);assert.match(refusal.stderr,/Outstanding PR delivery/);assert.equal(host.harness.sdk.callsTo('threads.archive').length,0);
  const forgotten=await host.harness.behavior.runCli(['forget','c1'],ctx);assert.equal(forgotten.exitCode,0,forgotten.stderr);assert.equal((await host.bb.storage.kv.get('crews')).length,0);
  assert.ok([...commands.values()].every(c=>!c.includes('fm-check-unregister')&&!c.includes('fm-teardown')),'native authority is retained');
  host=await host.harness.lifecycle.reload(plugin);commonStubs(host);
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt',archivedAt:threadId==='thr_c1'?1:null}));
  host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'unavailable'}));
  const resumed=hostCommands(host,command=>command.includes('gh pr view')?{payload:JSON.stringify(forge())}:command.includes('fm-pr-merge')?{code:1,payload:'native required check refuses merge'}:{code:0});
  host.harness.sdk.stub('threads.updatePluginMetadata',async()=>({}));host.harness.sdk.stub('threads.unarchive',async()=>({}));host.harness.sdk.stub('threads.send',async()=>({delivery:'sent'}));
  const fix=await host.harness.behavior.runCli(['tell','c1','--message','Fix the failing check on this PR'],ctx);assert.equal(fix.exitCode,0,fix.stderr);
  assert.equal(host.harness.sdk.callsTo('threads.unarchive').length,1);
  assert.equal(host.harness.sdk.callsTo('threads.updatePluginMetadata').at(-1)[0].set.crew,'true');assert.equal(host.harness.sdk.callsTo('threads.send').at(-1)[0].threadId,'thr_c1');
  const merge=await host.harness.behavior.runCli(['merge','c1','--yes'],ctx);assert.equal(merge.exitCode,1);assert.match(merge.stderr,/native required check refuses merge/);assert.ok([...resumed.values()].some(c=>c.includes('fm-pr-merge')));assert.ok([...resumed.values()].every(c=>!c.includes('gh pr merge')));
  host.harness.sdk.stub('threads.update',async()=>{throw new Error('archived author reparent failed');});
  const blocked=await host.harness.behavior.runCli(['handoff','--from','thr_cap','--crew','c1'],{threadId:'thr_new',projectId:'proj_1'});assert.equal(blocked.exitCode,0,blocked.stderr);assert.match(blocked.stdout,/Kept: c1/);
  assert.equal(createDeliveries(host.bb.storage.database()).get('acme/retained#1').owner,'thr_cap');
  host.harness.sdk.stub('threads.update',async()=>({}));
  const transferred=await host.harness.behavior.runCli(['handoff','--from','thr_cap','--crew','c1'],{threadId:'thr_new',projectId:'proj_1'});assert.equal(transferred.exitCode,0,transferred.stderr);assert.equal(createDeliveries(host.bb.storage.database()).get('acme/retained#1').owner,'thr_new');
  const foreign=await host.harness.behavior.runCli(['merge','c1','--yes'],{threadId:'thr_other',projectId:'proj_1'});assert.equal(foreign.exitCode,1);assert.match(foreign.stderr,/No crew/);
 }finally{await host.harness.lifecycle.dispose();}
});
test('native guard failure after real bridge creation retains an unadmitted worker and its capacity',async()=>{
 const host=await base({fmHome:'/native',fmHostId:'host_1',transport:'real',queueOwner:'real',maxActiveCrews:1});try {
  let metadata;host.harness.sdk.stub('files.read',async()=>({content:'Validated native brief',contentEncoding:'utf8',sizeBytes:22}));
  host.harness.sdk.stub('threads.spawn',async args=>{metadata=args.pluginMetadata;return{id:'thr_created'};});
  host.harness.sdk.stub('threads.list',async()=>metadata?[makeThreadResponse({id:'thr_created',projectId:'proj_1',parentThreadId:'thr_cap'})]:[]);
  host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>threadId==='thr_created'?metadata??{}:{});
  const commands=new Map();let n=0;
  host.harness.sdk.stub('terminals.create',async args=>{const id=`native${++n}`;commands.set(id,args.start.command);return{id};});
  host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));host.harness.sdk.stub('terminals.close',async()=>({}));
  host.harness.sdk.stub('terminals.output',async({terminalId})=>{
   const command=commands.get(terminalId);let code=0,payload='';
   if(command.includes('fm-spawn.sh')&&!command.includes('native_command=')) {
    const creation=await host.harness.behavior.runCli(['create-worker','--task','guard','--shape','ship','--project','proj_1','--home','/native','--host','host_1','--path','/repo','--prompt-file','/tmp/brief','--parent','thr_cap','--native-pid','999'],ctx);
    assert.equal(creation.exitCode,0,creation.stderr);code=1;payload='native isolation/publication guard refused after BB creation';
   }else if(command.includes('bb_thread_id')) payload='FM_META_ABSENT';
   return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:${code}\n`).toString('base64')}]};
  });
  const result=await host.harness.behavior.runCli(['dispatch','--project','proj_1','--task-id','guard','--','fix login'],ctx);
  assert.equal(result.exitCode,1,result.stdout);assert.match(result.stderr,/Native admission\/publication remains unresolved/);
  const launches=createLaunches(host.bb.storage.database());assert.equal(launches.list()[0].state,'provisioning');assert.equal(launches.list()[0].threadId,'thr_created');assert.equal(host.harness.sdk.callsTo('threads.spawn').length,1);
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');assert.equal(launches.list()[0].state,'provisioning');
  const other=await host.harness.behavior.runCli(['dispatch','--project','proj_1','--task-id','second','--','other work'],ctx);assert.equal(other.exitCode,1);assert.match(other.stderr,/cap reached/);assert.equal(host.harness.sdk.callsTo('threads.stop').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});

test('registered PR schedule parses real PTY forge reads for discovery and merge verification; command failures stay stale',async()=>{
 const host=await base();const dir=mkdtempSync(join(tmpdir(),'fm-forge-pty-'));
 try {
  writeFileSync(join(dir,'gh'),`#!/usr/bin/env python3
import os,sys
if sys.stdout.isatty(): print("Working...")
print("forge stderr diagnostic",file=sys.stderr)
if sys.argv[2] == "list": print('[{"url":"https://github.com/acme/pty/pull/50"}]')
else: print(open(os.path.join(os.path.dirname(__file__),"observation")).read())
sys.exit(int(open(os.path.join(os.path.dirname(__file__),"exit")).read()))
`,{mode:0o700});
  writeFileSync(join(dir,'observation'),mergedJson);writeFileSync(join(dir,'exit'),'0');
  await host.bb.storage.kv.set('crews',[{...row(1),deliveryRequirement:'merged-and-verified'}]);
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
  host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'unavailable'}));
  host.harness.sdk.stub('environments.get',async()=>({id:'env_wt',hostId:'host_1',status:'ready',path:dir,branchName:'owned-task'}));
  host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));host.harness.sdk.stub('threads.queuedMessages.list',async()=>[]);
  let n=0;const commands=new Map(),outputs=new Map();
  host.harness.sdk.stub('terminals.create',async args=>{const id=`pty${++n}`;commands.set(id,args.start.command);outputs.set(id,runPty(args.start.command.replaceAll('gh pr ',`${dir}/gh pr `).replace(/; sleep 86400$/, '')));return{id};});
  host.harness.sdk.stub('terminals.get',async()=>({status:'exited'}));host.harness.sdk.stub('terminals.close',async()=>({}));
  host.harness.sdk.stub('terminals.output',async({terminalId})=>({nextSeq:1,chunks:[{dataBase64:Buffer.from(outputs.get(terminalId)).toString('base64')}]}));
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  const store=createDeliveries(host.bb.storage.database());let record=store.get('acme/pty#50');
  assert.ok(record,'PTY lookup must discover the owned PR');
  assert.equal(record.freshness,'fresh');assert.equal(record.status,'merged-needs-verification');assert.equal(record.headSha,JSON.parse(mergedJson).headRefOid);
  assert.ok([...commands.values()].some(cmd=>cmd.includes('gh pr list')));assert.ok([...commands.values()].filter(cmd=>cmd.includes('gh pr view')).length>=2);
  // Valid merged JSON cannot hide a failed forge command. Keep the last observed
  // contract/state and expose stderr. The next successful read remains retryable.
  writeFileSync(join(dir,'exit'),'7');record.nextCheckAt=0;store.save(record);
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');record=store.get(record.id);
  assert.equal(record.freshness,'stale');assert.equal(record.status,'merged-needs-verification');assert.match(record.error,/forge stderr diagnostic/);
  writeFileSync(join(dir,'exit'),'0');writeFileSync(join(dir,'observation'),'Working...\n'+mergedJson);record.nextCheckAt=0;store.save(record);
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');assert.equal(store.get(record.id).freshness,'stale');
  writeFileSync(join(dir,'observation'),mergedJson);record=store.get(record.id);record.nextCheckAt=0;store.save(record);
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');assert.equal(store.get(record.id).freshness,'fresh');
 }finally{await host.harness.lifecycle.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('native creation provisioning releases capacity only on exact core deletion and retains contract across reload',async()=>{
 let host=await base({fmHome:'/native',maxActiveCrews:1});try {
  hostCommands(host,()=>({code:0}));host.harness.sdk.stub('files.read',async()=>({content:'native brief',contentEncoding:'utf8',sizeBytes:12}));
  let n=0;host.harness.sdk.stub('threads.spawn',async()=>({id:`thr_native_${++n}`}));
  const argv=task=>['create-worker','--task',task,'--shape','ship','--project','proj_1','--home','/native','--host','host_1','--path','/repo','--prompt-file','/tmp/brief','--parent','thr_cap','--native-pid','999','--delivery-requirement','merged-and-verified'];
  const first=await host.harness.behavior.runCli(argv('deleted-worker'),ctx);assert.equal(first.exitCode,0,first.stderr);
  let launches=createLaunches(host.bb.storage.database());const original=launches.list()[0];assert.equal(original.state,'provisioning');
  await host.harness.behavior.emitThreadEvent('thread.deleted',{thread:makeThreadResponse({id:'thr_unrelated',projectId:'proj_1'})});
  const refused=await host.harness.behavior.runCli(argv('next-worker'),ctx);assert.equal(refused.exitCode,1);assert.match(refused.stderr,/cap reached/);assert.equal(n,1);
  await host.harness.behavior.emitThreadEvent('thread.deleted',{thread:makeThreadResponse({id:original.threadId,projectId:'proj_1'})});
  assert.equal(launches.get(original.key).state,'deleted');assert.equal(launches.get(original.key).deliveryRequirement,'merged-and-verified');assert.equal(launches.get(original.key).threadId,original.threadId);
  launches.update(original.key,{state:'running'});assert.equal(launches.get(original.key).state,'deleted','slow provisioning cannot undo deletion');
  host=await host.harness.lifecycle.reload(plugin);commonStubs(host);hostCommands(host,()=>({code:0}));host.harness.sdk.stub('files.read',async()=>({content:'native brief',contentEncoding:'utf8',sizeBytes:12}));host.harness.sdk.stub('threads.spawn',async()=>({id:`thr_native_${++n}`}));
  const retry=await host.harness.behavior.runCli(argv('deleted-worker'),ctx);assert.equal(retry.exitCode,1);assert.match(retry.stderr,/deleted by BB core/);assert.equal(n,1);
  const next=await host.harness.behavior.runCli(argv('next-worker'),ctx);assert.equal(next.exitCode,0,next.stderr);assert.equal(n,2);
  launches=createLaunches(host.bb.storage.database());assert.equal(launches.get(original.key).state,'deleted');
 }finally{await host.harness.lifecycle.dispose();}
});

test('PR-only delivered artifact remains monitored across reload; baseline follow-up never hides an independent CI failure',async()=>{
 let host=await base();try {
 const author={...row(1),prUrl:'https://github.com/acme/repo/pull/901',deliveryRequirement:'pr'};
 const baseline={...row(2),task:'Fix authorized baseline failure',deliveryRequirement:'pr'};
 await host.bb.storage.kv.set('crews',[author,baseline]);
 const registered=await host.harness.behavior.runCli(['deliveries','register','--crew','c1','--url',author.prUrl,'--json'],ctx);assert.equal(registered.exitCode,0,registered.stderr);
 let rollup=[{name:'branch-unit',conclusion:'SUCCESS',detailsUrl:'https://ci.example/branch/1'}];
 const observation=()=>({headRefOid:'sha-ci',state:'OPEN',isDraft:false,mergeable:'MERGEABLE',reviewDecision:'',reviews:[],statusCheckRollup:rollup});
 const install=()=>{
   commonStubs(host);host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
   host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));host.harness.sdk.stub('threads.queuedMessages.list',async()=>[]);
   hostCommands(host,c=>c.includes('gh pr view')?{payload:JSON.stringify(observation())}:{code:0});
 };
 install();let store=createDeliveries(host.bb.storage.database());const id='acme/repo#901';
 const pass=async()=>{const r=store.get(id);store.save({...r,nextCheckAt:0});await host.harness.behavior.runSchedule('pr-delivery-follow-up');};
 await pass();let r=store.get(id);assert.equal(r.status,'pr-delivered');assert.ok(r.deliverySatisfiedAt);assert.equal(r.requirement,'pr');assert.deepEqual(r.workers,['thr_c1']);
 const satisfiedAt=r.deliverySatisfiedAt;
 // Worker completes and leaves the cache. The persistent author remains callable.
 await host.bb.storage.kv.set('crews',[baseline]);host=await host.harness.lifecycle.reload(plugin);install();store=createDeliveries(host.bb.storage.database());
 rollup=[{name:'convex-baseline',conclusion:'FAILURE',detailsUrl:'https://ci.example/baseline/1'}];await pass();r=store.get(id);
 assert.equal(r.status,'failing-checks');assert.equal(r.deliverySatisfiedAt,satisfiedAt);assert.equal(r.requirement,'pr');assert.ok(r.continuation);assert.equal(r.failures[0].accounting,undefined);
 const firstSignature=r.notification.delivered;assert.ok(firstSignature);
 const authorRead=await host.harness.behavior.runCli(['crew','c1'],ctx);assert.equal(authorRead.exitCode,0,authorRead.stderr);
 const accounted=await host.harness.behavior.runCli(['deliveries','account',id,'--failure',r.failures[0].id,'--scope','baseline','--follow-up-task','c2','--reason','Same named check fails on main at verified baseline commit; existing user-authorized c2 fix','--authorized','--json'],ctx);assert.equal(accounted.exitCode,0,accounted.stderr);
 rollup.push({name:'proxy-parity',conclusion:'FAILURE',detailsUrl:'https://ci.example/parity/1'});await pass();r=store.get(id);
 assert.equal(r.failures.length,2);assert.equal(r.failures[0].accounting.taskId,'c2');assert.equal(r.failures[1].accounting,undefined);assert.notEqual(r.notification.delivered,firstSignature);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({captain:'true'}));
 const fleet=await host.harness.behavior.callRpc('fleet',{threadId:'thr_cap'});assert.equal(rpcContract.fleet.output.safeParse(fleet).success,true);
 const visible=fleet.deliveries.find(d=>d.id===id);assert.equal(visible.deliverySatisfiedAt,satisfiedAt);assert.deepEqual(visible.failures,r.failures);assert.deepEqual(visible.workers,['thr_c1']);
 const deliveryTool=host.harness.registrations.agentTools.find(t=>t.name==='firstmate_deliveries');
 const branchAccount=await deliveryTool.execute({action:'account',id,failureId:r.failures[1].id,scope:'author',followUpTask:'c1',authorized:true,reason:'Reuse original chat author for this branch-specific check'},ctx);assert.equal(typeof branchAccount,'string',JSON.stringify(branchAccount));
 r=store.get(id);assert.equal(r.failures[1].accounting.worker,'thr_c1');assert.equal(r.failures[0].accounting.worker,'thr_c2');
 assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(host.harness.sdk.callsTo('threads.send').filter(c=>c[0].threadId!=='thr_cap').length,0,'accounting records identity; no worker turn or new authority');
 const before=host.harness.sdk.callsTo('threads.send').length;await pass();const after=host.harness.sdk.callsTo('threads.send').length;await pass();assert.equal(host.harness.sdk.callsTo('threads.send').length,after,'unchanged observations do not wake another model turn');
 const output=await host.harness.behavior.runCli(['deliveries','list'],ctx);assert.match(output.stdout,/Agreed delivery satisfied/);assert.match(output.stdout,/proxy-parity/);assert.match(output.stdout,/convex-baseline/);assert.ok(output.stdout.includes(author.prUrl));
 const foreign=await host.harness.behavior.runCli(['deliveries','account',id,'--failure',r.failures[1].id,'--scope','author','--authorized','--reason','wrong owner'],{threadId:'foreign',projectId:'proj_1'});assert.equal(foreign.exitCode,1);
 rollup=rollup.map(c=>({...c,conclusion:'SUCCESS'}));await pass();r=store.get(id);assert.equal(r.status,'pr-delivered');assert.ok(r.failures.every(f=>f.resolvedAt));assert.equal(r.requirement,'pr');assert.equal(r.deliverySatisfiedAt,satisfiedAt);
 }finally{await host.harness.lifecycle.dispose();}
});

test('recorded standing yolo reaches the native guard without a fresh merge ask; legacy provenance and actual user holds remain explicit',async()=>{
 const host=await base({fmHome:'/scratch/native',fmHostId:'host_1'});try{
 await host.bb.storage.kv.set('crews',[{...row(1),nativeHome:'/scratch/native',prUrl:'https://github.com/acme/repo/pull/10'}]);
 await host.bb.storage.kv.set('postures',{proj_1:{mode:'direct-PR',yolo:true}});
 const legacy=await host.harness.behavior.runCli(['merge','c1'],ctx);assert.equal(legacy.exitCode,1);assert.match(legacy.stderr,/provenance is unverified/);assert.match(legacy.stderr,/no fresh per-PR request/);
 await host.bb.storage.kv.set('postures',{proj_1:{mode:'direct-PR',yolo:true,provenance:{source:'captain-instruction',actor:'thr_cap',at:'2026-10-05T00:00:00Z',reason:'User approved standing green in-scope merge; supervisor earlier wrote do-not-merge without user authority'}}});
 host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'unavailable'}));
 let guarded=0;hostCommands(host,c=>{
 if(c.includes('/fm-pr-merge.sh')){guarded++;return{code:1,payload:'NATIVE_USER_HOLD_OR_CHECK_REFUSAL: retained task'};}
 if(c.includes('gh pr view'))return{payload:JSON.stringify({state:'OPEN',mergeable:'MERGEABLE'})};
 return{code:0};
 });
 const standing=await host.harness.behavior.runCli(['merge','c1'],ctx);assert.equal(standing.exitCode,1);assert.match(standing.stderr,/NATIVE_USER_HOLD_OR_CHECK_REFUSAL/);assert.equal(guarded,1,'standing authority must reach the guarded route without a fresh request');
 assert.equal((await host.bb.storage.kv.get('crews')).length,1);assert.equal(host.harness.sdk.callsTo('environments.mergePullRequest').length,0);
 await host.bb.storage.kv.set('postures',{proj_1:{mode:'direct-PR',yolo:false,provenance:{source:'captain-instruction',actor:'thr_cap',at:'2026-10-05T01:00:00Z',reason:'Actual user hold'}}});
 const held=await host.harness.behavior.runCli(['merge','c1'],ctx);assert.equal(held.exitCode,1);assert.match(held.stderr,/Needs captain/);assert.equal(guarded,1,'actual hold must retain its gate');
 }finally{await host.harness.lifecycle.dispose();}
});

test('durable launch orphan discovery preserves native task mode before author continuation publication',async()=>{
 const host=await base();try {
  const record={key:'proj_1:thr_cap:/native:orphan',taskId:'orphan',projectId:'proj_1',owner:'thr_cap',home:'/native',generation:1,shape:'ship',state:'running',threadId:'thr_orphan',deliveryMode:'no-mistakes',deliveryRequirement:'pr',updatedAt:Date.now()};
  await createLaunches(host.bb.storage.database()).reserve(record,async()=>({cap:5,activeTaskIds:[]}));
  host.harness.sdk.stub('threads.list',async()=>[]); // Cache/metadata adoption cannot satisfy this path.
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
  host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>threadId==='thr_orphan'?{launchKey:record.key,nativeHome:record.home,crewId:record.taskId}:{});
  host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'available',pullRequest:{url:'https://github.com/acme/orphan/pull/11',state:'open'}}));
  host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));hostCommands(host,()=>({payload:JSON.stringify(forge())}));
  await host.harness.behavior.runSchedule('pr-delivery-follow-up');
  const delivery=createDeliveries(host.bb.storage.database()).get('acme/orphan#11');assert.ok(delivery,'scheduled orphan recovery must discover the exact owned PR');
  assert.equal(delivery.continuation.posture,'no-mistakes');assert.equal(delivery.requirement,'pr');assert.deepEqual(delivery.workers,['thr_orphan']);
  assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(host.harness.sdk.callsTo('environments.mergePullRequest').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});
