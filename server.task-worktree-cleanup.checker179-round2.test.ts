// Checker probes from check round 2 of PR #179 (D179-check-2), kept as regression tests.
// Each showed a defect; its defect assertion is flipped to the safe outcome.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createOwnerTasks } from "./lib/owner-tasks.ts";
import { createDeliveries } from "./lib/pr-delivery.ts";
import { KEPT_UNSAVED } from "./lib/task-worktree-cleanup.ts";

const ctx = { threadId: "thr_cap", projectId: "proj_1" };

function crewRow(id: string, threadId: string, extra: Record<string, unknown> = {}) {
  return { id, task: "x", title: id, projectId: "proj_1", threadId, parentThreadId: "thr_cap", nativeHome: "/native", worktree: true, shape: "scout", posture: "direct-PR", createdAt: "2026-10-13T00:00:00.000Z", providerId: null, model: null, reasoningLevel: null, ...extra };
}

async function captainHost(opts: {
  envOf?: Record<string, string>;
  statusOf?: Record<string, string>;
  worktreeOf?: Record<string, boolean>;
  extraOccupants?: Record<string, string[]>;
  unsaved?: Record<string, string>;
  /** child thread id -> parent thread id */
  parentOf?: Record<string, string>;
  /** dependent thread id -> lifecycle owner thread id */
  lifecycleOwnerOf?: Record<string, string>;
} = {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"], settings: { fmHome: "/native", fmHostId: "host_1" } });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  const envOf = opts.envOf ?? {};
  const statusOf = opts.statusOf ?? {};
  const worktreeOf = opts.worktreeOf ?? {};
  const extraOccupants = opts.extraOccupants ?? {};
  const archived = new Set<string>();
  const unarchived: string[] = [];
  const envDeletes: string[] = [];
  const parentOf = opts.parentOf ?? {};
  const lifecycleOwnerOf = opts.lifecycleOwnerOf ?? {};
  const known = () => [...new Set(["thr_cap", ...Object.keys(envOf), ...Object.keys(statusOf), ...Object.keys(parentOf), ...Object.keys(lifecycleOwnerOf)])];
  const row = (id: string, environmentId = envOf[id] ?? `env_${id}`) => ({
    ...makeThreadResponse({
      id, projectId: "proj_1", status: (statusOf[id] ?? "idle") as "idle", environmentId,
      ...(archived.has(id) ? { archivedAt: Date.now() } : {}),
    }),
    parentThreadId: parentOf[id] ?? (id === "thr_cap" ? null : "thr_cap"),
    lifecycleOwnerThreadId: lifecycleOwnerOf[id] ?? null,
  });
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => row(threadId));
  host.harness.sdk.stub("threads.list", async (args: { environmentId?: string; parentThreadId?: string; sourceThreadId?: string; projectId?: string } = {}) => {
    if (args.parentThreadId) return known().filter((id) => parentOf[id] === args.parentThreadId).map((id) => row(id));
    if (args.sourceThreadId) return [];
    if (args.projectId) return known().map((id) => row(id));
    if (!args.environmentId) return [];
    const own = Object.entries(envOf).filter(([, env]) => env === args.environmentId).map(([id]) => id);
    const fallback = own.length > 0 ? own : Object.keys(statusOf).length === 0 && args.environmentId.startsWith("env_") ? [args.environmentId.slice(4)] : [];
    const ids = [...new Set([...fallback, ...(extraOccupants[args.environmentId] ?? [])])];
    return ids.map((id) => makeThreadResponse({
      id, projectId: "proj_1", status: (statusOf[id] ?? "idle") as "idle", environmentId: args.environmentId,
      ...(archived.has(id) ? { archivedAt: Date.now() } : {}),
    }));
  });
  host.harness.sdk.stub("threads.send", async () => ({ delivery: "queued" }));
  host.harness.sdk.stub("threads.stop", async () => ({}));
  // Like BB: the thread, its children and its lifecycle dependents, recursively.
  host.harness.sdk.stub("threads.archive", async ({ threadId }: { threadId: string }) => {
    const tree = (root: string): string[] => [root, ...known().filter((id) => parentOf[id] === root || lifecycleOwnerOf[id] === root).flatMap(tree)];
    const archivedThreadIds = tree(threadId).filter((id) => !archived.has(id));
    for (const id of archivedThreadIds) archived.add(id);
    return { ok: true, archivedThreadIds };
  });
  host.harness.sdk.stub("threads.unarchive", async ({ threadId }: { threadId: string }) => { archived.delete(threadId); unarchived.push(threadId); return { ok: true }; });
  host.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({
    id: environmentId, hostId: "host_1", status: "ready", isWorktree: worktreeOf[environmentId] !== false, path: `/wt/${environmentId}`,
  }));
  host.harness.sdk.stub("environments.diffFiles", async () => ({ files: [] }));
  host.harness.sdk.stub("environments.list", async () => [{ id: "env_source", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("environments.delete", async ({ environmentId }: { environmentId: string }) => { envDeletes.push(environmentId); return {}; });
  host.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Cyndra", kind: "repo" }));
  host.harness.sdk.stub("files.read", async () => { throw new Error("HTTP 404: Path does not exist"); });
  const byId = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub("terminals.create", async (args: { start: { command: string } }) => { const id = `term${++n}`; byId.set(id, args.start.command); return { id }; });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
    const command = byId.get(terminalId) ?? "";
    const checked = command.includes("FM_UNSAVED") ? /\/wt\/(env_\w+|thr_\w+)/.exec(command)?.[1] : undefined;
    const payload = checked !== undefined ? `${opts.unsaved?.[checked] ?? ""}FM_UNSAVED checked\n` : "";
    const captured = command.includes("FM_HOST_CAPTURE_V1");
    const out = captured ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: 0, stdout: payload, stderr: "" }) : payload;
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${out}\n__FM_HOST_RC:0\n`).toString("base64") }] };
  });
  return { host, archived, unarchived, envDeletes, statusOf, byId };
}

function liveTask(host: Awaited<ReturnType<typeof captainHost>>["host"], crewId: string, title = "Banner") {
  const tasks = createOwnerTasks(host.bb.storage.database());
  const opened = tasks.open({ captain: "thr_cap", project: "Cyndra", title, sourceRefs: ["tg:1:1"], crewId, at: Date.now() });
  return tasks.move(opened.id, "thr_cap", { to: "live", reason: "production OTA holds it" }, Date.now());
}


test('probe: delayed archived event after undo still marks the active crew delivery owner lost',async()=>{
 const {host,archived,unarchived,statusOf}=await captainHost({envOf:{thr_c1:'env_c1'}});
 try{
  await host.bb.storage.kv.set('crews',[crewRow('c1','thr_c1')]);liveTask(host,'c1');
  const deliveries=createDeliveries(host.bb.storage.database());
  deliveries.register({url:'https://github.com/acme/app/pull/7',taskId:'c1',projectId:'proj_1',owner:'thr_c1',home:'',worker:'thr_c1',requirement:'pr'});
  let archiveEvent;
  host.harness.sdk.stub('threads.archive',async({threadId}:{threadId:string})=>{
   statusOf[threadId]='active';archived.add(threadId);
   archiveEvent=makeThreadResponse({id:threadId,projectId:'proj_1',status:'active',environmentId:'env_c1',archivedAt:Date.now()});
   return {ok:true,archivedThreadIds:[threadId]};
  });
  await host.harness.behavior.runSchedule('task-worktree-cleanup');
  assert.deepEqual(unarchived,['thr_c1']);assert.equal(archived.size,0);
  assert.equal(deliveries.get('acme/app#7')?.ownerNeeded,false);
  await host.harness.behavior.emitThreadEvent('thread.archived',{thread:archiveEvent!});
  // Flipped to the safe outcome: the late event finds the archive undone and changes nothing.
  assert.equal(deliveries.get('acme/app#7')?.ownerNeeded,false,'late event applies effects even though undo restored an active crew');
 }finally{await host.harness.lifecycle.dispose();}
});

test('probe: successful RPCs each inside the 15-second limit can consume more than BB undo grace',async()=>{
 const {runTaskWorktreeCleanup}=await import('./lib/task-worktree-cleanup.ts');
 let elapsed=0, archived=false, stopped=false;
 const result=await runTaskWorktreeCleanup({
  signal:new AbortController().signal,
  tasks:[{id:'T1',captain:'thr_cap',project:null,title:'ready',sourceRefs:[],state:'live',prs:[],crewIds:['c1'],backfilled:false,createdAt:0,updatedAt:1}],
  crews:[{id:'c1',threadId:'thr_c1',parentThreadId:'thr_cap',worktree:true}],workstreamTaskIds:new Set(),
  thread:async id=>{
   if(id==='thr_cap')return {id,status:'idle',archivedAt:null};
   if(archived)elapsed+=14000;
   return {id,status:archived?'active':'idle',environmentId:'env_c1',archivedAt:archived?1:null};
  },
  environment:async id=>({id,isWorktree:true,path:'/wt'}),
  occupants:async()=>{if(archived)elapsed+=14000;return [{id:'thr_c1',status:archived?'active':'idle',archivedAt:archived?1:null}];},
  unsaved:async()=>[],descendants:async()=>0,
  archive:async id=>{archived=true;elapsed+=3000;return [id];},
  unarchive:async()=>{stopped=elapsed>=30000;archived=false;},
  recordKept:()=>{},alreadyReported:async()=>false,reportKept:async()=>true,isCaptain:async()=>false,
 });
 // Flipped to the safe outcome: the read-back already shows work, so the undo starts at once
 // (17 s: archive 3 s + read 14 s) instead of after the worktree read (31 s).
 assert.equal(elapsed,17000);
 assert.equal(stopped,false,'undo is invoked after BB may already stop archived work');
 assert.equal(result.rows[0]?.action,'kept');
});

test('probe: CI-shaped preload without the PATH stand-in still invokes installed-bb decoy',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync}=await import('node:fs');
 const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'d179-ci-guard-'));mkdirSync(join(dir,'bin'));
 try{
  writeFileSync(join(dir,'bin','bb'),'#!/bin/sh\necho INSTALLED_DECOY_REACHED\n',{mode:0o755});
  const result=spawnSync(process.execPath,['--import','./test/no-live-bb.mjs','-e',"const r=require('node:child_process').spawnSync('bb',['connect','expose','5200'],{encoding:'utf8'});process.stdout.write(r.stdout);"],{env:{...process.env,HOME:dir,BB_CLI:undefined,PATH:join(dir,'bin')},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'INSTALLED_DECOY_REACHED');
  const workflow=readFileSync('.github/workflows/checks.yml','utf8');
  // Flipped to the safe outcome: CI runs tests through the shared environment, whose PATH puts the blocking stand-in first.
  assert.ok(workflow.includes('sh scripts/run-tests.sh $files') && readFileSync('scripts/run-tests.sh','utf8').includes('test/no-live-bb:$PATH'),'CI has preload but no blocking PATH prefix');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
