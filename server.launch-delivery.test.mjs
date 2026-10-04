import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost,makeThreadResponse,makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries } from './lib/pr-delivery.ts';
import { createLaunches } from './lib/launch.ts';
import { rpcContract } from './rpc.ts';
import { UPSTREAM_SKILL_NAMES } from './lib/upstream-surface.ts';
const row=(n,shape='ship')=>({id:`c${n}`,task:'fix login',projectId:'proj_1',threadId:`thr_c${n}`,parentThreadId:'thr_cap',providerId:null,model:null,reasoningLevel:null,worktree:true,shape,posture:shape==='scout'?'scout':'direct-PR',createdAt:'2026-09-18T00:00:00.000Z'});
const ctx={threadId:'thr_cap',projectId:'proj_1'};
function hostCommands(host,answer) {
 const commands=new Map();let n=0;
 host.harness.sdk.stub('terminals.create',async args=>{const id=`term${++n}`;commands.set(id,args.start.command);return{id};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{const out=answer(commands.get(terminalId));return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${out.payload ?? ''}\n__FM_HOST_RC:${out.code ?? 0}\n`).toString('base64')}]};});
 return commands;
}
async function base(settings={}) {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain','calm','catch-up',...UPSTREAM_SKILL_NAMES],settings});await plugin(host.bb);
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
 await host.bb.storage.kv.set('crews',[1,2,3,4].map(n=>row(n)));
 let spawned=0;host.harness.sdk.stub('threads.spawn',async()=>{spawned++;await new Promise(r=>setTimeout(r,10));return{id:'thr_new'};});
 const results=await Promise.all(['a','b'].map(task=>host.harness.behavior.runCli(['dispatch','--project','proj_1','--',task],ctx)));
 assert.equal(spawned,1);assert.equal(results.filter(r=>r.exitCode===0).length,1);assert.match(results.find(r=>r.exitCode!==0).stderr,/cap reached/);
 await host.bb.storage.kv.set('crews',[...[1,2,3,4,5].map(n=>row(n)),row(6,'scout')]);
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:threadId==='thr_c6'?'idle':'active'}));
 const promoted=await host.harness.behavior.runCli(['promote','c6'],ctx);assert.equal(promoted.exitCode,1);assert.match(promoted.stderr,/cap reached/);assert.equal(spawned,1);
 }finally{await host.harness.lifecycle.dispose();}
});
test('native bridge seeds role/home/generation before initial configuration and never invokes mark after creation',async()=>{
 const host=await base({fmHome:'/native'});try {
 hostCommands(host,()=>({code:0}));
 host.harness.sdk.stub('files.read',async()=>({content:'Native validated brief',contentEncoding:'utf8',sizeBytes:22}));
 let roleChecked=false;
 host.harness.sdk.stub('threads.spawn',async input=>{
  const configuration=await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({pluginMetadata:input.pluginMetadata}));
  assert.equal(configuration.tools.length,0);assert.equal(configuration.skills.length,0);
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
 const record={key,taskId:'owned',projectId:'proj_1',owner:'thr_cap',home:'',generation:1,shape:'ship',state:'running',threadId:'thr_owned',updatedAt:1};launches.save(record);
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
