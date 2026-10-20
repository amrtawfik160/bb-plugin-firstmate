import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createOwnerAsks } from './lib/owner-asks.ts';
import { createOwnerGate, approvalFor } from './lib/owner-gate.ts';
import { createProductionApprovals } from './lib/production-approval.ts';
import { createOwnerAsks as oldCreateOwnerAsks } from './test/fixtures/owner-asks-pre-stamp.ts';
import { approvalConnectorSkip, APPROVAL_CONNECTOR_SKIP, testEvidenceDir } from './test/approval-telegram-checkout.ts';

const evidence='/root/.local/share/hanoon-telegram-plan/170-check-10/';
function adapt(raw, before=()=>{}) {
 return {exec(sql){before(sql);return raw.exec(sql);},prepare(sql){return raw.prepare(sql);},transaction(fn){return ()=>{raw.exec('BEGIN');try{const out=fn();raw.exec('COMMIT');return out;}catch(error){raw.exec('ROLLBACK');throw error;}};}};
}
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'r10-upgrade-')),file=join(dir,'test.db'),raw=new DatabaseSync(file),old=oldCreateOwnerAsks(adapt(raw));
 for(const id of ['old','late'])old.create({id,captain:'thr_cap',kind:'approval',text:'Merge?',options:[{label:'Approve'},{label:'No'}],createdAt:1});
 old.resolve('old','thr_cap','answered','Approve',2,'owner');
 return {dir,file,raw,old,dispose(){raw.close();rmSync(dir,{recursive:true,force:true});}};
}
async function until(check,timeout=15000){const deadline=Date.now()+timeout;while(!check()){if(Date.now()>=deadline)throw new Error('timed out waiting for migration child');await new Promise(r=>setTimeout(r,10));}}

test('R10 killed upgrade rolls back legacy update and blocks concurrent writers before commit',async()=>{
 const f=fixture();let child,exited;try{
  const signal=join(f.dir,'legacy-update-complete');
  const code=`import {DatabaseSync} from 'node:sqlite';import {writeFileSync} from 'node:fs';const {createOwnerAsks}=await import(${JSON.stringify(new URL('./lib/owner-asks.ts',import.meta.url).href)});const raw=new DatabaseSync(process.argv[1]);const db={exec(sql){raw.exec(sql);if(sql.includes("SET tap_id = CASE")){writeFileSync(process.argv[2],'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}},prepare(sql){return raw.prepare(sql);},transaction(fn){return ()=>fn();}};createOwnerAsks(db);`;
  child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code,f.file,signal],{stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',v=>{errors+=v;});exited=new Promise(resolve=>child.once('exit',resolve));
  await until(()=>existsSync(signal)||child.exitCode!==null);assert.ok(existsSync(signal),errors);
  assert.equal(f.raw.prepare('SELECT tap_id FROM owner_ask_answer WHERE id=?').get('old').tap_id,null);
  assert.equal(f.raw.prepare('SELECT v FROM owner_ask_stamp_migrated WHERE v=1').get(),undefined);
  assert.throws(()=>f.old.resolve('late','thr_cap','answered','Approve',20,'owner'),/locked|busy/i);
  child.kill('SIGKILL');await exited;
  assert.equal(f.raw.prepare('SELECT tap_id FROM owner_ask_answer WHERE id=?').get('old').tap_id,null);
  assert.equal(f.raw.prepare('SELECT v FROM owner_ask_stamp_migrated WHERE v=1').get(),undefined);
  createOwnerAsks(adapt(f.raw));assert.equal(f.raw.prepare('SELECT tap_id FROM owner_ask_answer WHERE id=?').get('old').tap_id,'legacy:old');
  f.old.resolve('late','thr_cap','answered','Approve',20,'owner');createOwnerAsks(adapt(f.raw));
  const rows=f.raw.prepare('SELECT id,tap_id FROM owner_ask_answer ORDER BY id').all();assert.equal(rows.find(r=>r.id==='late').tap_id,null);
  writeFileSync(evidence+'170-real-interruption-10.json',JSON.stringify({concurrentWriterBlocked:true,uncommittedChangesInvisible:true,rows},null,2));
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}f.dispose();}
});

test('R10 marker insert error rolls back legacy marking and permits a later startup retry',()=>{
 const f=fixture();try{
  assert.throws(()=>createOwnerAsks(adapt(f.raw,sql=>{if(sql.includes('INSERT INTO owner_ask_stamp_migrated'))throw new Error('injected marker insert failure');})),/injected marker insert failure/);
  assert.equal(f.raw.prepare('SELECT v FROM owner_ask_stamp_migrated WHERE v=1').get(),undefined);
  assert.equal(f.raw.prepare('SELECT tap_id FROM owner_ask_answer WHERE id=?').get('old').tap_id,null);
  createOwnerAsks(adapt(f.raw));assert.equal(f.raw.prepare('SELECT tap_id FROM owner_ask_answer WHERE id=?').get('old').tap_id,'legacy:old');
 }finally{f.dispose();}
});

test('R10 unset connector setting gives a clear skip and default evidence stays in test temp',()=>{
 const prior=process.env.APPROVAL_TELEGRAM_CHECKOUT,priorEvidence=process.env.FM_TEST_EVIDENCE_DIR;
 try{delete process.env.APPROVAL_TELEGRAM_CHECKOUT;delete process.env.FM_TEST_EVIDENCE_DIR;assert.equal(approvalConnectorSkip(),APPROVAL_CONNECTOR_SKIP);const dir=testEvidenceDir();assert.ok(dir.startsWith(tmpdir()+'/'));writeFileSync(join(dir,'test.json'),'{}');assert.ok(existsSync(join(dir,'test.json')));}
 finally{if(prior===undefined)delete process.env.APPROVAL_TELEGRAM_CHECKOUT;else process.env.APPROVAL_TELEGRAM_CHECKOUT=prior;if(priorEvidence===undefined)delete process.env.FM_TEST_EVIDENCE_DIR;else process.env.FM_TEST_EVIDENCE_DIR=priorEvidence;}
});

test('R10 NON-BLOCKING synthetic legacy UPDATE exception should propagate and roll back',()=>{
 const f=fixture();try{
  const db=adapt(f.raw,sql=>{if(sql.includes('SET tap_id = CASE'))throw new Error('injected update exception');});
  let error;try{createOwnerAsks(db);}catch(e){error=e;}
  const marker=f.raw.prepare('SELECT v FROM owner_ask_stamp_migrated WHERE v=1').get();const row=f.raw.prepare('SELECT tap_id FROM owner_ask_answer WHERE id=?').get('old');
  writeFileSync(evidence+'170-synthetic-update-error-10.json',JSON.stringify({error:error?String(error):null,marker:marker??null,row},null,2));
  assert.match(String(error),/injected update exception/);assert.equal(marker,undefined);
 }finally{f.dispose();}
});

test('R10 storage-full migration must not persist its marker after SQLite rolls back',()=>{
 const f=fixture();try{
  // A bounded database exercises SQLite's actual SQLITE_FULL rollback, as a full disk does.
  f.raw.exec('BEGIN');
  const ask=f.raw.prepare("INSERT INTO owner_ask VALUES (?, 'thr_cap', 'approval', 'Merge?', '[]', NULL, NULL, 0, 'answered', 'Approve', 1, 2)");
  const answer=f.raw.prepare("INSERT INTO owner_ask_answer(id,source,resolution,at,tap_id) VALUES (?, 'owner', 'Approve', 2, NULL)");
  for(let i=0;i<3000;i++){const id='a'+String(i).padStart(6,'0');ask.run(id);answer.run(id);}f.raw.exec('COMMIT');
  createProductionApprovals(adapt(f.raw)).bindCard('old',[{pr:'cyndra-ai/cyndra-saas#2391',head:'a'.repeat(40)}]);
  f.raw.exec('CREATE TABLE IF NOT EXISTS owner_ask_stamp_migrated(v INTEGER PRIMARY KEY)');
  const pages=f.raw.prepare('PRAGMA page_count').get().page_count;f.raw.exec('PRAGMA max_page_count='+pages);
  const base=adapt(f.raw),errors=[];
  const db={...base,exec(sql){try{return base.exec(sql);}catch(error){errors.push({legacyUpdate:sql.includes('SET tap_id = CASE'),code:error.code,errcode:error.errcode,message:String(error)});throw error;}}};
  let startupError;try{createOwnerAsks(db);}catch(error){startupError=String(error);}
  const marker=f.raw.prepare('SELECT v FROM owner_ask_stamp_migrated WHERE v=1').get();
  const beforeRetry=f.raw.prepare('SELECT tap_id FROM owner_ask_answer WHERE id=?').get('old');
  f.raw.exec('PRAGMA max_page_count='+(pages+1000));createOwnerAsks(adapt(f.raw));
  const afterRetry=f.raw.prepare('SELECT tap_id FROM owner_ask_answer WHERE id=?').get('old');
  const cards=createOwnerGate(adapt(f.raw)).cardsForPr('cyndra-ai/cyndra-saas#2391');
  const decision=approvalFor({pr:'cyndra-ai/cyndra-saas#2391',head:'a'.repeat(40),action:'merge',cards,coverage:()=> 'covers',preApprovals:[]});
  writeFileSync(evidence+'170-storage-full-10.json',JSON.stringify({pages,errors,startupError,marker:marker??null,beforeRetry,afterRetry,cards,decision},null,2));
  assert.ok(errors.some(e=>e.legacyUpdate&&/full/i.test(e.message)),'fixture must hit real SQLite storage exhaustion in the legacy update');
  assert.equal(marker,undefined,'SQLITE_FULL rolled back the transaction, but the swallowed error let the marker commit alone');
  assert.equal(afterRetry.tap_id,'legacy:old','a restart after storage becomes available must preserve the old owner permission');
 }finally{f.dispose();}
});
