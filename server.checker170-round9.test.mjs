import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerAsks } from './lib/owner-asks.ts';
import { createOwnerAsks as oldCreateOwnerAsks } from './test/fixtures/owner-asks-pre-stamp.ts';
import { createOwnerGate, approvalFor } from './lib/owner-gate.ts';
import { createProductionApprovals } from './lib/production-approval.ts';
import { testEvidenceDir } from './test/approval-telegram-checkout.ts';

const evidence=testEvidenceDir();
const PR='cyndra-ai/cyndra-saas#2391';const HEAD='a'.repeat(40);
function adapt(raw, intercept=()=>{}) {
 return {
  exec(sql){const out=raw.exec(sql);intercept(sql);return out;},
  prepare(sql){return raw.prepare(sql);},
  transaction(fn){return ()=>{raw.exec('BEGIN');try{const out=fn();raw.exec('COMMIT');return out;}catch(error){raw.exec('ROLLBACK');throw error;}};},
 };
}
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'r9-migration-'));const file=join(dir,'test.db');
 const prior=new DatabaseSync(file);const old=oldCreateOwnerAsks(adapt(prior));
 for(const id of ['old','late']) old.create({id,captain:'thr_cap',kind:'approval',text:'Merge?',options:[{label:'Approve'},{label:'No'}],createdAt:1});
 old.resolve('old','thr_cap','answered','Approve',2,'owner');
 const raw=new DatabaseSync(file);
 return {old,prior,raw,dispose(){raw.close();prior.close();rmSync(dir,{recursive:true,force:true});}};
}
function state(raw,id) {
 const db=adapt(raw);createProductionApprovals(db).bindCard(id,[{pr:PR,head:HEAD}]);
 const cards=createOwnerGate(db).cardsForPr(PR);
 return {row:raw.prepare('SELECT * FROM owner_ask_answer WHERE id=?').get(id),marker:raw.prepare('SELECT * FROM owner_ask_stamp_migrated').all(),cards,decision:approvalFor({pr:PR,head:HEAD,action:'merge',cards,coverage:()=> 'covers',preApprovals:[]})};
}
test('R9 only answers preceding the migration marker keep legacy permission',()=>{
 const f=fixture();try{
  let interleaved=false;
  createOwnerAsks(adapt(f.raw,sql=>{
   if(sql.includes('INSERT INTO owner_ask_stamp_migrated')) {
    assert.equal(f.prior.prepare('SELECT v FROM owner_ask_stamp_migrated WHERE v=1').get().v,1);
    f.old.resolve('late','thr_cap','answered','Approve',20,'owner');interleaved=true;
   }
  }));
  assert.equal(interleaved,true);const result=state(f.raw,'late');writeFileSync(evidence+'170-migration-race-9.json',JSON.stringify(result,null,2));
  assert.equal(result.row.tap_id,null,'a concurrent unstamped answer recorded after the marker was promoted to legacy');
  assert.equal(result.decision.state,'pending');
 }finally{f.dispose();}
});
test('R9 interrupted upgrade can retry migration of existing owner permissions',()=>{
 const f=fixture();try{
  let interrupted=false;
  assert.throws(()=>createOwnerAsks(adapt(f.raw,sql=>{if(sql.includes('INSERT INTO owner_ask_stamp_migrated')){interrupted=true;throw new Error('simulated startup interruption after committed marker');}})),/simulated startup interruption/);
  assert.equal(interrupted,true);createOwnerAsks(adapt(f.raw));const result=state(f.raw,'old');writeFileSync(evidence+'170-migration-interruption-9.json',JSON.stringify(result,null,2));
  assert.equal(result.decision.state,'success','pre-upgrade owner permission was permanently lost after interruption');
 }finally{f.dispose();}
});
test('R9 later unstamped rows stay excluded after repeated startup',()=>{
 const f=fixture();try{
  const asks=createOwnerAsks(adapt(f.raw));asks.resolve('late','thr_cap','answered','Approve',20,'owner');
  createOwnerAsks(adapt(f.raw));const result=state(f.raw,'late');assert.equal(result.row.tap_id,null);assert.equal(result.decision.state,'pending');
 }finally{f.dispose();}
});
test('R9 a valid replay leaves the card, its skip, and follow-up sequence unchanged',()=>{
 const raw=new DatabaseSync(':memory:');try{
  const db=adapt(raw),asks=createOwnerAsks(db);asks.create({id:'a',captain:'thr_cap',kind:'question',text:'Which?',options:[{label:'Yes'},{label:'No'}],createdAt:1});
  const tap={tapId:'board:stable',answeredAt:10};asks.resolve('a','thr_cap','answered','Yes',20,'owner',tap);
  raw.prepare('INSERT INTO owner_ask_defer(id,until,told) VALUES (?,?,?)').run('a',1000,0);
  const before=asks.get('a'),jobs=asks.pendingFollowUps();assert.deepEqual(asks.resolve('a','thr_cap','answered','Yes',30,'owner',tap),before);assert.deepEqual(asks.get('a'),before);assert.deepEqual(asks.pendingFollowUps(),jobs);
 }finally{raw.close();}
});
test('R9 same known tap at reopen cutoff is refused without any database change',()=>{
 const raw=new DatabaseSync(':memory:');try{
  const asks=createOwnerAsks(adapt(raw));asks.create({id:'a',captain:'thr_cap',kind:'approval',text:'Merge?',options:[{label:'Approve'},{label:'No'}],createdAt:1});
  const tap={tapId:'board:stable',answeredAt:10};asks.resolve('a','thr_cap','answered','Approve',20,'owner',tap);asks.resolve('a','thr_cap','open','Reopen',30);asks.defer(['a'],'thr_cap',1000,40);
  const before=JSON.stringify({card:asks.get('a'),jobs:asks.pendingFollowUps(),answer:raw.prepare('SELECT * FROM owner_ask_answer').all()});
  assert.equal(asks.resolve('a','thr_cap','answered','Approve',50,'owner',tap),undefined);
  assert.equal(JSON.stringify({card:asks.get('a'),jobs:asks.pendingFollowUps(),answer:raw.prepare('SELECT * FROM owner_ask_answer').all()}),before);
 }finally{raw.close();}
});
