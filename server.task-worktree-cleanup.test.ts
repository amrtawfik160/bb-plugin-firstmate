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

test("Live archives the task's worktree crew so BB can tear the worktree down", async () => {
  const { host, archived, envDeletes } = await captainHost({ envOf: { thr_c1: "env_c1" } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    liveTask(host, "c1");
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual([...archived], ["thr_c1"]);
    assert.deepEqual(envDeletes, []);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("merged-not-live keeps the worktree", async () => {
  const { host, archived } = await captainHost({ envOf: { thr_c1: "env_c1" } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    const tasks = createOwnerTasks(host.bb.storage.database());
    const opened = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Banner", sourceRefs: ["tg:1:1"], crewId: "c1", at: Date.now() });
    tasks.move(opened.id, "thr_cap", { to: "merged" }, Date.now());
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual([...archived], []);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("dropped archives at once", async () => {
  const { host, archived } = await captainHost({ envOf: { thr_c1: "env_c1" } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    const tasks = createOwnerTasks(host.bb.storage.database());
    const opened = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Banner", sourceRefs: ["tg:1:1"], crewId: "c1", at: Date.now() });
    tasks.move(opened.id, "thr_cap", { to: "dropped", reason: "owner said stop", ref: "tg:1:9" }, Date.now());
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual([...archived], ["thr_c1"]);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("unsaved work is kept, recorded on the task, and reported once", async () => {
  const { host, archived } = await captainHost({ envOf: { thr_c1: "env_c1" }, unsaved: { env_c1: "FM_UNSAVED uncommitted 1\n" } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    const live = liveTask(host, "c1");
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual([...archived], []);
    assert.equal(createOwnerTasks(host.bb.storage.database()).get(live.id)?.worktreeKept, KEPT_UNSAVED);
    const notices = host.harness.sdk.callsTo("threads.send").filter((call) => JSON.stringify(call).includes("kept: unsaved work"));
    assert.equal(notices.length, 1);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a shared environment is kept", async () => {
  const { host, archived } = await captainHost({ envOf: { thr_c1: "env_c1" }, extraOccupants: { env_c1: ["thr_stranger"] } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    liveTask(host, "c1");
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual([...archived], []);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a checker another open task still uses is kept", async () => {
  const { host, archived } = await captainHost({ envOf: { thr_b: "env_1", thr_k: "env_1" } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("builder", "thr_b"), crewRow("checker", "thr_k")]);
    const tasks = createOwnerTasks(host.bb.storage.database());
    const first = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "round 1", sourceRefs: ["tg:1:1"], crewId: "builder", at: 1 });
    tasks.attach(first.id, "thr_cap", { crewId: "checker", sourceRefs: [], at: 2 });
    const second = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "round 2", sourceRefs: ["tg:1:2"], at: 3 });
    tasks.attach(second.id, "thr_cap", { crewId: "checker", sourceRefs: [], at: 3 });
    tasks.move(first.id, "thr_cap", { to: "live", reason: "production OTA holds it" }, 4);
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual([...archived], ["thr_b"]);
    assert.equal(archived.has("thr_k"), false);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a checkout environment is never archived", async () => {
  const { host, archived } = await captainHost({ envOf: { thr_c1: "env_c1" }, worktreeOf: { env_c1: false } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    liveTask(host, "c1");
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual([...archived], []);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("dropping a task through firstmate_task archives its crew at once, without waiting for the schedule", async () => {
  const { host, archived } = await captainHost({ envOf: { thr_c1: "env_c1" } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    const tasks = createOwnerTasks(host.bb.storage.database());
    const opened = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Banner", sourceRefs: ["tg:1:1"], crewId: "c1", at: Date.now() });
    const tool = host.harness.inspection.registrations.agentTools.find((t) => t.name === "firstmate_task")!;
    await tool.execute({ action: "close", id: opened.id, state: "dropped", reason: "owner said stop", ref: "tg:1:9" }, ctx as never);
    for (let i = 0; i < 50 && archived.size === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual([...archived], ["thr_c1"]);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a running crew of a dropped task is kept until it stops", async () => {
  const { host, archived } = await captainHost({ envOf: { thr_c1: "env_c1" }, statusOf: { thr_c1: "active" } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    const tasks = createOwnerTasks(host.bb.storage.database());
    const opened = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Banner", sourceRefs: ["tg:1:1"], crewId: "c1", at: Date.now() });
    tasks.move(opened.id, "thr_cap", { to: "dropped", reason: "owner said stop", ref: "tg:1:9" }, Date.now());
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual([...archived], []);
    assert.equal(host.harness.sdk.callsTo("threads.stop").length, 0, "cleanup never stops a crew");
  } finally { await host.harness.lifecycle.dispose(); }
});

// Check round 1 (PR #179), finding 2: BB's archive takes the crew's child threads too.
test("a crew with a child thread in another worktree is kept, and so is the child", async () => {
  const { host, archived } = await captainHost({
    envOf: { thr_c1: "env_c1", thr_child: "env_child" }, statusOf: { thr_child: "active" }, parentOf: { thr_child: "thr_c1" },
  });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    liveTask(host, "c1");
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual([...archived], []);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a crew with a lifecycle dependent is kept", async () => {
  const { host, archived } = await captainHost({ envOf: { thr_c1: "env_c1", thr_dep: "env_dep" }, lifecycleOwnerOf: { thr_dep: "thr_c1" } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    liveTask(host, "c1");
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual([...archived], []);
  } finally { await host.harness.lifecycle.dispose(); }
});

// Finding 1: BB's archive has no idle precondition.
test("a turn that starts between the last read and the archive survives: the archive is undone and the crew is not marked ended", async () => {
  const { host, archived, unarchived, statusOf } = await captainHost({ envOf: { thr_c1: "env_c1" } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    liveTask(host, "c1");
    const deliveries = createDeliveries(host.bb.storage.database());
    deliveries.register({ url: "https://github.com/acme/app/pull/7", taskId: "c1", projectId: "proj_1", owner: "thr_c1", home: "", worker: "thr_c1", requirement: "pr" });
    host.harness.sdk.stub("threads.archive", async ({ threadId }: { threadId: string }) => {
      statusOf[threadId] = "active"; // the owner's follow-up reached the crew just before the archive
      archived.add(threadId);
      return { ok: true, archivedThreadIds: [threadId] };
    });
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual(unarchived, ["thr_c1"]);
    assert.deepEqual([...archived], [], "the thread is back, inside BB's undo grace");
    assert.equal(host.harness.sdk.callsTo("threads.stop").length, 0);
    assert.equal(deliveries.get("acme/app#7")?.ownerNeeded, false, "an undone archive never runs the thread-archived effects");
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a verified archive runs the thread-archived effects once", async () => {
  const { host, archived } = await captainHost({ envOf: { thr_c1: "env_c1" } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    liveTask(host, "c1");
    const deliveries = createDeliveries(host.bb.storage.database());
    deliveries.register({ url: "https://github.com/acme/app/pull/7", taskId: "c1", projectId: "proj_1", owner: "thr_c1", home: "", worker: "thr_c1", requirement: "pr" });
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual([...archived], ["thr_c1"]);
    assert.equal(deliveries.get("acme/app#7")?.ownerNeeded, true);
  } finally { await host.harness.lifecycle.dispose(); }
});

// Finding 3: the parent's turn is read again after the worktree check.
test("a captain turn that starts during the worktree check keeps the crew", async () => {
  const { host, archived, statusOf, byId } = await captainHost({ envOf: { thr_c1: "env_c1" } });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1")]);
    liveTask(host, "c1");
    host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
      const command = byId.get(terminalId) ?? "";
      const checking = command.includes("FM_UNSAVED");
      if (checking) statusOf["thr_cap"] = "active";
      const payload = checking ? "FM_UNSAVED checked\n" : "";
      const output = command.includes("FM_HOST_CAPTURE_V1") ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: 0, stdout: payload, stderr: "" }) : payload;
      return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${output}\n__FM_HOST_RC:0\n`).toString("base64") }] };
    });
    await host.harness.behavior.runSchedule("task-worktree-cleanup");
    assert.deepEqual([...archived], []);
  } finally { await host.harness.lifecycle.dispose(); }
});
