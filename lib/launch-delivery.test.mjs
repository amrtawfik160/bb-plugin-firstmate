import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLaunches,launchKey,launchTaskKey,discoverLaunch } from './launch.ts';
import { createDeliveries,parseForge } from './pr-delivery.ts';
import { selectExecution,validateLaunchCapabilities } from './execution-selection.ts';
const launch=(task='task')=>({ key:launchKey('project','manager','/home',task),taskId:task,projectId:'project',owner:'manager',home:'/home',generation:1,shape:'ship',state:'reserved',threadId:null,updatedAt:1 });
const observation=(patch={})=>({ headSha:'sha1',state:'open',draft:false,checks:'passing',review:'approved',reviewHeadSha:'sha1',mergeCommitSha:'sha-merged',mergeable:'mergeable',...patch });
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'fm-delivery-regression-'));
 let db=new Database(join(dir,'state.db'));
 return { get db(){ return db; },reopen(){ db.close(); db=new Database(join(dir,'state.db'));return db; },close(){ db.close();rmSync(dir,{recursive:true,force:true}); } };
}
const register=s=>s.register({ url:'https://github.com/acme/repo/pull/7',taskId:'task',projectId:'project',owner:'manager',home:'/home',worker:'worker' });
test('launch capacity atomically reserves one slot for two concurrent dispatches and same-task retries',async()=>{
 const f=fixture();try { const s=createLaunches(f.db);const capacity=async()=>({cap:5,activeTaskIds:['a','b','c','d']});
 const results=await Promise.allSettled([s.reserve(launch('e'),capacity),s.reserve(launch('f'),capacity)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const record=results.find(r=>r.status==='fulfilled').value;
 assert.equal((await s.reserve(record,capacity)).key,record.key);
 assert.equal(createLaunches(f.reopen()).list('manager').length,1);
 }finally{f.close();}
});
test('creation persists before spawn; a lost response holds its slot across a process restart',async()=>{
 const f=fixture();try { let s=createLaunches(f.db);await s.reserve(launch(),async()=>({cap:1,activeTaskIds:[]}));
 await assert.rejects(s.create(launch().key,async()=>{assert.equal(s.get(launch().key).state,'creating');throw new Error('lost response');}));
 s=createLaunches(f.reopen());assert.equal(s.get(launch().key).state,'uncertain');
 let spawned=0;await assert.rejects(s.create(launch().key,async()=>{spawned++;return{id:'duplicate'};}),/uncertain/);assert.equal(spawned,0);
 await assert.rejects(s.reserve(launch('other'),async()=>({cap:1,activeTaskIds:[]})),/cap reached/);
 // A separate Node process sees exactly the same durable reservation.
 const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`import Database from 'better-sqlite3';import {createLaunches} from './lib/launch.ts';const db=new Database(${JSON.stringify(join(f.db.name.split('/').slice(0,-1).join('/'),'state.db'))});process.stdout.write(createLaunches(db).list('manager')[0].state);db.close();`],{encoding:'utf8',cwd:process.cwd()});
 assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'uncertain');
 }finally{f.close();}
});
test('spawn identity write fault is recoverable and cancellation before create has no side effects',async()=>{
 const f=fixture();try {const s=createLaunches(f.db);await s.reserve(launch(),async()=>({cap:5,activeTaskIds:[]}));
 const aborted=new AbortController();aborted.abort();let spawned=0;
 await assert.rejects(s.create(launch().key,async()=>{spawned++;return{id:'worker'};},aborted.signal));assert.equal(spawned,0);
 f.db.exec("CREATE TRIGGER fail_identity BEFORE UPDATE ON launches WHEN json_extract(NEW.record,'$.threadId') IS NOT NULL BEGIN SELECT RAISE(ABORT,'fault'); END");
 await assert.rejects(s.create(launch().key,async()=>{spawned++;return{id:'worker'};}));
 assert.equal(spawned,1);assert.equal(s.get(launch().key).state,'uncertain');
 f.db.exec('DROP TRIGGER fail_identity');s.update(launch().key,{threadId:'worker',state:'provisioning'});
 assert.equal((await s.create(launch().key,async()=>{throw new Error('duplicate');})).threadId,'worker');
 }finally{f.close();}
});
test('bounded recovery matches exact metadata and project/manager scope beyond first page',async()=>{
 let lists=[];const r=launch();const bb={sdk:{threads:{ list:async args=>{lists.push(args);return args.offset===0?Array.from({length:50},(_,i)=>({id:`other${i}`})):[{id:'worker'}];},getPluginMetadata:async({threadId})=>threadId==='worker'?{launchKey:r.key,generation:1,nativeHome:'/home'}:{launchKey:'foreign'} }}};
 assert.equal(await discoverLaunch(bb,r),'worker');assert.equal(lists.length,2);assert.equal(lists[0].projectId,'project');assert.equal(lists[0].parentThreadId,'manager');
});
test('coherent checkout selection refuses a path on the wrong host and capabilities refuse before launch',async()=>{
 const bb={sdk:{environments:{list:async()=>[{id:'a',hostId:'A',status:'ready',isWorktree:false,path:'/host-a'}]},projects:{get:async()=>({sources:[]})}}};
 await assert.rejects(selectExecution(bb,'project','B'),/No matching/);
 assert.equal((await selectExecution(bb,'project','A')).checkout,'/host-a');
 assert.throws(()=>validateLaunchCapabilities({transport:'real',shape:'ship',worktree:false}),/isolation/);
 assert.throws(()=>validateLaunchCapabilities({transport:'real',shape:'scout',worktree:true,sendAt:0}),/unsupported/);
});
test('PR completion is separate from worker and wake retention, with durable checks/review transitions',async()=>{
 const f=fixture();try {let s=createDeliveries(f.db);const r=register(s);
 s.observe(r.id,observation({checks:'pending'}),false,1);
 assert.equal(s.get(r.id).status,'waiting-checks');assert.equal(s.get(r.id).workers[0],'worker');
 // Worker finishes, is archived/forgotten, and the manager compacts/restarts.
 s=createDeliveries(f.reopen());assert.equal(s.list({owner:'manager'})[0].id,r.id);
 s.observe(r.id,observation(),false,2);assert.equal(s.get(r.id).status,'waiting-approval');
 let wakes=0;assert.equal(await s.notify(r.id,async()=>{wakes++;return true;},3),true);
 assert.equal(s.list({owner:'manager'}).length,1,'acknowledged wake does not clear an open PR');
 s=createDeliveries(f.reopen());s.observe(r.id,observation(),false,4);await s.notify(r.id,async()=>{wakes++;return true;},5);assert.equal(wakes,1);
 s.observe(r.id,observation({checks:'failing'}),false,6);assert.equal(s.get(r.id).status,'failing-checks');
 s.observe(r.id,observation({review:'changes-requested'}),false,7);assert.equal(s.get(r.id).status,'changes-requested');
 s.observe(r.id,observation(),true,8);assert.equal(s.get(r.id).status,'ready-to-merge');
 s.observe(r.id,observation({headSha:'sha2'}),true,9);assert.equal(s.get(r.id).status,'waiting-checks');
 s.observe(r.id,observation({headSha:'sha2'}),true,10);assert.equal(s.get(r.id).status,'waiting-review','old approval cannot establish current-head readiness');
 s.observe(r.id,observation({headSha:'sha2',reviewHeadSha:'sha2'}),true,11);assert.equal(s.get(r.id).status,'ready-to-merge');
 }finally{f.close();}
});
test('forge failure is stale last-known state, closed-unmerged requires disposition, abandonment requires owner/reason',()=>{
 const f=fixture();try {const s=createDeliveries(f.db);const r=register(s);s.observe(r.id,observation(),false,1);s.observe(r.id,observation(),false,2);
 const stale=s.stale(r.id,'forge unavailable',3);assert.equal(stale.status,'waiting-approval');assert.equal(stale.freshness,'stale');assert.equal(stale.observedAt,2);
 s.observe(r.id,observation({state:'closed'}),false,4);assert.equal(s.get(r.id).status,'closed-needs-disposition');
 assert.throws(()=>s.abandon(r.id,'foreign','reason'),/owning/);assert.throws(()=>s.abandon(r.id,'manager',''),/reason/);
 s.abandon(r.id,'manager','User explicitly cancelled the task');assert.equal(s.list().length,0);assert.equal(s.get(r.id).disposition.actor,'manager');
 }finally{f.close();}
});
test('handoff/lost manager preserves owner-needed obligation and refuses project/owner takeover',()=>{
 const f=fixture();try {const s=createDeliveries(f.db);const r=register(s);s.ownerLost('manager');assert.equal(s.get(r.id).ownerNeeded,true);
 assert.equal(s.list({owner:'foreign'}).length,0);assert.equal(s.list({projectId:'other'}).length,0);
 assert.throws(()=>s.assign(r.id,'manager','new','other'),/mismatch/);
 s.assign(r.id,'manager','new','project');assert.equal(s.list({owner:'new'})[0].ownerNeeded,false);
 assert.throws(()=>s.register({url:r.url,taskId:'foreign',projectId:'project',owner:'foreign',home:'/home',worker:'other'}),/another task/);
 }finally{f.close();}
});
test('merged verification follows only the agreed contract and validates head plus evidence',()=>{
 const f=fixture();try {const s=createDeliveries(f.db);const r=s.register({url:'https://github.com/acme/repo/pull/7',taskId:'task',projectId:'project',owner:'manager',home:'/home',worker:'worker',requirement:'merged-and-verified'});
 s.observe(r.id,observation({state:'merged'}),false,1);assert.equal(s.get(r.id).status,'merged-needs-verification');
 assert.throws(()=>s.verify(r.id,'manager','old','passed'),/Verification/);assert.throws(()=>s.verify(r.id,'manager','sha-merged',''),/Verification/);
 s.verify(r.id,'manager','sha-merged','Required smoke check passed on sha-merged');assert.equal(s.get(r.id).status,'complete');
 const pr=s.register({url:'https://github.com/acme/repo/pull/8',taskId:'pr-only',projectId:'project',owner:'manager',home:'/home',worker:'worker',requirement:'pr'});
 assert.equal(s.observe(pr.id,observation(),false,2).status,'pr-delivered');
 }finally{f.close();}
});
test('duplicate events and failed notifications survive restart without losing retry or spamming successful delivery',async()=>{
 const f=fixture();try {let s=createDeliveries(f.db);const r=register(s);s.observe(r.id,observation({checks:'failing'}),false,1);
 assert.equal(await s.notify(r.id,async()=>false,2),false);s=createDeliveries(f.reopen());
 let sends=0;await s.notify(r.id,async()=>{sends++;return true;},60_003);s=createDeliveries(f.reopen());
 await s.notify(r.id,async()=>{sends++;return true;},60_004);assert.equal(sends,1);assert.equal(s.list().length,1);
 }finally{f.close();}
});
test('notification acceptance/write crash reconciles its identity before repeating an external send',async()=>{
 const f=fixture();try {let s=createDeliveries(f.db);const r=register(s);s.observe(r.id,observation({checks:'failing'}),false,1);
 f.db.exec("CREATE TRIGGER fail_delivery BEFORE UPDATE ON deliveries WHEN json_extract(NEW.record,'$.notification.delivered') IS NOT NULL BEGIN SELECT RAISE(ABORT,'fault'); END");
 let sends=0;await s.notify(r.id,async()=>{sends++;return true;},2);
 f.db.exec('DROP TRIGGER fail_delivery');s=createDeliveries(f.reopen());
 await s.notify(r.id,async()=>{sends++;return true;},60_003,async()=> 'accepted');assert.equal(sends,1);
 assert.equal(s.get(r.id).notification.delivered,s.get(r.id).notification.desired);
 }finally{f.close();}
});
test('record storage scales beyond one KV value and forge parser never guesses readiness',()=>{
 const f=fixture();try {const s=createDeliveries(f.db);for(let n=1;n<=1000;n++)s.register({url:`https://github.com/acme/repo/pull/${n}`,taskId:`task-${n}`,projectId:'project',owner:'manager',home:'/home',worker:`worker-${n}`});
 assert.equal(s.list({limit:100}).length,100);assert.equal(s.list({limit:100,offset:900}).length,100);
 const parsed=parseForge({headRefOid:'sha',state:'OPEN',statusCheckRollup:[{status:'IN_PROGRESS',conclusion:''}],reviewDecision:'',mergeable:'UNKNOWN'});
 assert.equal(parsed.checks,'pending');assert.equal(parsed.review,'unknown');assert.equal(parsed.mergeable,'unknown');
 }finally{f.close();}
});
test('cancellation during create retains capacity, captures a late identity and recovers after restart',async()=>{
 const f=fixture();try {let s=createLaunches(f.db);await s.reserve(launch(),async()=>({cap:1,activeTaskIds:[]}));
 let resolveSpawn;const abort=new AbortController();const pending=s.create(launch().key,()=>new Promise(resolve=>{resolveSpawn=resolve;}),abort.signal);
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(s.get(launch().key).state,'creating');abort.abort();
 await assert.rejects(pending,/uncertain/);assert.equal(s.get(launch().key).state,'uncertain');
 await assert.rejects(s.reserve(launch('another'),async()=>({cap:1,activeTaskIds:[]})),/cap reached/);
 resolveSpawn({id:'slow-real-worker'});await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(s.get(launch().key).threadId,'slow-real-worker');s=createLaunches(f.reopen());
 assert.equal((await s.create(launch().key,async()=>{throw new Error('duplicate');})).threadId,'slow-real-worker');
 }finally{f.close();}
});
test('recovery detects duplicate launch identities across pages instead of adopting the first',async()=>{
 const r=launch();const bb={sdk:{threads:{ list:async args=>args.offset===0?Array.from({length:50},(_,i)=>({id:i===0?'worker1':`other${i}`})):[{id:'worker2'}],getPluginMetadata:async({threadId})=>threadId.startsWith('worker')?{launchKey:r.key,generation:1,nativeHome:r.home}:{} }}};
 await assert.rejects(discoverLaunch(bb,r),/Multiple workers/);
});
test('creation deadline retains uncertainty and two overlapping stores cannot duplicate the external call',async()=>{
 const f=fixture();try {const a=createLaunches(f.db),b=createLaunches(f.db);await a.reserve(launch(),async()=>({cap:1,activeTaskIds:[]}));
 let resolveSpawn;const request=a.create(launch().key,()=>new Promise(resolve=>{resolveSpawn=resolve;}),undefined,15);
 await assert.rejects(b.create(launch().key,async()=>{throw new Error('duplicate call');}),/uncertain|reconciliation/);
 await assert.rejects(request,/deadline.*uncertain/);assert.equal(a.get(launch().key).state,'uncertain');resolveSpawn({id:'created-after-timeout'});
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(a.get(launch().key).threadId,'created-after-timeout');
 }finally{f.close();}
});
test('cancelling a blocked inventory lookup preserves recoverability without waiting for core',async()=>{
 const abort=new AbortController();const bb={sdk:{threads:{list:()=>new Promise(()=>{})}}};
 const lookup=discoverLaunch(bb,launch(),abort.signal);abort.abort();await assert.rejects(lookup);
});
test('current-head and completion notifications cancel obsolete actions and retain one completion notice',async()=>{
 const f=fixture();try {const s=createDeliveries(f.db);const r=register(s);
 s.observe(r.id,observation(),true,1);s.observe(r.id,observation(),true,2);
 const priorSignature=s.get(r.id).notification.desired;assert.ok(priorSignature);
 s.observe(r.id,observation({headSha:'new'}),true,3);
 assert.equal(s.get(r.id).notification.desired,null);assert.equal(s.markQueued(r.id,'manager',priorSignature),false);
 s.observe(r.id,observation({state:'merged',headSha:'new'}),true,4);
 const signature=s.get(r.id).notification.desired;assert.ok(signature);
 let sends=0;await s.notify(r.id,async record=>{assert.equal(s.markQueued(record.id,'manager',signature),true);sends++;return true;},5);
 await s.notify(r.id,async()=>{sends++;return true;},6);assert.equal(sends,1);
 }finally{f.close();}
});
test('notification reconciliation and send callbacks cannot overwrite handoff or completed verification',async()=>{
 const f=fixture();try {const s=createDeliveries(f.db);const r=register(s);
 s.observe(r.id,observation({checks:'failing'}),false,1);
 let release;const pending=s.notify(r.id,()=>new Promise(resolve=>{release=resolve;}),2);
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(s.transferOwner('manager','new','project'),1);
 release(true);assert.equal(await pending,false);assert.equal(s.get(r.id).owner,'new');assert.equal(s.get(r.id).notification.delivered,null);
 const verified=s.register({url:'https://github.com/acme/repo/pull/8',taskId:'verify',projectId:'project',owner:'manager',home:'/home',worker:'worker',requirement:'merged-and-verified'});
 s.observe(verified.id,observation({state:'merged'}),false,1);await s.notify(verified.id,async()=>{throw new Error('unknown RPC result');},2);
 const reconciling=s.notify(verified.id,async()=>{throw new Error('obsolete action');},60_003,()=>new Promise(resolve=>{release=resolve;}));
 await new Promise(resolve=>setTimeout(resolve,0));s.verify(verified.id,'manager','sha-merged','Required verification passed');release('unknown');
 assert.equal(await reconciling,false);assert.equal(s.get(verified.id).status,'complete');assert.equal(s.get(verified.id).notification.desired,null);
 }finally{f.close();}
});
test('ownership conflicts beyond the first page and explicit unassigned recovery stay project scoped',()=>{
 const f=fixture();try {const s=createDeliveries(f.db);
 for(let n=1;n<=150;n++)s.register({url:`https://github.com/acme/repo/pull/${n}`,taskId:`task${n}`,projectId:'project',owner:'foreign',home:'/home',worker:'worker'});
 assert.equal(s.conflict('project','manager',[],[150]).number,150);
 assert.equal(s.hasOwned('foreign','project','task150'),true);assert.equal(s.hasOwned('foreign','other','task150'),false);
 assert.equal(s.conflict('other','manager',[],[150]),undefined);
 const lost=s.register({url:'https://github.com/acme/repo/pull/151',taskId:'lost',projectId:'project',owner:null,home:'/home',worker:'worker'});
 assert.equal(s.conflict('project','manager',[lost.id],[]).owner,null);
 assert.throws(()=>s.assign(lost.id,'foreign','manager','project'),/mismatch/);
 s.assign(lost.id,null,'manager','project');assert.equal(s.get(lost.id).ownerNeeded,false);
 s.abandon('acme/repo#150','foreign','User cancelled');
 assert.equal(s.transferOwner('foreign','manager','project'),149);assert.equal(s.get('acme/repo#150').owner,'foreign');
 }finally{f.close();}
});
test('reservation write failure precedes all external creation and explicit task IDs are project scoped',async()=>{
 const f=fixture();try {const s=createLaunches(f.db);
 f.db.exec("CREATE TRIGGER fail_reservation BEFORE INSERT ON launches BEGIN SELECT RAISE(ABORT,'reservation fault'); END");
 await assert.rejects(s.reserve(launch(),async()=>({cap:1,activeTaskIds:[]})),/reservation fault/);
 let spawned=0;await assert.rejects(s.create(launch().key,async()=>{spawned++;return{id:'worker'};}),/reservation missing/);assert.equal(spawned,0);
 f.db.exec('DROP TRIGGER fail_reservation');
 const other={...launch(),projectId:'other',key:launchKey('other','manager','/home','task')};
 await assert.rejects(s.reserve(other,async()=>({cap:1,activeTaskIds:[launchTaskKey('project','task')]})),/cap reached/);
 }finally{f.close();}
});
test('overdue next action sends one durable reminder after an acknowledged actionable transition',async()=>{
 const f=fixture();try {const s=createDeliveries(f.db);const r=register(s);
 s.observe(r.id,observation(),false,1);s.observe(r.id,observation(),false,2);
 let sends=0;await s.notify(r.id,async()=>{sends++;return true;},3);
 s.observe(r.id,observation(),false,86_400_003);await s.notify(r.id,async()=>{sends++;return true;},86_400_004);
 s.observe(r.id,observation(),false,86_400_005);await s.notify(r.id,async()=>{sends++;return true;},86_400_006);
 assert.equal(sends,2);assert.match(s.get(r.id).notification.desired,/^overdue:/);assert.equal(s.list().length,1);
 }finally{f.close();}
});
test('explicit worker handoff transfers admission accounting while preserving its creation identity',async()=>{
 const f=fixture();try {const s=createLaunches(f.db);await s.reserve(launch(),async()=>({cap:1,activeTaskIds:[]}));
 s.update(launch().key,{state:'provisioning',threadId:'worker'});
 assert.equal(s.reassignWorker('worker','manager','new','other'),0);
 assert.equal(s.reassignWorker('worker','manager','new','project'),1);
 assert.equal(s.get(launch().key).key,launch().key);assert.equal(s.heldTaskIds('manager').length,0);
 assert.equal(s.heldTaskIds('new').length,1);
 await assert.rejects(s.reserve({...launch('other'),owner:'new',key:launchKey('project','new','/home','other')},async()=>({cap:1,activeTaskIds:[]})),/cap reached/);
 }finally{f.close();}
});
test('native review path does not invent external GitHub approval; unknown evidence remains unresolved',()=>{
 const f=fixture();try {const s=createDeliveries(f.db),r=register(s);
  s.observe(r.id,observation({review:'unknown',reviewHeadSha:null}),true,1);
  const next=s.observe(r.id,observation({review:'unknown',reviewHeadSha:null}),true,2);
  assert.equal(next.status,'waiting-native-gates');assert.match(next.blocker,/unknown/);assert.match(next.nextAction,/native guarded merge/);assert.ok(!next.nextAction.includes('Obtain independent review'));
  assert.equal(s.observe(r.id,observation({review:'required',reviewHeadSha:null}),true,3).status,'waiting-review');
  assert.equal(s.observe(r.id,observation({review:'changes-requested'}),true,4).status,'changes-requested');
  assert.equal(s.observe(r.id,observation({review:'unknown',reviewHeadSha:null}),false,5).status,'waiting-approval');
 }finally{f.close();}
});

test('native startup workspace handoff creates no model prompt while explicit cd steering is delivered',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fm-startup-seam-'));
 try {
  const overlay=readFileSync('overlay/firstmate-bb-backend.patch','utf8'),pin=readFileSync('overlay/patch-base.txt','utf8').trim();
  const clone=process.env.FIRSTMATE_TEST_NATIVE ?? '/root/github_projects/firstmate';
  for(const match of overlay.matchAll(/^diff --git a\/(\S+) b\/\S+/gm)) {
   const source=spawnSync('git',['-C',clone,'show',`${pin}:${match[1]}`],{encoding:'utf8'});assert.equal(source.status,0,source.stderr);
   const target=join(dir,match[1]);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,source.stdout);
  }
  const patch=spawnSync('patch',['-p1','--fuzz=0','--batch'],{cwd:dir,input:overlay,encoding:'utf8'});assert.equal(patch.status,0,patch.stdout+patch.stderr);assert.ok(!/offset|fuzz/i.test(patch.stdout));
  const script=readFileSync(join(dir,'bin/fm-spawn.sh'),'utf8');
  const handoff=/spawn_enter_recorded_worktree\(\) \{[\s\S]*?\n\}/.exec(script)[0];
  const proof=spawnSync('bash',['-c',`${handoff}\nKIND=ship BACKEND=bb WT_TARGET=thr_worker WT=/managed\nspawn_send_text_line() { echo MODEL_INPUT; }; spawn_enter_recorded_worktree`],{encoding:'utf8'});
  assert.equal(proof.status,0,proof.stderr);assert.equal(proof.stdout,'');
  const explicit=spawnSync('bash',['-c',`. overlay/bin/backends/bb.sh; fm_backend_bb_send_literal() { printf '%s\\n' "$2"; }; fm_backend_bb_send_text_line thr_worker 'cd -- /requested-path'`],{encoding:'utf8'});
  assert.equal(explicit.status,0,explicit.stderr);assert.equal(explicit.stdout,'cd -- /requested-path\n');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('deletion before a late spawn identity holds unknown capacity then releases only that exact attempt across restart',async()=>{
 const f=fixture();try {
  let store=createLaunches(f.db);const record={...launch(),deliveryRequirement:'merged-and-verified'};const capacity=async()=>({cap:1,activeTaskIds:[]});
  await store.reserve(record,capacity);let resolve;
  const creating=store.create(record.key,()=>new Promise(r=>{resolve=r;}));
  store.workerDeleted('late-worker');store.workerDeleted('unrelated-worker');
  assert.equal(store.get(record.key).state,'creating');await assert.rejects(store.reserve(launch('other'),capacity),/cap reached/);
  resolve({id:'late-worker'});await assert.rejects(creating,/deleted by BB core/);
  store=createLaunches(f.reopen());assert.equal(store.get(record.key).state,'deleted');assert.equal(store.get(record.key).threadId,'late-worker');assert.equal(store.get(record.key).deliveryRequirement,'merged-and-verified');
  await store.reserve(launch('other'),capacity);assert.equal(store.get(launch('other').key).state,'reserved');
  store.workerDeleted('unrelated-worker');assert.equal(store.get(launch('other').key).state,'reserved');
 }finally{f.close();}
});

test('legacy PR-only completion reopens health observation once and failed completion notice survives unchanged waiting',async()=>{
 const f=fixture();try{
 let s=createDeliveries(f.db);const r=s.register({url:'https://github.com/acme/repo/pull/999',taskId:'task',projectId:'project',owner:'manager',home:'/home',worker:'author',requirement:'pr'});
 s.save({...r,status:'complete',mergeCommitSha:null,updatedAt:123});s=createDeliveries(f.reopen());assert.equal(s.get(r.id).status,'pr-delivered');assert.equal(s.get(r.id).deliverySatisfiedAt,123);assert.deepEqual(s.get(r.id).workers,['author']);
 s.observe(r.id,observation({checks:'failing'}),false,100);assert.equal(s.get(r.id).status,'failing-checks');
 const fresh=s.register({url:'https://github.com/acme/repo/pull/1000',taskId:'fresh',projectId:'project',owner:'manager',home:'/home',worker:'author',requirement:'pr'});
 s.observe(fresh.id,observation({checks:'pending',mergeCommitSha:null}),false,200);const signature=s.get(fresh.id).notification.desired;
 assert.ok(signature);await s.notify(fresh.id,async()=>false,201);s.observe(fresh.id,observation({checks:'pending'}),false,202);assert.equal(s.get(fresh.id).notification.desired,signature);
 s=createDeliveries(f.reopen());let sends=0;await s.notify(fresh.id,async()=>{sends++;return true;},60202);s.observe(fresh.id,observation({checks:'pending'}),false,864000000);await s.notify(fresh.id,async()=>{sends++;return true;},864000001);assert.equal(sends,1,'unchanged PR-only waiting has no overdue merge obligation');
 }finally{f.close();}
});
