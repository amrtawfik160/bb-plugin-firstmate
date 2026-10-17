import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createFakePluginHost,makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries } from './lib/pr-delivery.ts';

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
 host.harness.sdk.stub('files.read',async({path})=>{if(files.has(path))return{content:files.get(path)};throw new Error(`ENOENT: ${path}`);});
 host.harness.sdk.stub('files.write',async({path,content,contentEncoding})=>{const text=contentEncoding==='base64'?Buffer.from(content,'base64').toString('utf8'):content;files.set(path,text);return{outcome:'written',sha256:createHash('sha256').update(text).digest('hex')};});
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
  assert.match(again.stdout,/^tg:985:4410 is already recorded as C1\./);
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

test('a ledger that cannot be read is never overwritten',async()=>{
 const {host,files,cli}=await deck();try {
  host.harness.sdk.stub('files.read',async()=>{throw new Error('host offline');});
  const r=await cli('corrections','add','--ref','tg:1:2','--','x');
  assert.equal(r.exitCode,1);
  assert.match(r.stderr,/Could not read \/native\/data\/corrections\.jsonl: Error: host offline/);
  assert.equal(files.has(LEDGER),false);
 }finally{await host.harness.lifecycle.dispose();}
});

test('the scorecard counts the week from the ledger and the checker verdicts',async()=>{
 const now=Date.now();
 const day=(d)=>new Date(now-d*86_400_000).toISOString();
 const ledger=[{type:'correction',id:'C1',at:day(9),ref:'tg:1:1',words:'old'},{type:'correction',id:'C2',at:day(2),ref:'tg:1:2',words:'new'},{type:'fix',id:'C2',at:day(1),ref:'data/captain.md',changelog:'x'}].map(e=>JSON.stringify(e)).join('\n')+'\n';
 const {host,cli}=await deck({[LEDGER]:ledger});try {
  const store=createDeliveries(host.bb.storage.database());
  const r=store.register({url:'https://github.com/acme/app/pull/5',taskId:'t5',projectId:'proj_1',owner:'thr_cap',home:'/native',worker:'thr_w',requirement:'merged'});
  store.observe(r.id,{headSha:'a'.repeat(40),state:'open',draft:false,checks:'passing',review:'approved',reviewHeadSha:'a'.repeat(40),mergeCommitSha:null,mergeable:'mergeable'},true);
  store.recordCheck(r.id,'aaaaaaa',{verdict:'fail',crewId:'chk',providerId:'codex',model:'gpt-6-astra',notes:'1. drops a message'});
  const card=await cli('scorecard','--json');
  assert.equal(card.exitCode,0,card.stderr);
  const data=JSON.parse(card.stdout);
  assert.deepEqual(data.corrections.map(c=>[c.id,c.fixed]),[['C2',true]]);
  assert.deepEqual(data.checkerFails.map(f=>f.pr),['acme/app#5']);
  const plain=await cli('scorecard');
  assert.match(plain.stdout,/^🛠 Hanoon & tools · Weekly scorecard/);
  assert.match(plain.stdout,/Owner corrections: 1 correction\. 1 is fixed\. Source: corrections ledger\./);
  assert.match(plain.stdout,/Checker findings: 1 fail verdict on 1 PR\. Source: checker verdicts\./);
 }finally{await host.harness.lifecycle.dispose();}
});
