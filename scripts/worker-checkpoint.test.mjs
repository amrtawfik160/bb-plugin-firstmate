import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

const helper=process.env.FM_CHECKPOINT_HELPER??resolve('overlay/bin/fm-worker-checkpoint.py');
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'fm-checkpoint-')),worktree=join(dir,'worktree'),home=join(dir,'home'),bin=join(dir,'bin');
 for(const path of [worktree,join(home,'state'),bin])mkdirSync(path,{recursive:true});
 const git=(...args)=>{const result=spawnSync('git',args,{cwd:worktree,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;};
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 writeFileSync(join(worktree,'AGENTS.md'),'Read the project guide.\r\n');writeFileSync(join(worktree,'app.py'),'print("base")\n');git('add','.');git('commit','-qm','base');
 writeFileSync(join(home,'state/task.meta'),`endpoint_task_id=task\nworktree=${worktree}\nbb_thread_id=thr_fixture\n`);
 // Only the external scheduler is substituted. The actual helper, git,
 // subprocess command, receipts, status protocol and reports execute unchanged.
 if(!process.env.FM_CHECKPOINT_LIVE)writeFileSync(join(bin,'systemd-run'),`#!/usr/bin/python3\nimport os,subprocess,sys\na=sys.argv[1:]\nenv=dict(os.environ)\nwhile a and a[0].startswith('--'):\n item=a.pop(0)\n if item.startswith('--setenv='):\n  k,v=item[len('--setenv='):].split('=',1);env[k]=v\nr=subprocess.run(a,env=env)\nsys.exit(r.returncode)\n`,{mode:0o755});
 const env={...process.env,FM_HOME:home,FM_ROOT_OVERRIDE:home,BB_THREAD_ID:'thr_fixture',PATH:`${bin}:${process.env.PATH}`};
 const run=(...args)=>spawnSync('python3',[helper,'task',...args],{cwd:worktree,env,encoding:'utf8',input:'',timeout:35000});
 const ok=(...args)=>{const result=run(...args);assert.equal(result.status,0,result.stderr);if(args[0]==='check' && process.env.FM_CHECKPOINT_LIVE){const id=/wait ([a-f0-9]{32})/.exec(result.stdout)?.[1];assert.ok(id,result.stdout);const waited=run('wait',id);assert.notEqual(waited.status,2,waited.stderr);}return result.stdout;};
 const setup=()=>{ok('setup','direct-PR');ok('read',join(worktree,'AGENTS.md'));};
 const data=join(home,'data/task');
 const checks=()=>readdirSync(join(data,'checks')).filter(x=>x.endsWith('.json')).map(x=>JSON.parse(readFileSync(join(data,'checks',x),'utf8')));
 return {dir,worktree,home,bin,git,env,run,ok,setup,data,checks,close:()=>rmSync(dir,{recursive:true,force:true})};
}

test('setup requires complete, unchanged instruction reads including CRLF and added project guides',()=>{
 const f=fixture();try {
  writeFileSync(join(f.worktree,'AGENTS.md'),'a'.repeat(8200)+'\r\n');f.ok('setup','direct-PR');
  assert.notEqual(f.run('report','working','editing').status,0);
  assert.match(f.ok('read',join(f.worktree,'AGENTS.md')),/Continue:/);
  assert.notEqual(f.run('report','working','editing').status,0);
  f.ok('read',join(f.worktree,'AGENTS.md'),'8000');f.ok('report','working','editing');
  writeFileSync(join(f.worktree,'guide.md'),'Scope guide\n');f.ok('require-read','guide.md');
  assert.notEqual(f.run('report','working','editing').status,0);f.ok('read','guide.md');
  f.ok('report','working','guide read');writeFileSync(join(f.worktree,'guide.md'),'Changed guide\n');
  assert.notEqual(f.run('report','working','editing').status,0);
 }finally{f.close();}
});

test('no-mistakes setup executes doctor and initializes only an uninitialized repository',()=>{
 const f=fixture();try {
  const log=join(f.dir,'doctor.log'),marker=join(f.dir,'initialized');
  writeFileSync(join(f.bin,'no-mistakes'),`#!/usr/bin/python3\nfrom pathlib import Path\nimport sys\nwith Path(${JSON.stringify(log)}).open('a') as stream: stream.write(sys.argv[1]+'\\n')\nmarker=Path(${JSON.stringify(marker)})\nif sys.argv[1]=='init': marker.touch()\nelif not marker.exists(): print('Repository not initialized');sys.exit(1)\n`,{mode:0o755});
  f.ok('setup','no-mistakes');assert.equal(readFileSync(log,'utf8'),'doctor\ninit\ndoctor\n');
  f.ok('setup','no-mistakes');assert.equal(readFileSync(log,'utf8'),'doctor\ninit\ndoctor\ndoctor\n');
 }finally{f.close();}
});

test('report writes native status and factual worktree report together while retaining notes',()=>{
 const f=fixture();try {
  f.setup();writeFileSync(join(f.worktree,'new.py'),'new\n');
  const result=spawnSync('python3',[helper,'task','report','working','reproduced; editing'],{cwd:f.worktree,env:f.env,input:'Reproduced locally. Production unverified.\n',encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);f.ok('report','working','focused tests next');
  assert.match(readFileSync(join(f.home,'state/task.status'),'utf8'),/working \[at=\d+\]: focused tests next/);
  assert.ok(existsSync(join(f.data,'progress.md')),'phase changes retain a durable progress report');
  const report=readFileSync(join(f.data,'progress.md'),'utf8');assert.match(report,/\?\? new.py/);assert.match(report,/Reproduced locally. Production unverified/);assert.match(report,new RegExp(f.git('rev-parse','HEAD').trim()));
 }finally{f.close();}
});

test('background validation records paused before execution and resolves its exact wait key with durable evidence',()=>{
 const f=fixture();try {
  f.setup();const status=join(f.home,'state/task.status');
  f.ok('check','focused check','--','python3','-c',`from pathlib import Path; assert 'paused [' in Path(${JSON.stringify(status)}).read_text(); print('verified current worktree')`);
  const [row]=f.checks();assert.equal(row.exitCode,0);assert.deepEqual(row.revision,row.finishedRevision);
  const lines=readFileSync(status,'utf8');assert.match(lines,new RegExp(`paused .*key=bb-check-${row.id}`));assert.match(lines,new RegExp(`resolved .*key=bb-check-${row.id}`));
  assert.match(f.ok('wait',row.id),/verified current worktree/);assert.match(readFileSync(join(f.data,'progress.md'),'utf8'),/focused check: exit 0; current revision/);
  assert.notEqual(f.run('_execute',row.id).status,0,'a receipt never executes twice');
 }finally{f.close();}
});

test('validation reports failure and resolves waits when command startup fails',()=>{
 const f=fixture();try {
  f.setup();f.ok('check','missing executable','--','/nonexistent/fm-check-fixture');const [row]=f.checks();
  assert.equal(row.exitCode,127);assert.equal(f.run('wait',row.id).status,127);assert.match(readFileSync(join(f.home,'state/task.status'),'utf8'),/resolved .*exit 127/);
 }finally{f.close();}
});

for(const change of ['staged','unstaged','untracked'])test(`validation refuses a stale result after ${change} work changes`,()=>{
 const f=fixture();try {
  f.setup();f.ok('check','check','--','python3','-c','print("pass")');const [row]=f.checks();
  writeFileSync(join(f.worktree,change==='untracked'?'new.py':'app.py'),'changed\n');if(change==='staged')f.git('add','app.py');
  assert.match(f.run('wait',row.id).stderr,/worktree changed/);
  f.ok('report','working','changes after validation');assert.match(readFileSync(join(f.data,'progress.md'),'utf8'),/earlier revision/);
 }finally{f.close();}
});

test('task ownership rejects another worktree, thread and symlinked artifact namespace',()=>{
 const f=fixture();try {
  writeFileSync(join(f.home,'state/task.meta'),`worktree=${f.dir}\nbb_thread_id=thr_fixture\n`);assert.match(f.run('setup').stderr,/does not own/);
  writeFileSync(join(f.home,'state/task.meta'),`worktree=${f.worktree}\nbb_thread_id=thr_other\n`);assert.match(f.run('setup').stderr,/another BB thread/);
  writeFileSync(join(f.home,'state/task.meta'),`worktree=${f.worktree}\nbb_thread_id=thr_fixture\n`);
  mkdirSync(join(f.home,'data'));symlinkSync(f.dir,join(f.home,'data/task'));assert.match(f.run('setup').stderr,/symlinked task namespace/);
 }finally{f.close();}
});

test('first reporting migration preserves the prior authored report and allows setup failures to be reported',()=>{
 const f=fixture();try {
  mkdirSync(f.data,{recursive:true});writeFileSync(join(f.data,'progress.md'),'Original worker findings\n');
  f.ok('report','blocked','setup prerequisite unavailable');
  assert.equal(readFileSync(join(f.data,'progress-before-checkpoint.md'),'utf8'),'Original worker findings\n');
  assert.match(readFileSync(join(f.home,'state/task.status'),'utf8'),/blocked .*setup prerequisite unavailable/);
  f.setup();assert.equal(readFileSync(join(f.data,'progress-before-checkpoint.md'),'utf8'),'Original worker findings\n');
 }finally{f.close();}
});

test('setup cannot substitute a lighter delivery mode for the native task mode',()=>{
 const f=fixture();try {
  writeFileSync(join(f.home,'state/task.meta'),`endpoint_task_id=task\nworktree=${f.worktree}\nbb_thread_id=thr_fixture\nkind=ship\nmode=no-mistakes\n`);
  assert.match(f.run('setup','direct-PR').stderr,/must match native task metadata: no-mistakes/);
 }finally{f.close();}
});

test('a validation unit that ends without a receipt becomes a failed check and closes its wait',()=>{
 const f=fixture();try {
  f.setup();
  if(!process.env.FM_CHECKPOINT_LIVE)writeFileSync(join(f.bin,'systemd-run'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  // In live mode this terminates only the helper inside this test's own unit.
  f.ok('check','interrupted check','--','python3','-c','import os,signal; os.kill(os.getppid(),signal.SIGKILL)');
  const [row]=f.checks();const waited=f.run('wait',row.id);
  assert.equal(waited.status,125,waited.stdout+waited.stderr);
  assert.match(readFileSync(join(f.home,'state/task.status'),'utf8'),new RegExp(`resolved .*key=bb-check-${row.id}`));
  assert.equal(f.checks()[0].exitCode,125);
 }finally{f.close();}
});

test('a failed progress write cannot publish terminal completion',()=>{
 const f=fixture();try {
  f.setup();rmSync(join(f.data,'progress.md'));mkdirSync(join(f.data,'progress.md'));
  assert.notEqual(f.run('report','done','completed fixture').status,0);
  assert.doesNotMatch(readFileSync(join(f.home,'state/task.status'),'utf8'),/done .*completed fixture/);
 }finally{f.close();}
});

test('native zero-turn waiting uses foreground checks and refuses background polling',()=>{
 const f=fixture();try {
  f.ok('setup','direct-PR','--foreground-checks');f.ok('read',join(f.worktree,'AGENTS.md'));
  writeFileSync(join(f.bin,'systemd-run'),'#!/bin/sh\nexit 97\n',{mode:0o755});
  assert.notEqual(f.run('check','background validation','--','python3','-c','print("pass")').status,0);
  assert.equal(f.checks().length,0,'a forbidden background check never creates a wait');
  assert.match(f.ok('check-foreground','foreground validation','--','python3','-c','print("foreground result")'),/foreground result/);
  const [row]=f.checks();assert.equal(row.exitCode,0);assert.equal(row.transport,'foreground');
  const status=readFileSync(join(f.home,'state/task.status'),'utf8');assert.match(status,/paused /);assert.match(status,/resolved /);
 }finally{f.close();}
});

test('a TypeScript project without the best-practices skill sets up with a warning',()=>{
 const f=fixture();try {
  writeFileSync(join(f.worktree,'app.ts'),'export const x = 1;\n');f.git('add','app.ts');f.git('commit','-qm','ts');
  const home=join(f.dir,'bare-home');mkdirSync(home);
  const result=spawnSync('python3',[helper,'task','setup','direct-PR'],{cwd:f.worktree,env:{...f.env,HOME:home},encoding:'utf8',input:''});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stderr,/warning: .*typescript-best-practices/);
 }finally{f.close();}
});

test('a background check runs in the foreground when systemd cannot start the unit',{skip:!!process.env.FM_CHECKPOINT_LIVE},()=>{
 const f=fixture();try {
  writeFileSync(join(f.bin,'systemd-run'),'#!/bin/sh\necho "Failed to connect to bus: No such file or directory" >&2\nexit 1\n',{mode:0o755});
  f.setup();
  const result=f.run('check','focused check','--','python3','-c','print("ran in foreground")');
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/ran in foreground/);
  const [row]=f.checks();assert.equal(row.exitCode,0);assert.equal(row.transport,'foreground');
 }finally{f.close();}
});

test('a background check gives the unit HOME and the caller environment',{skip:!!process.env.FM_CHECKPOINT_LIVE},()=>{
 const f=fixture();try {
  writeFileSync(join(f.bin,'systemd-run'),`#!/usr/bin/python3\nimport subprocess,sys\na=sys.argv[1:]\nenv={}\nwhile a and a[0].startswith('--'):\n item=a.pop(0)\n if item.startswith('--setenv='):\n  k,v=item[len('--setenv='):].split('=',1);env[k]=v\nsys.exit(subprocess.run(a,env=env).returncode)\n`,{mode:0o755});
  f.setup();
  const probe=`import os; assert os.environ.get('HOME')==${JSON.stringify(f.env.HOME??'')}, os.environ.get('HOME'); assert os.environ.get('FM_FIXTURE_VAR')=='kept'`;
  const result=spawnSync('python3',[helper,'task','check','env check','--','python3','-c',probe],{cwd:f.worktree,env:{...f.env,FM_FIXTURE_VAR:'kept'},encoding:'utf8',input:''});
  assert.equal(result.status,0,result.stderr);
  const [row]=f.checks();assert.equal(row.exitCode,0,readFileSync(join(f.data,'checks',`${row.id}.log`),'utf8'));
 }finally{f.close();}
});

test('reports and check output hide secret values but keep variable names',()=>{
 const f=fixture();try {
  f.setup();
  const secrets=['prod:happy-otter-123|eyJ2MiI6ImFiY2RlZjAxMjM0NTY3ODkifQ==','sk_live_51HabcdefGHIJKLmnop','hunter2-Secret!','9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08']; // gitleaks:allow (made-up fixture values)
  const notes=`CONVEX_DEPLOY_KEY=${secrets[0]}\nexport STRIPE_SECRET_KEY="${secrets[1]}"\nDB_PASSWORD: ${secrets[2]}\nsha ${secrets[3]}\n`;
  const result=spawnSync('python3',[helper,'task','report','working',`deploy used API_TOKEN=${secrets[1]}`],{cwd:f.worktree,env:f.env,input:notes,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const check=f.run('check','env dump','--','python3','-c',`print("CONVEX_DEPLOY_KEY=${secrets[0]}")`);assert.equal(check.status,0,check.stderr);
  const id=/wait ([a-f0-9]{32})/.exec(check.stdout)?.[1];const waited=id?f.run('wait',id):check;
  const surfaces={status:readFileSync(join(f.home,'state/task.status'),'utf8'),progress:readFileSync(join(f.data,'progress.md'),'utf8'),output:waited.stdout+waited.stderr};
  for(const [name,text] of Object.entries(surfaces))for(const secret of secrets)assert.ok(!text.includes(secret),`${name} leaked ${secret}`);
  assert.match(surfaces.status,/API_TOKEN=\[redacted\]/);assert.match(surfaces.progress,/CONVEX_DEPLOY_KEY=\[redacted\]/);assert.match(surfaces.progress,/STRIPE_SECRET_KEY="\[redacted\]"/);assert.match(surfaces.output,/CONVEX_DEPLOY_KEY=\[redacted\]/);
 }finally{f.close();}
});
