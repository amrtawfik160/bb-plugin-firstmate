// Checker round 2 for PR #174 (findings 2 and 6): archive events of an undone archive change nothing, and End
// never archives the workstream environment wholesale. Each defect assertion states the safe outcome.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries } from './lib/pr-delivery.ts';
import { createOwnerTasks } from './lib/owner-tasks.ts';
import { createWorkstreams } from './lib/workstreams.ts';
import { stubProviderCatalog } from './test/provider-catalog.mjs';
import { manifestSkillIds } from './scripts/plugin-skill-fixture.mjs';

type Row = Record<string, unknown>;

async function foldedTask() {
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: manifestSkillIds(new URL('.', import.meta.url).pathname) });
  const seeded = createWorkstreams(host.bb.storage.database(), {
    now: () => 0, provision: async () => [{ repository: 'cyndra-ai/cyndra-saas', projectId: 'cyndra', hostId: 'h1', path: '/repo/ws', sourcePath: '/repo/main', branch: 'workstream/ws-test', environmentId: 'env_ws' }],
    start: async () => 'thr_task', status: async () => 'active', startDev: async () => '', stopDev: async () => {}, unsaved: async () => [], remove: async () => {}, ship: async () => {}, taskState: () => 'working',
  });
  const w = await seeded.create({ threadId: 'cap', projectId: 'cyndra', name: 'Design', requestId: 'create' });
  await seeded.submit(w.id, 'cap', { id: 'crew1', editing: true, payload: '{"task":"First edit"}', repository: 'cyndra-ai/cyndra-saas' });
  const tasks = createOwnerTasks(host.bb.storage.database());
  const task = tasks.open({ captain: 'cap', project: 'Cyndra SaaS', projectId: 'cyndra', title: 'First edit', sourceRefs: ['tg:42:1'], crewId: 'crew1', at: Date.now() });
  seeded.noteJob(w.id, 'cap', 'crew1', {
    state: 'folded', cleanup: 'pending', taskId: task.id, threadId: 'thr_task', environmentId: 'env_task', path: '/repo/task', branch: 'task/one',
    repos: [{ repository: 'cyndra-ai/cyndra-saas', path: '/repo/task', branch: 'task/one', environmentId: 'env_task', hostId: 'h1' }],
  });
  await plugin(host.bb); stubProviderCatalog(host);
  await host.harness.behavior.setSettings({ signInCheck: false, fmHome: '', maxActiveCrews: 0 });
  await host.bb.storage.kv.set('captain-project:cap', 'cyndra');
  const threads = new Map<string, Row>([
    ['cap', { status: 'idle' }],
    ['thr_task', { status: 'idle', environmentId: 'env_task', parentThreadId: 'cap' }],
  ]);
  const lists = { occupants: new Map<string, Row[]>([['env_task', [{ id: 'thr_task', archivedAt: null, status: 'idle' }]]]), children: [] as Row[], project: [] as Row[] };
  const archived: string[] = [];
  const unarchived: string[] = [];
  const stopped: string[] = [];
  const commands: string[] = [];
  // What BB does inside the archive call; by default it archives just this thread.
  let onArchive: (threadId: string) => string[] = (threadId) => [threadId];
  let unsaved = 'FM_UNSAVED checked';
  let duringCheck: () => void = () => {};
  let archiveError: Error | undefined;
  host.harness.sdk.stub('threads.getPluginMetadata', async ({ threadId }: { threadId: string }) => (threadId === 'cap' ? { captain: 'true' } : {}));
  host.harness.sdk.stub('threads.get', async ({ threadId }: { threadId: string }) => ({
    ...makeThreadResponse({ id: threadId, projectId: 'cyndra', status: String(threads.get(threadId)?.status ?? 'idle') }),
    archivedAt: null, ...threads.get(threadId),
  }));
  host.harness.sdk.stub('threads.list', async (args: { environmentId?: string; parentThreadId?: string; sourceThreadId?: string; projectId?: string }) => {
    if (args.environmentId) return lists.occupants.get(args.environmentId) ?? [];
    if (args.parentThreadId) return args.parentThreadId === 'thr_task' ? lists.children : [];
    if (args.sourceThreadId) return [];
    if (args.projectId) return lists.project;
    return [];
  });
  host.harness.sdk.stub('environments.get', async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: 'h1', path: environmentId === 'env_task' ? '/repo/task' : '/repo/ws', status: 'ready', isWorktree: true }));
  host.harness.sdk.stub('hosts.exec', async ({ command }: { command: string }) => {
    commands.push(command);
    if (command.includes('echo present')) return { exitCode: 0, stdout: 'present' };
    if (command.includes(' check ')) { duringCheck(); return { exitCode: 0, stdout: unsaved }; }
    return { exitCode: 0, stdout: '' };
  });
  host.harness.sdk.stub('threads.archive', async ({ threadId }: { threadId: string }) => {
    if (archiveError) throw archiveError;
    archived.push(threadId);
    return { ok: true, archivedThreadIds: onArchive(threadId) };
  });
  host.harness.sdk.stub('threads.unarchive', async ({ threadId }: { threadId: string }) => { unarchived.push(threadId); return { ok: true }; });
  host.harness.sdk.stub('threads.stop', async ({ threadId }: { threadId: string }) => { stopped.push(threadId); return { ok: true }; });
  host.harness.sdk.stub('plugins.callRpc', async () => ({ ok: true, queued: 1, duplicate: false }));
  const job = () => seeded.get(w.id, 'cap').jobs.find((j) => j.id === 'crew1')!;
  return {
    host, tasks, task, threads, lists, archived, unarchived, stopped, commands, job,
    whenArchived: (fn: (threadId: string) => string[]) => { onArchive = fn; },
    pass: () => host.harness.behavior.runSchedule('workstreams'),
    set: (knobs: { unsaved?: string; duringCheck?: () => void; archiveError?: Error }) => {
      if (knobs.unsaved !== undefined) unsaved = knobs.unsaved;
      if (knobs.duringCheck) duringCheck = knobs.duringCheck;
      archiveError = knobs.archiveError;
    },
  };
}


test('round2: a widened archive is undone and its child archive event keeps delivery ownership', async () => {
 const f=await foldedTask();try {
  const store=createDeliveries(f.host.bb.storage.database());
  const row=store.register({url:'https://github.com/example/fixture/pull/1',taskId:'fixture',projectId:'cyndra',owner:'thr_hidden_source',home:'',worker:'fixture-worker'});
  assert.equal(store.get(row.id)!.ownerNeeded,false);
  f.host.harness.sdk.stub('threads.unarchive',async({threadId}:{threadId:string})=>{f.unarchived.push(threadId);f.threads.set(threadId,{...f.threads.get(threadId),archivedAt:null});return{ok:true}});
  f.host.harness.sdk.stub('threads.archive',async({threadId}:{threadId:string})=>{
   f.archived.push(threadId);
   f.threads.set('thr_hidden_source',{status:'active',archivedAt:Date.now(),environmentId:'env_hidden'});
   await f.host.harness.behavior.emitThreadEvent('thread.archived',{thread:makeThreadResponse({id:'thr_hidden_source',projectId:'cyndra',status:'active',archivedAt:Date.now()})});
   await f.host.harness.behavior.emitThreadEvent('thread.archived',{thread:makeThreadResponse({id:threadId,projectId:'cyndra',status:'idle',archivedAt:Date.now()})});
   return {ok:true,archivedThreadIds:[threadId,'thr_hidden_source']};
  });
  await f.pass();assert.deepEqual(f.unarchived,['thr_task','thr_hidden_source']);assert.equal(f.job().cleanup,'pending');
  assert.equal(f.threads.get('thr_hidden_source')!.archivedAt,null);assert.equal(f.threads.get('thr_hidden_source')!.status,'active');
  assert.equal(store.get(row.id)!.ownerNeeded,false);
 }finally{await f.host.harness.lifecycle.dispose()}
});
test('round2: an archive event delivered after undo keeps a live crew delivery owner',async()=>{
 const f=await foldedTask();try{
  const store=createDeliveries(f.host.bb.storage.database());const row=store.register({url:'https://github.com/example/fixture/pull/2',taskId:'fixture',projectId:'cyndra',owner:'thr_task',home:'',worker:'fixture-worker'});
  assert.equal(store.get(row.id)!.ownerNeeded,false);
  f.host.harness.sdk.stub('threads.unarchive',async({threadId}:{threadId:string})=>{f.unarchived.push(threadId);f.threads.set(threadId,{...f.threads.get(threadId),archivedAt:null});return{ok:true}});
  f.whenArchived((id)=>{f.threads.set(id,{...f.threads.get(id),status:'active'});return[id]});await f.pass();assert.deepEqual(f.unarchived,['thr_task']);
  await f.host.harness.behavior.emitThreadEvent('thread.archived',{thread:makeThreadResponse({id:'thr_task',projectId:'cyndra',status:'active',archivedAt:Date.now()})});
  assert.equal(f.threads.get('thr_task')!.status,'active');assert.equal(store.get(row.id)!.ownerNeeded,false);
 }finally{await f.host.harness.lifecycle.dispose()}
});

test('round2 End: an active thread that is not a crew keeps the workstream worktree; no environment-wide archive',async()=>{
 const f=await foldedTask();try{
  const db=f.host.bb.storage.database();const saved=db.prepare('SELECT id,record FROM firstmate_workstream').all()[0] as {id:string;record:string};const w=JSON.parse(saved.record);w.jobs[0].cleanup='done';
  db.prepare('UPDATE firstmate_workstream SET record=? WHERE id=?').run(JSON.stringify(w),saved.id);
  f.tasks.move(f.task.id,'cap',{to:'dropped',reason:'owner ended this fixture task',ref:'tg:42:1'},Date.now());
  f.threads.set('thr_debug',{status:'active',environmentId:'env_ws',archivedAt:null});f.lists.occupants.set('env_ws',[{id:'thr_debug',status:'active',archivedAt:null}]);
  const bulk:string[]=[];f.host.harness.sdk.stub('environments.archiveThreads',async({environmentId}:{environmentId:string})=>{bulk.push(environmentId);f.threads.set('thr_debug',{...f.threads.get('thr_debug'),archivedAt:Date.now()});return{archivedThreadIds:['thr_debug']}});
  await assert.rejects(f.host.harness.behavior.callRpc('workstreams.end',{threadId:'cap',workstreamId:saved.id}),/thr_debug/);
  assert.deepEqual(bulk,[]);assert.equal(f.threads.get('thr_debug')!.archivedAt,null);
 }finally{await f.host.harness.lifecycle.dispose()}
});
