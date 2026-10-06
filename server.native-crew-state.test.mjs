// Native read-only reconciliation through registered CLI/tool, with owned Git
// copies and an SDK-produced activity snapshot. No model or forge invocation.
import assert from 'node:assert/strict';import test from 'node:test';
import {mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
import {createFakePluginHost,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';import {fixture,pins,run,ok,overlay} from './scripts/prompt-fixture.mjs';
const ctx={threadId:'thr_fixturecap',projectId:'proj_fixture'},worker='thr_fixtureworker';
function unwrap(command){const m=/^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(command);assert.ok(m,command);return m[1].replace(/'\\''/g,"'");}

for(const pin of pins)test(`native BB crew-state reads settled ship/scout and preserves native gates on ${pin.slice(0,8)}`,async()=>{
 const home=fixture(pin),state=join(home,'state'),fake=join(home,'fakebin'),project=join(home,'project'),wt=join(home,'worktree');
 let host;
 try{
  ok(run('python3',[join(overlay,'install-bb-backend.py'),'--home',home]));mkdirSync(fake);mkdirSync(project);
  ok(run('git',['init','--quiet',project]));ok(run('git',['-C',project,'config','user.name','Fixture']));ok(run('git',['-C',project,'config','user.email','fixture@example.invalid']));
  writeFileSync(join(project,'proof.txt'),'owned baseline\n');ok(run('git',['-C',project,'add','proof.txt']));ok(run('git',['-C',project,'commit','--quiet','-m','owned baseline']));
  const head=ok(run('git',['-C',project,'rev-parse','HEAD'])).trim();ok(run('git',['-C',project,'update-ref','refs/remotes/origin/proof',head]));
  ok(run('git',['-C',project,'worktree','add','--quiet','-b','fm/owned',wt]));
  writeFileSync(join(fake,'bb'),`#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\na=sys.argv[1:]\nwith open(${JSON.stringify(join(home,'cli-calls.jsonl'))},'a') as f:f.write(json.dumps(a)+'\\n')\nif a[:2]==['firstmate','activity']:print(Path(${JSON.stringify(join(home,'activity.json'))}).read_text())\nelif a[:2]==['thread','show']:print(json.dumps({'thread':{'id':${JSON.stringify(worker)},'status':'idle'}}))\nelse:sys.exit(2)\n`,{mode:0o755});
  for(const name of ['no-mistakes','gh','gh-axi','gerrit-axi'])writeFileSync(join(fake,name),'#!/bin/sh\nexit 2\n',{mode:0o755});
  const env={...process.env,HOME:home,PATH:`${fake}:${process.env.PATH}`};for(const key of Object.keys(env))if(key.startsWith('BB_'))delete env[key];
  host=createFakePluginHost({pluginId:'firstmate',settings:{fmHome:home,fmHostId:'host_fixture'}});await plugin(host.bb);
  await host.bb.storage.kv.set(`native-home:${ctx.threadId}`,home);await host.bb.storage.kv.set(`native-home-host:${ctx.threadId}`,'host_fixture');
  let status='idle',runtimeStatus='idle';
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:ctx.projectId,environmentId:'env_fixture',status:threadId===worker?status:'idle',runtime:{displayStatus:threadId===worker?runtimeStatus:'idle',hostReconnectGraceExpiresAt:null}}));
  host.harness.sdk.stub('environments.get',async()=>({id:'env_fixture',hostId:'host_fixture',path:wt,status:'ready',isWorktree:true}));
  host.harness.sdk.stub('threads.getPluginMetadata',async()=>({captain:'true',nativeHome:home}));
  host.harness.sdk.stub('threads.output',async()=>({output:'DONE: exact native artifact retained'}));host.harness.sdk.stub('threads.events.list',async()=>[]);host.harness.sdk.stub('threads.interactions.list',async()=>[]);
  const outputs=new Map(),commands=[];let n=0;
  host.harness.sdk.stub('terminals.create',async({start})=>{const command=unwrap(start.command);commands.push(command);const r=spawnSync('bash',['-c',command],{encoding:'utf8',env,timeout:30000,maxBuffer:8*1024*1024});const id=`term_${++n}`;outputs.set(id,(r.stdout??'')+(r.stderr??'')+`\n__FM_HOST_RC:${r.status??2}\n`);return{id};});
  host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));host.harness.sdk.stub('terminals.output',async({terminalId})=>({nextSeq:1,chunks:[{dataBase64:Buffer.from(outputs.get(terminalId)).toString('base64')}]}));host.harness.sdk.stub('terminals.close',async()=>({}));
  const snapshot=async()=>{const r=await host.harness.behavior.runCli(['activity',worker,'--json'],ctx);assert.equal(r.exitCode,0,r.stderr);writeFileSync(join(home,'activity.json'),r.stdout);};
  const meta=(kind,mode)=>writeFileSync(join(state,'owned.meta'),`window=bb:${worker}\nendpoint_task_id=owned\nworktree=${wt}\nproject=${project}\nharness=bb\nkind=${kind}\nbackend=bb\nbb_thread_id=${worker}\nbranch=fm/owned\nmode=${mode}\n`);
  const statusFile=join(state,'owned.status'),report=join(home,'data/owned/report.md');mkdirSync(join(home,'data/owned'),{recursive:true});writeFileSync(report,'Exact owned scout artifact\n');
  const cli=async()=>{const before=[readFileSync(join(state,'owned.meta')),readFileSync(statusFile)],branch=ok(run('git',['-C',wt,'branch','--show-current'])),head=ok(run('git',['-C',wt,'rev-parse','HEAD']));const r=await host.harness.behavior.runCli(['fm','crew-state','--','owned'],ctx);assert.equal(r.exitCode,0,r.stderr);assert.deepEqual([readFileSync(join(state,'owned.meta')),readFileSync(statusFile)],before);assert.equal(ok(run('git',['-C',wt,'branch','--show-current'])),branch);assert.equal(ok(run('git',['-C',wt,'rev-parse','HEAD'])),head);return r.stdout;};
  await snapshot();
  for(const mode of ['direct-PR','no-mistakes','local-only']){
   meta('ship',mode);writeFileSync(statusFile,'done: checks green, named head ready\n');assert.match(await cli(),/^state: done · source: status-log/m,mode+' must reach native DoD, not unknown missing');
  }
  meta('scout','');writeFileSync(statusFile,'done: report data/owned/report.md\n');assert.match(await cli(),/^state: done · source: status-log/m,'settled scout permits native report status');
  writeFileSync(join(state,'owned.busy-state'),'malformed record\n');assert.match(await cli(),/^state: unknown · source: pane.*malformed/m,'a malformed native record cannot fall through to BB idle');rmSync(join(state,'owned.busy-state'));
  const tool=host.harness.registrations.agentTools.find(t=>t.name==='firstmate_fm');const toolResult=await tool.execute({script:'crew-state',args:['owned']},ctx);assert.equal(typeof toolResult,'string',JSON.stringify(toolResult));assert.match(toolResult,/state: done · source: status-log/);
  status='active';runtimeStatus='active';await snapshot();assert.match(await cli(),/^state: working · source: pane/m,'active turn supersedes stale done');
  status='idle';runtimeStatus='host-reconnecting';await snapshot();assert.match(await cli(),/^state: unknown · source: pane/m,'unavailable host cannot license done');
  runtimeStatus='idle';await snapshot();meta('ship','direct-PR');writeFileSync(statusFile,'done: named head ready\n');
  writeFileSync(join(wt,'proof.txt'),'owned unpublished work\n');ok(run('git',['-C',wt,'add','proof.txt']));ok(run('git',['-C',wt,'commit','--quiet','-m','unpublished owned change']));
  const unpublished=ok(run('git',['-C',wt,'rev-parse','HEAD'])).trim();assert.match(await cli(),/^state: blocked · source: status-log.*unreachable outside/m,'BB idle must retain native pushed-head safeguard');
  meta('scout','');writeFileSync(statusFile,'blocked: [key=owned] waiting for decision\n');assert.match(await cli(),/^state: blocked · source: status-log/m,'idle is not artificial done');
  assert.equal(ok(run('git',['-C',wt,'rev-parse','HEAD'])).trim(),unpublished);assert.equal(ok(run('git',['-C',wt,'branch','--show-current'])).trim(),'fm/owned');assert.equal(readFileSync(report,'utf8'),'Exact owned scout artifact\n');
  assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(host.harness.sdk.callsTo('threads.send').length,0);
  const calls=readFileSync(join(home,'cli-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.ok(calls.every(a=>a[0]==='firstmate'&&a[1]==='activity'&&a[2]===worker));
  assert.ok(commands.some(c=>c.includes('/fm-crew-state.sh')&&c.endsWith("'owned'")),'registered CLI forwards exact id and native script');
  assert.equal(host.harness.sdk.callsTo('terminals.close').length,n,'all owned host reads close their terminal');
 }finally{if(host)await host.harness.lifecycle.dispose();rmSync(home,{recursive:true,force:true});}
});
