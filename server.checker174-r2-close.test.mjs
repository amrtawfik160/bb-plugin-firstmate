// Checker round 2 for PR #174 (finding 3). The defect assertion states the safe outcome.
import assert from 'node:assert/strict';import test from 'node:test';import{DatabaseSync}from'node:sqlite';import{createWorkstreams}from'./lib/workstreams.ts';
test('round2 legacy main record: a finished editing job closes under its old rule, so End works',async()=>{
 const db=new DatabaseSync(':memory:');try{const deps={now:()=>100,provision:async()=>[{repository:'o/r',projectId:'p',hostId:'h',path:'/fixture/ws',sourcePath:'/fixture/main',branch:'workstream/ws',environmentId:null}],start:async()=>'',status:async()=> 'idle',startDev:async()=>'',stopDev:async()=>{},unsaved:async()=>[],remove:async()=>{},ship:async()=>{},taskState:()=> 'live',busy:async()=>false};const store=createWorkstreams(db,deps);const w=await store.create({threadId:'cap',projectId:'p',name:'Before upgrade',requestId:'create'});
 w.taskIds=['T1'];w.jobs=[{id:'legacy-finished',editing:true,payload:'{}',state:'finished',threadId:'old-thread'}];db.prepare('UPDATE firstmate_workstream SET record=? WHERE id=?').run(JSON.stringify(w),w.id);
 assert.equal((await store.end(w.id,'cap')).state,'ended');await store.reconcile();assert.equal(store.get(w.id,'cap').state,'ended');
 }finally{db.close()}
});
