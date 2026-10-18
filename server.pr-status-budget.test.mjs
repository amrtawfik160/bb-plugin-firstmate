import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost,makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';

// BB 0.46 review F1 (#5704): each uncached environments.pullRequest read makes the host run
// gh pr view plus a GraphQL merge-queue query, and BB caches it for only 10 seconds. Only
// one of Firstmate's six callers went through its GitHub budget, so a captain reading its
// bearings a few times a minute paid two GitHub reads per idle crew each time.
const CREWS=Array.from({length:5},(_,i)=>({id:`c${i}`,task:'fix login',projectId:'proj_1',threadId:`thr_c${i}`,parentThreadId:'thr_cap',
 providerId:null,model:null,reasoningLevel:null,worktree:true,shape:'ship',posture:'direct-PR',createdAt:'2026-10-17T00:00:00.000Z'}));
const prUrl=n=>`https://github.com/acme/app/pull/${100+n}`;

async function deck({pullRequest}={}) {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain']});await plugin(host.bb);
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:`env_${threadId}`,parentThreadId:'thr_cap'}));
 host.harness.sdk.stub('threads.output',async()=>({output:'Working on it.'}));
 host.harness.sdk.stub('threads.events.list',async()=>[]);
 host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));
 host.harness.sdk.stub('threads.queuedMessages.list',async()=>[]);
 host.harness.sdk.stub('environments.list',async()=>[]);
 host.harness.sdk.stub('environments.get',async({environmentId})=>({id:environmentId,hostId:'host_1',status:'ready',isWorktree:true,path:'/wt',branchName:'fm/x'}));
 host.harness.sdk.stub('environments.diffFiles',async()=>({files:[]}));
 host.harness.sdk.stub('environments.pullRequest',pullRequest ?? (async({environmentId})=>{
  const n=Number(environmentId.slice(-1));
  return {outcome:'available',pullRequest:{url:prUrl(n),number:100+n,title:`Change ${n}`,state:'open',checks:{state:'passing'},mergeability:{mergeable:'MERGEABLE'}}};
 }));
 host.harness.sdk.stub('files.read',async()=>{throw new Error('ENOENT');});
 await host.bb.storage.kv.set('crews',CREWS);
 return host;
}
const tool=(host,name)=>host.harness.inspection.registrations.agentTools.find(t=>t.name===name);
const reads=host=>host.harness.sdk.callsTo('environments.pullRequest').length;

test('a captain cycle of three bearings reads and one deliver reads each crew PR from GitHub once, not on every look',async()=>{
 const host=await deck();try {
  const cap={threadId:'thr_cap',projectId:'proj_1'};
  for(let i=0;i<3;i++) await tool(host,'firstmate_bearings').execute({},cap);
  await tool(host,'firstmate_deliver').execute({crewId:'c0'},cap);
  // Before: each bearings read 2 per idle crew (landed check, then the row): 3 x 2 x 5 + 1 = 31.
  assert.equal(reads(host),CREWS.length,`${reads(host)} PR status reads for ${CREWS.length} crews in one cycle`);
 }finally{await host.harness.lifecycle.dispose();}
});

test('repeated reads within the cache window share one answer, and concurrent reads share one request',async()=>{
 let release;const gate=new Promise(r=>{release=r;});
 const host=await deck({pullRequest:async()=>{await gate;return {outcome:'available',pullRequest:{url:prUrl(0),number:100,title:'Change 0',state:'open'}};}});try {
  const cap={threadId:'thr_cap',projectId:'proj_1'};
  const both=Promise.all([tool(host,'firstmate_deliver').execute({crewId:'c0'},cap),tool(host,'firstmate_deliver').execute({crewId:'c0'},cap)]);
  await new Promise(r=>setTimeout(r,20));release();await both;
  assert.equal(reads(host),1,'two concurrent delivers of one crew read its PR once');
 }finally{await host.harness.lifecycle.dispose();}
});

test('after the cache window a read goes to BB again',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const host=await deck();try {
  const cap={threadId:'thr_cap',projectId:'proj_1'};
  await tool(host,'firstmate_deliver').execute({crewId:'c0'},cap);
  t.mock.timers.tick(30_000);
  await tool(host,'firstmate_deliver').execute({crewId:'c0'},cap);
  assert.equal(reads(host),1,'30 seconds later the cached answer stands');
  t.mock.timers.tick(5*60_000);
  await tool(host,'firstmate_deliver').execute({crewId:'c0'},cap);
  assert.equal(reads(host),2,'5 minutes later the PR is read again');
 }finally{await host.harness.lifecycle.dispose();}
});

// The landing sweep runs every few minutes outside any captain turn, so it is background
// work: its PR reads are charged to the follow-up allowance and stop under the GraphQL reserve.
async function sweepOnce(remaining) {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain']});await plugin(host.bb);
 await host.harness.behavior.setSettings({supervisionEnabled:true});
 await host.bb.storage.kv.set('crews',[{...CREWS[0],parentThreadId:'thr_capB'}]);
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,status:'idle',environmentId:threadId==='thr_c0'?'env_thr_c0':null}));
 host.harness.sdk.stub('threads.output',async()=>({output:'DONE: shipped'}));
 host.harness.sdk.stub('threads.stop',async()=>({}));
 host.harness.sdk.stub('threads.archive',async()=>({}));
 host.harness.sdk.stub('threads.send',async()=>({}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'available',pullRequest:{url:prUrl(0),number:100,title:'t',state:'merged',checks:{state:'passing'},mergeability:{mergeable:'MERGEABLE'}}}));
 const byId=new Map();let n=0;const commands=[];
 host.harness.sdk.stub('terminals.create',async args=>{const id=`t${++n}`;byId.set(id,args.start.command);commands.push(args.start.command);return{id};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{
  const command=byId.get(terminalId);
  const stderr=command.includes('rateLimit')?`< X-Ratelimit-Remaining: ${remaining}\n< X-Ratelimit-Reset: ${Math.floor(Date.now()/1000)+600}\n< X-Ratelimit-Resource: graphql\n`:'';
  const payload=command.includes('FM_HOST_CAPTURE_V1')?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:0,stdout:'',stderr}):'';
  return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:0\n`).toString('base64')}]};
 });
 await host.bb.storage.kv.set('watch-meta',{lastPassAt:Date.now(),checked:-1,notified:-1});
 const run=host.harness.behavior.runService('crew-watch');
 const deadline=Date.now()+4000;
 while(Date.now()<deadline&&!commands.some(c=>c.includes('rateLimit'))) await new Promise(r=>setTimeout(r,10));
 await new Promise(r=>setTimeout(r,200));
 run.controller.abort();await run.done;
 return {host,commands};
}

test('under the GraphQL reserve the landing sweep reads no PR status and retires nothing; with quota it reads',async()=>{
 const low=await sweepOnce(150);try {
  assert.ok(low.commands.some(c=>c.includes('rateLimit')),'the sweep probed the quota');
  assert.equal(reads(low.host),0,'no PR status read with 150 points left and a 1,000-point reserve');
  assert.ok(!low.commands.some(c=>c.includes('gh pr view')),'and no gh fallback read');
  assert.equal((await low.host.bb.storage.kv.get('crews')).length,1,'missing data retires nothing');
 }finally{await low.host.harness.lifecycle.dispose();}
 const ok=await sweepOnce(4000);try {
  assert.equal(reads(ok.host),1,'with quota the sweep reads the PR');
 }finally{await ok.host.harness.lifecycle.dispose();}
});

// Checker findings on fe392683 (153-verdict-1): cached answers must name the crew's own PR,
// a refused refresh must not act on expired data, and a status read reserves its worst case.

test('a cached merged answer for an earlier PR in the environment does not retire the crew of its new open PR',async()=>{
 let current={outcome:'available',pullRequest:{url:prUrl(0),number:100,title:'old',state:'merged'}};
 const host=await deck({pullRequest:async()=>current});
 try {
  await host.bb.storage.kv.set('crews',[CREWS[0]]);
  const ctx={threadId:'thr_cap',projectId:'proj_1'};
  await tool(host,'firstmate_deliver').execute({crewId:'c0'},ctx);
  current={outcome:'available',pullRequest:{url:prUrl(1),number:101,title:'new',state:'open'}};
  await host.bb.storage.kv.set('crews',[{...CREWS[0],prUrl:prUrl(1)}]);
  host.harness.sdk.stub('threads.output',async()=>({output:'DONE: PR 101 open for review'}));
  host.harness.sdk.stub('threads.stop',async()=>({}));
  host.harness.sdk.stub('threads.archive',async()=>({}));
  await tool(host,'firstmate_bearings').execute({},ctx);
  assert.equal(host.harness.sdk.callsTo('threads.archive').length,0,'PR 101 is open; cached PR 100 must not archive its crew');
 } finally {await host.harness.lifecycle.dispose();}
});
test('external merge after cached open is observed at two minute expiry',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 let state='open';
 const host=await deck({pullRequest:async()=>({outcome:'available',pullRequest:{url:prUrl(0),number:100,title:'x',state}})});
 try {
  await host.bb.storage.kv.set('crews',[CREWS[0]]);
  host.harness.sdk.stub('threads.output',async()=>({output:'DONE: change ready'}));
  host.harness.sdk.stub('threads.stop',async()=>({}));
  host.harness.sdk.stub('threads.archive',async()=>({}));
  // Retirement asks git for unpushed commits first; there are none.
  host.harness.sdk.stub('terminals.create',async()=>({id:'t_git'}));
  host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
  host.harness.sdk.stub('terminals.close',async()=>({}));
  host.harness.sdk.stub('terminals.output',async()=>({nextSeq:1,chunks:[{dataBase64:Buffer.from('\n__FM_HOST_RC:0\n').toString('base64')}]}));
  const ctx={threadId:'thr_cap',projectId:'proj_1'};
  await tool(host,'firstmate_bearings').execute({},ctx);
  state='merged';
  t.mock.timers.tick(119_999);
  await tool(host,'firstmate_bearings').execute({},ctx);
  assert.equal(host.harness.sdk.callsTo('threads.archive').length,0);
  t.mock.timers.tick(2);
  await tool(host,'firstmate_bearings').execute({},ctx);
  assert.equal(host.harness.sdk.callsTo('threads.archive').length,1);
 } finally {await host.harness.lifecycle.dispose();}
});
test('two crews sharing one environment each get an answer for their own PR',async()=>{
 let current={outcome:'available',pullRequest:{url:prUrl(0),number:100,title:'old',state:'merged'}};
 const host=await deck({pullRequest:async()=>current});
 try {
  const ctx={threadId:'thr_cap',projectId:'proj_1'};
  await tool(host,'firstmate_deliver').execute({crewId:'c0'},ctx);
  current={outcome:'available',pullRequest:{url:prUrl(1),number:101,title:'new',state:'open'}};
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_thr_c0',parentThreadId:'thr_cap'}));
  await host.bb.storage.kv.set('crews',[CREWS[0],{...CREWS[1],prUrl:prUrl(1)}]);
  const out=await tool(host,'firstmate_deliver').execute({crewId:'c1'},ctx);
  assert.match(String(out),/PR: #101/,'second crew must not inherit first crew cached merged PR 100');
 } finally {await host.harness.lifecycle.dispose();}
});

const originalNow=Date.now;
async function expiredSweep(remaining) {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain']});await plugin(host.bb);
 await host.harness.behavior.setSettings({supervisionEnabled:true});
 await host.bb.storage.kv.set('crews',[{...CREWS[0],parentThreadId:'thr_capB'}]);
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,status:'idle',environmentId:threadId==='thr_c0'?'env_thr_c0':null}));
 host.harness.sdk.stub('threads.output',async()=>({output:'DONE: shipped'}));
 host.harness.sdk.stub('threads.stop',async()=>({}));
 host.harness.sdk.stub('threads.archive',async()=>({}));
 host.harness.sdk.stub('threads.send',async()=>({}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'available',pullRequest:{url:prUrl(0),number:100,title:'t',state:'merged',checks:{state:'passing'},mergeability:{mergeable:'MERGEABLE'}}}));
 const byId=new Map();let n=0;const commands=[];
 host.harness.sdk.stub('terminals.create',async args=>{const id=`t${++n}`;byId.set(id,args.start.command);commands.push(args.start.command);return{id};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{
  const command=byId.get(terminalId);
  const stderr=command.includes('rateLimit')?`< X-Ratelimit-Remaining: ${remaining}\n< X-Ratelimit-Reset: ${Math.floor(Date.now()/1000)+600}\n< X-Ratelimit-Resource: graphql\n`:'';
  const payload=command.includes('FM_HOST_CAPTURE_V1')?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:0,stdout:'',stderr}):'';
  return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:0\n`).toString('base64')}]};
 });
 host.harness.sdk.stub('environments.get',async({environmentId})=>({id:environmentId,hostId:'host_1',status:'ready',isWorktree:true,path:'/wt',branchName:'fm/x'}));
 host.harness.sdk.stub('environments.diffFiles',async()=>({files:[]}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:threadId==='thr_c0'?'env_thr_c0':null,parentThreadId:'thr_capB'}));
 await tool(host,'firstmate_deliver').execute({crewId:'c0'},{threadId:'thr_capB',projectId:'proj_1'});
 Date.now=()=>originalNow()+180_000;
 await host.bb.storage.kv.set('watch-meta',{lastPassAt:Date.now(),checked:-1,notified:-1});
 const run=host.harness.behavior.runService('crew-watch');
 const deadline=Date.now()+4000;
 while(Date.now()<deadline&&!commands.some(c=>c.includes('rateLimit'))) await new Promise(r=>setTimeout(r,10));
 await new Promise(r=>setTimeout(r,200));
 run.controller.abort();await run.done;
 return {host,commands};
}

test('a refused refresh of an expired merged answer retires nothing',async()=>{
 let host;
 try {
  ({host}=await expiredSweep(150));
  assert.equal(reads(host),1,'only the priming read ran');
  assert.equal((await host.bb.storage.kv.get('crews')).length,1,'paused stale data must not retire crew');
 } finally {Date.now=originalNow;if(host) await host.harness.lifecycle.dispose();}
});

async function accountingSweep(remaining) {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain']});await plugin(host.bb);
 await host.harness.behavior.setSettings({supervisionEnabled:true});
 await host.bb.storage.kv.set('crews',[{...CREWS[0],parentThreadId:'thr_capB'}]);
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,status:'idle',environmentId:threadId==='thr_c0'?'env_thr_c0':null}));
 host.harness.sdk.stub('threads.output',async()=>({output:'DONE: shipped'}));
 host.harness.sdk.stub('threads.stop',async()=>({}));
 host.harness.sdk.stub('threads.archive',async()=>({}));
 host.harness.sdk.stub('threads.send',async()=>({}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'available',pullRequest:{url:prUrl(0),number:100,title:'t',state:'open',checks:{state:'passing'},mergeability:{mergeable:'MERGEABLE'}}}));
 const byId=new Map();let n=0;const commands=[];
 host.harness.sdk.stub('terminals.create',async args=>{const id=`t${++n}`;byId.set(id,args.start.command);commands.push(args.start.command);return{id};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{
  const command=byId.get(terminalId);
  const stderr=command.includes('rateLimit')?`< X-Ratelimit-Remaining: ${remaining}\n< X-Ratelimit-Reset: ${Math.floor(Date.now()/1000)+600}\n< X-Ratelimit-Resource: graphql\n`:'';
  const payload=command.includes('FM_HOST_CAPTURE_V1')?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:0,stdout:'',stderr}):'';
  return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:0\n`).toString('base64')}]};
 });
 await host.bb.storage.kv.set('watch-meta',{lastPassAt:Date.now(),checked:-1,notified:-1});
 const run=host.harness.behavior.runService('crew-watch');
 const deadline=Date.now()+4000;
 while(Date.now()<deadline&&!commands.some(c=>c.includes('rateLimit'))) await new Promise(r=>setTimeout(r,10));
 await new Promise(r=>setTimeout(r,200));
 run.controller.abort();await run.done;
 return {host,commands};
}

test('1,001 GraphQL points cannot fund a PR status read: BB can spend 2 and the reserve is 1,000',async()=>{
 const {host}=await accountingSweep(1001);
 try {assert.equal(reads(host),0,'BB may spend two GraphQL points on one open PR read');}
 finally {await host.harness.lifecycle.dispose();}
});

test('a crew joining a read in flight for another PR in its environment reads its own PR',async()=>{
 let release;const gate=new Promise(r=>{release=r;});let calls=0;
 const host=await deck({pullRequest:async()=>{calls++;if(calls===1){await gate;return {outcome:'available',pullRequest:{url:prUrl(0),number:100,title:'old',state:'merged'}};}
  return {outcome:'available',pullRequest:{url:prUrl(1),number:101,title:'new',state:'open'}};}});
 try {
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_thr_c0',parentThreadId:'thr_cap'}));
  await host.bb.storage.kv.set('crews',[CREWS[0],{...CREWS[1],prUrl:prUrl(1)}]);
  const ctx={threadId:'thr_cap',projectId:'proj_1'};
  const first=tool(host,'firstmate_deliver').execute({crewId:'c0'},ctx);
  await new Promise(r=>setTimeout(r,20));
  const second=tool(host,'firstmate_deliver').execute({crewId:'c1'},ctx);
  await new Promise(r=>setTimeout(r,20));release();
  await first;
  assert.match(String(await second),/PR: #101/,'the in-flight answer named PR 100, so crew c1 read again');
 } finally {await host.harness.lifecycle.dispose();}
});

// Checker round 2 on a1b45fd: a fresh answer is the environment's state, not proof of this crew's PR.

test('a fresh answer naming another PR does not retire the crew of its recorded open PR',async()=>{
 const host=await deck({pullRequest:async()=>({outcome:'available',pullRequest:{url:prUrl(1),number:101,title:'another crew PR',state:'merged'}})});
 try {
  await host.bb.storage.kv.set('crews',[{...CREWS[0],prUrl:prUrl(0)}]);
  host.harness.sdk.stub('threads.output',async()=>({output:'DONE: PR 100 is open for review'}));
  host.harness.sdk.stub('threads.stop',async()=>({}));
  host.harness.sdk.stub('threads.archive',async()=>({}));
  const ctx={threadId:'thr_cap',projectId:'proj_1'};
  // Prime the shared environment entry with PR 101, forcing a mismatch and refresh for PR 100.
  await host.bb.storage.kv.set('crews',[CREWS[1],{...CREWS[0],prUrl:prUrl(0)}]);
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_shared',parentThreadId:'thr_cap'}));
  await tool(host,'firstmate_deliver').execute({crewId:'c1'},ctx);
  await host.bb.storage.kv.set('crews',[{...CREWS[0],prUrl:prUrl(0)}]);
  await tool(host,'firstmate_bearings').execute({},ctx);
  assert.ok(reads(host)>=2,'the cached mismatch caused a fresh BB read');
  assert.equal(host.harness.sdk.callsTo('threads.archive').length,0,'PR 101 being merged says nothing about the recorded PR 100');
 }finally{await host.harness.lifecycle.dispose();}
});
test('a fresh answer naming another PR does not overwrite the crew\'s recorded PR',async()=>{
 let current={outcome:'available',pullRequest:{url:prUrl(0),number:100,title:'crew A',state:'open'}};
 const host=await deck({pullRequest:async()=>current});
 try {
  const ctx={threadId:'thr_cap',projectId:'proj_1'};
  host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_shared',parentThreadId:'thr_cap'}));
  await host.bb.storage.kv.set('crews',[{...CREWS[0],prUrl:prUrl(0)},{...CREWS[1],prUrl:prUrl(1)}]);
  await tool(host,'firstmate_deliver').execute({crewId:'c0'},ctx);
  current={outcome:'available',pullRequest:{url:prUrl(1),number:101,title:'crew B',state:'merged'}};
  await tool(host,'firstmate_deliver').execute({crewId:'c1'},ctx);
  await tool(host,'firstmate_deliver').execute({crewId:'c0'},ctx);
  const crews=await host.bb.storage.kv.get('crews');
  assert.equal(crews.find(c=>c.id==='c0').prUrl,prUrl(0),'crew A recorded PR must survive an answer for crew B');
 }finally{await host.harness.lifecycle.dispose();}
});
