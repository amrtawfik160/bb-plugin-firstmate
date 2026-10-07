import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';

const heavy=process.env.FM_HEAVY_BIN??resolve('overlay/bin/fm-heavy');

function run(args,env,opts={}) {
  const child=spawn('/bin/bash',[heavy,...args],{env:{...process.env,...env},stdio:['ignore','pipe','pipe'],...opts});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const done=new Promise(resolveDone=>child.on('close',(code,signal)=>resolveDone({code,signal,stderr})));
  return {child,done};
}

async function until(predicate,ms) {
  const deadline=Date.now()+ms;
  while(!predicate()){if(Date.now()>deadline)return false;await new Promise(r=>setTimeout(r,50));}
  return true;
}

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'fm-heavy-'));
  return {dir,env:{FM_HEAVY_DIR:join(dir,'slots'),FM_HEAVY_SLOTS:'2'}};
}

test('four heavy commands share two slots: at most two overlap and all finish', async () => {
  const {dir,env}=fixture();
  try {
    const log=join(dir,'log');
    const body=`echo "start $(date +%s%N)" >> ${log}; sleep 1; echo "end $(date +%s%N)" >> ${log}`;
    const results=await Promise.all([1,2,3,4].map(()=>run(['bash','-c',body],env).done));
    assert.deepEqual(results.map(r=>r.code),[0,0,0,0]);
    const events=readFileSync(log,'utf8').trim().split('\n').map(line=>line.split(' ')).map(([kind,ns])=>({kind,at:BigInt(ns)}));
    events.sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:a.kind==='end'?-1:1);
    let live=0,peak=0;
    for(const event of events){live+=event.kind==='start'?1:-1;peak=Math.max(peak,live);}
    assert.equal(events.length,8);
    assert.equal(peak,2,'exactly two commands run at once');
    assert.equal(results.filter(r=>r.stderr.includes('fm-heavy: waiting for a heavy-check slot')).length,2,'the two queued commands each say they wait');
    for(const r of results)assert.ok((r.stderr.match(/waiting for a heavy-check slot/g)??[]).length<=1,'wait notice prints once');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('the command exit code passes through', async () => {
  const {dir,env}=fixture();
  try {
    assert.equal((await run(['bash','-c','exit 3'],env).done).code,3);
    assert.equal((await run(['true'],env).done).code,0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('terminating fm-heavy stops its command and frees the slot', async () => {
  const {dir,env}=fixture();
  try {
    const one={...env,FM_HEAVY_SLOTS:'1'};
    const marker=join(dir,'started'),survivor=join(dir,'survived');
    const holder=run(['bash','-c',`touch ${marker}; sleep 5; touch ${survivor}`],one);
    assert.ok(await until(()=>existsSync(marker),5000),'holder started');
    holder.child.kill('SIGTERM');
    const held=await holder.done;
    assert.notEqual(held.code,0,'a terminated command is not reported as success');
    const started=Date.now();
    const next=await run(['true'],one).done;
    assert.equal(next.code,0);
    assert.ok(Date.now()-started<1500,`slot freed at once, took ${Date.now()-started} ms`);
    await new Promise(r=>setTimeout(r,5500));
    assert.equal(existsSync(survivor),false,'the command died with fm-heavy');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('interrupting fm-heavy stops its command and frees the slot', async () => {
  const {dir,env}=fixture();
  try {
    const one={...env,FM_HEAVY_SLOTS:'1'};
    const marker=join(dir,'started');
    const holder=run(['bash','-c',`touch ${marker}; exec sleep 30`],one);
    assert.ok(await until(()=>existsSync(marker),5000),'holder started');
    holder.child.kill('SIGINT');
    const held=await Promise.race([holder.done,new Promise(r=>setTimeout(()=>r('timeout'),5000))]);
    assert.notEqual(held,'timeout','SIGINT reaches the command');
    assert.equal((await run(['true'],one).done).code,0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('a command killed directly frees its slot', async () => {
  const {dir,env}=fixture();
  try {
    const one={...env,FM_HEAVY_SLOTS:'1'};
    const pidFile=join(dir,'pid');
    const holder=run(['bash','-c',`echo $$ > ${pidFile}; exec sleep 30`],one);
    assert.ok(await until(()=>existsSync(pidFile)&&readFileSync(pidFile,'utf8').trim()!=='',5000),'holder started');
    process.kill(Number(readFileSync(pidFile,'utf8')),'SIGKILL');
    assert.equal((await holder.done).code,137);
    assert.equal((await run(['true'],one).done).code,0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('without flock the command still runs, with a warning', async () => {
  const {dir,env}=fixture();
  try {
    const r=await run(['/bin/bash','-c','exit 4'],{...env,PATH:'/nonexistent'});
    assert.equal(r.code,4);
    assert.match(r.stderr,/fm-heavy: flock not found/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
