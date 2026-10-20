import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";
import plugin from "./server.ts";
import { createLaunches } from "./lib/launch.ts";

type Host = ReturnType<typeof createFakePluginHost>;
const SKILLS = ["captain", "firstmate"];
const HOME = "/tmp/fm-idle-home";
const CAPTAIN = "thr_cap";
const CREW = "thr_crew";

async function load(settings: Record<string, unknown> = {}) {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: {
      watchOwner: "fm-watch",
      watchHeartbeatSec: 30,
      signInCheck: false,
      ...settings,
    },
  });
  await plugin(host.bb);
  stubProviderCatalog(host);
  return host;
}

function tool(host: Host, name: string) {
  const found = host.harness.inspection.registrations.agentTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not registered`);
  return found!;
}

function text(result: unknown): string {
  if (typeof result === "string") return result;
  return (result as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n");
}

const logs = (host: Host, level: string, pattern: RegExp) =>
  host.harness.logEntries.filter((e) => e.level === level && pattern.test(e.message)).map((e) => e.message);

function hostRc(payload: string, code = 0) {
  return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${payload}\n__FM_HOST_RC:${code}\n`).toString("base64") }] };
}

function hostCommands(host: Host, answer: (command: string) => string) {
  const commands: string[] = [];
  let n = 0;
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
    const id = `t_${++n}`;
    commands.push(args.start?.command ?? "");
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const idx = Number(args.terminalId.slice(2)) - 1;
    return hostRc(answer(commands[idx] ?? ""));
  });
  return commands;
}

function isStopCommand(cmd: string): boolean {
  return cmd.includes("rm -f") && cmd.includes("fm-watch-arm.sh") && cmd.includes("--stop") && !cmd.includes("FM_OWNER_BEAT");
}

function isSuperviseCommand(cmd: string): boolean {
  return cmd.includes("FM_OWNER_BEAT") || cmd.includes("FM_KEEPER_LAUNCHED") || cmd.includes("FM_BEAT_AGE");
}

function isSourceProbe(cmd: string): boolean {
  return cmd.includes("FM_WATCH_SOURCE=");
}

function isWakeAppend(cmd: string): boolean {
  return cmd.includes("fm_wake_append");
}

function crewRow(threadId: string, extra: Record<string, unknown> = {}) {
  return {
    id: "c1",
    task: "fix login",
    projectId: "proj_1",
    threadId,
    parentThreadId: CAPTAIN,
    providerId: null,
    worktree: true,
    shape: "ship" as const,
    posture: "direct-PR",
    createdAt: "2026-09-18T00:00:00.000Z",
    ...extra,
  };
}

async function bindHome(host: Host) {
  await host.bb.storage.kv.set(`native-home:${CAPTAIN}`, HOME);
  await host.bb.storage.kv.set(`native-home-host:${CAPTAIN}`, "host_1");
}

function answerHost(cmd: string, source: () => string): string {
  if (isSourceProbe(cmd)) return `FM_WATCH_SOURCE=${source()}`;
  if (isWakeAppend(cmd)) return "FM_BB_WAKE_SEQ=1";
  if (isSuperviseCommand(cmd)) return "FM_OWNER_BEAT=ok\nFM_BEAT_AGE=5\nFM_KEEPER=alive\n---FM_LOGTAIL---\n";
  if (cmd.includes("FMWAKES")) return "FMWAKES=0";
  if (cmd.includes("project-mode")) return "direct-PR off";
  return "";
}

function stubCaptain(host: Host, status: string, extra: Record<string, unknown> = {}, crewStatus = "idle") {
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
    if (threadId === CREW) {
      return makeThreadResponse({ id: CREW, projectId: "proj_1", status: crewStatus, environmentId: null });
    }
    return makeThreadResponse({ id: threadId, projectId: "proj_1", status, environmentId: null, ...extra });
  });
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.output", async () => ({ output: "" }));
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_1", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }));
  host.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "App", kind: "repo" }));
}

async function runWatchUntil(host: Host, check: () => boolean) {
  const run = host.harness.behavior.runService("captain-home-watch");
  const deadline = Date.now() + 4000;
  let hit = false;
  while (!(hit = check()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  run.controller.abort();
  await run.done;
  return hit;
}

test("the home watcher stops when nothing is live", async () => {
  const host = await load();
  try {
    await bindHome(host);
    stubCaptain(host, "idle");
    const commands = hostCommands(host, (cmd) => answerHost(cmd, () => "none"));
    const stopped = await runWatchUntil(host, () => commands.some(isStopCommand));
    assert.equal(stopped, true);
    assert.equal(commands.some(isSuperviseCommand), false);
    assert.match(logs(host, "info", /watcher stopped/).join("\n"), /thr_cap: watcher stopped \(nothing live\)/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the home watcher keeps running while a crew runs even if the captain thread is in error", async () => {
  const host = await load();
  try {
    await bindHome(host);
    await host.bb.storage.kv.set("crews", [crewRow(CREW)]);
    stubCaptain(host, "error", {}, "active");
    host.harness.sdk.stub("threads.list", async () => [makeThreadResponse({ id: CREW, status: "active", parentThreadId: CAPTAIN })]);
    const commands = hostCommands(host, (cmd) => answerHost(cmd, () => "none"));
    const supervised = await runWatchUntil(host, () => commands.some(isSuperviseCommand));
    assert.equal(supervised, true);
    assert.equal(commands.some(isStopCommand), false);
    assert.deepEqual(logs(host, "info", /watcher stopped/), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the home watcher starts again on dispatch with no manual step", async () => {
  const host = await load();
  try {
    await bindHome(host);
    stubCaptain(host, "idle");
    host.harness.sdk.stub("threads.spawn", async () => ({ id: CREW }));
    host.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "grok-4", reasoningLevel: "high" }));
    host.harness.sdk.stub("projects.defaultExecutionOptions", async () => ({ providerId: "acp-grok" }));
    const commands = hostCommands(host, (cmd) => answerHost(cmd, () => "none"));
    assert.equal(await runWatchUntil(host, () => commands.some(isStopCommand)), true);
    const before = commands.filter(isSuperviseCommand).length;
    const dispatched = await tool(host, "firstmate_dispatch").execute(
      { task: "fix login", projectId: "proj_1", taskId: "c-dispatch", worktree: false, shape: "scout" },
      { threadId: CAPTAIN, projectId: "proj_1" } as never,
    );
    assert.equal((dispatched as { isError?: boolean }).isError === true, false, text(dispatched));
    assert.ok(commands.filter(isSuperviseCommand).length > before);
    assert.match(logs(host, "info", /watcher restarted/).join("\n"), /thr_cap: watcher restarted \(in-flight launch\)/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the home watcher starts again on a queued wake", async () => {
  const host = await load({ notifyOwner: "real", supervisionEnabled: true });
  try {
    await bindHome(host);
    await host.bb.storage.kv.set("crews", [crewRow(CREW)]);
    stubCaptain(host, "idle");
    const commands = hostCommands(host, (cmd) => answerHost(cmd, () => "none"));
    assert.equal(await runWatchUntil(host, () => commands.some(isStopCommand)), true);
    const before = commands.filter(isSuperviseCommand).length;
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: CREW, status: "idle", projectId: "proj_1" }),
      lastAssistantText: "DONE: login fixed",
    });
    assert.ok(commands.some(isWakeAppend), "the wake must be written to the durable queue");
    assert.ok(commands.filter(isSuperviseCommand).length > before);
    assert.match(logs(host, "info", /watcher restarted/).join("\n"), /thr_cap: watcher restarted \(queued wake\)/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a wake written while the watcher is stopped is kept and picked up on restart", async () => {
  const host = await load({ notifyOwner: "real", supervisionEnabled: true });
  try {
    await bindHome(host);
    await host.bb.storage.kv.set("crews", [crewRow(CREW)]);
    stubCaptain(host, "idle");
    const commands = hostCommands(host, (cmd) => answerHost(cmd, () => "none"));
    assert.equal(await runWatchUntil(host, () => commands.some(isStopCommand)), true);
    const stop = commands.find(isStopCommand) ?? "";
    assert.doesNotMatch(stop, /ack-through|wake-drain|fm_wake_ack/);
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: CREW, status: "idle", projectId: "proj_1" }),
      lastAssistantText: "DONE: login fixed",
    });
    assert.ok(commands.some(isWakeAppend));
    assert.ok(commands.some(isSuperviseCommand));
    assert.match(logs(host, "info", /watcher restarted/).join("\n"), /queued wake/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a nonempty durable queue on the first idle pass keeps the watcher", async () => {
  const host = await load();
  try {
    await bindHome(host);
    stubCaptain(host, "idle");
    const commands = hostCommands(host, (cmd) => answerHost(cmd, () => "wake-queue"));
    const supervised = await runWatchUntil(host, () => commands.some(isSuperviseCommand) || commands.some(isStopCommand));
    assert.equal(supervised, true);
    assert.equal(commands.some(isStopCommand), false);
    assert.equal(commands.some(isSuperviseCommand), true);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an in-flight launch record keeps the watcher while the captain is idle", async () => {
  const host = await load();
  try {
    await bindHome(host);
    stubCaptain(host, "idle");
    createLaunches(host.bb.storage.database()).save({
      key: JSON.stringify(["proj_1", CAPTAIN, HOME, "job1", 1]),
      taskId: "job1",
      projectId: "proj_1",
      owner: CAPTAIN,
      home: HOME,
      generation: 1,
      shape: "ship",
      deliveryMode: "direct-PR",
      deliveryRequirement: "merged",
      state: "reserved",
      threadId: null,
      updatedAt: Date.now(),
    });
    const commands = hostCommands(host, (cmd) => answerHost(cmd, () => "none"));
    const supervised = await runWatchUntil(host, () => commands.some(isSuperviseCommand) || commands.some(isStopCommand));
    assert.equal(supervised, true);
    assert.equal(commands.some(isStopCommand), false);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a registered native check keeps the watcher while every crew is idle", async () => {
  const host = await load();
  try {
    await bindHome(host);
    stubCaptain(host, "error");
    const commands = hostCommands(host, (cmd) => answerHost(cmd, () => "check"));
    const supervised = await runWatchUntil(host, () => commands.some(isSuperviseCommand) || commands.some(isStopCommand));
    assert.equal(supervised, true);
    assert.equal(commands.some(isStopCommand), false);
    assert.deepEqual(logs(host, "info", /watcher stopped/), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an unreadable probe keeps the watcher", async () => {
  const host = await load();
  try {
    await bindHome(host);
    stubCaptain(host, "idle");
    const commands = hostCommands(host, (cmd) => (isSourceProbe(cmd) ? "garbled" : answerHost(cmd, () => "none")));
    const supervised = await runWatchUntil(host, () => commands.some(isSuperviseCommand) || commands.some(isStopCommand));
    assert.equal(supervised, true);
    assert.equal(commands.some(isStopCommand), false);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a stopped watcher probes again after a native script run and restarts for the source it finds", async () => {
  const host = await load({ fmHostId: "host_1" });
  try {
    await bindHome(host);
    stubCaptain(host, "idle");
    let source = "none";
    const commands = hostCommands(host, (cmd) => answerHost(cmd, () => source));
    assert.equal(await runWatchUntil(host, () => commands.some(isStopCommand)), true);
    const probes = () => commands.filter(isSourceProbe).length;
    const afterStop = probes();
    // While stopped, a pass reuses the last probe: no new host command.
    let reads = 0;
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (threadId === CAPTAIN) reads++;
      return makeThreadResponse({ id: threadId, projectId: "proj_1", status: "idle", environmentId: null });
    });
    let firstRead = 0;
    await runWatchUntil(host, () => {
      if (reads > 0 && firstRead === 0) firstRead = Date.now();
      return firstRead > 0 && Date.now() - firstRead > 150;
    });
    assert.ok(reads > 0);
    assert.equal(probes(), afterStop);
    assert.equal(commands.filter(isSuperviseCommand).length, 0);
    source = "check";
    await tool(host, "firstmate_fm").execute({ script: "status" }, { threadId: CAPTAIN, projectId: "proj_1" } as never);
    assert.equal(await runWatchUntil(host, () => commands.some(isSuperviseCommand)), true);
    assert.ok(probes() > afterStop);
    assert.match(logs(host, "info", /watcher restarted/).join("\n"), /thr_cap: watcher restarted \(native wake source: registered check\)/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a captain turn on a running watcher leaves supervision to the pass", async () => {
  const host = await load();
  try {
    await bindHome(host);
    stubCaptain(host, "active");
    const commands = hostCommands(host, (cmd) => answerHost(cmd, () => "none"));
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: CAPTAIN, status: "active", projectId: "proj_1" }),
    });
    assert.equal(commands.some(isSuperviseCommand), false);
    assert.deepEqual(logs(host, "info", /watcher restarted/), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
