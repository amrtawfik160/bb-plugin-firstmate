import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createFakePluginHost,makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createQualityEvents } from './lib/quality-events.ts';

// Owner decisions Q15, Q16, Q21: each owner correction is recorded in the captain home's
// ledger and becomes a crew task; the weekly scorecard counts the week from durable records.
const ctx={threadId:'thr_cap',projectId:'proj_1'};
const LEDGER='/native/data/corrections.jsonl';

async function deck(disk={}) {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain'],settings:{fmHome:'/native',fmHostId:'host_1'}});await plugin(host.bb);
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle'}));
 const files=new Map(Object.entries(disk));
 const sha=text=>createHash('sha256').update(text).digest('hex');
 // A host file with compare-and-swap writes, and reads slow enough for two commands to overlap.
 host.harness.sdk.stub('files.read',async({path})=>{await new Promise(r=>setTimeout(r,5));if(files.has(path))return{content:files.get(path)};throw new Error(`ENOENT: ${path}`);});
 host.harness.sdk.stub('files.write',async({path,content,contentEncoding,expectedSha256})=>{
  const current=files.has(path)?sha(files.get(path)):null;
  if(expectedSha256!==undefined&&expectedSha256!==current)return{outcome:'conflict',currentSha256:current};
  const text=contentEncoding==='base64'?Buffer.from(content,'base64').toString('utf8'):content;files.set(path,text);return{outcome:'written',sha256:sha(text),sizeBytes:text.length};});
 await host.bb.storage.kv.set('native-home:thr_cap','/native');
 const cli=(...argv)=>host.harness.behavior.runCli(argv,ctx);
 return {host,files,cli};
}

test('an owner correction is recorded once in the captain home, and the command prints the crew task',async()=>{
 const {host,files,cli}=await deck();try {
  const first=await cli('corrections','add','--ref','tg:985:4410','--','You sent the PR list without links again.');
  assert.equal(first.exitCode,0,first.stderr);
  assert.match(first.stdout,/^Recorded C1 for tg:985:4410 in \/native\/data\/corrections\.jsonl\./);
  assert.match(first.stdout,/firstmate_dispatch role=builder playbook=none title="Correction C1"/);
  assert.match(first.stdout,/pstack `correct` and `principle-encode-lessons-in-structure`/);
  assert.match(first.stdout,/bb firstmate corrections fix C1 --fix/);
  const ledger=files.get(LEDGER);
  assert.equal(ledger.split('\n').filter(Boolean).length,1);
  const again=await cli('corrections','add','--ref','tg:985:4410','--','You sent the PR list without links again.');
  assert.match(again.stdout,/^tg:985:4410 is already recorded as C1, still open\./);
  assert.equal(files.get(LEDGER),ledger);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a fix is recorded with its changelog line, and refused while captain.md is too long',async()=>{
 const long=Array.from({length:41},(_,i)=>`Rule ${i}.`).join('\n');
 const {host,files,cli}=await deck({'/native/data/captain.md':long});try {
  await cli('corrections','add','--ref','tg:985:4410','--','No links.');
  const refused=await cli('corrections','fix','C1','--fix','data/captain.md','--changelog','PR lists now carry their links.');
  assert.equal(refused.exitCode,1);
  assert.match(refused.stderr,/data\/captain\.md has 41 lines; the limit is 40\. Move the oldest rules to data\/captain\.archive\.md first/);
  files.set('/native/data/captain.md','Rule 1.\n');
  const fixed=await cli('corrections','fix','C1','--fix','https://github.com/o/r/pull/12','--changelog','PR lists now carry their links.');
  assert.equal(fixed.exitCode,0,fixed.stderr);
  assert.match(fixed.stdout,/Send the owner: PR lists now carry their links\./);
  const listed=JSON.parse((await cli('corrections','list','--json')).stdout);
  assert.deepEqual(listed.map(c=>[c.id,c.fix?.ref]),[['C1','https://github.com/o/r/pull/12']]);
 }finally{await host.harness.lifecycle.dispose();}
});

test('concurrent adds and fixes keep every correction and every fix, each with its own id',async()=>{
 const {host,files,cli}=await deck();try {
  const refs=['tg:1:1','tg:1:2','tg:1:3','tg:1:4'];
  const results=await Promise.all(refs.map(ref=>cli('corrections','add','--ref',ref,'--',`words ${ref}`)));
  for(const r of results)assert.equal(r.exitCode,0,r.stderr);
  const rows=JSON.parse((await cli('corrections','list','--json')).stdout);
  assert.deepEqual(rows.map(c=>c.ref).sort(),refs);
  assert.deepEqual(rows.map(c=>c.id).sort(),['C1','C2','C3','C4']);
  const [fix,add]=await Promise.all([cli('corrections','fix','C1','--fix','data/captain.md','--changelog','one'),cli('corrections','add','--ref','tg:1:5','--','five')]);
  assert.equal(fix.exitCode,0,fix.stderr);assert.equal(add.exitCode,0,add.stderr);
  const after=JSON.parse((await cli('corrections','list','--json')).stdout);
  assert.equal(after.find(c=>c.id==='C1').fix.changelog,'one');
  assert.equal(after.find(c=>c.ref==='tg:1:5').id,'C5');
 }finally{await host.harness.lifecycle.dispose();}
});

test('a write that lost a race with another writer reads again and keeps both events',async()=>{
 const {host,files,cli}=await deck();try {
  await cli('corrections','add','--ref','tg:1:1','--','first');
  const outside=JSON.stringify({type:'correction',id:'C2',at:new Date().toISOString(),ref:'tg:9:9',words:'written by another process'})+'\n';
  let raced=false;
  host.harness.sdk.stub('files.read',async({path})=>{const content=files.get(path);if(!raced&&path===LEDGER){raced=true;files.set(path,content+outside);}if(content===undefined)throw new Error('ENOENT');return{content};});
  const r=await cli('corrections','add','--ref','tg:1:3','--','third');
  assert.equal(r.exitCode,0,r.stderr);
  const rows=JSON.parse((await cli('corrections','list','--json')).stdout);
  assert.deepEqual(rows.map(c=>[c.id,c.ref]),[['C1','tg:1:1'],['C2','tg:9:9'],['C3','tg:1:3']]);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a repeated add of a known correction does not ask for a second crew',async()=>{
 const {host,cli}=await deck();try {
  await cli('corrections','add','--ref','tg:1:1','--','first');
  const open=await cli('corrections','add','--ref','tg:1:1','--','first');
  assert.match(open.stdout,/^tg:1:1 is already recorded as C1, still open\. Do not dispatch another crew/);
  assert.doesNotMatch(open.stdout,/Dispatch the correction crew now/);
  await cli('corrections','fix','C1','--fix','data/captain.md','--changelog','done');
  assert.match((await cli('corrections','add','--ref','tg:1:1','--','first')).stdout,/^tg:1:1 is already recorded as C1, fixed by data\/captain\.md\./);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a ledger that cannot be read is never overwritten',async()=>{
 const {host,files,cli}=await deck();try {
  host.harness.sdk.stub('files.read',async()=>{throw new Error('host offline');});
  const r=await cli('corrections','add','--ref','tg:1:2','--','x');
  assert.equal(r.exitCode,1);
  assert.match(r.stderr,/Could not read \/native\/data\/corrections\.jsonl: Error: host offline/);
  assert.equal(files.has(LEDGER),false);
 }finally{await host.harness.lifecycle.dispose();}
});

test('the scorecard counts the week from the ledger and the durable events, for the captain it names',async()=>{
 const now=Date.now();
 const day=(d)=>new Date(now-d*86_400_000).toISOString();
 const ledger=[{type:'correction',id:'C1',at:day(9),ref:'tg:1:1',words:'old'},{type:'correction',id:'C2',at:day(2),ref:'tg:1:2',words:'new'},{type:'fix',id:'C2',at:day(1),ref:'data/captain.md',changelog:'x'}].map(e=>JSON.stringify(e)).join('\n')+'\n';
 const {host}=await deck({[LEDGER]:ledger});try {
  const q=createQualityEvents(host.bb.storage.database());
  q.noteCheck({captain:'thr_cap',pr:'acme/app#5',commitSha:'a'.repeat(40),crew:'chk',model:'gpt-6-astra',verdict:'fail',findings:1,notes:'1. drops a message',at:now-3_600_000});
  q.noteCheck({captain:'thr_other',pr:'acme/app#6',commitSha:'b'.repeat(40),crew:'chk',model:'gpt-6-astra',verdict:'fail',findings:4,notes:'x',at:now-3_600_000});
  await host.bb.storage.kv.set('native-home:thr_worker','/worker');
  // A worker thread passes the captain explicitly and reads the captain's home and events.
  const worker=(...argv)=>host.harness.behavior.runCli(argv,{threadId:'thr_worker',projectId:'proj_1'});
  const card=await worker('scorecard','--captain','thr_cap','--json');
  assert.equal(card.exitCode,0,card.stderr);
  const data=JSON.parse(card.stdout);
  assert.deepEqual(data.corrections.map(c=>[c.id,c.fixed]),[['C2',true]]);
  assert.deepEqual(data.checks.map(c=>c.pr),['acme/app#5']);
  const listed=JSON.parse((await worker('corrections','list','--captain','thr_cap','--since',day(3),'--until',day(0),'--json')).stdout);
  assert.deepEqual(listed.map(c=>c.id),['C2']);
  const plain=await worker('scorecard','--captain','thr_cap');
  assert.match(plain.stdout,/^🛠 Hanoon & tools · Weekly scorecard/);
  assert.match(plain.stdout,/Owner corrections: 1 correction\. 1 is fixed\. Source: corrections ledger\./);
  assert.match(plain.stdout,/Checker findings: 1 finding in 1 fail verdict on 1 PR\. Source: checker verdicts\./);
 }finally{await host.harness.lifecycle.dispose();}
});
