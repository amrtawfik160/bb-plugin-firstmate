import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createQueueStore,queueKey} from './queue-store.ts';
const row=(id,owner='thr_a',project='proj_a')=>({id,title:`task ${id}`,detail:'full original task\n'.repeat(100),projectId:project,parentThreadId:owner,nativeHome:`/tmp/${owner}`,shape:'ship',mode:'direct-PR',providerId:'codex',model:'gpt-6.1-sol',reasoningLevel:'xhigh',deliveryRequirement:'merged-and-verified',blockedBy:[],waitUntil:null,status:'queued',crewId:null,createdAt:'2026-10-04T00:00:00.000Z'});
test('queue migration is complete, ordered, scoped and transactional; restart/prune cannot resurrect evidence',async()=>{
 const home=mkdtempSync(join(tmpdir(),'fm-queue-db-'));const file=join(home,'queue.sqlite');let db=new Database(file);
 const original=[row('same'),row('same','thr_b'),row('same','thr_a','proj_b'),...Array.from({length:250},(_,n)=>row(`q${n}`))];
 let reads=0;const legacy=async()=>{reads++;return original;};
 try {
  let q=createQueueStore(db,legacy);db.exec("CREATE TRIGGER fault BEFORE INSERT ON queue_records WHEN NEW.ordinal=101 BEGIN SELECT RAISE(ABORT,'migration write fault'); END");
  await assert.rejects(q.ready(),/migration write fault/);assert.equal(db.prepare('SELECT count(*) AS n FROM queue_records').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM queue_migration').get().n,0);
  db.close();db=new Database(file);db.exec('DROP TRIGGER fault');q=createQueueStore(db,legacy);await q.ready();assert.deepEqual(q.list(),original);
  const evidence=db.prepare('SELECT * FROM queue_migration').get();assert.equal(evidence.original,JSON.stringify(original));assert.equal(evidence.count,253);
  q.transform(r=>r.parentThreadId==='thr_a' && r.projectId==='proj_a',()=>null);const survivor=q.list();assert.equal(survivor.length,2);
  db.close();db=new Database(file);q=createQueueStore(db,async()=>{throw new Error('must never reread migrated KV');});await q.ready();assert.deepEqual(q.list(),survivor);assert.deepEqual(db.prepare('SELECT * FROM queue_migration').get(),evidence);assert.equal(reads,2);
 }finally{db.close();rmSync(home,{recursive:true,force:true});}
});
for(const [label,input] of [['not-array',{}],['malformed',[row('good'),{...row('bad'),blockedBy:23}]],['unknown',[{...row('bad'),newUnknownAuthority:true}]],['duplicate',[row('same'),row('same')]]]) test(`queue refuses ${label} legacy data without silent loss or marker`,async()=>{
 const db=new Database(':memory:');try{const q=createQueueStore(db,async()=>input);await assert.rejects(q.ready(),/migration refused/);assert.equal(db.prepare('SELECT count(*) AS n FROM queue_records').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM queue_migration').get().n,0);}finally{db.close();}
});
test('queue read/write errors stay loud; row mutations and colliding handoff roll back without foreign loss',async()=>{
 const db=new Database(':memory:');try {
 const q=createQueueStore(db,async()=>[row('same'),row('same','thr_b')]);await q.ready();const before=q.list();
 db.exec("CREATE TRIGGER fault BEFORE UPDATE ON queue_records BEGIN SELECT RAISE(ABORT,'write failed'); END");assert.throws(()=>q.patch(before[0],{status:'done'}),/write failed/);assert.deepEqual(q.list(),before);db.exec('DROP TRIGGER fault');
 assert.throws(()=>q.transform(r=>r.parentThreadId==='thr_a',r=>({...r,parentThreadId:'thr_b'})),/UNIQUE/);assert.deepEqual(q.list(),before);
 q.patch(before[0],{status:'done'});q.patch(before[0],{status:'dispatched',crewId:'same'});assert.equal(q.get(before[0]).status,'done','late spawn publication cannot resurrect finished work');assert.deepEqual(q.get(before[1]),before[1]);
 db.prepare('UPDATE queue_records SET record=? WHERE key=?').run('not JSON',queueKey(before[0]));assert.throws(()=>q.list(),/JSON/);assert.deepEqual(q.get(before[1]),before[1]);
 }finally{db.close();}
});
test('two stores racing migration share one complete snapshot; legacy read failure remains recoverable',async()=>{
 const db=new Database(':memory:');try {
 const original=[row('a')];let fail=true;
 const a=createQueueStore(db,async()=>{if(fail)throw new Error('KV unavailable');await Promise.resolve();return original;});
 await assert.rejects(a.ready(),/KV unavailable/);fail=false;const b=createQueueStore(db,async()=>original);await Promise.all([a.ready(),b.ready()]);assert.deepEqual(a.list(),original);assert.deepEqual(b.list(),original);
 await Promise.all([Promise.resolve().then(()=>a.add(row('a2'))),Promise.resolve().then(()=>b.add(row('b2','thr_b')))]);assert.equal(a.list().length,3);
 }finally{db.close();}
});
