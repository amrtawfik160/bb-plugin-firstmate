// Checker probe from check round 1 of PR #179 (D179-check-1), kept as a regression test.
// It showed a defect; its result assertion is flipped to the safe outcome.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createOwnerTasks } from "./lib/owner-tasks.ts";
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
} = {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"], settings: { fmHome: "/native", fmHostId: "host_1" } });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  const envOf = opts.envOf ?? {};
  const statusOf = opts.statusOf ?? {};
  const worktreeOf = opts.worktreeOf ?? {};
  const extraOccupants = opts.extraOccupants ?? {};
  const archived = new Set<string>();
  const envDeletes: string[] = [];
  const byId = new Map<string, string>();
  let n = 0;
  const restub = (target: typeof host) => {
  target.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  target.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({
    id: threadId, projectId: "proj_1", status: (statusOf[threadId] ?? "idle") as "idle",
    environmentId: envOf[threadId] ?? `env_${threadId}`,
    ...(archived.has(threadId) ? { archivedAt: Date.now() } : {}),
  }));
  target.harness.sdk.stub("threads.list", async (args: { environmentId?: string } = {}) => {
    if (!args.environmentId) return [];
    const own = Object.entries(envOf).filter(([, env]) => env === args.environmentId).map(([id]) => id);
    const fallback = own.length > 0 ? own : Object.keys(statusOf).length === 0 && args.environmentId.startsWith("env_") ? [args.environmentId.slice(4)] : [];
    const ids = [...new Set([...fallback, ...(extraOccupants[args.environmentId] ?? [])])];
    return ids.map((id) => makeThreadResponse({
      id, projectId: "proj_1", status: (statusOf[id] ?? "idle") as "idle", environmentId: args.environmentId,
      ...(archived.has(id) ? { archivedAt: Date.now() } : {}),
    }));
  });
  target.harness.sdk.stub("threads.send", async () => ({ delivery: "queued" }));
  target.harness.sdk.stub("threads.stop", async () => ({}));
  target.harness.sdk.stub("threads.archive", async ({ threadId }: { threadId: string }) => { archived.add(threadId); return {}; });
  target.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({
    id: environmentId, hostId: "host_1", status: "ready", isWorktree: worktreeOf[environmentId] !== false, path: `/wt/${environmentId}`,
  }));
  target.harness.sdk.stub("environments.diffFiles", async () => ({ files: [] }));
  target.harness.sdk.stub("environments.list", async () => [{ id: "env_source", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  target.harness.sdk.stub("environments.delete", async ({ environmentId }: { environmentId: string }) => { envDeletes.push(environmentId); return {}; });
  target.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Cyndra", kind: "repo" }));
  target.harness.sdk.stub("files.read", async () => { throw new Error("HTTP 404: Path does not exist"); });
  target.harness.sdk.stub("terminals.create", async (args: { start: { command: string } }) => { const id = `term${++n}`; byId.set(id, args.start.command); return { id }; });
  target.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  target.harness.sdk.stub("terminals.close", async () => ({}));
  target.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
    const command = byId.get(terminalId) ?? "";
    const checked = command.includes("FM_UNSAVED") ? /\/wt\/(env_\w+|thr_\w+)/.exec(command)?.[1] : undefined;
    const payload = checked !== undefined ? `${opts.unsaved?.[checked] ?? ""}FM_UNSAVED checked\n` : "";
    const captured = command.includes("FM_HOST_CAPTURE_V1");
    const out = captured ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: 0, stdout: payload, stderr: "" }) : payload;
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${out}\n__FM_HOST_RC:0\n`).toString("base64") }] };
  });
  };
  restub(host);
  return { host, archived, envDeletes, byId, restub };
}

function liveTask(host: Awaited<ReturnType<typeof captainHost>>["host"], crewId: string, title = "Banner") {
  const tasks = createOwnerTasks(host.bb.storage.database());
  const opened = tasks.open({ captain: "thr_cap", project: "Cyndra", title, sourceRefs: ["tg:1:1"], crewId, at: Date.now() });
  return tasks.move(opened.id, "thr_cap", { to: "live", reason: "production OTA holds it" }, Date.now());
}


test('probe: new open task uses checker during host git check, but server archives it from old task snapshot',async()=>{
 const {host,archived,byId}=await captainHost({envOf:{thr_c1:'env_c1'}});
 try{
  await host.bb.storage.kv.set('crews',[crewRow('c1','thr_c1')]);liveTask(host,'c1');
  const tasks=createOwnerTasks(host.bb.storage.database());
  const open=tasks.open({captain:'thr_cap',project:'Cyndra',title:'next review',sourceRefs:['tg:1:2'],at:2});
  let attached=false;
  host.harness.sdk.stub('terminals.output',async({terminalId}:{terminalId:string})=>{
    const command=byId.get(terminalId)??'';
    const checking=command.includes('FM_UNSAVED');
    if(checking&&!attached){tasks.attach(open.id,'thr_cap',{crewId:'c1',sourceRefs:[],at:3});attached=true;}
    const payload=checking?'FM_UNSAVED checked\n':'';
    const output=command.includes('FM_HOST_CAPTURE_V1')?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:0,stdout:payload,stderr:''}):payload;
    return {nextSeq:1,chunks:[{dataBase64:Buffer.from(`${output}\n__FM_HOST_RC:0\n`).toString('base64')}]};
  });
  await host.harness.behavior.runSchedule('task-worktree-cleanup');
  assert.equal(attached,true);assert.ok(tasks.get(open.id)?.crewIds.includes('c1'));
  // Flipped to the safe outcome: the task records are read again after the host Git check.
  assert.deepEqual([...archived],[]);
 }finally{await host.harness.lifecycle.dispose();}
});

