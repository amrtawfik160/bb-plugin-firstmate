import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { ATTEMPT_TOKEN_ENVIRON_PY, attemptTokenFromAdmissionOutput, createLaunches, launchKey } from "./lib/launch.ts";
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

async function realCaptain(opts: { hangSpawn?: boolean; abort?: AbortController; beforePlugin?: (host: Host) => void } = {}) {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: ["captain", "firstmate"],
    settings: { fmHome: HOME, fmHostId: "host_1", transport: "real", queueOwner: "real" },
  });
  await host.bb.storage.kv.set(`native-home:${ctx.threadId}`, HOME);
  await host.bb.storage.kv.set(`native-home-host:${ctx.threadId}`, "host_1");
  await host.bb.storage.kv.set(`captain-project:${ctx.threadId}`, ctx.projectId);
  opts.beforePlugin?.(host);
  await plugin(host.bb);
  stubProviderCatalog(host);
  const seen: string[] = [];
  const cmds = new Map<string, string>();
  const state = { spawnExit: 1, spawnOutput: ADMISSION_TIMEOUT, threadIdAfterSpawn: "", spawned: 0, spawnSucceeded: false, spawnCreateError: undefined as Error | undefined, onSpawn: undefined as undefined | (() => Promise<void>), omitSpawnMarker: false, envAttemptToken: undefined as string | undefined, failBriefStaging: false };
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
    if (state.spawnCreateError && (args.start?.command ?? "").includes("fm-spawn.sh") && !(args.start?.command ?? "").includes("native_command=")) throw state.spawnCreateError;
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const cmd = cmds.get(args.terminalId) ?? "";
    if (state.failBriefStaging && cmd.includes(".fm-brief-fill")) return hostRc("host file staging failed", 1);
    if (cmd.includes("fm-project-mode.sh")) return hostRc("direct-PR off");
    if (cmd.includes("fm-spawn.sh") && !cmd.includes("native_command=")) {
      state.spawned++;
      if (state.onSpawn) await state.onSpawn();
      if (opts.hangSpawn) {
        opts.abort?.abort();
        await new Promise(() => {});
      }
      state.spawnSucceeded = state.spawnExit === 0;
      if (state.omitSpawnMarker) return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(state.spawnOutput).toString("base64") }] };
      return hostRc(state.spawnOutput, state.spawnExit);
    }
    if (cmd.includes("bb_thread_id")) {
      const tid = state.spawnSucceeded ? state.threadIdAfterSpawn : "";
      return hostRc(tid === "" ? "FM_META_ABSENT" : tid);
    }
    if (cmd.includes("FM_SPAWN_LOCK") || cmd.includes(".spawn-")) {
      return hostRc(`FM_SPAWN_LOCK=absent\nFM_BB_ATTEMPT_TOKEN=${state.envAttemptToken ?? ""}`);
    }
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
    seedUncertain(host, { creationRequested: false });
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

// 20 Oct: retry reservations hermes-split-step3-1020 (generation 3, creation never requested) and reels-animate-6118
// (generation 2, since ~01:00 UTC, a record from before creationRequested was saved) held crew slots with no worker.
for (const [name, generation, ageMs, creationRequested] of [
  ["hermes-split-step3-1020", 3, 3 * 60 * 60_000, false],
  ["reels-animate-6118", 2, 12 * 60 * 60_000, undefined],
] as const) {
  test(`a reserved retry that never asked for a worker is released after the safe age (${name} shape)`, async (t) => {
    const { host } = await realCaptain();
    try {
      const store = launchStore(host);
      const first = launchKey(ctx.projectId, ctx.threadId, HOME, TASK);
      store.save({ key: first, taskId: TASK, projectId: ctx.projectId, owner: ctx.threadId, home: HOME, generation: 1, shape: "ship", deliveryMode: "direct-PR", deliveryRequirement: "merged",
        state: "running", threadId: "thr_source", nativeInvoked: true, hostId: "host_1", updatedAt: Date.now() - ageMs - 60_000 } as never);
      const key = launchKey(ctx.projectId, ctx.threadId, HOME, TASK, generation);
      store.save({ key, taskId: TASK, projectId: ctx.projectId, owner: ctx.threadId, home: HOME, generation, shape: "ship", deliveryMode: "direct-PR", deliveryRequirement: "merged",
        state: "reserved", threadId: null, hostId: "host_1", updatedAt: Date.now() - ageMs, ...(creationRequested === undefined ? {} : { creationRequested }),
        replacement: { sourceCrew: {}, sourceThreadId: "thr_source", environmentId: "env_wt", intent: "failure-recovery", reason: "", recoveryCount: 1, task: "fix login", prompt: "fix login", target: { providerId: "claude-code", model: null, reasoningLevel: null } } } as never);
      assert.deepEqual(store.heldTaskIds(ctx.threadId).length, 1, "the reservation holds a crew slot");
      let reads = 0;
      host.harness.sdk.stub("threads.list", async () => { reads++; return []; });
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
      const pending = host.harness.behavior.runCli(["launches", "release", TASK], ctx);
      await drain(() => reads === 1);
      for (let i = 0; i < 100; i++) await Promise.resolve();
      t.mock.timers.tick(30_000);
      const result = await pending;
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Released 47806a51/);
      assert.equal(store.get(key)?.state, "failed");
      assert.deepEqual(store.heldTaskIds(ctx.threadId), [], "the crew slot is free");
      assert.equal(store.get(first)?.state, "running", "the first generation's record is untouched");
    } finally {
      t.mock.timers.reset();
      await host.harness.lifecycle.dispose();
    }
  });
}

test("a reserved launch younger than the safe age is not released: a dispatch may still be starting it", async () => {
  const { host } = await realCaptain();
  try {
    seedUncertain(host, { state: "reserved", creationRequested: false, updatedAt: Date.now() - 5 * 60_000 });
    const result = await host.harness.behavior.runCli(["launches", "release", TASK], ctx);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /Release refused: the reservation is 5 min old\. A reservation that never asked for a worker can be released once it is 30 min old\./);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "reserved");
    const running = await (async () => { seedUncertain(host, { state: "running", threadId: "thr_w", updatedAt: 1 }); return host.harness.behavior.runCli(["launches", "release", TASK], ctx); })();
    assert.equal(running.exitCode, 1, running.stderr);
    assert.match(running.stderr, /Release refused: state is running\./);
  } finally {
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

    seedUncertain(host, { creationRequested: false });
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

    seedUncertain(host, { creationRequested: false });
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

    seedUncertain(host, { creationRequested: false });
    const foreign = await host.harness.behavior.runCli(["launches", "release", TASK], { threadId: "thr_other", projectId: ctx.projectId });
    assert.equal(foreign.exitCode, 1, foreign.stderr);
    assert.match(foreign.stderr, /owning captain|captain|home|project/);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "uncertain");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("create-worker refuses a mismatched attempt token and does not spawn", async () => {
  const { host } = await realCaptain();
  try {
    const key = launchKey(ctx.projectId, ctx.threadId, HOME, TASK);
    launchStore(host).save({
      key, taskId: TASK, projectId: ctx.projectId, owner: ctx.threadId, home: HOME,
      generation: 1, shape: "ship", deliveryMode: "direct-PR", deliveryRequirement: "merged",
      state: "reserved", threadId: null, nativeInvoked: true, hostId: "host_1", updatedAt: Date.now(),
      creationRequested: false, attemptToken: "token-a",
    } as never);
    host.harness.sdk.stub("files.read", async () => ({ content: "Native validated brief", contentEncoding: "utf8", sizeBytes: 22 }));
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_should_not_exist" }));
    const created = await host.harness.behavior.runCli(["create-worker", "--json", "--task", TASK, "--shape", "ship", "--project", ctx.projectId, "--home", HOME, "--host", "host_1", "--path", "/repo", "--prompt-file", "/tmp/brief", "--parent", ctx.threadId, "--native-pid", "999", "--attempt-token", "token-b"], ctx);
    assert.equal(created.exitCode, 1, created.stderr);
    assert.match(created.stderr, /token/);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    assert.equal(launchStore(host).get(key)?.threadId, null);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("legacy release is refused without a process boundary", async () => {
  const { host } = await realCaptain();
  try {
    seedUncertain(host, { updatedAt: Date.now() });
    const result = await host.harness.behavior.runCli(["launches", "release", TASK], ctx);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /process boundary|plugin process/);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "uncertain");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("legacy release is refused on a failed inventory page", async (t) => {
  const { host } = await realCaptain();
  try {
    seedUncertain(host, { updatedAt: 1 });
    host.harness.sdk.stub("threads.list", async () => { throw new Error("inventory page failed"); });
    const result = await host.harness.behavior.runCli(["launches", "release", TASK], ctx);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /inventory page|page read failed/);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "uncertain");
  } finally {
    t.mock.timers.reset();
    await host.harness.lifecycle.dispose();
  }
});

test("legacy release is refused when inventory pages never exhaust", async (t) => {
  const { host } = await realCaptain();
  try {
    seedUncertain(host, { updatedAt: 1 });
    host.harness.sdk.stub("threads.list", async ({ offset }: { offset?: number }) =>
      Array.from({ length: 50 }, (_, i) => makeThreadResponse({ id: `other_${(offset ?? 0) + i}`, projectId: ctx.projectId, parentThreadId: ctx.threadId })));
    const result = await host.harness.behavior.runCli(["launches", "release", TASK], ctx);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /limit|inventory/);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "uncertain");
  } finally {
    t.mock.timers.reset();
    await host.harness.lifecycle.dispose();
  }
});

test("a wrapped diagnostic is not a typed exit status for this attempt", async () => {
  const { host, state } = await realCaptain();
  try {
    state.spawnCreateError = new Error("ECONNRESET; context from earlier attempt: fm-spawn exit 1");
    const result = await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--", "fix login"], ctx);
    assert.equal(result.exitCode, 1);
    assert.equal(state.spawned, 0);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "uncertain");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

function createWorkerArgv(token: string | undefined) {
  return ["create-worker", "--json", "--task", TASK, "--shape", "ship", "--project", ctx.projectId, "--home", HOME, "--host", "host_1", "--path", "/repo", "--prompt-file", "/tmp/brief", "--parent", ctx.threadId, "--native-pid", "999", ...(token === undefined ? [] : ["--attempt-token", token])];
}

async function drain(condition: () => boolean) {
  for (let i = 0; i < 3000 && !condition(); i++) await Promise.resolve();
  assert.ok(condition());
}

test("incident-shaped legacy record releases after process boundary and exhaustive empty reads", async (t) => {
  const { host } = await realCaptain();
  try {
    const key = launchKey(ctx.projectId, ctx.threadId, HOME, TASK);
    launchStore(host).save({
      key, taskId: TASK, projectId: ctx.projectId, owner: ctx.threadId, home: HOME,
      generation: 1, shape: "ship", deliveryMode: "direct-PR", deliveryRequirement: "merged",
      state: "uncertain", threadId: null, nativeInvoked: true, hostId: "host_1", updatedAt: 1,
    } as never);
    let reads = 0;
    host.harness.sdk.stub("threads.list", async () => { reads++; return []; });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const pending = host.harness.behavior.runCli(["launches", "release", TASK], ctx);
    await drain(() => reads === 1);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    t.mock.timers.tick(30_000);
    const result = await pending;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(launchStore(host).get(key)?.state, "failed");
  } finally {
    t.mock.timers.reset();
    await host.harness.lifecycle.dispose();
  }
});

test("an active create-worker request cannot be released, and create rechecks the attempt token", async (t) => {
  let arm = false;
  let entered = false;
  let unpause = () => {};
  const gate = new Promise<void>((resolve) => { unpause = resolve; });
  const { host, state } = await realCaptain({
    beforePlugin(next) {
      const define = next.bb.settings.define.bind(next.bb.settings);
      next.bb.settings.define = ((schema: never) => {
        const obj = define(schema);
        const get = obj.get.bind(obj);
        return {
          ...obj,
          async get() {
            const value = await get();
            if (arm) {
              arm = false;
              entered = true;
              await gate;
            }
            return value;
          },
        };
      }) as typeof next.bb.settings.define;
    },
  });
  let work: Promise<{ exitCode: number; stderr: string }> | undefined;
  try {
    const store = launchStore(host);
    host.harness.sdk.stub("files.read", async () => {
      arm = true;
      return { content: "OLD attempt task prompt", contentEncoding: "utf8", sizeBytes: 23 };
    });
    host.harness.sdk.stub("threads.spawn", async (input: { prompt?: string }) => {
      assert.equal(input.prompt, "OLD attempt task prompt");
      return { id: "thr_stale_worker" };
    });
    let record: ReturnType<typeof store.get>;
    state.onSpawn = async () => {
      record = store.forTask(ctx.projectId, ctx.threadId, TASK);
      work = host.harness.behavior.runCli(createWorkerArgv(record?.attemptToken), ctx);
      await drain(() => entered);
    };
    const first = await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--", "OLD task"], ctx);
    assert.equal(first.exitCode, 1, first.stderr);
    assert.equal(store.get(record!.key)?.state, "uncertain");
    assert.equal(store.get(record!.key)?.createWorkerStarted, true);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const pendingRelease = host.harness.behavior.runCli(["launches", "release", TASK], ctx);
    for (let i = 0; i < 200; i++) await Promise.resolve();
    t.mock.timers.tick(30_000);
    const released = await pendingRelease;
    assert.equal(released.exitCode, 1, released.stderr);
    assert.match(released.stderr, /create-worker|still active|changed before/);
    assert.equal(store.get(record!.key)?.state, "uncertain");
    store.save({
      ...record!,
      state: "reserved",
      attemptToken: "new-token",
      createWorkerStarted: false,
      creationRequested: false,
      threadId: null,
      updatedAt: Date.now(),
    });
    unpause();
    const created = await work!;
    assert.equal(created.exitCode, 1, created.stderr);
    assert.match(created.stderr, /token/);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    assert.equal(store.get(record!.key)?.threadId, null);
  } finally {
    unpause();
    if (work) await work.catch(() => {});
    t.mock.timers.reset();
    await host.harness.lifecycle.dispose();
  }
});

test("a missing attempt token leaves a retryable failed launch", async () => {
  const { host, seen, state } = await realCaptain();
  try {
    const store = launchStore(host);
    host.harness.sdk.stub("files.read", async () => ({ content: "brief", contentEncoding: "utf8", sizeBytes: 5 }));
    let rejected: { exitCode: number; stderr: string } | undefined;
    state.onSpawn = async () => {
      rejected = await host.harness.behavior.runCli(createWorkerArgv(undefined), ctx);
    };
    const first = await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--", "fix login"], ctx);
    assert.equal(rejected?.exitCode, 1);
    assert.match(rejected?.stderr ?? "", /token/);
    assert.equal(first.exitCode, 1);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    assert.ok(spawnCommands(seen).some((c) => c.includes("export FM_BB_ATTEMPT_TOKEN=")));
    const record = store.forTask(ctx.projectId, ctx.threadId, TASK);
    assert.notEqual(record?.createWorkerStarted, true);
    assert.notEqual(record?.creationRequested, true);
    assert.equal(record?.state, "failed");
    state.spawnExit = 0;
    state.threadIdAfterSpawn = "thr_retry";
    const retry = await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--", "fix login"], ctx);
    assert.equal(retry.exitCode, 0, retry.stderr);
    assert.equal(state.spawned, 2);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an exited terminal without an RC marker or exit code stays uncertain", async () => {
  const { host, state } = await realCaptain();
  try {
    state.omitSpawnMarker = true;
    state.spawnOutput = "gateway timeout; terminal ended without a native return-code marker";
    host.harness.sdk.stub("terminals.get", async () => ({ status: "exited" }));
    const result = await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--", "fix login"], ctx);
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(result.stderr, /fm-spawn exit 1/);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "uncertain");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("committed native-lock test does not source the review-only fixture path", () => {
  const source = readFileSync(new URL("./server.checker172.test.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\/tmp\/verify-172-r1/);
});

test("a duplicate create-worker failure does not clear another active handler", async (t) => {
  const { host, state } = await realCaptain();
  let unpause = () => {};
  const gate = new Promise<void>((resolve) => { unpause = resolve; });
  let entered = false;
  let reads = 0;
  let work: Promise<{ exitCode: number; stderr: string }> | undefined;
  try {
    const store = launchStore(host);
    let record: ReturnType<typeof store.get>;
    host.harness.sdk.stub("files.read", async () => {
      if (++reads === 1) {
        entered = true;
        await gate;
        throw new Error("original prompt still failing");
      }
      throw new Error("definite duplicate prompt read failure");
    });
    state.onSpawn = async () => {
      record = store.forTask(ctx.projectId, ctx.threadId, TASK);
      work = host.harness.behavior.runCli(createWorkerArgv(record?.attemptToken), ctx);
      await drain(() => entered);
    };
    const dispatched = await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--", "fix login"], ctx);
    assert.equal(dispatched.exitCode, 1);
    assert.equal(store.get(record!.key)?.state, "uncertain");
    assert.equal(store.get(record!.key)?.createWorkerStarted, true);
    const listed = await host.harness.behavior.runCli(["launches", "list"], ctx);
    assert.equal(listed.exitCode, 0);
    assert.match(listed.stdout, /47806a51 uncertain/);
    const duplicate = await host.harness.behavior.runCli(createWorkerArgv(record!.attemptToken), ctx);
    assert.equal(duplicate.exitCode, 1);
    assert.match(duplicate.stderr, /duplicate prompt read failure/);
    assert.equal(store.get(record!.key)?.createWorkerStarted, true);
    const refused = await host.harness.behavior.runCli(["launches", "release", TASK], ctx);
    assert.equal(refused.exitCode, 1, refused.stderr);
    assert.match(refused.stderr, /still running/);
    assert.match(refused.stderr, /restart/);
    assert.equal(store.get(record!.key)?.state, "uncertain");
    unpause();
    const first = await work!;
    assert.equal(first.exitCode, 1, first.stderr);
    assert.notEqual(store.get(record!.key)?.createWorkerStarted, true);
    let inventoryReads = 0;
    host.harness.sdk.stub("threads.list", async () => { inventoryReads++; return []; });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const pendingRelease = host.harness.behavior.runCli(["launches", "release", TASK], ctx);
    await drain(() => inventoryReads === 1);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    t.mock.timers.tick(30_000);
    const released = await pendingRelease;
    assert.equal(released.exitCode, 0, released.stderr);
    assert.equal(store.get(record!.key)?.state, "failed");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    unpause();
    if (work) await work.catch(() => {});
    t.mock.timers.reset();
    await host.harness.lifecycle.dispose();
  }
});

test("the reserved attempt token reaches the fm-spawn process environment through the real host command", async () => {
  const { host, seen } = await realCaptain();
  const dir = mkdtempSync(join(tmpdir(), "fm-attempt-env-"));
  try {
    await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--", "fix login"], ctx);
    const token = launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.attemptToken;
    assert.ok(token);
    const wrapped = spawnCommands(seen).find((c) => c.includes("export FM_BB_ATTEMPT_TOKEN="));
    const match = /^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(wrapped ?? "");
    assert.ok(match, "spawn command keeps the host runner wrapper");
    const inner = match[1]!.replace(/'\\''/g, "'").replaceAll(HOME, dir);
    // An old runtime: fm-spawn.sh owns the lock pid, and its bb.sh passes --native-pid "$$" with no
    // --attempt-token. Admission runs in another process without the variable and reads the pid's environ.
    writeFileSync(join(dir, "admission.py"), ATTEMPT_TOKEN_ENVIRON_PY);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "fm-spawn.sh"), [
      "#!/usr/bin/env bash",
      `lock="$FM_HOME/state/.spawn-$1.lock"; mkdir -p "$lock"; echo "$$" > "$lock/pid"`,
      `env -u FM_BB_ATTEMPT_TOKEN python3 "$FM_HOME/admission.py" "$(cat "$lock/pid")" > "$FM_HOME/admission.out"`,
    ].join("\n"), { mode: 0o755 });
    const run = spawnSync("bash", ["-c", inner], { encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(attemptTokenFromAdmissionOutput(readFileSync(join(dir, "admission.out"), "utf8")), token);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await host.harness.lifecycle.dispose();
  }
});

test("an old-runtime create-worker still creates when the spawn process env carries the matching token", async () => {
  const { host, state } = await realCaptain();
  try {
    const key = launchKey(ctx.projectId, ctx.threadId, HOME, TASK);
    launchStore(host).save({
      key, taskId: TASK, projectId: ctx.projectId, owner: ctx.threadId, home: HOME,
      generation: 1, shape: "ship", deliveryMode: "direct-PR", deliveryRequirement: "merged",
      state: "reserved", threadId: null, nativeInvoked: true, hostId: "host_1", updatedAt: Date.now(),
      creationRequested: false, attemptToken: "token-a",
    } as never);
    state.envAttemptToken = "token-a";
    host.harness.sdk.stub("files.read", async () => ({ content: "Native validated brief", contentEncoding: "utf8", sizeBytes: 22 }));
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_env_token" }));
    const created = await host.harness.behavior.runCli(createWorkerArgv(undefined), ctx);
    assert.equal(created.exitCode, 0, created.stderr);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1);
    assert.equal(launchStore(host).get(key)?.threadId, "thr_env_token");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a wrong spawn-process env attempt token is refused and does not spawn", async () => {
  const { host, state } = await realCaptain();
  try {
    const key = launchKey(ctx.projectId, ctx.threadId, HOME, TASK);
    launchStore(host).save({
      key, taskId: TASK, projectId: ctx.projectId, owner: ctx.threadId, home: HOME,
      generation: 1, shape: "ship", deliveryMode: "direct-PR", deliveryRequirement: "merged",
      state: "reserved", threadId: null, nativeInvoked: true, hostId: "host_1", updatedAt: Date.now(),
      creationRequested: false, attemptToken: "token-a",
    } as never);
    state.envAttemptToken = "token-wrong";
    host.harness.sdk.stub("files.read", async () => ({ content: "Native validated brief", contentEncoding: "utf8", sizeBytes: 22 }));
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_should_not_exist" }));
    const created = await host.harness.behavior.runCli(createWorkerArgv(undefined), ctx);
    assert.equal(created.exitCode, 1, created.stderr);
    assert.match(created.stderr, /token/);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    assert.equal(launchStore(host).get(key)?.threadId, null);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a failed scout start then a same-id ship start launches and rewrites the native brief", async () => {
  const { host, seen, state } = await realCaptain();
  try {
    const first = await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--shape", "scout", "--", "survey login"], ctx);
    assert.equal(first.exitCode, 1, first.stderr);
    const record = launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK);
    assert.equal(record?.state, "failed");
    assert.equal(record?.shape, "scout");
    assert.equal(record?.threadId, null);
    assert.equal(spawnCommands(seen).length, 1);
    const before = seen.length;
    state.spawnExit = 0;
    state.threadIdAfterSpawn = "thr_ship";
    const retry = await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--shape", "ship", "--", "fix login"], ctx);
    assert.equal(retry.exitCode, 0, retry.stderr);
    assert.equal(spawnCommands(seen).length, 2);
    assert.ok(seen.slice(before).some((c) => c.includes("rm -f") && c.includes("launch-brief.md")));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a scout-to-ship retry that fails at brief staging keeps the rewrite for the next ship retry (177 check 1)", async () => {
  const { host, seen, state } = await realCaptain();
  try {
    const args = (shape: string, task: string) => ["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--shape", shape, "--", task];
    const first = await host.harness.behavior.runCli(args("scout", "survey login"), ctx);
    assert.equal(first.exitCode, 1, first.stderr);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.shape, "scout");
    assert.equal(spawnCommands(seen).length, 1);

    // The ship retry saves its shape, then host staging fails before the brief is rewritten.
    state.failBriefStaging = true;
    const staged = await host.harness.behavior.runCli(args("ship", "fix login"), ctx);
    assert.equal(staged.exitCode, 1, staged.stderr);
    assert.match(staged.stderr, /could not stage the brief text/);
    const failed = launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK);
    assert.equal(failed?.shape, "ship");
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.threadId, null);
    assert.equal(failed?.creationRequested, false);
    assert.equal(spawnCommands(seen).length, 1, "no spawn ran without a brief");

    state.failBriefStaging = false;
    state.spawnExit = 0;
    state.threadIdAfterSpawn = "thr_ship";
    const before = seen.length;
    const retry = await host.harness.behavior.runCli(args("ship", "fix login"), ctx);
    assert.equal(retry.exitCode, 0, retry.stderr);
    const briefScript = seen.slice(before).find((c) => c.includes("fm-brief.sh") && c.includes(".fm-brief-fill") && !c.includes(".fm-b64-"));
    assert.ok(briefScript, "the retry rewrites the native brief");
    assert.ok(briefScript.indexOf("launch-brief.md") > -1 && briefScript.indexOf("rm -f") < briefScript.indexOf("crew --mode"), "the scout brief is removed before the ship scaffold");
    assert.doesNotMatch(briefScript, /crew --scout/);
    const spawns = spawnCommands(seen.slice(before));
    assert.equal(spawns.length, 1, "exactly one ship start");
    assert.doesNotMatch(spawns[0]!, /--scout/);
    assert.match(spawns[0]!, /--mode/);
    const launched = launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK);
    assert.equal(launched?.threadId, "thr_ship");
    assert.equal(launched?.shape, "ship");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an unsafe same-id shape change is refused with a new id instead of spawning", async () => {
  const { host, seen } = await realCaptain();
  try {
    seedUncertain(host, { shape: "scout" });
    const result = await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--shape", "ship", "--", "fix login"], ctx);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /new id/);
    assert.doesNotMatch(result.stderr, /same id/);
    assert.equal(spawnCommands(seen).length, 0);
    assert.equal(launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK)?.state, "uncertain");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a stored dispatch error keeps attempt token mismatch when fm-spawn appends a long bb cli errors dump", async () => {
  const { host, state } = await realCaptain();
  try {
    const dump = "bb firstmate status UNAVAILABLE\n".repeat(150);
    state.spawnOutput = `error: Creation refused: attempt token mismatch.\nbb cli errors:\n${dump}`;
    const result = await host.harness.behavior.runCli(["dispatch", "--project", ctx.projectId, "--task-id", TASK, "--", "fix login"], ctx);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /attempt token mismatch/);
    const record = launchStore(host).forTask(ctx.projectId, ctx.threadId, TASK);
    assert.match(record?.error ?? "", /attempt token mismatch/);
    assert.doesNotMatch(record?.error ?? "", /bb cli errors:/);
    assert.doesNotMatch(result.stderr, /UNAVAILABLE/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
