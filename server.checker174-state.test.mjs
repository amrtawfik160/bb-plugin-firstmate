// Checker round 1 for PR #174 (findings 2, 4, 5, 7, 11): restart, retry cleanup, kept-unsaved, adopted drop,
// failed expiry and real-Git fold probes. Each defect assertion now states the safe outcome.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkstreams } from './lib/workstreams.ts';
import { seedLegacyWorkstream } from './test/legacy-workstream.mjs';
import { foldScript, rollbackFoldScript } from './lib/workstream-runtime.ts';
import { FAILED_KEEP_MS, crewOwnTestsPassed, parseFoldOutput } from './lib/workstream-fold.ts';
function fixture(){
 const db=new DatabaseSync(':memory:');let now=100;const statuses=new Map(),archived=[],tells=[];let folds=0,restarts=0;
 const deps={now:()=>now,provision:async()=>[{repository:'o/r',projectId:'p',hostId:'h',path:'/fixture/ws',sourcePath:'/fixture/source',branch:'workstream/ws',environmentId:null}],start:async(w,j)=>{statuses.set(j.id,'active');return j.id},status:async id=>statuses.get(id)??'unknown',startDev:async()=>'',stopDev:async()=>{},unsaved:async()=>[],remove:async()=>{},ship:async()=>{},taskState:()=> 'working',report:async()=> 'Tests passed',fold:async()=>{folds++;return {ok:true,conflict:false,files:['package.json']}},unsavedJob:async()=>[],archive:async(w,j)=>{archived.push({id:j.id,environmentId:j.environmentId})},deleteBranch:async()=>{},tell:async(w,j)=>tells.push(j.id),restartDev:async()=>{restarts++}};
 const store=createWorkstreams(db,deps);return {db,deps,store,statuses,archived,tells,time:t=>now=t,folds:()=>folds,restarts:()=>restarts,create:()=>store.create({threadId:'cap',projectId:'p',name:'Test',requestId:'create'})};
}
test('a restart after persisting folding recovers the fold, and Ship then runs', async () => {
 const f=fixture(),w=await f.create();await f.store.submit(w.id,'cap',{id:'one',editing:true,payload:'{}'});f.store.noteJob(w.id,'cap','one',{state:'folding'});
 const reloaded=createWorkstreams(f.db,f.deps);await reloaded.reconcile();const shipped=await reloaded.ship(w.id,'cap','ship');await reloaded.reconcile();
 assert.equal(reloaded.get(w.id,'cap').jobs[0].state,'folded');assert.equal(shipped.ship.state,'complete');assert.equal(f.folds(),1);
 f.db.close();
});
test('a retry in a failed crew\'s worktree supersedes the old crew\'s expiry', async () => {
 const f=fixture(),w=await f.create();await f.store.submit(w.id,'cap',{id:'old',editing:true,payload:'{}',environmentId:'env-retry'});f.statuses.set('old','error');await f.store.reconcile();
 await f.store.submit(w.id,'cap',{id:'retry',editing:true,payload:'{}',environmentId:'env-retry'});f.time(100+FAILED_KEEP_MS);await f.store.reconcile();
 assert.equal(f.store.get(w.id,'cap').jobs[1].state,'running');assert.deepEqual(f.archived,[]);
 f.db.close();
});
test('a fold kept for unsaved work restarts the dev link and is cleaned once the work is saved', async () => {
 const f=fixture(),w=await f.create();await f.store.devLink(w.id,'cap');await f.store.submit(w.id,'cap',{id:'one',editing:true,payload:'{}'});f.deps.unsavedJob=async()=>['1 uncommitted file(s)'];f.statuses.set('one','idle');await f.store.reconcile();f.deps.unsavedJob=async()=>[];await f.store.reconcile();
 assert.equal(f.store.get(w.id,'cap').jobs[0].state,'folded');assert.equal(f.restarts(),1);assert.equal(f.archived.length,1);
 f.db.close();
});
test('an adopted task drop keeps the old cleanup path: nothing is archived', async () => {
 const f=fixture();const w=seedLegacyWorkstream(f.db,{projectId:'p',name:'Adopt',requestId:'adopt',taskIds:['T1'],repos:[{repository:'o/r',projectId:'p',hostId:'h',path:'/fixture/existing',sourcePath:'/fixture/source',branch:'fm/existing',environmentId:'env-existing',existing:true}]});
 await f.store.submit(w.id,'cap',{id:'one',editing:true,payload:'{}',taskId:'T1',environmentId:'env-existing'});f.deps.taskState=()=> 'dropped';await f.store.reconcile();assert.equal(f.archived.length,0);
 f.db.close();
});
test('a failed crew archived after 7 days is not checked again as unsaved', async () => {
 const f=fixture(),w=await f.create();let present=true;f.deps.archive=async()=>{present=false};f.deps.unsavedJob=async()=>present?[]:['worktree unreadable'];await f.store.submit(w.id,'cap',{id:'expired',editing:true,payload:'{}'});f.statuses.set('expired','error');await f.store.reconcile();f.time(100+FAILED_KEEP_MS);await f.store.reconcile();assert.equal(f.store.get(w.id,'cap').jobs[0].note,'archived after 7 days');assert.equal(f.store.get(w.id,'cap').jobs[0].state,'failed');await f.store.reconcile();assert.equal(f.store.get(w.id,'cap').jobs[0].state,'failed');
 f.db.close();
});
test('report parser: an earlier positive phrase still passes (non-blocking follow-up, unchanged)', () => {
 assert.equal(crewOwnTestsPassed('Unit tests passed. Integration: FAIL. Deployment blocked.'),true);
});
test('real Git: dev output does not block a fold, an undo keeps dev writes, and concurrent folds serialize', async () => {
 const root=mkdtempSync(join(tmpdir(),'b174-real-git-')),source=root+'/source',ws=root+'/ws',crew=root+'/crew';
 try {
  const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  execFileSync('git',['init','-qb','main',source]);git(source,'config','user.name','fixture');git(source,'config','user.email','fixture@example.test');
  writeFileSync(source+'/base','base');git(source,'add','.');git(source,'commit','-qm','base');git(source,'worktree','add','-b','workstream/ws',ws);
  git(ws,'worktree','add','-q','-b','task/one',crew,'HEAD');writeFileSync(crew+'/feature','feature');git(crew,'add','.');git(crew,'commit','-qm','feature');
  const before=git(ws,'rev-parse','HEAD');writeFileSync(ws+'/generated-dev-file','dev output');
  let error;try{execFileSync('bash',['-c',foldScript(ws,crew,'workstream/ws')],{stdio:'pipe'});}catch(e){error=e}
  assert.equal(error,undefined);assert.notEqual(git(ws,'rev-parse','HEAD'),before);assert.equal(readFileSync(ws+'/generated-dev-file','utf8'),'dev output');assert.equal(existsSync(ws+'/feature'),true);
  execFileSync('bash',['-c',rollbackFoldScript(ws)],{stdio:'pipe'});
  execFileSync('git',['-C',ws,'clean','-f'],{stdio:'pipe'});execFileSync('bash',['-c',foldScript(ws,crew,'workstream/ws')],{stdio:'pipe'});assert.equal(existsSync(ws+'/feature'),true);execFileSync('bash',['-c',rollbackFoldScript(ws)],{stdio:'pipe'});assert.equal(git(ws,'rev-parse','HEAD'),before);assert.equal(existsSync(ws+'/feature'),false);
  execFileSync('bash',['-c',foldScript(ws,crew,'workstream/ws')],{stdio:'pipe'});writeFileSync(ws+'/base','dev-server write during multi-repo fold');execFileSync('bash',['-c',rollbackFoldScript(ws)],{stdio:'pipe'});assert.equal(readFileSync(ws+'/base','utf8'),'dev-server write during multi-repo fold');
  // Concurrent reconciliations, each with real Git folds, must serialize.
  const crew2=root+'/crew2';git(ws,'worktree','add','-q','-b','task/two',crew2,'HEAD');writeFileSync(crew2+'/feature-two','feature-two');git(crew2,'add','.');git(crew2,'commit','-qm','feature two');
  const f=fixture();f.deps.provision=async()=>[{repository:'o/r',projectId:'p',hostId:'h',path:ws,sourcePath:source,branch:'workstream/ws',environmentId:null}];let active=0,maxActive=0;
  f.deps.fold=async(w,j)=>{active++;maxActive=Math.max(maxActive,active);try{const output=await new Promise((resolve,reject)=>execFile('bash',['-c',foldScript(ws,j.path,'workstream/ws')],{encoding:'utf8'},(err,stdout)=>err?reject(err):resolve(stdout)));return parseFoldOutput(output)}finally{active--}};
  const w=await f.create();await f.store.submit(w.id,'cap',{id:'one',editing:true,payload:'{}',path:crew});await f.store.submit(w.id,'cap',{id:'two',editing:true,payload:'{}',path:crew2});f.statuses.set('one','idle');f.statuses.set('two','idle');await Promise.all([f.store.reconcile(),f.store.reconcile()]);assert.equal(maxActive,1);assert.ok(f.store.get(w.id,'cap').jobs.every(j=>j.state==='folded'));assert.equal(readFileSync(ws+'/feature','utf8'),'feature');assert.equal(readFileSync(ws+'/feature-two','utf8'),'feature-two');f.db.close();
 } finally { rmSync(root,{recursive:true,force:true}); }
});
