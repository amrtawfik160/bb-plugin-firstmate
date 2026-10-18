import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {overlay,pins,fixture,run,ok} from './prompt-fixture.mjs';

// A fake bb CLI: every call costs DELAY seconds, like the real CLI's ~0.3-0.7 s.
// Threads come from threads.json; interactions/<id>.json lists a thread's interactions.
const fakeBb=`#!/usr/bin/env python3
import json,os,sys,time
d=os.environ['FAKE_BB_DIR'];a=sys.argv[1:]
with open(os.path.join(d,'calls.jsonl'),'a') as f:f.write(json.dumps(a)+'\\n')
time.sleep(float(os.environ.get('FAKE_BB_DELAY','0'))+float(os.environ.get('FM_WAIT_TEST_SLOWDOWN','0')))
threads=json.load(open(os.path.join(d,'threads.json')))
if a[:2]==['thread','list']:
  print(json.dumps(threads if '--include-hidden' in a else [t for t in threads if t.get('visibility')!='hidden']));sys.exit(0)
if a[:2]==['thread','show']:
  p=os.path.join(d,'show.json')
  t=[t for t in (json.load(open(p)) if os.path.exists(p) else threads) if t['id']==a[-1]]
  if not t: print(json.dumps({'ok':False,'error':{'code':'not_found','message':'no thread'}}));sys.exit(1)
  print(json.dumps(t[0]));sys.exit(0)
if a[:3]==['thread','interactions','list']:
  p=os.path.join(d,'interactions',a[-1]+'.json')
  print(open(p).read() if os.path.exists(p) else '[]');sys.exit(0)
if a[:2]==['thread','wait']:
  time.sleep(min(float(a[a.index('--timeout')+1]),30));sys.exit(2)
sys.exit(1)
`;

function lab(n,{delay='0.2'}={}) {
 const home=fixture(pins.at(-1));
 ok(run('python3',[join(overlay,'install-bb-backend.py'),'--home',home,'--overlay',overlay]));
 const dir=join(home,'fakebb');mkdirSync(join(dir,'interactions'),{recursive:true});
 writeFileSync(join(dir,'bb'),fakeBb,{mode:0o755});
 const threads=[];const windows=[];
 for(let i=0;i<n;i++) {
  const id=`thr_w${String(i).padStart(3,'0')}`;
  threads.push({id,status:'idle',visibility:'hidden',archivedAt:null,hasPendingInteraction:false,runtime:{displayStatus:'idle'}});
  writeFileSync(join(home,'state',`t${i}.meta`),`window=bb:${id}\nbackend=bb\nbb_thread_id=${id}\nkind=ship\n`);
  windows.push(`bb:${id}`);
 }
 const save=()=>writeFileSync(join(dir,'threads.json'),JSON.stringify(threads));save();
 const wait=(timeout,env={})=>{
  const started=Date.now();
  // --norc: with SHLVL=0 (a Codex command) and a socket for stdin, Debian's bash reads
  // ~/.bashrc, which can put the real bb ahead of the fake one on PATH.
  const r=spawnSync('bash',['--norc','-c','. "$FM_HOME/bin-bb/fm-backend.sh"; fm_backend_source bb; FM_BACKEND_EVENTS_CAPABILITY_CONFIRMED=1 fm_backend_wait_transition bb bb "$@"','wait',String(timeout),join(home,'state'),...windows],
   {encoding:'utf8',timeout:600000,env:{...process.env,FM_HOME:home,FM_BACKEND:'bb',FAKE_BB_DIR:dir,FAKE_BB_DELAY:delay,PATH:`${dir}:${process.env.PATH}`,...env}});
  const calls=existsSync(join(dir,'calls.jsonl'))?readFileSync(join(dir,'calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  rmSync(join(dir,'calls.jsonl'),{force:true});
  return {rc:r.status,out:r.stdout,err:r.stderr,seconds:(Date.now()-started)/1000,calls};
 };
 // One fake bb call on this machine, start to exit, with no added delay: on a loaded host
 // starting a process can cost seconds, and a budget sized for an idle host then cuts the
 // first read off and exercises a different path.
 const callCost=()=>{
  const times=[0,1,2].map(()=>{const t=Date.now();spawnSync(join(dir,'bb'),['thread','list','--json'],{env:{...process.env,FAKE_BB_DIR:dir,FAKE_BB_DELAY:'0'}});return (Date.now()-t)/1000;});
  rmSync(join(dir,'calls.jsonl'),{force:true});
  return times.sort((a,b)=>a-b)[1]+Number(process.env.FM_WAIT_TEST_SLOWDOWN ?? 0);
 };
 return {home,dir,threads,save,wait,callCost};
}
// A budget with room for <calls> sequential BB calls of <delay> seconds each on this machine.
const roomy=(l,base,calls,delay=0.2)=>Math.ceil(base+calls*(delay+l.callCost()));
// The overhead a deadline test allows past its budget: at least 1.5 s, more on a slow host.
const slack=l=>Math.max(1.5,2*l.callCost());

test('a 60-window BB wait stays inside its timeout budget and reads every status in one list call',()=>{
 const l=lab(60);try {
  const budget=roomy(l,3,2),r=l.wait(budget);
  assert.equal(r.rc,1,r.err);
  assert.ok(r.seconds<budget+slack(l),`wait took ${r.seconds}s for a ${budget}s budget with 60 windows (calls: ${r.calls.length})`);
  assert.equal(r.calls.filter(c=>c[1]==='show').length,0,'no per-thread show when the list covers every window');
  assert.equal(r.calls.filter(c=>c[1]==='interactions').length,0,'no interaction read for idle threads the list reports without a pending interaction');
 }finally{rmSync(l.home,{recursive:true,force:true});}
});

test('a pending interaction the list reports surfaces at once as a blocked edge for that window',()=>{
 const l=lab(60);try {
  l.threads[41].hasPendingInteraction=true;l.save();
  const budget=roomy(l,3,3),r=l.wait(budget);
  assert.equal(r.rc,0,r.err);
  assert.equal(r.out.split('\t')[0],'thr_w041');assert.equal(r.out.split('\t')[3],'blocked');
  assert.ok(r.seconds<budget,`blocked edge took ${r.seconds}s of a ${budget}s budget`);
 }finally{rmSync(l.home,{recursive:true,force:true});}
});

test('a working thread is checked for a pending interaction the list flag may not show yet',()=>{
 const l=lab(60);try {
  l.threads[7].status='active';l.threads[7].runtime.displayStatus='active';l.save();
  writeFileSync(join(l.dir,'interactions','thr_w007.json'),JSON.stringify([{id:'int_1',status:'resolving'}]));
  const r=l.wait(roomy(l,3,3));
  assert.equal(r.rc,0,r.err);assert.equal(r.out.split('\t')[0],'thr_w007');assert.equal(r.out.split('\t')[3],'blocked');
  assert.deepEqual(r.calls.filter(c=>c[1]==='interactions').map(c=>c.at(-1)),['thr_w007'],'only the working thread gets an interaction read');
 }finally{rmSync(l.home,{recursive:true,force:true});}
});

test('a working thread that stays working is raced until the budget ends, then the wait returns',()=>{
 const l=lab(60);try {
  l.threads[3].status='active';l.threads[3].runtime.displayStatus='active';l.save();
  // A 6 s budget leaves room for the race after the scan on a loaded machine.
  const budget=roomy(l,6,3),r=l.wait(budget);
  assert.equal(r.rc,1,r.err);
  assert.ok(r.seconds<budget+slack(l),`wait took ${r.seconds}s for a ${budget}s budget`);
  assert.ok(r.calls.some(c=>c[1]==='wait'&&c.at(-1)==='thr_w003'),'the working thread was raced to idle');
 }finally{rmSync(l.home,{recursive:true,force:true});}
});

test('a window missing from the list falls back to that thread alone',()=>{
 const l=lab(5);try {
  // show still knows the thread the list omits.
  writeFileSync(join(l.dir,'show.json'),JSON.stringify(l.threads));
  const missing=l.threads.splice(2,1)[0];l.save();
  const r=l.wait(roomy(l,1,3));
  assert.equal(r.rc,1,r.err);
  const shown=r.calls.filter(c=>c[1]==='show').map(c=>c.at(-1));
  assert.ok(shown.length>0&&shown.every(id=>id===missing.id),`show calls: ${shown}`);
 }finally{rmSync(l.home,{recursive:true,force:true});}
});

test('60 threads with turns in flight still end the wait inside its budget, and a pending interaction among them is found',()=>{
 const l=lab(60);try {
  for(const t of l.threads){t.status='active';t.runtime.displayStatus='active';}l.save();
  // A list read, then four rounds of 16 parallel interaction reads.
  const budget=roomy(l,3,6),quiet=l.wait(budget);
  assert.equal(quiet.rc,1,quiet.err);
  assert.ok(quiet.seconds<budget+slack(l),`wait took ${quiet.seconds}s for a ${budget}s budget with 60 active threads (calls: ${quiet.calls.length})`);
  assert.ok(quiet.calls.filter(c=>c[1]==='wait').length<=8,'at most eight bb thread wait processes race at once');
  writeFileSync(join(l.dir,'interactions','thr_w052.json'),JSON.stringify([{id:'int_9',status:'pending'}]));
  const blocked=l.wait(budget);
  assert.equal(blocked.rc,0,blocked.err);assert.equal(blocked.out.split('\t')[0],'thr_w052');assert.equal(blocked.out.split('\t')[3],'blocked');
  assert.ok(blocked.seconds<budget+slack(l),`blocked edge took ${blocked.seconds}s`);
 }finally{rmSync(l.home,{recursive:true,force:true});}
});

test('with a slow BB CLI (1.5 s a call) the status read, interaction reads and scan all stop at one deadline',()=>{
 const l=lab(60,{delay:'1.5'});try {
  for(const t of l.threads){t.status='active';t.runtime.displayStatus='active';}l.save();
  // The budget stays fixed: the point is that slow calls cannot stretch it. On a host
  // too slow to finish even the list read, nothing was readable (2) instead of idle (1).
  const r=l.wait(3);
  assert.ok([1,2].includes(r.rc),r.err);
  assert.ok(r.seconds<3+slack(l),`wait took ${r.seconds}s for a 3s budget at 1.5s per bb call (calls: ${r.calls.length})`);
 }finally{rmSync(l.home,{recursive:true,force:true});}
});

test('a thread the list already shows with a pending interaction is handled before any interaction read, even with a slow BB CLI',()=>{
 const l=lab(60,{delay:'1.5'});try {
  for(const t of l.threads){t.status='active';t.runtime.displayStatus='active';}
  l.threads[44].hasPendingInteraction=true;l.save();
  const budget=roomy(l,3,2,1.5),r=l.wait(budget);
  assert.equal(r.rc,0,r.err);assert.equal(r.out.split('\t')[0],'thr_w044');assert.equal(r.out.split('\t')[3],'blocked');
  assert.equal(r.calls.filter(c=>c[1]==='interactions').length,0,'no interaction read before the confirmed one is handled');
  assert.ok(r.seconds<budget,`took ${r.seconds}s of a ${budget}s budget`);
 }finally{rmSync(l.home,{recursive:true,force:true});}
});

test('the wait reaches the fake bb even when the caller runs with SHLVL=0 and a ~/.bashrc that puts another bb first',()=>{
 // A Codex command runs with SHLVL=0. Node gives the test's bash a socket for stdin, and
 // Debian's bash then reads ~/.bashrc, which can put the real bb ahead of the fake one.
 const l=lab(5);try {
  const decoy=join(l.home,'decoy'),rc=join(l.home,'rc-home');mkdirSync(decoy);mkdirSync(rc);
  writeFileSync(join(decoy,'bb'),'#!/bin/sh\necho decoy >> "$FAKE_BB_DIR/decoy.log"\nexit 1\n',{mode:0o755});
  writeFileSync(join(rc,'.bashrc'),`export PATH="${decoy}:$PATH"\n`);
  writeFileSync(join(l.dir,'show.json'),JSON.stringify(l.threads));
  const missing=l.threads.splice(2,1)[0];l.save();
  const r=l.wait(roomy(l,1,3),{HOME:rc,SHLVL:'0'});
  assert.ok(!existsSync(join(l.dir,'decoy.log')),'the decoy bb from ~/.bashrc answered');
  assert.equal(r.rc,1,r.err);
  assert.deepEqual([...new Set(r.calls.filter(c=>c[1]==='show').map(c=>c.at(-1)))],[missing.id]);
 }finally{rmSync(l.home,{recursive:true,force:true});}
});
