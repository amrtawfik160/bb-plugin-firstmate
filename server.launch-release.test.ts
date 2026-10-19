import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createLaunches, launchKey } from "./lib/launch.ts";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";

type Host = ReturnType<typeof createFakePluginHost>;
const HOME = "/tmp/fm-home";
const TASK = "47806a51";
const ctx = { threadId: "thr_cap", projectId: "proj_1" };
const ADMISSION_TIMEOUT = "Timed out waiting for host command (host host_1, terminal t_1, budget 15s)";

function hostRc(payload: string, code = 0) {
  return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${payload}\n__FM_HOST_RC:${code}\n`).toString("base64") }] };
}

function launchStore(host: Host) {
  return createLaunches(host.bb.storage.database());
}

function spawnCommands(seen: string[]) {
  return seen.filter((c) => c.includes("fm-spawn.sh") && !c.includes("native_command="));
}

async function realCaptain(opts: { hangSpawn?: boolean; abort?: AbortController } = {}) {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: ["captain", "firstmate"],
    settings: { fmHome: HOME, fmHostId: "host_1", transport: "real", queueOwner: "real" },
  });
  await host.bb.storage.kv.set(`native-home:${ctx.threadId}`, HOME);
  await host.bb.storage.kv.set(`native-home-host:${ctx.threadId}`, "host_1");
  await host.bb.storage.kv.set(`captain-project:${ctx.threadId}`, ctx.projectId);
  await plugin(host.bb);
  stubProviderCatalog(host);
  const seen: string[] = [];
  const cmds = new Map<string, string>();
  const state = { spawnExit: 1, spawnOutput: ADMISSION_TIMEOUT, threadIdAfterSpawn: "", spawned: 0, spawnSucceeded: false };
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) =>
    threadId === ctx.threadId ? { captain: "true", nativeHome: HOME } : {});
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_wt", hostId: "host_1", path: "/wt", isWorktree: true, status: "ready" }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({
    id: threadId, projectId: ctx.projectId, status: threadId === ctx.threadId ? "idle" : "starting",
    environmentId: threadId === ctx.threadId ? "env_cap" : "env_wt",
  }));
  let n = 0;
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
    const id = `term_${++n}`;
    cmds.set(id, args.start?.command ?? "");
    seen.push(args.start?.command ?? "");
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const cmd = cmds.get(args.terminalId) ?? "";
    if (cmd.includes("fm-project-mode.sh")) return hostRc("direct-PR off");
    if (cmd.includes("fm-spawn.sh") && !cmd.includes("native_command=")) {
      state.spawned++;
      if (opts.hangSpawn) {
        opts.abort?.abort();
        await new Promise(() => {});
      }
      state.spawnSucceeded = state.spawnExit === 0;
      return hostRc(state.spawnOutput, state.spawnExit);
    }
    if (cmd.includes("bb_thread_id")) {
      const tid = state.spawnSucceeded ? state.threadIdAfterSpawn : "";
      return hostRc(tid === "" ? "FM_META_ABSENT" : tid);
    }
    if (cmd.includes("FM_SPAWN_LOCK") || cmd.includes(".spawn-")) return hostRc("FM_SPAWN_LOCK=absent");
    return hostRc("");
  });
  return { host, seen, state };
}

function seedUncertain(host: Host, patch: Record<string, unknown> = {}) {
  const key = launchKey(ctx.projectId, ctx.threadId, HOME, TASK);
  launchStore(host).save({
    key, taskId: TASK, projectId: ctx.projectId, owner: ctx.threadId, home: HOME,
    generation: 1, shape: "ship", deliveryMode: "direct-PR", deliveryRequirement: "merged",
    state: "uncertain", threadId: null, nativeInvoked: true, hostId: "host_1", updatedAt: Date.now(),
    ...patch,
  } as never);
  return key;
}

test("fm-spawn exit 1 before create-worker reserves fails the slot, and the same id can start again", async () => {
  const { host, seen, state } = await realCaptain();
  try {
    const first = await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--", "fix login"], ctx);
    assert.equal(first.exitCode, 1, first.stderr);
    assert.match(first.stderr, /Launch 47806a51 \(failed\)/);
    assert.match(first.stderr, /No worker was created/);
    assert.match(first.stderr, /same id/);
    const record = launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK);
    assert.equal(record?.state, "failed");
    assert.equal(record?.threadId, null);
    assert.deepEqual(launchStore(host).heldTaskIds(ctx.threadId), []);
    assert.equal(spawnCommands(seen).length, 1);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);

    state.spawnExit = 0;
    state.threadIdAfterSpawn = "thr_worker";
    const retry = await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--", "fix login"], ctx);
    assert.equal(retry.exitCode, 0, retry.stderr);
    assert.equal(spawnCommands(seen).length, 2);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an abort while fm-spawn is still running keeps the reserved slot uncertain", { timeout: 20_000 }, async () => {
  const abort = new AbortController();
  const { host } = await realCaptain({ hangSpawn: true, abort });
  try {
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--", "fix login"],
      { ...ctx, signal: abort.signal },
    );
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /Launch 47806a51 \(uncertain\)/);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "uncertain");
    assert.equal(launchStore(host).heldTaskIds(ctx.threadId).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("help names launches release", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"], settings: { fmHome: HOME } });
  await plugin(host.bb);
  try {
    const help = await host.harness.behavior.runCli(["help"], ctx);
    assert.equal(help.exitCode, 0, help.stderr);
    assert.match(help.stdout, /bb firstmate launches release <task-id>/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an uncertain no-thread legacy launch can be released", async (t) => {
  const { host } = await realCaptain();
  try {
    seedUncertain(host);
    let lists = 0;
    host.harness.sdk.stub("threads.list", async () => {
      lists++;
      return [];
    });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const pending = host.harness.behavior.runCli(["launches", "release", TASK], ctx);
    for (let i = 0; i < 200 && lists < 1; i++) await Promise.resolve();
    assert.equal(lists, 1);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    t.mock.timers.tick(30_000);
    const result = await pending;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Released 47806a51/);
    const record = launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK);
    assert.equal(record?.state, "failed");
    assert.deepEqual(launchStore(host).heldTaskIds(ctx.threadId), []);
    assert.equal(lists, 2);
  } finally {
    t.mock.timers.reset();
    await host.harness.lifecycle.dispose();
  }
});

test("release refuses creationRequested, a matching thread, a live fm-spawn lock, and a non-owner thread", async () => {
  const { host } = await realCaptain();
  try {
    seedUncertain(host, { creationRequested: true });
    const requested = await host.harness.behavior.runCli(["launches", "release", TASK], ctx);
    assert.equal(requested.exitCode, 1, requested.stderr);
    assert.match(requested.stderr, /creationRequested|creation was requested/);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "uncertain");

    seedUncertain(host);
    host.harness.sdk.stub("threads.list", async () => [makeThreadResponse({ id: "thr_found", projectId: ctx.projectId, parentThreadId: ctx.threadId })]);
    host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => {
      if (threadId === ctx.threadId) return { captain: "true", nativeHome: HOME };
      if (threadId === "thr_found") return { launchKey: launchKey(ctx.projectId, ctx.threadId, HOME, TASK), generation: 1, nativeHome: HOME };
      return {};
    });
    const found = await host.harness.behavior.runCli(["launches", "release", TASK], ctx);
    assert.equal(found.exitCode, 1, found.stderr);
    assert.match(found.stderr, /thread/);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "uncertain");

    seedUncertain(host);
    host.harness.sdk.stub("threads.list", async () => []);
    const cmds = new Map<string, string>();
    let n = 0;
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      const id = `lock_${++n}`;
      cmds.set(id, args.start?.command ?? "");
      return { id };
    });
    host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
      const cmd = cmds.get(terminalId) ?? "";
      if (cmd.includes(".spawn-") || cmd.includes("FM_SPAWN_LOCK")) return hostRc("FM_SPAWN_LOCK=live");
      return hostRc("");
    });
    const live = await host.harness.behavior.runCli(["launches", "release", TASK], ctx);
    assert.equal(live.exitCode, 1, live.stderr);
    assert.match(live.stderr, /fm-spawn|spawn lock/);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "uncertain");

    seedUncertain(host);
    const foreign = await host.harness.behavior.runCli(["launches", "release", TASK], { threadId: "thr_other", projectId: ctx.projectId });
    assert.equal(foreign.exitCode, 1, foreign.stderr);
    assert.match(foreign.stderr, /owning captain|captain|home|project/);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "uncertain");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
