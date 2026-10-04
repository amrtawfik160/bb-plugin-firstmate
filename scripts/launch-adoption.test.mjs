import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,cpSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createFakePluginHost,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
import {createLaunches,launchKey} from '../lib/launch.ts';
import {createDeliveries} from '../lib/pr-delivery.ts';
import {pins,fixture,scaffold,run,ok,overlay} from './prompt-fixture.mjs';

const ctx={threadId:'thr_captain',projectId:'proj_repair'};
const target='thr_legacy';
function setup(pin=pins[1],shape='ship',mode='direct-PR') {
 const home=fixture(pin);ok(run('python3',[join(overlay,'install-bb-backend.py'),'--home',home]));
 const root=mkdtempSync(join(tmpdir(),'fm-adopt-repo-')),repo=join(root,'repo'),wt=join(root,'wt');mkdirSync(repo);
 ok(run('git',['-C',repo,'init','--quiet']));ok(run('git',['-C',repo,'config','user.email','test@example.com']));ok(run('git',['-C',repo,'config','user.name','Fixture']));
 writeFileSync(join(repo,'file'),'original\n');ok(run('git',['-C',repo,'add','file']));ok(run('git',['-C',repo,'commit','--quiet','-m','fixture']));ok(run('git',['-C',repo,'remote','add','origin','https://github.com/acme/repo.git']));
 ok(run('git',['-C',repo,'worktree','add','--quiet','-b','fm/deadbeef',wt]));
 ok(run('git',['-C',wt,'checkout','--quiet','-b','fm/deadbeef-disclosures']));writeFileSync(join(wt,'dirty'),'keep existing dirty work\n');
 const source=scaffold(home,'deadbeef',shape,mode);writeFileSync(source.source,source.text.replace('worktree of /example/project,','worktree of '+repo+','));
 const brief=readFileSync(source.source,'utf8');
 const status='2026-10-04T00:00:00Z done: PRs https://github.com/acme/repo/pull/43 and https://github.com/acme/repo/pull/47\n';writeFileSync(join(home,'state/deadbeef.status'),status);
 writeFileSync(join(home,'config/bb-captain'),ctx.threadId+'\n');
 writeFileSync(join(home,'config/backlog-backend'),'manual\n');
 const prompt=`# Current worker role contract\nYour steering inbox is \`${home}/state/deadbeef.inbox\`.\n\n${brief}`;
 const record={key:launchKey(ctx.projectId,ctx.threadId,home,'deadbeef'),owner:ctx.threadId,projectId:ctx.projectId,home,taskId:'deadbeef',generation:1,shape,deliveryMode:mode,deliveryRequirement:'merged-and-verified',state:'uncertain',threadId:null,nativeInvoked:true,hostId:'host_fixture',path:repo,updatedAt:1000,execution:{providerId:'codex',model:'gpt-6.1-sol',reasoningLevel:'high'},error:'Old adapter timed out before environment path was ready'};
 const plan={record,threadId:target,environmentId:'env_worker',eventId:'event_initial',createdAt:900,worktree:wt,prompt,execution:{model:'gpt-6.1-sol',reasoningLevel:'high',permissionMode:'auto'}};
 const env={FM_HOME:home,FM_ROOT:home,FM_BINDIR:join(home,'bin-bb'),FM_BACKEND:'bb',FM_SUPERVISION_ACTOR:'main'};
 const native=(action,p=plan,extraEnv={})=>spawnSync('bash',[join(home,'bin-bb/fm-launch-adopt.sh'),action],{input:JSON.stringify(p),encoding:'utf8',env:{...process.env,...env,...extraEnv},timeout:15000});
 return {home,root,repo,wt,record,plan,status,brief,native,clean:()=>{rmSync(home,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});}};
}
function invariant(f) {return {head:ok(run('git',['-C',f.wt,'rev-parse','HEAD'])),branch:ok(run('git',['-C',f.wt,'symbolic-ref','HEAD'])),refs:ok(run('git',['-C',f.repo,'show-ref'])),dirty:readFileSync(join(f.wt,'dirty'),'utf8'),brief:readFileSync(join(f.home,'data/deadbeef/brief.md'),'utf8'),status:readFileSync(join(f.home,'state/deadbeef.status'),'utf8')};}
for(const pin of pins) for(const [shape,mode] of [['ship','direct-PR'],['ship','no-mistakes'],['ship','local-only'],['scout','direct-PR']]) {
 test(`real native adoption ${pin.slice(0,8)} ${shape}/${mode}: guards publish exact existing endpoint without touching work`,()=>{
  const f=setup(pin,shape,mode);try {
   const before=invariant(f);const inspected=JSON.parse(ok(f.native('--check')));assert.equal(inspected.existing,false);assert.equal(existsSync(join(f.home,'state/deadbeef.meta')),false);
   const adopted=JSON.parse(ok(f.native('--publish')));assert.equal(adopted.existing,true);assert.equal(adopted.proof,inspected.proof);
   const meta=readFileSync(join(f.home,'state/deadbeef.meta'),'utf8');assert.match(meta,/bb_original_admission=unconfirmed/);assert.match(meta,/bb_delivery_requirement=merged-and-verified/);assert.match(meta,/bb_thread_id=thr_legacy/);
   const preflight=run('bash',['-c','. "$FM_BINDIR/fm-backend.sh"; fm_backend_validate_task_endpoint "$FM_HOME/state/deadbeef.meta" deadbeef; printf "%s" "$FM_BACKEND_VALIDATED_TARGET"'],{FM_HOME:f.home,FM_BINDIR:join(f.home,'bin-bb')});assert.equal(ok(preflight),`bb:${target}`);
   ok(f.native('--publish'));assert.equal(readFileSync(join(f.home,'state/deadbeef.meta'),'utf8'),meta);assert.deepEqual(invariant(f),before);
  }finally{f.clean();}
 });
}
test('native repair refuses changed source, task, repo, primary checkout, metadata collision and retired namespace before registration',()=>{
 const changes=[
  ['source mode',f=>{const p=join(f.home,'data/deadbeef/brief.md');writeFileSync(p,f.brief.replace('Delivery contract: mode=direct-PR','Delivery contract: mode=local-only'));},/delivery contract/],
  ['wrong prompt',f=>{f.plan.prompt=f.plan.prompt.replace('Smooth canvas zoom','Different user task');},/prompt/],
  ['wrong source project',f=>{writeFileSync(join(f.home,'data/deadbeef/brief.md'),f.brief.replace('worktree of '+f.repo+',','worktree of /wrong/project,'));},/project provenance/],
  ['wrong home',f=>{f.plan.record={...f.record,home:f.root};},/namespace|native|ENOENT/],
  ['primary',f=>{f.plan.worktree=f.repo;},/isolation/],
  ['wrong repo',f=>{ok(run('git',['-C',f.repo,'remote','set-url','origin','https://github.com/acme/different.git']));const isolated=join(f.root,'other');ok(run('git',['clone','--quiet',f.repo,isolated]));ok(run('git',['-C',isolated,'branch','fm/deadbeef']));ok(run('git',['-C',isolated,'remote','set-url','origin','https://github.com/acme/repo.git']));f.plan.worktree=isolated;},/origin/],
  ['collision',f=>writeFileSync(join(f.home,'state/deadbeef.meta'),'window=bb:thr_other\n'),/collision/],
  ['retirement',f=>writeFileSync(join(f.home,'state/deadbeef.backlog-close'),'retired'),/retirement/],
  ['symlink status',f=>{rmSync(join(f.home,'state/deadbeef.status'));symlinkSync(join(f.wt,'dirty'),join(f.home,'state/deadbeef.status'));},/symbolic|links/],
  ['modified native isolation',f=>{const p=join(f.home,'bin/fm-spawn.sh');writeFileSync(p,readFileSync(p,'utf8').replace('spawn_worktree_isolated() { # <path>','spawn_worktree_isolated() { # changed'));},/predicate changed/],
 ];
 for(const [name,mutate,reason] of changes) {const f=setup();try{mutate(f);const result=f.native('--publish');assert.notEqual(result.status,0,name);assert.match(result.stderr,reason,name);assert.equal(existsSync(join(f.home,'state/deadbeef.meta')),name==='collision',name);}finally{f.clean();}}
});
// Execute the actual installed helpers through the public terminal transport.
// Only BB is fake; git/native scripts and persistent database are real fixtures.
async function factory(f,reuse) {
 const host=reuse?.host ?? createFakePluginHost({pluginId:'firstmate',settings:{fmHome:f.home,fmHostId:'host_fixture',readThrough:true}});if(!reuse) await plugin(host.bb);
 await host.bb.storage.kv.set(`native-home:${ctx.threadId}`,f.home);
 if(!reuse) createLaunches(host.bb.storage.database()).save(f.record);
 const metadata=reuse?.metadata ?? new Map([[ctx.threadId,{captain:'true',nativeHome:f.home}],[target,{}]]);
 const environment={id:'env_worker',projectId:ctx.projectId,hostId:'host_fixture',path:f.wt,status:'ready',managed:true,isWorktree:true,workspaceProvisionType:'managed-worktree',lifecycle:{phase:'active'}};
 const thread=makeThreadResponse({id:target,parentThreadId:ctx.threadId,projectId:ctx.projectId,createdAt:900,status:'idle',environmentId:environment.id,providerId:'codex'});
 host.harness.sdk.stub('threads.get',async({threadId})=>threadId===ctx.threadId?makeThreadResponse({id:ctx.threadId,projectId:ctx.projectId}):thread);
 host.harness.sdk.stub('threads.list',async args=>args.environmentId?[thread]:args.parentThreadId?[thread]:[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>metadata.get(threadId)??{});
 host.harness.sdk.stub('threads.updatePluginMetadata',async({threadId,set})=>{metadata.set(threadId,{...metadata.get(threadId),...set});return metadata.get(threadId);});
 host.harness.sdk.stub('threads.events.list',async({threadId})=>threadId===target?[{id:f.plan.eventId,threadId,seq:1,createdAt:900,type:'client/turn/requested',data:{input:[{type:'text',text:f.plan.prompt}],target:{kind:'thread-start'},execution:f.plan.execution}}]:[]);
 host.harness.sdk.stub('threads.output',async()=>({output:'DONE: https://github.com/acme/repo/pull/43 and https://github.com/acme/repo/pull/47'}));
 host.harness.sdk.stub('environments.get',async()=>environment);
 host.harness.sdk.stub('projects.get',async()=>({id:ctx.projectId,sources:[{hostId:'host_fixture',path:f.repo}]}));
 host.harness.sdk.stub('environments.list',async()=>[{hostId:'host_fixture',path:f.repo,status:'ready',isWorktree:false}]);
 const commands=new Map();let n=0;
 host.harness.sdk.stub('terminals.create',async({start})=>{const id=`terminal${++n}`;commands.set(id,start.command);return{id};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{
  const wrapped=commands.get(terminalId);const match=/^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(wrapped);const inner=match?match[1].replace(/'\\''/g,"'"):wrapped;
  const result=run('bash',['-c',inner]);return{nextSeq:1,chunks:[{dataBase64:Buffer.from((result.stdout??'')+(result.stderr??'')+`\n__FM_HOST_RC:${result.status??1}\n`).toString('base64')}]};
 });
 return {host,metadata,environment,thread};
}
function noWorkerMutations(host) {for(const method of ['threads.spawn','threads.send','threads.retry','threads.stop','threads.update','threads.delete','threads.archive']) assert.equal(host.harness.sdk.callsTo(method).length,0,method);}
test('actual factory legacy repair restores crew visibility, keeps multiple PR obligations and immutable contract after reload',async()=>{
 const f=setup(pins[0]);let {host,metadata}=await factory(f);try {
  const deliveries=createDeliveries(host.bb.storage.database());for(const number of [43,47]) deliveries.register({url:`https://github.com/acme/repo/pull/${number}`,taskId:f.record.taskId,projectId:ctx.projectId,owner:ctx.threadId,home:f.home,worker:target,requirement:f.record.deliveryRequirement});
  const records=[deliveries.get('acme/repo#43'),deliveries.get('acme/repo#47')];const before=invariant(f);
  const args=['launches','adopt','deadbeef','--thread',target,'--json'];
  const check=await host.harness.behavior.runCli([...args,'--check'],ctx);assert.equal(check.exitCode,0,check.stderr);assert.equal(JSON.parse(check.stdout).adopted,false);assert.equal(createLaunches(host.bb.storage.database()).get(f.record.key).state,'uncertain');
  const adopted=await host.harness.behavior.runCli(args,ctx);assert.equal(adopted.exitCode,0,adopted.stderr);assert.equal(JSON.parse(adopted.stdout).workerStatus,'idle');
  const shown=await host.harness.behavior.runCli(['crew','deadbeef','--json'],ctx);assert.equal(shown.exitCode,0,shown.stderr);assert.equal(JSON.parse(shown.stdout).threadId,target);assert.equal(JSON.parse(shown.stdout).deliveryRequirement,'merged-and-verified');
  const tool=await host.harness.behavior.callAgentTool('firstmate_crew',{crewId:'deadbeef'},ctx);assert.match(JSON.stringify(tool),/thr_legacy/);
  assert.deepEqual([deliveries.get('acme/repo#43'),deliveries.get('acme/repo#47')],records);assert.deepEqual(invariant(f),before);
  const record=createLaunches(host.bb.storage.database()).get(f.record.key);assert.equal(record.adoption.phase,'complete');assert.equal(record.adoption.originalUpdatedAt,1000);assert.equal(record.adoption.createdAt,900);assert.equal(record.path,f.repo);assert.equal(record.deliveryRequirement,'merged-and-verified');
  assert.equal(createLaunches(host.bb.storage.database()).adoptionTask(f.record.key),f.plan.prompt.slice(f.plan.prompt.indexOf('# Task\n'),f.plan.prompt.indexOf('\n# Herdr lifecycle declaration')));assert.equal(record.adoption.execution.model,'gpt-6.1-sol');assert.equal(record.adoption.execution.permissionMode,'auto');assert.equal(record.adoption.originalError,f.record.error);
  noWorkerMutations(host);host=await host.harness.lifecycle.reload(plugin);await factory(f,{host,metadata});
  assert.equal((await host.harness.behavior.runCli(args,ctx)).exitCode,0);noWorkerMutations(host);
 }finally{await host.harness.lifecycle.dispose();f.clean();}
});
test('factory refuses wrong owner/project/host/environment/provenance/metadata/rival/deleted identities without publication',async()=>{
 const changes=[
  ['owner',async()=>({threadId:'thr_other',projectId:ctx.projectId})],
 ['project',async()=>({...ctx,projectId:'proj_other'})],
  ['home',async(f,x)=>{await x.host.bb.storage.kv.set(`native-home:${ctx.threadId}`,f.root);}],
  ['thread',async(_f,x)=>{x.thread.id='thr_other';}],
  ['parent',async(_f,x)=>{x.thread.parentThreadId='thr_other';}],
  ['host',async(_f,x)=>{x.environment.hostId='host_other';}],
  ['managed',async(_f,x)=>{x.environment.managed=false;}],
  ['lifecycle',async(_f,x)=>{x.thread.archivedAt=1;}],
  ['metadata',async(_f,x)=>{x.metadata.set(target,{crewId:'different'});}],
  ['provenance',async(_f,x)=>{x.host.harness.sdk.stub('threads.events.list',async()=>[]);}],
  ['model',async(f)=>{f.plan.execution={...f.plan.execution,model:'different-model'};}],
  ['rival',async(_f,x)=>{x.host.harness.sdk.stub('threads.list',async args=>args.environmentId?[x.thread]:[x.thread,makeThreadResponse({id:'thr_rival',projectId:ctx.projectId,parentThreadId:ctx.threadId})]);x.metadata.set('thr_rival',{crewId:'deadbeef'});}],
  ['retired',async(_f,x)=>{await x.host.bb.storage.kv.set(`crew-retired:${target}`,true);}],
  ['contract',async(f,x)=>{createLaunches(x.host.bb.storage.database()).update(f.record.key,{deliveryRequirement:undefined});}],
  ['deleted',async(f,x)=>{createLaunches(x.host.bb.storage.database()).workerDeleted(target);}],
 ];
 for(const [name,mutate] of changes) {const f=setup();const x=await factory(f);try{const context=await mutate(f,x)??ctx;const result=await x.host.harness.behavior.runCli(['launches','adopt','deadbeef','--thread',target],context);assert.equal(result.exitCode,1,name);assert.equal(existsSync(join(f.home,'state/deadbeef.meta')),false,name);assert.equal(x.host.harness.sdk.callsTo('threads.updatePluginMetadata').length,0,name);noWorkerMutations(x.host);}finally{await x.host.harness.lifecycle.dispose();f.clean();}}
});
for(const boundary of ['reservation','bb-metadata','crew-cache','completion']) test(`actual factory interrupted ${boundary} publication recovers durable exact adoption after reload`,async()=>{
 const f=setup();let {host,metadata}=await factory(f);try {
  const db=host.bb.storage.database();
  if(boundary==='reservation') db.exec("CREATE TRIGGER adoption_fault BEFORE UPDATE ON launches WHEN json_extract(NEW.record,'$.adoption.phase')='publishing' BEGIN SELECT RAISE(ABORT,'fault before reserved identity publication'); END");
  if(boundary==='completion') db.exec("CREATE TRIGGER adoption_fault BEFORE UPDATE ON launches WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT,'fault after native/BB/cache publication'); END");
  if(boundary==='bb-metadata') host.harness.sdk.stub('threads.updatePluginMetadata',async()=>{throw new Error('fault after native publication before BB metadata');});
  if(boundary==='crew-cache') {const original=host.bb.storage.kv.set;host.bb.storage.kv.set=async(key,value)=>{if(key==='crews') throw new Error('fault before crew cache publication');return original(key,value);};}
  const args=['launches','adopt','deadbeef','--thread',target,'--json'];
  const first=await host.harness.behavior.runCli(args,ctx);assert.equal(first.exitCode,1,first.stdout);assert.match(first.stderr,/fault/);
  let launch=createLaunches(db).get(f.record.key);assert.equal(launch.state,boundary==='reservation'?'uncertain':'provisioning');assert.equal(existsSync(join(f.home,'state/deadbeef.meta')),boundary!=='reservation');
  const nativeBefore=existsSync(join(f.home,'state/deadbeef.meta'))?readFileSync(join(f.home,'state/deadbeef.meta'),'utf8'):null;
  noWorkerMutations(host);if(['reservation','completion'].includes(boundary)) db.exec('DROP TRIGGER adoption_fault');
  host=await host.harness.lifecycle.reload(plugin);await factory(f,{host,metadata});
  if(boundary!=='reservation') {await host.harness.behavior.runSchedule('pr-delivery-follow-up');assert.equal(createLaunches(host.bb.storage.database()).get(f.record.key).state,'provisioning','background cannot certify partial repair');}
  const recovered=await host.harness.behavior.runCli(args,ctx);assert.equal(recovered.exitCode,0,recovered.stderr);launch=createLaunches(host.bb.storage.database()).get(f.record.key);assert.equal(launch.state,'running');assert.equal(launch.threadId,target);assert.equal(launch.adoption.phase,'complete');assert.equal(launch.deliveryRequirement,f.record.deliveryRequirement);
  if(nativeBefore) assert.equal(readFileSync(join(f.home,'state/deadbeef.meta'),'utf8'),nativeBefore);
  assert.equal((await host.harness.behavior.runCli(['crew','deadbeef','--json'],ctx)).exitCode,0);noWorkerMutations(host);
 }finally{await host.harness.lifecycle.dispose();f.clean();}
});
test('hung adoption identity read cancels on plugin disposal before any native or worker mutation',async()=>{
 const f=setup();const {host}=await factory(f);try {
  let entered;const pending=new Promise(r=>entered=r);
  host.harness.sdk.stub('threads.get',async()=>{entered();return new Promise(()=>{});});
  const action=host.harness.behavior.runCli(['launches','adopt','deadbeef','--thread',target],ctx);await pending;
  const started=Date.now();await host.harness.lifecycle.dispose();const result=await action;assert.equal(result.exitCode,1);assert.ok(Date.now()-started<1000);assert.equal(existsSync(join(f.home,'state/deadbeef.meta')),false);noWorkerMutations(host);
 }finally{await host.harness.lifecycle.dispose();f.clean();}
});
for(const pin of pins) test(`native ${pin.slice(0,8)} backlog pairing and closed-task refusal are authoritative`,()=>{
 const f=setup(pin);try {
  rmSync(join(f.home,'config/backlog-backend'));
  const env={FM_HOME:f.home,FM_ROOT_OVERRIDE:f.home,FM_BINDIR:join(f.home,'bin-bb')};
  ok(run('bash',[join(f.home,'bin-bb/fm-tasks-axi.sh'),'add','deadbeef','Legacy repair task','--kind','ship'],env));
  ok(f.native('--publish'));
  const show=ok(run('bash',[join(f.home,'bin-bb/fm-tasks-axi.sh'),'show','deadbeef'],env));assert.match(show,/In flight|in_flight/i);
  // Native metadata can be gone after an explicit lifecycle close. Do not
  // recreate its registration merely because source/status/prompt survive.
  rmSync(join(f.home,'state/deadbeef.meta'));ok(run('bash',[join(f.home,'bin-bb/fm-tasks-axi.sh'),'done','deadbeef'],env));
  const result=f.native('--publish');assert.notEqual(result.status,0);assert.match(result.stderr,/backlog/);assert.equal(existsSync(join(f.home,'state/deadbeef.meta')),false);
 }finally{f.clean();}
});
for(const pin of pins) test(`native ${pin.slice(0,8)} interrupted metadata/backlog publication retries the same endpoint`,()=>{
 const f=setup(pin);try {
  const before=invariant(f);rmSync(join(f.home,'config/backlog-backend'));
  const env={FM_HOME:f.home,FM_ROOT_OVERRIDE:f.home,FM_BINDIR:join(f.home,'bin-bb')};
  ok(run('bash',[join(f.home,'bin-bb/fm-tasks-axi.sh'),'add','deadbeef','Legacy repair task','--kind','ship'],env));
  const fakebin=join(f.root,'fakebin');mkdirSync(fakebin);
  const actual=ok(run('bash',['-c','command -v tasks-axi'])).trim();
  writeFileSync(join(fakebin,'tasks-axi'),`#!/bin/bash\nfor arg in "$@"; do if [ "$arg" = start ]; then echo 'injected backlog pairing failure' >&2; exit 1; fi; done\nexec '${actual}' "$@"\n`,{mode:0o755});
  const failed=f.native('--publish',f.plan,{PATH:fakebin+':'+process.env.PATH});assert.notEqual(failed.status,0);assert.match(failed.stderr,/pairing requires retry/);
  const meta=readFileSync(join(f.home,'state/deadbeef.meta'),'utf8');assert.match(meta,/bb_thread_id=thr_legacy/);
  ok(f.native('--publish'));assert.equal(readFileSync(join(f.home,'state/deadbeef.meta'),'utf8'),meta);assert.deepEqual(invariant(f),before);
  assert.match(ok(run('bash',[join(f.home,'bin-bb/fm-tasks-axi.sh'),'show','deadbeef'],env)),/In flight|in_flight/i);
 }finally{f.clean();}
});
