import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createFakePluginHost,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import {createQueueStore} from './lib/queue-store.ts';
import {createLaunches,launchKey} from './lib/launch.ts';
import {pins,fixture,run,ok,overlay} from './scripts/prompt-fixture.mjs';
const ctx={threadId:'thr_a',projectId:'proj_a'};
const other={threadId:'thr_b',projectId:'proj_b'};
const row=(id,owner='thr_a',project='proj_a')=>({id,title:`task ${id}`,detail:'',projectId:project,parentThreadId:owner,nativeHome:'/scratch/native',shape:'ship',mode:'direct-PR',providerId:'codex',model:'gpt-6.1-sol',reasoningLevel:'xhigh',deliveryRequirement:'merged-and-verified',blockedBy:[],waitUntil:null,status:'queued',crewId:null,backlogId:id,createdAt:'2026-10-04T00:00:00.000Z'});
async function inventory(host) {const q=createQueueStore(host.bb.storage.database(),()=>host.bb.storage.kv.get('queue'));await q.ready();return q;}
function sdk(host) {
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:threadId==='thr_b'?'proj_b':'proj_a',parentThreadId:threadId==='thr_worker'?'thr_a':null,status:'active',environmentId:'env_wt'}));
 host.harness.sdk.stub('threads.defaultExecutionOptions',async()=>({permissionMode:'accept-edits',model:'gpt-6.1-sol',reasoningLevel:'xhigh'}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('environments.get',async()=>({id:'env_wt',hostId:'host_1',status:'ready',isWorktree:true,path:'/wt'}));
 host.harness.sdk.stub('providers.list',async()=>[{id:'codex',available:true,models:[{id:'gpt-6.1-sol'}],reasoningLevels:[{id:'xhigh'}]}]);
 host.harness.sdk.stub('threads.output',async()=>({output:'DONE: done'}));host.harness.sdk.stub('threads.events.list',async()=>[]);
}
async function factory(settings={},previous) {
 const host=previous??createFakePluginHost({pluginId:'firstmate',settings});if(!previous)await plugin(host.bb);sdk(host);return host;
}
function hostCommands(host,respond) {
 const commands=[];const outputs=new Map();let n=0;
 host.harness.sdk.stub('terminals.create',async args=>{const id=`term${++n}`,command=args.start.command;commands.push(command);const out=respond(command);outputs.set(id,`${out.output??''}\n__FM_HOST_RC:${out.code??0}\n`);return{id};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>({nextSeq:1,chunks:[{dataBase64:Buffer.from(outputs.get(terminalId)).toString('base64')}]}));return commands;
}
const tool=host=>host.harness.registrations.agentTools.find(t=>t.name==='firstmate_queue');
function syntheticLegacy() {
 const statuses=[...Array(24).fill('dispatched'),...Array(41).fill('queued'),...Array(62).fill('done'),...Array(57).fill('dropped')];
 const records=statuses.map((status,n)=>({...row(`q${n}`,n%2?'thr_b':'thr_a',n%2?'proj_b':'proj_a'),status,crewId:status==='dispatched'?`crew${n}`:null}));
 let spare=261986-Buffer.byteLength(JSON.stringify(records));assert.ok(spare>0);
 records.forEach((r,n)=>{const length=Math.ceil(spare/(records.length-n));r.detail='X'.repeat(length);spare-=length;});assert.equal(Buffer.byteLength(JSON.stringify(records)),261986);return records;
}
test('aggregate cap: actual factory migrates 184 full records and adds beyond 262144 bytes losslessly across reload',async()=>{
 let host=await factory();try {
 const legacy=syntheticLegacy();await host.bb.storage.kv.set('queue',legacy);
 const add=await host.harness.behavior.runCli(['queue','add','another full task','--detail','Z'.repeat(3000),'--delivery-requirement','merged-and-verified','--json'],ctx);assert.equal(add.exitCode,0,add.stderr);
 const added=JSON.parse(add.stdout);let q=await inventory(host);assert.ok(Buffer.byteLength(JSON.stringify(q.list()))>262144);assert.equal(q.list().length,185);assert.deepEqual(q.list().slice(1),legacy);
 assert.deepEqual(await host.bb.storage.kv.get('queue'),legacy,'immutable original evidence stays retained');
 const next=await host.harness.behavior.runCli(['queue','next','--json'],ctx);assert.equal(JSON.parse(next.stdout).id,'q64','oldest eligible row, preserving native dependency order');
 const toolAdded=await tool(host).execute({action:'add',title:'small tool task',detail:'Y'.repeat(70)},ctx);assert.equal(typeof toolAdded,'string',JSON.stringify(toolAdded));assert.match(toolAdded,/Queued/);assert.equal(q.list().find(r=>r.title==='small tool task').detail,'Y'.repeat(70));
 const foreign=q.list('thr_b');
 await Promise.all([
  host.harness.behavior.runCli(['queue','drop',added.id],ctx),host.harness.behavior.runCli(['queue','done','q24'],ctx),host.harness.behavior.runCli(['queue','add','owner B extra','--json'],other),
 ]);
 assert.deepEqual(q.list('thr_b').slice(1),foreign);
 const prune=await host.harness.behavior.runCli(['queue','prune'],ctx);assert.equal(prune.exitCode,0,prune.stderr);assert.equal(q.get(added),undefined);assert.equal(q.list('thr_b').length,foreign.length+1);
 const retained=q.list();host=await factory({},await host.harness.lifecycle.reload(plugin));q=await inventory(host);assert.deepEqual(q.list(),retained);assert.deepEqual(await host.bb.storage.kv.get('queue'),legacy);assert.equal(q.get(added),undefined);
 const listed=await host.harness.behavior.runCli(['queue','list','--json'],ctx);assert.equal(listed.exitCode,0);assert.ok(JSON.parse(listed.stdout).every(r=>r.parentThreadId==='thr_a'));
 }finally{await host.harness.lifecycle.dispose();}
});
test('full dispatch spec/execution, dependency gates and same-task concurrency preserve one launch',async()=>{
 const host=await factory();try {
 await host.bb.storage.kv.set('queue',[{...row('gated'),blockedBy:['dep']},{...row('dep'),status:'done'},row('foreign','thr_b','proj_b')]);
 const q=await inventory(host);q.patch(q.get(row('gated')),{detail:'full body\n'.repeat(180)});
 let prompt;host.harness.sdk.stub('threads.spawn',async input=>{prompt=input;return{id:'thr_worker'};});
 const results=await Promise.all([1,2].map(()=>host.harness.behavior.runCli(['queue','dispatch','gated'],ctx)));assert.equal(results.filter(r=>r.exitCode===0).length,1);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,1);
 assert.ok(prompt.prompt.includes('full body\n'.repeat(180)));assert.equal(prompt.providerId,'codex');assert.equal(prompt.model,'gpt-6.1-sol');assert.equal(prompt.reasoningLevel,'xhigh');assert.equal(prompt.pluginMetadata.deliveryRequirement,'merged-and-verified');assert.equal(q.get(row('gated')).status,'dispatched');assert.deepEqual(q.get(row('foreign','thr_b','proj_b')),row('foreign','thr_b','proj_b'));
 }finally{await host.harness.lifecycle.dispose();}
});
test('actual factory migration/read/write failure retains complete evidence and cannot execute a native add',async()=>{
 let host=await factory({fmHome:'/scratch/native',fmHostId:'host_1',queueOwner:'real'});try {
 const legacy=[row('good'),{...row('bad'),blockedBy:'unknown'}];await host.bb.storage.kv.set('queue',legacy);
 const first=await host.harness.behavior.runCli(['queue','add','must not file'],ctx);assert.equal(first.exitCode,1);assert.match(first.stderr,/invalid legacy row/);assert.equal(host.harness.sdk.callsTo('terminals.create').length,0);assert.deepEqual(await host.bb.storage.kv.get('queue'),legacy);
 await host.bb.storage.kv.set('queue',[row('good')]);host=await factory({},await host.harness.lifecycle.reload(plugin));const db=host.bb.storage.database();
 db.exec("CREATE TRIGGER fault BEFORE INSERT ON queue_records WHEN NEW.ordinal<0 BEGIN SELECT RAISE(ABORT,'queue storage full'); END");
 const failed=await host.harness.behavior.runCli(['queue','add','durable first'],ctx);assert.equal(failed.exitCode,1);assert.match(failed.stderr,/queue storage full/);assert.equal(host.harness.sdk.callsTo('terminals.create').length,0);assert.equal((await inventory(host)).list().length,1);db.exec('DROP TRIGGER fault');
 }finally{await host.harness.lifecycle.dispose();}
});
test('native add ambiguity retains full intent; explicit exact reconcile never repeats add or starts worker',async()=>{
 let host=await factory({fmHome:'/scratch/native',fmHostId:'host_1',queueOwner:'real'});try {
 await host.bb.storage.kv.set('native-home:thr_a','/scratch/native');
 let title;let nativeId;const commands=hostCommands(host,wrapped=>{
  const match=/^__fm_cmd='([\s\S]*?)'; set \+e; \"/.exec(wrapped);
  const command=match?match[1].replace(/'\\''/g,"'"):wrapped;
  if(command.includes("'add'")){const m=/'add' '([^']+)' '([^']+)'/.exec(command);nativeId=m[1];title=m[2];return{code:1,output:'response lost after native add'};}
  return{output:`task:\n  id: ${nativeId}\n  title: ${title}\n  kind: ship\n  state: queued\n`};
 });
 const add=await host.harness.behavior.runCli(['queue','add','retained native intent','--detail','full saved\ntext','--mode','direct-PR','--delivery-requirement','merged-and-verified'],ctx);assert.equal(add.exitCode,1);assert.match(add.stderr,/saved; native add unresolved/);let q=await inventory(host);const stored=q.list()[0];assert.equal(stored.detail,'full saved\ntext');assert.equal(stored.nativePending,true);
 const blocked=await host.harness.behavior.runCli(['queue','dispatch',stored.id],ctx);assert.equal(blocked.exitCode,1);assert.match(blocked.stderr,/native publication unresolved/);
 const fixed=await host.harness.behavior.runCli(['queue','reconcile',stored.id],ctx);assert.equal(fixed.exitCode,0,fixed.stderr);assert.equal(q.get(stored).deliveryRequirement,'merged-and-verified');assert.equal(q.get(stored).nativePending,false);assert.equal(commands.filter(c=>c.includes("'add'")).length,1);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);
 const duplicate=await tool(host).execute({action:'reconcile',queueId:stored.id},ctx);assert.equal(typeof duplicate,'string');assert.equal(q.list().length,1);
 }finally{await host.harness.lifecycle.dispose();}
});
test('legacy post-launch queue-save failure recovers exact admitted worker and refuses duplicate dispatch across reload',async()=>{
 let host=await factory({fmHome:'/scratch/native',fmHostId:'host_1',queueOwner:'real'});try {
 await host.bb.storage.kv.set('native-home:thr_a','/scratch/native');
 const key=launchKey('proj_a','thr_a','/scratch/native','task6');const task='task task6\n\nfull original native work';
 const crew={id:'task6',title:'task task6',task,projectId:'proj_a',parentThreadId:'thr_a',threadId:'thr_worker',nativeHome:'/scratch/native',worktree:true,shape:'ship',posture:'direct-PR',providerId:'codex',model:'gpt-6.1-sol',reasoningLevel:'xhigh',deliveryRequirement:'merged-and-verified',launchKey:key,createdAt:'2026-10-04T00:00:00.000Z',metaWritten:true,backlogRow:true};
 await host.bb.storage.kv.set('crews',[crew]);createLaunches(host.bb.storage.database()).save({key,taskId:'task6',projectId:'proj_a',owner:'thr_a',home:'/scratch/native',generation:1,shape:'ship',state:'running',threadId:'thr_worker',nativeInvoked:true,hostId:'host_1',deliveryMode:'direct-PR',deliveryRequirement:'merged-and-verified',updatedAt:Date.now()});
 // Actual old post-launch save fails at the former aggregate cap. Launch and native evidence survive.
 await host.bb.storage.kv.set('queue',syntheticLegacy());await assert.rejects(host.bb.storage.kv.set('queue',[...syntheticLegacy(),{...row('task6'),detail:'new record'.repeat(500)}]),/262144|too large|exceeds/);
 const stubs=()=>{
  sdk(host);host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>threadId==='thr_worker'?{crew:'true',crewId:'task6',launchKey:key,nativeHome:'/scratch/native'}:{});
  return hostCommands(host,command=>({output:command.includes("'show'")?'task:\n  id: task6\n  title: task task6\n  kind: ship\n  state: in_flight\n':command.includes('bb_thread_id')?'thr_worker':''}));
 };stubs();const fixed=await host.harness.behavior.runCli(['queue','reconcile','task6','--json'],ctx);assert.equal(fixed.exitCode,0,fixed.stderr);const recovered=JSON.parse(fixed.stdout);assert.equal(recovered.status,'dispatched');assert.equal(recovered.detail,task);assert.equal(recovered.deliveryRequirement,'merged-and-verified');assert.equal(recovered.model,'gpt-6.1-sol');
 host=await factory({},await host.harness.lifecycle.reload(plugin));stubs();const again=await host.harness.behavior.runCli(['queue','reconcile','task6'],ctx);assert.equal(again.exitCode,0,again.stderr);const dispatch=await host.harness.behavior.runCli(['queue','dispatch','task6'],ctx);assert.equal(dispatch.exitCode,1);assert.match(dispatch.stderr,/status dispatched/);
 for(const method of ['threads.spawn','threads.send','threads.retry','threads.stop','threads.archive'])assert.equal(host.harness.sdk.callsTo(method).length,0);
 const wrong=await host.harness.behavior.runCli(['queue','reconcile','task6'],other);assert.equal(wrong.exitCode,1);assert.match(wrong.stderr,/exact registered/);
 }finally{await host.harness.lifecycle.dispose();}
});
for(const pin of pins)test(`disposable real native backlog ${pin.slice(0,8)} add/read/transition through actual factory`,async()=>{
 const home=fixture(pin);let host;try {
 mkdirSync(join(home,'data'),{recursive:true});ok(run('python3',[join(overlay,'install-bb-backend.py'),'--home',home]));
 host=await factory({fmHome:home,fmHostId:'host_1',queueOwner:'real'});await host.bb.storage.kv.set('native-home:thr_a',home);
 const commands=hostCommands(host,command=>{const match=/^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(command);assert.ok(match);const inner=match[1].replace(/'\\''/g,"'");const result=spawnSync('bash',['-c',inner],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});return{code:result.status??2,output:result.stdout+result.stderr};});
 const add=await host.harness.behavior.runCli(['queue','add','synthetic backlog task','--detail','synthetic complete detail','--json'],ctx);assert.equal(add.exitCode,0,add.stderr);const item=JSON.parse(add.stdout);assert.equal(item.backlogId,item.id);
 const read=ok(run('bash',[join(home,'bin-bb/fm-tasks-axi.sh'),'show',item.id,'--full'],{FM_HOME:home}));assert.match(read,/synthetic backlog task/);assert.match(read,/queued/);
 const done=await host.harness.behavior.runCli(['queue','done',item.id],ctx);assert.equal(done.exitCode,0,done.stderr);assert.match(ok(run('bash',[join(home,'bin-bb/fm-tasks-axi.sh'),'show',item.id,'--full'],{FM_HOME:home})),/state: done/);
 const q=await inventory(host);assert.equal(q.get(item).status,'done');assert.equal(q.get(item).detail,'synthetic complete detail');assert.ok(commands.some(c=>c.includes('fm-tasks-axi.sh')));
 for(const method of ['threads.spawn','threads.send','threads.retry'])assert.equal(host.harness.sdk.callsTo(method).length,0);
 }finally{if(host)await host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});
test('native-only queued repair requires the complete explicit contract and rejects conflicting identities',async()=>{
 const host=await factory({fmHome:'/scratch/native',fmHostId:'host_1',queueOwner:'real'});try {
 await host.bb.storage.kv.set('native-home:thr_a','/scratch/native');let nativeId='orphan';
 hostCommands(host,()=>({output:`task:\n  id: ${nativeId}\n  title: original title\n  kind: ship\n  state: queued\n`}));
 const incomplete=await host.harness.behavior.runCli(['queue','reconcile','orphan'],ctx);assert.equal(incomplete.exitCode,1);assert.match(incomplete.stderr,/original --title/);assert.equal((await inventory(host)).list().length,0);
 const full={action:'reconcile',queueId:'orphan',title:'original title',detail:'complete original BB body',mode:'direct-PR',deliveryRequirement:'merged-and-verified',providerId:'codex',model:'gpt-6.1-sol',reasoningLevel:'xhigh',after:['dep'],waitUntil:'2030-10-04T00:00:00Z'};
 nativeId='different';const bad=await tool(host).execute(full,ctx);assert.equal(bad.isError,true);assert.equal((await inventory(host)).list().length,0);
 nativeId='orphan';const repaired=await tool(host).execute(full,ctx);assert.equal(typeof repaired,'string',JSON.stringify(repaired));const saved=(await inventory(host)).list()[0];assert.equal(saved.detail,full.detail);assert.equal(saved.deliveryRequirement,full.deliveryRequirement);assert.deepEqual(saved.blockedBy,['dep']);assert.equal(saved.waitUntil,full.waitUntil);assert.equal(saved.model,full.model);
 const conflict=await tool(host).execute({...full,deliveryRequirement:'merged'},ctx);assert.equal(conflict.isError,true);assert.deepEqual((await inventory(host)).list()[0],saved);
 for(const method of ['threads.spawn','threads.send','threads.retry'])assert.equal(host.harness.sdk.callsTo(method).length,0);
 }finally{await host.harness.lifecycle.dispose();}
});
test('actual dispatch returns from native start before failed queue publication; reconcile/reload reuse exact worker',async()=>{
 let host=await factory({fmHome:'/scratch/native',fmHostId:'host_1',queueOwner:'real'});try {
 await host.bb.storage.kv.set('native-home:thr_a','/scratch/native');let metadata;let started=false;let id;
 const stubs=()=>{
  sdk(host);host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>threadId==='thr_worker'?metadata:{});
  return hostCommands(host,command=>{
   if(command.includes("'start'"))started=true;
   return{output:command.includes("fm-project-mode.sh")?(command.includes("--branch-prefix")?"fm/\n":"no-mistakes off\n"):command.includes("'show'")?`task:\n  id: ${id}\n  title: full launch spec\n  kind: ship\n  state: ${started?'in_flight':'queued'}\n`:command.includes('bb_thread_id')?'thr_worker':''};
  });
 };stubs();
 const add=await host.harness.behavior.runCli(['queue','add','full launch spec','--detail','saved unchanged body','--delivery-requirement','merged-and-verified','--json'],ctx);assert.equal(add.exitCode,0,add.stderr);const item=JSON.parse(add.stdout);id=item.id;
 host.harness.sdk.stub('threads.spawn',async input=>{
  metadata=input.pluginMetadata;
  // The old call already succeeded; simulate the remaining DB publication failing.
  host.bb.storage.database().exec("CREATE TRIGGER fault BEFORE UPDATE ON queue_records BEGIN SELECT RAISE(ABORT,'post-launch publication failed'); END");return{id:'thr_worker'};
 });
 const dispatch=await host.harness.behavior.runCli(['queue','dispatch',id],ctx);assert.equal(dispatch.exitCode,1);assert.match(dispatch.stderr,/post-launch publication failed/);assert.equal(started,true);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,1);assert.equal((await inventory(host)).get(item).status,'queued');assert.equal(createLaunches(host.bb.storage.database()).forTask('proj_a','thr_a',id).state,'running');
 host.bb.storage.database().exec('DROP TRIGGER fault');const fixed=await host.harness.behavior.runCli(['queue','reconcile',id],ctx);assert.equal(fixed.exitCode,0,fixed.stderr);assert.equal((await inventory(host)).get(item).status,'dispatched');assert.equal(host.harness.sdk.callsTo('threads.spawn').length,1);
 host=await factory({},await host.harness.lifecycle.reload(plugin));stubs();const again=await host.harness.behavior.runCli(['queue','reconcile',id],ctx);assert.equal(again.exitCode,0,again.stderr);const retry=await host.harness.behavior.runCli(['queue','dispatch',id],ctx);assert.equal(retry.exitCode,1);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(host.harness.sdk.callsTo('threads.send').length,0);assert.equal((await inventory(host)).get(item).detail,'saved unchanged body');
 }finally{await host.harness.lifecycle.dispose();}
});
test('worker read-through completion and explicit handoff mutate only exact owned project queue records',async()=>{
 const host=await factory({fmHome:'/scratch/native',fmHostId:'host_1',readThrough:true});try {
 const crew={id:'same',task:'full preserved task',projectId:'proj_a',parentThreadId:'thr_a',threadId:'thr_worker',nativeHome:'/scratch/native',worktree:true,shape:'ship',posture:'direct-PR',providerId:null,model:null,reasoningLevel:null,createdAt:'2026-09-18T00:00:00.000Z'};
 const own={...row('qOwn'),status:'dispatched',crewId:'same'},foreign={...row('qForeign','thr_b','proj_b'),status:'dispatched',crewId:'same'};
 await host.bb.storage.kv.set('queue',[own,foreign]);await host.bb.storage.kv.set('crews',[crew]);hostCommands(host,()=>({output:''}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,status:'idle',projectId:'proj_a',environmentId:'env_wt'}));
 const bearings=await host.harness.behavior.runCli(['crews'],ctx);assert.equal(bearings.exitCode,0,bearings.stderr);const q=await inventory(host);assert.equal(q.get(own).status,'done');assert.deepEqual(q.get(foreign),foreign);
 await host.bb.storage.kv.set('crews',[{...crew,id:'next',threadId:'thr_next',nativeHome:'/old-home',metaWritten:false}]);q.add({...row('move'),crewId:'next',nativeHome:'/old-home',providerId:'codex',model:'gpt-6.1-sol',detail:'saved full unchanged work'});
 host.harness.sdk.stub('threads.update',async()=>({}));const moved=await host.harness.behavior.runCli(['handoff','--from','thr_a'],{threadId:'thr_new',projectId:'proj_a'});assert.equal(moved.exitCode,0,moved.stderr);const after=q.list().find(r=>r.id==='move');assert.equal(after.parentThreadId,'thr_new');assert.equal(after.nativeHome,'/old-home');assert.equal(after.detail,'saved full unchanged work');assert.equal(after.deliveryRequirement,'merged-and-verified');assert.deepEqual(q.get(foreign),foreign);
 }finally{await host.harness.lifecycle.dispose();}
});
