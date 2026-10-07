import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createFakePluginHost,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import {distribution,helper,assets,secondRelease} from './scripts/native-runtime-fixture.mjs';
import {createLaunches,launchKey} from './lib/launch.ts';
const ctx={threadId:'thr_fresh',projectId:'proj_fixture'};
export async function factory(options={}) {
 const directory=options.directory??mkdtempSync(join(tmpdir(),'fm-runtime-sdk-owned-'));mkdirSync(join(directory,'bin'),{recursive:true});writeFileSync(join(directory,'bin/bb'),'#!/bin/sh\nprintf "{}\\n"\n',{mode:0o755});
 const host=options.host??createFakePluginHost({pluginId:'firstmate',settings:{fmHome:'',fmHostId:'host_remote'}});if(!options.registered)await (process.env.FM_RUNTIME_BUILT?(await import('./dist/server.js')).default:plugin)(host.bb);
 const seen=[],outputs=new Map(),metadata=new Map([[ctx.threadId,{captain:'true'}]]);let n=0;
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:ctx.projectId,environmentId:'env_fixture',status:'idle',providerId:'acp-grok'}));host.harness.sdk.stub('environments.get',async()=>({id:'env_fixture',projectId:ctx.projectId,hostId:options.actualHost??'host_remote',path:'/owned/product',status:'ready',isWorktree:true}));host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>metadata.get(threadId)??{});host.harness.sdk.stub('threads.updatePluginMetadata',async({threadId,set})=>{metadata.set(threadId,{...metadata.get(threadId),...set});return{};});host.harness.sdk.stub('threads.update',async()=>({}));host.harness.sdk.stub('threads.pin',async()=>({}));host.harness.sdk.stub('threads.list',async()=>{throw new Error('Unrelated fleet must not be scanned');});
 host.harness.sdk.stub('files.remove',async data=>{assert.equal(data.hostId,'host_remote');assert.equal(data.rootPath,'/tmp');assert.match(data.path,/^\/tmp\/.fm-runtime-/);rmSync(data.path,{recursive:true,force:true});return{};});
 host.harness.sdk.stub('files.write',async data=>{assert.equal(data.hostId,'host_remote');assert.equal(data.expectedSha256,null);mkdirSync(join(data.path,'..'),{recursive:true});const bytes=Buffer.from(data.content,'base64');writeFileSync(data.path,bytes,{mode:data.mode});return{outcome:'written',sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length};});host.harness.sdk.stub('files.read',async({hostId,path})=>{assert.equal(hostId,'host_remote');const content=readFileSync(path,'utf8');return{content,contentEncoding:'utf8',sizeBytes:Buffer.byteLength(content)};});
 const env={...process.env,HOME:directory,PATH:`${directory}/bin:${process.env.PATH}`,FM_BOOTSTRAP_NETWORK:'skip'};
 host.harness.sdk.stub('terminals.create',async({scope,start})=>{
  assert.equal(scope.hostId,'host_remote');const match=/^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(start.command);assert.ok(match,start.command);const command=match[1].replace(/'\\''/g,"'");seen.push(command);
  const r=spawnSync('bash',['-c',command],{encoding:'utf8',env,timeout:60000,maxBuffer:8*1024*1024});const id=`t${++n}`;outputs.set(id,(r.stdout??'')+(r.stderr??'')+`\n__FM_HOST_RC:${r.status??2}\n`);return{id};
 });host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));host.harness.sdk.stub('terminals.output',async({terminalId})=>({nextSeq:1,chunks:[{dataBase64:Buffer.from(outputs.get(terminalId)).toString('base64')}]}));host.harness.sdk.stub('terminals.close',async()=>({}));
 const clean=async()=>{await host.harness.lifecycle.dispose();rmSync(directory,{recursive:true,force:true});};return{host,directory,seen,metadata,env,clean};
}
function install(f,release){const r=spawnSync('python3',[helper,'install','--store',join(f.directory,'.local/share/bb-firstmate'),'--archive',release.archive,'--sha256',release.sha256],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);}
for(const entry of ['cli','tool'])test(`actual registered ${entry} clean captain binding stages package on authoritative host without external source`,async()=>{
 const f=await factory();try{
 const r=entry==='cli'?await f.host.harness.behavior.runCli(['deck','--json'],ctx):await f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_deck').execute({},ctx);
 if(entry==='cli'){assert.equal(r.exitCode,0,r.stderr);const value=JSON.parse(r.stdout);assert.equal(value.ready,false);assert.equal(value.requiresAgentShell,true);assert.equal(value.hostId,'host_remote');assert.ok(value.startupCommand.includes('$FM_BINDIR/fm-session-start.sh'));}else{assert.equal(typeof r,'string',JSON.stringify(r));assert.match(r,/ready=false/);}
 const home=await f.host.bb.storage.kv.get(`native-home:${ctx.threadId}`);assert.equal(home,join(f.directory,'.local/share/bb-firstmate/homes',ctx.threadId));const selection=await f.host.bb.storage.kv.get(`native-runtime:${ctx.threadId}`);assert.equal(selection.release,distribution.release);assert.equal(f.metadata.get(ctx.threadId).nativeHome,home);assert.ok(existsSync(join(home,'data')));assert.ok(f.seen.every(c=>!c.includes('/root/firstmate')&&!c.includes('/root/github_projects/firstmate')&&!c.includes('git fetch')&&!c.includes('git pull')));assert.ok(f.host.harness.sdk.callsTo('files.write').some(c=>c[0].path.endsWith('runtime.tar.gz')));
 const contract=await f.host.harness.behavior.runCli(['contract'],ctx);assert.equal(contract.exitCode,0,contract.stderr);assert.ok(f.host.harness.sdk.callsTo('files.read').every(c=>c[0].path.startsWith(selection.root+'/')));
 const status=await f.host.harness.behavior.runCli(['runtime','status','--json'],ctx);assert.equal(status.exitCode,0,status.stderr);assert.equal(JSON.parse(status.stdout).selected.root,selection.root);
 const before=f.seen.length;const again=await f.host.harness.behavior.runCli(['deck','--json'],ctx);assert.equal(again.exitCode,0,again.stderr);assert.equal(f.seen.slice(before).some(c=>c.includes('runtime.tar.gz')),false);assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(f.host.harness.sdk.callsTo('threads.send').length,0);
 }finally{await f.clean();}
});
test('runtime commands retain exact captain/project scope and refuse mutation with live reservation',async()=>{
 const f=await factory();try{assert.equal((await f.host.harness.behavior.runCli(['deck','--json'],ctx)).exitCode,0);const home=await f.host.bb.storage.kv.get(`native-home:${ctx.threadId}`);const store=createLaunches(f.host.bb.storage.database());store.save({key:launchKey(ctx.projectId,ctx.threadId,home,'held'),taskId:'held',projectId:ctx.projectId,owner:ctx.threadId,home,generation:1,state:'uncertain',threadId:null,hostId:'host_remote',shape:'ship',deliveryRequirement:'merged-and-verified',updatedAt:1});
 const native=secondRelease(f,{'NOTICE':'\nnative fixture change\n'});install(f,native);const refusal=await f.host.harness.behavior.runCli(['runtime','select',native.release,'--check'],ctx);assert.equal(refusal.exitCode,1);assert.match(refusal.stderr,/running\/reserved\/uncertain; native difference: NOTICE/);
 const wrong=await f.host.harness.behavior.runCli(['runtime','status','--machine','host_foreign'],ctx);assert.equal(wrong.exitCode,1);assert.match(wrong.stderr,/differs/);const worker={threadId:'thr_worker',projectId:ctx.projectId};f.metadata.set(worker.threadId,{crew:'true'});const denied=await f.host.harness.registrations.agentTools.find(t=>t.name==='firstmate_runtime').execute({action:'install'},worker);assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/Worker threads/);
 }finally{await f.clean();}
});
test('adapter-only release selects while crews run; their recorded release stays installed and is reported',async()=>{
 const f=await factory();try{
 assert.equal((await f.host.harness.behavior.runCli(['deck','--json'],ctx)).exitCode,0);const home=await f.host.bb.storage.kv.get(`native-home:${ctx.threadId}`),old=await f.host.bb.storage.kv.get(`native-runtime:${ctx.threadId}`);
 const adapter=secondRelease(f,{'overlay/bin/fm-worker-checkpoint.py':'\n# adapter fixture change\n'});install(f,adapter);
 createLaunches(f.host.bb.storage.database()).save({key:launchKey(ctx.projectId,ctx.threadId,home,'c1'),taskId:'c1',projectId:ctx.projectId,owner:ctx.threadId,home,generation:1,state:'running',threadId:'thr_crew',hostId:'host_remote',shape:'ship',deliveryRequirement:'merged-and-verified',updatedAt:1});
 mkdirSync(join(home,'state/c1.git-hooks'));writeFileSync(join(home,'state/c1.meta'),'bb_thread_id=thr_crew\n');writeFileSync(join(home,'state/c1.git-hooks/commit-msg'),`#!/bin/sh\nexec ${old.root}/bin-bb/fm-commit-msg-hook.sh "$@"\n`);
 const checked=await f.host.harness.behavior.runCli(['runtime','select',adapter.release,'--check'],ctx);assert.equal(checked.exitCode,0,checked.stderr);
 const selected=await f.host.harness.behavior.runCli(['runtime','select',adapter.release],ctx);assert.equal(selected.exitCode,0,selected.stderr);assert.equal(JSON.parse(readFileSync(join(home,'config/bb-runtime-selected.json'),'utf8')).release,adapter.release);assert.ok(existsSync(old.root));
 const status=await f.host.harness.behavior.runCli(['runtime','status','--json'],ctx);assert.equal(status.exitCode,0,status.stderr);const value=JSON.parse(status.stdout);assert.equal(value.selected.release,adapter.release);assert.deepEqual(value.referencedReleases,[{release:distribution.release,tasks:['c1']}]);
 }finally{await f.clean();}
});
test('partial home KV publication recovers installed/bound bytes rather than resetting state or creating workers',async()=>{
 const f=await factory();try {
 let once=true;const set=f.host.bb.storage.kv.set.bind(f.host.bb.storage.kv);f.host.bb.storage.kv.set=async(key,value)=>{if(key===`native-home:${ctx.threadId}`&&once){once=false;throw new Error('KV crash after native home publication');}return set(key,value);};
 const fail=await f.host.harness.behavior.runCli(['deck','--json'],ctx);assert.equal(fail.exitCode,1);const home=join(f.directory,'.local/share/bb-firstmate/homes',ctx.threadId);assert.ok(existsSync(join(home,'config/bb-runtime-selected.json')));writeFileSync(join(home,'state/held.status'),'pending retained report\n');const retry=await f.host.harness.behavior.runCli(['deck','--json'],ctx);assert.equal(retry.exitCode,0,retry.stderr);assert.equal(readFileSync(join(home,'state/held.status'),'utf8'),'pending retained report\n');assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await f.clean();}
});
test('seeded bundled captain recovers exact child binding before first deck without a shared/global home or model turn',async()=>{
 const f=await factory();try {
 const first=await f.host.harness.behavior.runCli(['deck','--json'],ctx);assert.equal(first.exitCode,0,first.stderr);const parentHome=await f.host.bb.storage.kv.get(`native-home:${ctx.threadId}`),selection=await f.host.bb.storage.kv.get(`native-runtime:${ctx.threadId}`),child=join(f.directory,'seeded-home');
 let result=spawnSync('bash',[join(selection.root,'bin-bb/fm-home-seed.sh'),'domain',child,'--no-projects'],{encoding:'utf8',env:{...f.env,FM_HOME:parentHome,FM_ROOT_OVERRIDE:selection.root,FM_BACKEND:'bb',FM_SECONDMATE_CHARTER:'Read-only fixture audit',FM_SECONDMATE_SCOPE:'Fixture',FM_SKIP_SECONDMATE_SYNC:'1'}});assert.equal(result.status,0,result.stdout+result.stderr);
 result=spawnSync('python3',[join(selection.root,'../overlay/install-bb-backend.py'),'--home',child,'--overlay',join(selection.root,'../overlay')],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);const charter=readFileSync(join(child,'data/charter.md'),'utf8');
 const childContext={threadId:'thr_child',projectId:ctx.projectId};f.metadata.set('thr_child',{captain:'true',nativeHome:child,nativeParentHome:parentHome,nativeTaskId:'domain',nativeRuntimeRelease:selection.release});
 f.host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:ctx.projectId,parentThreadId:threadId==='thr_child'?ctx.threadId:null,environmentId:threadId==='thr_child'?'env_child':'env_fixture',status:'idle'}));f.host.harness.sdk.stub('environments.get',async({environmentId})=>({id:environmentId,hostId:'host_remote',path:environmentId==='env_child'?child:'/owned/product',status:'ready',isWorktree:false}));
 const recovered=await f.host.harness.behavior.runCli(['deck','--json'],childContext);assert.equal(recovered.exitCode,0,recovered.stderr);assert.equal(JSON.parse(recovered.stdout).nativeHome,child);assert.equal((await f.host.bb.storage.kv.get('native-runtime:thr_child')).root,selection.root);assert.equal(readFileSync(join(child,'data/charter.md'),'utf8'),charter);assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(f.host.harness.sdk.callsTo('threads.send').length,0);
 }finally{await f.clean();}
});
test('runtime factory registration is load-safe before SDK bind',async()=>{
 const host=createFakePluginHost({pluginId:'firstmate'});const descriptor=Object.getOwnPropertyDescriptor(host.bb,'sdk');Object.defineProperty(host.bb,'sdk',{configurable:true,get(){throw new Error('SDK is not bound');}});
 try {await plugin(host.bb);assert.ok(host.harness.registrations.agentTools.find(t=>t.name==='firstmate_runtime'));}finally{Object.defineProperty(host.bb,'sdk',descriptor);await host.harness.lifecycle.dispose();}
});
test('published selection plus failed BB cache write recovers across factory reload without another selection or worker',async()=>{
 let f=await factory();try {
 assert.equal((await f.host.harness.behavior.runCli(['deck','--json'],ctx)).exitCode,0);const home=await f.host.bb.storage.kv.get(`native-home:${ctx.threadId}`),next=secondRelease(f);const r=spawnSync('python3',[helper,'install','--store',join(f.directory,'.local/share/bb-firstmate'),'--archive',join(f.directory,'next.tar.gz'),'--sha256',next.sha256],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);writeFileSync(join(home,'state/held.status'),'retained report and PR reference\n');
 let once=true;const set=f.host.bb.storage.kv.set.bind(f.host.bb.storage.kv);f.host.bb.storage.kv.set=async(key,value)=>{if(key===`native-runtime:${ctx.threadId}`&&value?.release===next.release&&once){once=false;throw new Error('cache write fault after on-host selection');}return set(key,value);};
 const failed=await f.host.harness.behavior.runCli(['runtime','select',next.release],ctx);assert.equal(failed.exitCode,1);assert.match(failed.stderr,/cache write fault/);assert.equal(JSON.parse(readFileSync(join(home,'config/bb-runtime-selected.json'),'utf8')).release,next.release);assert.ok(await f.host.bb.storage.kv.get(`runtime-selection-pending:${ctx.threadId}`));
 const blocked=await f.host.harness.behavior.runCli(['runtime','select',distribution.release],ctx);assert.equal(blocked.exitCode,1);assert.match(blocked.stderr,/earlier runtime selection/);
 const directory=f.directory,host=await f.host.harness.lifecycle.reload(plugin);f=await factory({host,directory,registered:true});const status=await f.host.harness.behavior.runCli(['runtime','status','--json'],ctx);assert.equal(status.exitCode,0,status.stderr);assert.equal(JSON.parse(status.stdout).selected.release,next.release);assert.equal(await f.host.bb.storage.kv.get(`runtime-selection-pending:${ctx.threadId}`),undefined);assert.equal((await f.host.bb.storage.kv.get(`native-runtime:${ctx.threadId}`)).release,next.release);assert.equal(readFileSync(join(home,'state/held.status'),'utf8'),'retained report and PR reference\n');assert.equal(f.host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await f.clean();}
});
