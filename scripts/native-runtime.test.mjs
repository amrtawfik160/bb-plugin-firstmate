import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,cpSync,existsSync,symlinkSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {runtimeFixture,assets,helper,distribution,secondRelease} from './native-runtime-fixture.mjs';
import {fixture,pins,run,ok,overlay} from './prompt-fixture.mjs';
import {captainStartupCommand} from '../server.ts';
import {runtimeRootAssign} from '../lib/native-runtime.ts';
test('audit regression: generated runtime scripts and redirected sibling links refuse before execution',()=>{
 const f=runtimeFixture();try {
  const root=f.ready(),marker='UNVERIFIED_GENERATED_SCRIPT_EXECUTED';
  for(const name of ['fm-spawn.sh','fm-teardown.sh','fm-backend.sh','fm-merge-local.sh']){
   const path=join(root,'bin-bb',name),original=readFileSync(path);
   writeFileSync(path,`#!/bin/bash\nprintf '${marker}\\n'\nexit 99\n`);
   const refused=f.call('inspect',f.owned);assert.equal(refused.status,2,`${name}: ${refused.stdout}`);
   assert.match(refused.stdout,/generated|corrupt|stale|mismatch/);
   const execution=run('bash',['-c',`${runtimeRootAssign(f.home)}; bash "$FM_RUNTIME_ROOT/bin-bb/${name}"`],f.env);
   assert.notEqual(execution.status,0);assert.ok(!(execution.stdout+execution.stderr).includes(marker));
   assert.equal(f.install().status,2,'identical install cannot reuse a corrupted executable');
   writeFileSync(path,original);f.json(f.call('inspect',f.owned));
  }
  const sibling=join(root,'bin-bb/fm-brief.sh'),originalLink=readlinkSync(sibling),foreign=join(f.directory,'foreign-script.sh');
  writeFileSync(foreign,'#!/bin/bash\nexit 0\n');rmSync(sibling);symlinkSync(foreign,sibling);
  assert.equal(f.call('resolve',f.owned).status,2,'live but redirected sibling is not a valid runtime');
  rmSync(sibling);symlinkSync(originalLink,sibling);f.json(f.call('inspect',f.owned));
 }finally{f.clean();}
});
function state(home){return Object.fromEntries(['state/.wake-queue','state/legacy.status','data/legacy/brief.md','config/delivery-mode'].map(p=>[p,readFileSync(join(home,p),'utf8')]));}
function sentinels(home){mkdirSync(join(home,'data/legacy'),{recursive:true});writeFileSync(join(home,'state/.wake-queue'),'unhandled report PR https://github.com/fixture/repo/pull/1\n');writeFileSync(join(home,'state/legacy.status'),'waiting-checks\n');writeFileSync(join(home,'data/legacy/brief.md'),'Exact task; provider acp-grok; model grok-4.6; xhigh; merged-and-verified\n');writeFileSync(join(home,'config/delivery-mode'),'direct-PR\n');}

test('shipped native assets are reproducible, complete and current against exact adapter inputs',()=>{ok(run('python3',['scripts/package-native-runtime.py','--check']));assert.equal(distribution.upstreamCommit,pins[1]);assert.match(readFileSync(join(assets,'LICENSE.firstmate'),'utf8'),/Copyright \(c\) 2026 Kun Chen/);});
test('offline clean installation and bound state use only shipped Git snapshot; reload verifies and reuses exact bytes',()=>{
 const f=runtimeFixture();try{const installed=f.json(f.install());assert.equal(installed.signature,'FM_BUNDLED_RUNTIME_INSTALLED');const bound=f.json(f.bind());assert.equal(bound.signature,'FM_BUNDLED_HOME_BOUND');const root=bound.selection.root;
 assert.equal(ok(run('git',['-C',root,'remote','-v'])), '');assert.equal(ok(run('git',['-C',f.home,'remote','-v'])), '');assert.equal(ok(run('git',['-C',root,'rev-list','--count','HEAD'])).trim(),'1');assert.equal(ok(run('git',['-C',root,'rev-parse','HEAD'])).trim(),distribution.snapshotCommit);
 assert.equal(existsSync(join(root,'tests')),false);assert.equal(existsSync(join(root,'.env')),false);assert.ok(existsSync(join(root,'.tasks.toml')));assert.ok(existsSync(join(root,'bin/fm-captain-hold.sh')));
 sentinels(f.home);const before=state(f.home);const again=f.json(f.install());assert.equal(again.signature,'FM_BUNDLED_RUNTIME_REUSED');assert.equal(f.json(f.bind()).changed,false);assert.deepEqual(state(f.home),before);
 const status=f.json(f.call('status',[...f.owned,'--audited-sources',JSON.stringify(distribution.auditedSources)]));assert.equal(status.mode,'bundled');assert.equal(status.migrationRequiredForBundledMode,false);assert.equal(status.installed[0].compatible,true);assert.equal(status.selected.release,distribution.release);
 const loaded=ok(run('bash',['-c','set -eu; . "$1"; fm_backend_source bb; fm_backend_validate_spawn bb; declare -F fm_transition_record fm_backend_bb_create_task','fixture',join(root,'bin-bb/fm-backend.sh')],{FM_HOME:f.home,FM_ROOT_OVERRIDE:root,FM_BACKEND:'bb'}));assert.match(loaded,/fm_backend_bb_create_task/);
 const bin=ok(run('bash',['-c','. "$1"; fm_backend_bb_crew_bindir','fixture',join(root,'bin-bb/backends/bb.sh')],{FM_HOME:f.home,FM_ROOT_OVERRIDE:root}));assert.equal(bin,join(root,'bin-bb'));
 }finally{f.clean();}
});
test('staging/home-publication faults preserve unresolved reports and retry safely in another process',()=>{
 const f=runtimeFixture();try {
 const failed=f.call('install',['--archive',join(assets,'runtime.tar.gz'),'--sha256',distribution.archiveSha256],{FM_RUNTIME_TEST_FAIL:'before-publication'});assert.equal(failed.status,2);assert.match(failed.stdout,/before runtime publication/);assert.equal(existsSync(join(f.store,'versions',distribution.release)),false);f.json(f.install());
 const failBind=f.call('bind',[...f.owned,'--release',distribution.release],{FM_RUNTIME_TEST_FAIL:'before-home-publication'});assert.equal(failBind.status,2);assert.equal(existsSync(f.home),false);f.json(f.bind());sentinels(f.home);const before=state(f.home);f.json(f.bind());assert.deepEqual(state(f.home),before);assert.equal(readdirSync(join(f.store,'versions')).filter(s=>s.startsWith('.staging')).length,0);
 }finally{f.clean();}
});
test('overlapping installs serialize one publication and reuse its fully verified release',async()=>{
 const f=runtimeFixture();try{
 const call=()=>new Promise((resolve,reject)=>{const child=spawn('python3',[helper,'install','--store',f.store,'--archive',join(assets,'runtime.tar.gz'),'--sha256',distribution.archiveSha256],{env:f.env});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(out+err)));});
 const rows=await Promise.all([call(),call()]);assert.deepEqual(rows.map(x=>x.signature).sort(),['FM_BUNDLED_RUNTIME_INSTALLED','FM_BUNDLED_RUNTIME_REUSED']);assert.equal(readdirSync(join(f.store,'versions')).filter(x=>/^[0-9a-f]{64}$/.test(x)).length,1);
 }finally{f.clean();}
});
test('corrupted release/native source/mirror and unknown synthetic Git identity are refused without state mutation',()=>{
 const f=runtimeFixture();try {
 const archive=join(f.directory,'corrupt.tar.gz');writeFileSync(archive,Buffer.concat([readFileSync(join(assets,'runtime.tar.gz')),Buffer.from('broken')]));const bad=f.call('install',['--archive',archive,'--sha256',distribution.archiveSha256]);assert.equal(bad.status,2);assert.match(bad.stdout,/checksum mismatch/);
 const root=f.ready();sentinels(f.home);const before=state(f.home);
 for(const path of ['bin/fm-spawn.sh','bin-bb/backends/bb.sh']){const target=join(root,path),original=readFileSync(target);writeFileSync(target,Buffer.concat([original,Buffer.from('\n# unexpected modification\n')]));const r=f.call('inspect',f.owned);assert.equal(r.status,2);assert.match(r.stdout,/mismatch|modified|changed|stale/);assert.deepEqual(state(f.home),before);writeFileSync(target,original);}
 ok(run('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','unsupported packaged source']));assert.equal(f.call('inspect',f.owned).status,2);assert.deepEqual(state(f.home),before);
 }finally{f.clean();}
});
for(const pin of pins)test(`explicit external ${pin.slice(0,8)} migration/read-back/rollback preserve state and original Git identity`,()=>{
 const f=runtimeFixture(),home=fixture(pin);try {
 ok(run('python3',[join(overlay,'install-bb-backend.py'),'--home',home]));writeFileSync(join(home,'config/bb-captain'),'thr_fixture\n');sentinels(home);const before=state(home);f.json(f.install());const owned=['--home',home,'--captain','thr_fixture','--host','host_fixture'];
 const status=f.json(f.call('status',[...owned,'--audited-sources',JSON.stringify(distribution.auditedSources)]));assert.equal(status.external.compatible,true);assert.equal(status.migrationRequiredForBundledMode,true);
 const check=f.json(f.call('migrate',[...owned,'--release',distribution.release,'--check']));assert.equal(check.changed,false);assert.equal(existsSync(join(home,'config/bb-runtime-selected.json')),false);
 const change=f.json(f.call('migrate',[...owned,'--release',distribution.release]));assert.equal(change.selection.previous,'external');assert.equal(ok(run('git',['-C',home,'rev-parse','HEAD'])).trim(),pin);assert.deepEqual(state(home),before);
 const rollback=f.json(f.call('rollback',[...owned,'--release','external']));assert.equal(rollback.signature,'FM_EXTERNAL_ROLLBACK_PUBLISHED');assert.equal(existsSync(join(home,'config/bb-runtime-selected.json')),false);assert.deepEqual(state(home),before);assert.equal(f.json(f.call('rollback',[...owned,'--release','external'])).changed,false);assert.ok(existsSync(change.selection.root));
 }finally{f.clean();rmSync(home,{recursive:true,force:true});}
});
test('selection refuses foreign captain/host, retained tasks/native lock, unknown release and unaudited external version',()=>{
 const f=runtimeFixture(),home=fixture();try {
 const root=f.ready();sentinels(f.home);const before=state(f.home);for(const args of [[...f.owned.map(x=>x==='thr_fixture'?'thr_foreign':x)], [...f.owned.map(x=>x==='host_fixture'?'host_foreign':x)]]){assert.equal(f.call('inspect',args).status,2);assert.deepEqual(state(f.home),before);}
 assert.equal(f.call('select',[...f.owned,'--release','a'.repeat(64)]).status,2);
 ok(run('python3',[join(overlay,'install-bb-backend.py'),'--home',home]));writeFileSync(join(home,'config/bb-captain'),'thr_fixture\n');const own=['--home',home,'--captain','thr_fixture','--host','host_fixture'];
 for(const name of ['task.meta','.lock','.watch.lock','.bb-watch-keeper.pid']){writeFileSync(join(home,'state',name),'retained authoritative identity\n');const refused=f.call('migrate',[...own,'--release',distribution.release]);assert.equal(refused.status,2);assert.match(refused.stdout,/selection refused/);assert.equal(existsSync(join(home,'config/bb-runtime-selected.json')),false);rmSync(join(home,'state',name));}
 ok(run('git',['-C',home,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','unaudited version']));assert.equal(f.call('migrate',[...own,'--release',distribution.release]).status,2);
 assert.ok(existsSync(root));assert.deepEqual(state(f.home),before);
 }finally{f.clean();rmSync(home,{recursive:true,force:true});}
});

test('native-seeded secondmate seals parent runtime without changing charter, source or allocating a worker',()=>{
 const f=runtimeFixture();try{
 const root=f.ready(),child=join(f.directory,'secondmate');const env={FM_HOME:f.home,FM_ROOT_OVERRIDE:root,FM_BACKEND:'bb',FM_SECONDMATE_CHARTER:'Read-only fixture audit',FM_SECONDMATE_SCOPE:'Fixture',FM_SKIP_SECONDMATE_SYNC:'1'};
 ok(run('bash',[join(root,'bin-bb/fm-home-seed.sh'),'domain',child,'--no-projects'],env));ok(run('python3',[join(root,'../overlay/install-bb-backend.py'),'--home',child,'--overlay',join(root,'../overlay')]));
 const charter=readFileSync(join(child,'data/charter.md'),'utf8'),commit=ok(run('git',['-C',child,'rev-parse','HEAD']));
 const args=['--home',child,'--captain','thr_child','--host','host_fixture','--parent-home',f.home,'--parent-captain','thr_fixture','--task-id','domain','--release',distribution.release];
 const bound=f.json(f.call('bind-seeded',args));assert.equal(bound.selection.root,root);assert.equal(f.json(f.call('bind-seeded',args)).changed,false);assert.equal(readFileSync(join(child,'data/charter.md'),'utf8'),charter);assert.equal(ok(run('git',['-C',child,'rev-parse','HEAD'])),commit);assert.equal(f.call('bind-seeded',args.map(x=>x==='domain'?'wrong':x)).status,2);
 }finally{f.clean();}
});
for(const [shape,mode] of [['ship','direct-PR'],['ship','no-mistakes'],['ship','local-only'],['scout','direct-PR']])test(`bundled ${shape}/${mode}: real native launch/render/completion resolves immutable code and durable task paths`,()=>{
 const f=runtimeFixture(),task=`bundle-${f.directory.split("-").at(-1)}`;try{
 const root=f.ready(),project=join(f.directory,'product'),wt=join(f.directory,'worker'),fake=join(f.directory,'fake-bin'),log=join(f.directory,'bb-events');mkdirSync(project);mkdirSync(fake);
 ok(run('git',['-C',project,'init','--quiet','--initial-branch=main']));ok(run('git',['-C',project,'config','user.name','Fixture']));ok(run('git',['-C',project,'config','user.email','fixture@example.invalid']));writeFileSync(join(project,'file'),'original\n');ok(run('git',['-C',project,'add','.']));ok(run('git',['-C',project,'commit','--quiet','-m','fixture']));ok(run('git',['-C',project,'remote','add','origin','https://github.com/fixture/product.git']));ok(run('git',['-C',project,'worktree','add','--quiet','--detach',wt]));
 writeFileSync(join(fake,'bb'),`#!/usr/bin/env python3\nimport json,sys\na=sys.argv[1:]\nwith open(${JSON.stringify(log)},'a') as f:f.write(json.dumps(a)+'\\n')\nif a[:2] in [['firstmate','create-worker'],['thread','show']]:print(json.dumps({'id':'thr_bundledworker','status':'idle','path':${JSON.stringify(wt)}}))\n`,{mode:0o755});writeFileSync(join(f.home,'config/backlog-backend'),'manual\n');
 const env={...f.env,FM_HOME:f.home,FM_ROOT_OVERRIDE:root,FM_BACKEND:'bb',FM_BB_MACHINE:'host_fixture',FM_BB_PROJECT_ID:'proj_fixture',FM_BB_PROVIDER:'codex',FM_BB_MODEL:'gpt-6.1-sol',FM_BB_REASONING:'low',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`url.${project}.insteadOf`,GIT_CONFIG_VALUE_0:'https://github.com/fixture/product.git',PATH:`${fake}:${process.env.PATH}`};
 ok(run('bash',[join(root,'bin-bb/fm-brief.sh'),task,project,...(shape==='scout'?['--scout']:['--mode',mode])],env));const brief=join(f.home,`data/${task}/brief.md`);writeFileSync(brief,readFileSync(brief,'utf8').replace('{TASK}','Inspect and fix the owned fixture. Preserve user words: Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.').replace('{FIRSTMATE_SPEC}','Reproduce, verify, and preserve the native delivery contract.'));
 const source=readFileSync(brief,'utf8');const rendered=ok(run('bash',['-c','. "$1"; fm_backend_bb_worker_prompt "$2" "$3" "$4" "$5"','fixture',join(root,'bin-bb/backends/bb.sh'),brief,shape,task,shape==='ship'?mode:''],env));assert.ok(rendered.includes(`${root}/bin-bb/fm-inbox-take.sh`));assert.ok(rendered.includes(`${f.home}/data/${task}/`));assert.ok(rendered.includes('Preserve user words: Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.'));assert.equal(readFileSync(brief,'utf8'),source);
 // A real worker shell has none of the launcher's exports. The rendered
 // invocation must address this home's backlog, never the immutable code tree.
 const prefix=rendered.match(/Native command environment: `([^`]+)`/);assert.ok(prefix,'worker has an explicit native home/code environment');
 writeFileSync(join(fake,'tasks-axi'),'#!/bin/sh\nprintf "%s\\n" "$PWD"\n',{mode:0o755});
 const workerEnv={...f.env,PATH:`${fake}:${process.env.PATH}`};delete workerEnv.FM_HOME;delete workerEnv.FM_ROOT_OVERRIDE;delete workerEnv.FM_BACKEND;
 const addressed=ok(run('bash',['-c',`${prefix[1]} bash "$1" list`,'fixture',join(root,'bin-bb/fm-tasks-axi.sh')],workerEnv));assert.equal(addressed,f.home+'\n');
 const spawned=run('bash',[join(root,'bin-bb/fm-spawn.sh'),task,project,...(shape==='scout'?['--scout']:['--mode',mode,'--yolo','off']),'--backend','bb','--harness','bb','--model','gpt-6.1-sol','--effort','low'],env);ok(spawned);assert.match(spawned.stdout,/spawned|launched|bb:/i);const meta=readFileSync(join(f.home,`state/${task}.meta`),'utf8');assert.match(meta,/^bb_thread_id=thr_bundledworker$/m);assert.match(meta,/^model=gpt-6.1-sol$/m);assert.match(meta,new RegExp(`^kind=${shape}$`,'m'));
 const calls=readFileSync(log,'utf8').split('\n').filter(Boolean).map(JSON.parse);assert.equal(calls.filter(a=>a[0]==='firstmate'&&a[1]==='create-worker').length,1);assert.equal(calls.some(a=>a[0]==='thread'&&a[1]==='spawn'),false);assert.equal(readFileSync(brief,'utf8').startsWith(source),true);
 if(shape==='ship')ok(run('git',['-C',wt,'checkout','--quiet','-b',`fm/${task}`]));
 // Completion/PR references stay in the durable home across another runtime
 // process/reload. BB forge observation remains covered by factory tests.
 writeFileSync(join(f.home,`state/${task}.status`),'2026-10-05T00:00:00Z done: https://github.com/fixture/product/pull/1\n');const before=readFileSync(join(f.home,`state/${task}.status`),'utf8');f.json(f.call('inspect',f.owned));assert.equal(readFileSync(join(f.home,`state/${task}.status`),'utf8'),before);
 if(shape==='ship') {
  writeFileSync(join(wt,'saved-skill'),'uncommitted original work\n');const current=ok(run('git',['-C',wt,'rev-parse','HEAD']));const plan={home:f.home,taskId:task,owner:'thr_fixture',sourceThreadId:'thr_bundledworker',threadId:'thr_replacement',generation:2,worktree:wt,shape,project,mode,providerId:'codex',model:'gpt-6.1-sol',reasoningLevel:'low'};
  const rebound=run('bash',['-c','export FM_BINDIR="$1"; printf "%s" "$2" | bash "$1/fm-worker-rebind.sh" --publish','fixture',join(root,'bin-bb'),JSON.stringify(plan)],env);ok(rebound);assert.match(readFileSync(join(f.home,`state/${task}.meta`),'utf8'),/^bb_thread_id=thr_replacement$/m);assert.equal(readFileSync(join(wt,'saved-skill'),'utf8'),'uncommitted original work\n');assert.equal(ok(run('git',['-C',wt,'rev-parse','HEAD'])),current);assert.equal(readFileSync(join(f.home,`state/${task}.status`),'utf8'),before);
 }
 }finally{rmSync(`/tmp/fm-${task}`,{recursive:true,force:true});f.clean();}
});
test('tested bundled selection/rollback keep both versions, task state and policy; lost response recovers exact publication',()=>{
 const f=runtimeFixture();try {
 const original=f.ready();sentinels(f.home);const before=state(f.home);const next=secondRelease(f);f.json(f.call('install',['--archive',join(f.directory,'next.tar.gz'),'--sha256',next.sha256]));
 // Rebinding after a plugin reload must retain the installed older selection.
 assert.equal(f.json(f.call('bind',[...f.owned,'--release',next.release])).selection.release,distribution.release);
 const failed=f.call('select',[...f.owned,'--release',next.release],{FM_RUNTIME_TEST_FAIL:'before-selection'});assert.equal(failed.status,2);assert.equal(f.json(f.call('inspect',f.owned)).selected.release,distribution.release);
 const unknown=f.call('select',[...f.owned,'--release',next.release],{FM_RUNTIME_TEST_FAIL:'after-selection'});assert.equal(unknown.status,2);assert.match(unknown.stdout,/lost selection response/);assert.equal(f.json(f.call('inspect',f.owned)).selected.release,next.release);assert.equal(f.json(f.call('select',[...f.owned,'--release',next.release])).changed,false);assert.deepEqual(state(f.home),before);
 assert.equal(f.json(f.call('rollback',[...f.owned,'--release',distribution.release,'--check'])).changed,false);assert.equal(f.json(f.call('rollback',[...f.owned,'--release',distribution.release])).selection.release,distribution.release);assert.ok(existsSync(original));assert.ok(existsSync(join(f.store,'versions',next.release)));assert.deepEqual(state(f.home),before);
 const invalid=f.call('rollback',[...f.owned,'--release','b'.repeat(64)]);assert.equal(invalid.status,2);assert.deepEqual(state(f.home),before);
 }finally{f.clean();}
});
test('native task-set lock prevents selection during admission; read-only check does not steal native locks',()=>{
 const f=runtimeFixture();try{
 f.ready();const next=secondRelease(f);f.json(f.call('install',['--archive',join(f.directory,'next.tar.gz'),'--sha256',next.sha256]));const path=join(f.home,'state/.task-set.lock');mkdirSync(path);writeFileSync(join(path,'pid'),`${process.pid}\n`);writeFileSync(join(path,'host'),ok(run('hostname',[])).trim()+'\n');const before=readFileSync(join(path,'pid'),'utf8');
 const refused=f.call('select',[...f.owned,'--release',next.release]);assert.equal(refused.status,2);assert.match(refused.stdout,/native task set is busy/);assert.equal(f.json(f.call('inspect',f.owned)).selected.release,distribution.release);assert.equal(readFileSync(join(path,'pid'),'utf8'),before);f.json(f.call('select',[...f.owned,'--release',next.release,'--check']));assert.equal(readFileSync(join(path,'pid'),'utf8'),before);
 }finally{f.clean();}
});
test('synthetic source cannot self-declare an audited upstream pin without the exact published attestation',()=>{
 const f=runtimeFixture();try {
 const root=f.ready();ok(run('git',['-C',f.home,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','unattested runtime source']));const before=readFileSync(join(f.home,'bin-bb/.mirror-manifest'),'utf8');const refusal=run('python3',[join(root,'../overlay/install-bb-backend.py'),'--home',f.home,'--overlay',join(root,'../overlay')]);assert.notEqual(refusal.status,0);assert.match(refusal.stderr,/no audited snapshot attestation/);assert.equal(readFileSync(join(f.home,'bin-bb/.mirror-manifest'),'utf8'),before);
 }finally{f.clean();}
});
test('process crash before atomic publication keeps prior captain state and retry publishes one complete version',async()=>{
 const f=runtimeFixture();try {
 const signal=join(f.directory,'crash-boundary');const code=`import os,runpy,sys,time\nfrom pathlib import Path\noriginal=os.rename\ndef pause(source,target):\n if Path(source).name.startswith('.staging-'):\n  Path(${JSON.stringify(signal)}).write_text('verified staging before publication')\n  while True:time.sleep(.1)\n return original(source,target)\nos.rename=pause\nsys.argv=${JSON.stringify([helper,'install','--store',f.store,'--archive',join(assets,'runtime.tar.gz'),'--sha256',distribution.archiveSha256])}\nrunpy.run_path(${JSON.stringify(helper)},run_name='__main__')`;
 const child=spawn('python3',['-c',code],{env:f.env});let stderr='';child.stderr.on('data',b=>stderr+=b);const exited=new Promise(resolve=>child.on('exit',resolve));
 try{const deadline=Date.now()+30000;while(!existsSync(signal)&&Date.now()<deadline&&child.exitCode===null)await new Promise(r=>setTimeout(r,20));assert.ok(existsSync(signal),stderr);child.kill('SIGKILL');await exited;}finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
 assert.equal(existsSync(join(f.store,'versions',distribution.release)),false);assert.ok(readdirSync(join(f.store,'versions')).some(name=>name.startsWith('.staging-')));const installed=f.json(f.install());assert.equal(installed.signature,'FM_BUNDLED_RUNTIME_INSTALLED');f.json(f.bind());sentinels(f.home);const before=state(f.home);assert.equal(f.json(f.install()).signature,'FM_BUNDLED_RUNTIME_REUSED');assert.deepEqual(state(f.home),before);assert.equal(readdirSync(join(f.store,'versions')).filter(name=>/^[0-9a-f]{64}$/.test(name)).length,1);
 }finally{f.clean();}
});
