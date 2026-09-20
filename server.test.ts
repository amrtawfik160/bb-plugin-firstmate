import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { formatFmMeta, formatSecondmate, pickSecondmate, toolbeltPhrase, versionAtLeast } from "./server.ts";

const SKILLS = ["captain", "firstmate", "afk", "ahoy", "bearings", "quiet", "stow"] as const;

async function load() {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
  });
  await plugin(host.bb);
  return host;
}

test("cli help lists dispatch and deck", async () => {
  const host = await load();
  try {
    const result = await host.harness.behavior.runCli([]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /bb firstmate dispatch/);
    assert.match(result.stdout, /bb firstmate deck/);
    assert.match(result.stdout, /bb firstmate fm/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("crews get no dispatch tools", async () => {
  const host = await load();
  try {
    const cfg = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { crew: "true" } }),
    );
    assert.deepEqual(cfg.tools.map((t) => t.name), []);
    assert.deepEqual(cfg.skills, []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("unmarked threads still get firstmate_deck so /captain can take the deck", async () => {
  const host = await load();
  try {
    const cfg = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: {} }),
    );
    const names = cfg.tools.map((t) => t.name);
    assert.ok(names.includes("firstmate_deck"));
    assert.ok(names.includes("firstmate_dispatch"));
    assert.ok(names.includes("firstmate_interrupt"));
    assert.ok(names.includes("firstmate_queue"));
    assert.ok(names.includes("firstmate_fm"));
    assert.deepEqual(cfg.skills, ["firstmate"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("captain metadata loads the full skill set", async () => {
  const host = await load();
  try {
    const cfg = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { captain: "true" } }),
    );
    assert.ok(cfg.skills.includes("captain"));
    assert.ok(cfg.skills.includes("afk"));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("bearings on an empty fleet", async () => {
  const host = await load();
  try {
    const result = await host.harness.behavior.runCli(["bearings"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /No crews, no queue, no decisions/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("dispatch spawns an isolated ship worktree", async () => {
  const host = await load();
  try {
    host.harness.sdk.stub("threadSections.list", async () => []);
    host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_crew" }));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_crew", status: "starting" }));
    const result = await host.harness.behavior.runCli(
                      ["dispatch", "--project", "proj_1", "--", "fix flaky login"],
                      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Dispatched ship crew/);
    const spawnCalls = host.harness.sdk.callsTo("threads.spawn");
    assert.equal(spawnCalls.length, 1);
    const args = spawnCalls[0]![0] as {
      environment?: { type?: string; hostId?: string; workspace?: { type?: string } };
      visibility?: string;
    };
    assert.equal(args.environment?.type, "host");
    assert.equal(args.environment?.hostId, "host_1");
    assert.equal(args.environment?.workspace?.type, "managed-worktree");
    assert.equal(args.visibility, "visible");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("dispatch falls back to a normal spawn when the secondmate thread is dead", async () => {
  const host = await load();
  try {
    host.harness.sdk.stub("threadSections.list", async () => []);
    host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    // A registered secondmate whose thread is dead: the routing send throws.
    await host.bb.storage.kv.set("secondmates", [
      { projectId: "proj_1", threadId: "thr_dead", scope: "", projects: [], createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    host.harness.sdk.stub("threads.send", async () => { throw new Error("thread archived"); });
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_crew" }));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_crew", status: "starting" }));
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Dispatched ship crew/, "must fall back to a real spawn, not fail");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1, "task must be spawned, never lost");
    const crews = (await host.bb.storage.kv.get("crews")) as Array<{ id: string; posture: string }>;
    assert.ok(!crews.some((c) => c.id.startsWith("sm-")), "no routed secondmate crew when the send failed");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("formatFmMeta matches fm-spawn bb keys", () => {
  const scout = formatFmMeta({
    id: "abc12def",
    threadId: "thr_x",
    worktree: "/wt",
    project: "/repo",
    kind: "scout",
    spawnGen: "s1",
  });
  assert.match(scout, /^window=thr_x$/m);
  assert.match(scout, /^endpoint_task_id=abc12def$/m);
  assert.match(scout, /^worktree=\/wt$/m);
  assert.match(scout, /^project=\/repo$/m);
  assert.match(scout, /^harness=bb$/m);
  assert.match(scout, /^kind=scout$/m);
  assert.match(scout, /^tasktmp=\/tmp\/fm-abc12def$/m);
  assert.match(scout, /^model=default$/m);
  assert.match(scout, /^effort=default$/m);
  assert.match(scout, /^spawn_gen=s1$/m);
  assert.match(scout, /^backend=bb$/m);
  assert.match(scout, /^bb_thread_id=thr_x$/m);
  assert.doesNotMatch(scout, /^mode=/m);
  assert.doesNotMatch(scout, /^yolo=/m);

  const ship = formatFmMeta({
    id: "ship1",
    threadId: "thr_s",
    worktree: "/wt2",
    project: "/repo",
    kind: "ship",
    mode: "direct-PR",
    yolo: "off",
    model: "composer",
    spawnGen: "s2",
  });
  assert.match(ship, /^kind=ship$/m);
  assert.match(ship, /^mode=direct-PR$/m);
  assert.match(ship, /^yolo=off$/m);
  assert.match(ship, /^model=composer$/m);
});

function hostRcOutput(code = 0) {
  const text = `\n__FM_HOST_RC:${code}\n`;
  return {
    nextSeq: 1,
    chunks: [{ dataBase64: Buffer.from(text).toString("base64") }],
  };
}

test("dispatch with fmHome writes state meta and forget drops it", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home" },
  });
  await plugin(host.bb);
  try {
    const hostCommands: string[] = [];
    host.harness.sdk.stub("threadSections.list", async () => []);
    host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    host.harness.sdk.stub("environments.get", async () => ({
      id: "env_wt",
      hostId: "host_1",
      path: "/wt",
      isWorktree: true,
      status: "ready",
    }));
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_crew" }));
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "starting", environmentId: "env_wt" }),
    );
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      if (typeof args.start?.command === "string") hostCommands.push(args.start.command);
      return { id: "term_1" };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.output", async () => hostRcOutput(0));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /fm: bb firstmate fm peek -- /);
    const idMatch = /Dispatched ship crew (\S+)/.exec(result.stdout);
    assert.ok(idMatch);
    const crewId = idMatch[1]!;
    const writeCmd = hostCommands.find((cmd) => cmd.includes("window=thr_crew"));
    assert.ok(writeCmd, `no meta write command in ${hostCommands.join("\n---\n")}`);
    assert.match(writeCmd, /window=thr_crew/);
    assert.match(writeCmd, new RegExp(`endpoint_task_id=${crewId}`));
    assert.match(writeCmd, /worktree=\/wt/);
    assert.match(writeCmd, /project=\/repo/);
    assert.match(writeCmd, /backend=bb/);
    assert.match(writeCmd, /kind=ship/);
    assert.match(writeCmd, /mode=direct-PR/);
    assert.match(writeCmd, /yolo=off/);
    assert.ok(writeCmd.includes("/tmp/fm-home/state"));

    const forgotten = await host.harness.behavior.runCli(["forget", crewId], { projectId: "proj_1" });
    assert.equal(forgotten.exitCode, 0, forgotten.stderr);
    assert.ok(hostCommands.some((cmd) => cmd.includes(`rm -f`) && cmd.includes(`${crewId}.meta`)));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

function stubCaptainDeck(host: Awaited<ReturnType<typeof load>>, thread = makeThreadResponse({
  id: "thr_cap",
  title: null,
  titleFallback: "/captain",
  projectId: "proj_1",
})) {
  host.harness.sdk.stub("threads.get", async () => thread);
  host.harness.sdk.stub("threads.update", async (args: unknown) => args);
  host.harness.sdk.stub("threads.pin", async (args: unknown) => args);
  host.harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  host.harness.sdk.stub("projects.get", async () => ({
    id: "proj_1",
    name: "Cyndra SaaS",
    kind: "standard" as const,
    gitRemoteUrl: null,
    sources: [],
    createdAt: 0,
    updatedAt: 0,
  }));
}

test("deck titles and pins an untitled /captain thread", async () => {
  const host = await load();
  try {
    stubCaptainDeck(host);
    const result = await host.harness.behavior.runCli(["deck"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(result.exitCode, 0, result.stderr);
    const updates = host.harness.sdk.callsTo("threads.update");
    assert.equal(updates.length, 1);
    assert.equal((updates[0]![0] as { title?: string }).title, "Captain · Cyndra SaaS");
    assert.equal(host.harness.sdk.callsTo("threads.pin").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("deck reports real firstmate active and does not re-init when fmHome is set", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home" },
  });
  await plugin(host.bb);
  try {
    stubCaptainDeck(host);
    const result = await host.harness.behavior.runCli(["deck"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Real firstmate: active \(fmHome \/tmp\/fm-home;/);
    assert.match(result.stdout, /bb firstmate fm spawn/);
    // Already initialized: deck must not clone or create a project again.
    assert.equal(host.harness.sdk.callsTo("projects.create").length, 0);
    assert.equal(host.harness.sdk.callsTo("terminals.create").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("deck surfaces the one-time init command when real firstmate is not activatable", async () => {
  const host = await load();
  try {
    stubCaptainDeck(host);
    // No thread environment → host cannot be resolved → auto-init is skipped gracefully.
    const result = await host.harness.behavior.runCli(["deck"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Real firstmate: not active yet/);
    assert.match(result.stdout, /bb firstmate init --real/);
    // Native BB deck still succeeded (thread titled + pinned).
    assert.equal(host.harness.sdk.callsTo("threads.pin").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("new /captain thread is titled and pinned on create, before deck runs", async () => {
  const host = await load();
  try {
    stubCaptainDeck(host);
    const emitted = await host.harness.behavior.emitThreadEvent("thread.created", {
      thread: makeThreadResponse({
        id: "thr_cap",
        title: null,
        titleFallback: "/captain",
        projectId: "proj_1",
      }),
    });
    assert.deepEqual(emitted.errors, []);
    const updates = host.harness.sdk.callsTo("threads.update");
    assert.equal(updates.length, 1);
    assert.equal((updates[0]![0] as { title?: string }).title, "Captain · Cyndra SaaS");
    assert.equal(host.harness.sdk.callsTo("threads.pin").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("ordinary new threads are not titled as captain", async () => {
  const host = await load();
  try {
    stubCaptainDeck(host);
    const emitted = await host.harness.behavior.emitThreadEvent("thread.created", {
      thread: makeThreadResponse({
        id: "thr_other",
        title: null,
        titleFallback: "Fix login",
        projectId: "proj_1",
      }),
    });
    assert.deepEqual(emitted.errors, []);
    assert.equal(host.harness.sdk.callsTo("threads.update").length, 0);
    assert.equal(host.harness.sdk.callsTo("threads.pin").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

function sendCalls(host: Awaited<ReturnType<typeof load>>) {
  return host.harness.sdk.callsTo("threads.send").map((call) => {
    const args = call[0] as {
      threadId?: string;
      mode?: string;
      input?: Array<{ text?: string }>;
    };
    return { threadId: args.threadId, mode: args.mode, text: args.input?.[0]?.text ?? "" };
  });
}

async function seedCrew(host: Awaited<ReturnType<typeof load>>) {
  await host.bb.storage.kv.set("crews", [
    {
      id: "c1",
      task: "fix login",
      projectId: "proj_1",
      threadId: "thr_crew",
      parentThreadId: "thr_cap",
      providerId: null,
      worktree: true,
      shape: "ship",
      posture: "local-only",
      createdAt: "2026-09-18T00:00:00.000Z",
    },
  ]);
}

function stubIdleSdk(host: Awaited<ReturnType<typeof load>>) {
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: null }),
  );
}

async function emitIdle(
  host: Awaited<ReturnType<typeof load>>,
  lastAssistantText: string | null,
  thread: Parameters<typeof makeThreadResponse>[0] = {},
) {
  return host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "thr_crew", status: "idle", projectId: "proj_1", ...thread }),
    lastAssistantText,
  });
}

test("idle on a non-crew thread is ignored", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    const emitted = await emitIdle(host, "still working", { id: "thr_other" });
    assert.deepEqual(emitted.errors, []);
    assert.equal(sendCalls(host).length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a protocol verdict does not nudge; supervision still pings the captain", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    const emitted = await emitIdle(host, "ACK: on it\n\nDONE: shipped branch bb/nudge");
    assert.deepEqual(emitted.errors, []);
    const sends = sendCalls(host);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.threadId, "thr_cap");
    assert.match(sends[0]?.text ?? "", /DONE: shipped branch bb\/nudge/);
    assert.doesNotMatch(sends[0]?.text ?? "", /TURN ENDED WITHOUT A STATUS VERDICT/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("missing protocol doorbells the crew and does not ping done", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    const emitted = await emitIdle(host, "I am DONE: almost, but this is prose");
    assert.deepEqual(emitted.errors, []);
    const sends = sendCalls(host);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.threadId, "thr_crew");
    assert.equal(sends[0]?.mode, "queue-if-active");
    assert.match(sends[0]?.text ?? "", /TURN ENDED WITHOUT A STATUS VERDICT \(nag 1 of 3\)/);
    assert.match(sends[0]?.text ?? "", /DONE: <one-line outcome>/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("cooldown blocks a second nudge; the cap then surfaces NEEDS DECISION", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    const first = await emitIdle(host, "still working");
    assert.deepEqual(first.errors, []);
    const second = await emitIdle(host, "still working");
    assert.deepEqual(second.errors, []);
    assert.equal(sendCalls(host).filter((send) => send.threadId === "thr_crew").length, 1);

    await host.harness.behavior.setSettings({ nudgeMaxPerCrew: 2, nudgeCooldownSeconds: 0 });
    await host.bb.storage.kv.set("protocol-nudges", {
      c1: { generation: "2026-09-18T00:00:00.000Z", count: 1, lastAt: 0, exhausted: false },
    });
    await emitIdle(host, "still working");
    await emitIdle(host, "still working");
    const sends = sendCalls(host);
    const crewNags = sends.filter((send) => send.threadId === "thr_crew");
    const captain = sends.filter((send) => send.threadId === "thr_cap");
    assert.equal(crewNags.length, 2);
    assert.equal(captain.length, 1);
    assert.match(captain[0]?.text ?? "", /NEEDS DECISION/);
    await emitIdle(host, "still working");
    assert.equal(sendCalls(host).length, sends.length);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("stopping or a manual interrupt is not nudged", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    host.harness.sdk.stub("threads.events.list", async (args: { types?: string[] }) => {
      const types = args.types ?? [];
      if (types.includes("turn/started")) return [{ createdAt: 1_000 }];
      return [{ createdAt: 2_000, data: { reason: "manual-stop" } }];
    });
    const stopped = await emitIdle(host, "still working", { status: "stopping" });
    assert.deepEqual(stopped.errors, []);
    assert.equal(sendCalls(host).length, 0);
    const interrupted = await emitIdle(host, "still working", { status: "idle" });
    assert.deepEqual(interrupted.errors, []);
    assert.equal(sendCalls(host).length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("provider-turn-idle still nudges; afk nudges the crew and holds the captain ping", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    host.harness.sdk.stub("threads.events.list", async () => [
      { data: { reason: "provider-turn-idle" } },
    ]);
    await host.bb.storage.kv.set("afk", {
      on: true,
      words: "out",
      since: "2026-09-18T00:00:00.000Z",
      held: [],
    });
    await host.harness.behavior.setSettings({ nudgeMaxPerCrew: 1, nudgeCooldownSeconds: 0, supervisionEnabled: true });
    const nudged = await emitIdle(host, "no verdict");
    assert.deepEqual(nudged.errors, []);
    assert.equal(sendCalls(host).length, 1);
    assert.equal(sendCalls(host)[0]?.threadId, "thr_crew");

    const exhausted = await emitIdle(host, "no verdict");
    assert.deepEqual(exhausted.errors, []);
    assert.equal(sendCalls(host).filter((send) => send.threadId === "thr_cap").length, 0);
    const afk = (await host.bb.storage.kv.get("afk")) as { held?: string[] };
    assert.match(afk.held?.join("\n") ?? "", /NEEDS DECISION/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("nudgeEnabled false leaves the idle ping to supervision", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ nudgeEnabled: false, supervisionEnabled: true });
    const emitted = await emitIdle(host, "still working");
    assert.deepEqual(emitted.errors, []);
    const sends = sendCalls(host);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.threadId, "thr_cap");
    assert.match(sends[0]?.text ?? "", /crew c1 done/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

function crewRow(id: string, threadId: string, parentThreadId: string | null) {
  return {
    id,
    task: "fix login",
    projectId: "proj_1",
    threadId,
    parentThreadId,
    providerId: null,
    worktree: true,
    shape: "ship" as const,
    posture: "local-only",
    createdAt: "2026-09-18T00:00:00.000Z",
  };
}

function stubBusyCrew(host: Awaited<ReturnType<typeof load>>, output = "same") {
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
  host.harness.sdk.stub("threads.output", async () => ({ output }));
}

async function runStuckOnce(
  host: Awaited<ReturnType<typeof load>>,
  opts?: { lastPassAt?: number | null },
) {
  const metaInit: Record<string, unknown> = { checked: -1, notified: -1 };
  if (opts?.lastPassAt === undefined) metaInit["lastPassAt"] = Date.now();
  else if (opts.lastPassAt !== null) metaInit["lastPassAt"] = opts.lastPassAt;
  await host.bb.storage.kv.set("watch-meta", metaInit);
  const run = host.harness.behavior.runService("crew-watch");
  const deadline = Date.now() + 4000;
  let meta: { lastPassAt: number; checked: number; notified: number } | null = null;
  while (Date.now() < deadline) {
    const raw = await host.bb.storage.kv.get("watch-meta");
    if (typeof raw === "object" && raw !== null && "checked" in raw) {
      const row = raw as { lastPassAt: number; checked: number; notified: number };
      if (row.checked !== -1) {
        meta = row;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  run.controller.abort();
  await run.done;
  assert.ok(meta, "stuck pass did not finish");
  return meta;
}

test("stale output with fresh tool activity does not page", async () => {
  const host = await load();
  try {
    stubBusyCrew(host);
    const staleAt = Date.now() - 31 * 60_000;
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    await host.bb.storage.kv.set("watch", {
      c1: { status: "active", hash: "same", at: staleAt, stuck: false, legacy: true },
    });
    host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: Date.now() - 1000 }]);
    const first = await runStuckOnce(host);
    assert.equal(first.notified, 0);
    assert.equal(sendCalls(host).length, 0);
    const mid = (await host.bb.storage.kv.get("watch")) as Record<string, { at: number; stuck: boolean; activityAt?: number }>;
    assert.equal(mid["c1"]?.stuck, false);
    assert.equal(mid["c1"]?.at, staleAt);
    assert.equal(typeof mid["c1"]?.activityAt, "number");
    const second = await runStuckOnce(host);
    assert.equal(second.notified, 0);
    assert.equal(sendCalls(host).length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("stale output and stale tool activity pages both signals", async () => {
  const host = await load();
  try {
    stubBusyCrew(host);
    const now = Date.now();
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    await host.bb.storage.kv.set("watch", {
      c1: { status: "active", hash: "same", at: now - 31 * 60_000, stuck: false },
    });
    host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: now - 40 * 60_000 }]);
    const pass = await runStuckOnce(host);
    assert.equal(pass.notified, 1);
    const sends = sendCalls(host);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.threadId, "thr_cap");
    assert.match(sends[0]?.text ?? "", /stuck \(31m no output change, no tool\/file activity 40m\)/);
    assert.match(sends[0]?.text ?? "", /same/);
    const again = await runStuckOnce(host);
    assert.equal(again.notified, 0);
    assert.equal(sendCalls(host).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("stuck pass checks every parented crew past the old cap of 20", async () => {
  const host = await load();
  try {
    stubBusyCrew(host);
    const staleAt = Date.now() - 31 * 60_000;
    const crews = [];
    const watch: Record<string, { status: string; hash: string; at: number; stuck: boolean }> = {};
    for (let i = 0; i < 21; i++) {
      const id = `c${i}`;
      crews.push(crewRow(id, `thr_${i}`, "thr_cap"));
      watch[id] = { status: "active", hash: "same", at: staleAt, stuck: false };
    }
    crews.push(crewRow("orphan", "thr_orphan", null));
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.bb.storage.kv.set("crews", crews);
    await host.bb.storage.kv.set("watch", watch);
    host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: staleAt }]);
    const pass = await runStuckOnce(host);
    assert.equal(pass.checked, 21);
    assert.equal(pass.notified, 21);
    assert.equal(sendCalls(host).length, 21);
    assert.equal(host.harness.sdk.callsTo("threads.output").length, 21);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an interrupt older than this idle turn does not block the nudge", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    host.harness.sdk.stub("threads.events.list", async (args: { types?: string[] }) => {
      const types = args.types ?? [];
      if (types.includes("turn/started")) return [{ createdAt: 5_000 }];
      return [{ createdAt: 1_000, data: { reason: "manual-stop" } }];
    });
    const emitted = await emitIdle(host, "still working");
    assert.deepEqual(emitted.errors, []);
    assert.equal(sendCalls(host).filter((send) => send.threadId === "thr_crew").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a thrown nudge does not count and does not report nudged", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    let fail = true;
    host.harness.sdk.stub("threads.send", async () => {
      if (fail) throw new Error("send down");
    });
    const failed = await emitIdle(host, "still working");
    assert.deepEqual(failed.errors, []);
    const mid = (await host.bb.storage.kv.get("protocol-nudges")) as { c1?: { count?: number } } | null;
    assert.equal(mid?.c1?.count ?? 0, 0);
    assert.equal(sendCalls(host).filter((send) => send.threadId === "thr_cap").length, 0);
    fail = false;
    await emitIdle(host, "still working");
    const nag = sendCalls(host).filter((send) => send.threadId === "thr_crew").at(-1);
    assert.match(nag?.text ?? "", /nag 1 of 3/);
    const after = (await host.bb.storage.kv.get("protocol-nudges")) as { c1?: { count?: number } };
    assert.equal(after.c1?.count, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("cooldown persists dueAt and a reload re-arms the deferred nudge", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    await emitIdle(host, "still working");
    await emitIdle(host, "still working");
    const cooled = (await host.bb.storage.kv.get("protocol-nudges")) as {
      c1?: { count?: number; lastAt?: number; dueAt?: number };
    };
    assert.equal(cooled.c1?.count, 1);
    assert.equal(typeof cooled.c1?.dueAt, "number");
    assert.ok((cooled.c1?.dueAt ?? 0) > (cooled.c1?.lastAt ?? 0));
  } finally {
    await host.harness.lifecycle.dispose();
  }

  const restarted = await load();
  try {
    stubIdleSdk(restarted);
    await seedCrew(restarted);
    const dueAt = Date.now() - 500;
    await restarted.bb.storage.kv.set("protocol-nudges", {
      c1: {
        generation: "2026-09-18T00:00:00.000Z",
        count: 1,
        lastAt: Date.now() - 120_000,
        exhausted: false,
        dueAt,
      },
    });
    const run = restarted.harness.behavior.runService("crew-watch");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && sendCalls(restarted).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    run.controller.abort();
    await run.done;
    const nag = sendCalls(restarted).find((send) => send.threadId === "thr_crew");
    assert.match(nag?.text ?? "", /nag 2 of 3/);
    const row = (await restarted.bb.storage.kv.get("protocol-nudges")) as { c1?: { count?: number; dueAt?: number } };
    assert.equal(row.c1?.count, 2);
    assert.equal(row.c1?.dueAt, undefined);
  } finally {
    await restarted.harness.lifecycle.dispose();
  }
});

test("a nudge refreshes watch so the old hash cannot instant-stall", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    const staleAt = Date.now() - 31 * 60_000;
    await host.bb.storage.kv.set("watch", {
      c1: { status: "active", hash: "same", at: staleAt, stuck: true },
    });
    await emitIdle(host, "still working");
    const watch = (await host.bb.storage.kv.get("watch")) as Record<string, { at: number; stuck: boolean }>;
    assert.equal(watch["c1"]?.stuck, false);
    assert.ok((watch["c1"]?.at ?? 0) > staleAt);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("secondmate routes are not nudged, stuck-paged, fail-pinged, or interaction-paged", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    stubBusyCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    const second = { ...crewRow("sm", "thr_sm", "thr_cap"), posture: "secondmate:proj_1" };
    await host.bb.storage.kv.set("crews", [second, crewRow("c1", "thr_crew", "thr_cap")]);
    const idle = await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_sm", status: "idle", projectId: "proj_1" }),
      lastAssistantText: "still working",
    });
    assert.deepEqual(idle.errors, []);
    const failed = await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_sm", status: "error", projectId: "proj_1" }),
      error: "provider down",
    });
    assert.deepEqual(failed.errors, []);
    const turn = await host.harness.behavior.emitThreadEvent("turn.failed", {
      threadId: "thr_sm",
      requestId: "req_sm",
      turnId: null,
      errorInfo: null,
      inputAccepted: false,
      rateLimits: null,
      attemptNumber: 1,
    });
    assert.deepEqual(turn.errors, []);
    const pending = await host.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: makeThreadResponse({ id: "thr_sm", status: "idle", projectId: "proj_1" }),
      interaction: { id: "int_1" },
    });
    assert.deepEqual(pending.errors, []);
    const staleAt = Date.now() - 31 * 60_000;
    await host.bb.storage.kv.set("watch", {
      sm: { status: "active", hash: "same", at: staleAt, stuck: false },
      c1: { status: "active", hash: "same", at: staleAt, stuck: false },
    });
    host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: staleAt }]);
    const pass = await runStuckOnce(host);
    assert.equal(pass.checked, 1);
    assert.equal(pass.notified, 1);
    const sends = sendCalls(host);
    assert.equal(sends.length, 1);
    assert.match(sends[0]?.text ?? "", /crew c1/);
    assert.doesNotMatch(sends[0]?.text ?? "", /crew sm/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("thread.failed pages once; turn.failed does not double-page", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    const failed = await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_crew", status: "error", projectId: "proj_1" }),
      error: "provider down",
    });
    assert.deepEqual(failed.errors, []);
    const turn = await host.harness.behavior.emitThreadEvent("turn.failed", {
      threadId: "thr_crew",
      requestId: "req_1",
      turnId: null,
      errorInfo: null,
      inputAccepted: false,
      rateLimits: null,
      attemptNumber: 1,
    });
    assert.deepEqual(turn.errors, []);
    const sends = sendCalls(host);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.threadId, "thr_cap");
    assert.match(sends[0]?.text ?? "", /failed/);
    assert.match(sends[0]?.text ?? "", /provider down/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("quiet holds without an AFK record and flushes on quiet off", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.bb.storage.kv.set("quiet", true);
    await host.bb.storage.kv.set("afk", {
      on: false,
      words: "",
      since: "2026-09-18T00:00:00.000Z",
      held: ["stale-afk"],
    });
    const emitted = await emitIdle(host, "DONE: batched");
    assert.deepEqual(emitted.errors, []);
    assert.equal(sendCalls(host).filter((send) => send.threadId === "thr_cap").length, 0);
    const quiet = (await host.bb.storage.kv.get("quiet")) as { on?: boolean; held?: string[] };
    assert.equal(quiet.on, true);
    assert.match(quiet.held?.join("\n") ?? "", /DONE: batched/);
    const afk = (await host.bb.storage.kv.get("afk")) as { held?: string[] };
    assert.deepEqual(afk.held, ["stale-afk"]);
    const off = await host.harness.behavior.runCli(["quiet", "off"]);
    assert.equal(off.exitCode, 0, off.stderr);
    assert.match(off.stdout, /Quiet off/);
    assert.match(off.stdout, /DONE: batched/);
    const cleared = (await host.bb.storage.kv.get("quiet")) as { on?: boolean; held?: string[] };
    assert.equal(cleared.on, false);
    assert.deepEqual(cleared.held, []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("afk hold keeps the newest 20 and flushes the oldest", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.bb.storage.kv.set("afk", {
      on: true,
      words: "",
      since: "2026-09-18T00:00:00.000Z",
      held: [],
    });
    for (let i = 0; i < 21; i++) {
      const emitted = await emitIdle(host, `DONE: item ${i}`);
      assert.deepEqual(emitted.errors, []);
    }
    const afk = (await host.bb.storage.kv.get("afk")) as { held?: string[] };
    assert.equal(afk.held?.length, 20);
    assert.match(afk.held?.[0] ?? "", /DONE: item 1/);
    assert.match(afk.held?.[19] ?? "", /DONE: item 20/);
    const flushed = sendCalls(host).filter((send) => send.threadId === "thr_cap");
    assert.equal(flushed.length, 1);
    assert.match(flushed[0]?.text ?? "", /DONE: item 0/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("stuck pass pages error and unknown once, and a read failure is not a stable hash", async () => {
  const host = await load();
  try {
    stubBusyCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "error", environmentId: null }));
    const first = await runStuckOnce(host);
    assert.equal(first.notified, 1);
    assert.match(sendCalls(host)[0]?.text ?? "", /failed/);
    const second = await runStuckOnce(host);
    assert.equal(second.notified, 0);
    assert.equal(sendCalls(host).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }

  const unread = await load();
  try {
    stubBusyCrew(unread);
    await unread.harness.behavior.setSettings({ supervisionEnabled: true });
    await unread.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    const staleAt = Date.now() - 31 * 60_000;
    await unread.bb.storage.kv.set("watch", {
      c1: { status: "active", hash: "same", at: staleAt, stuck: false },
    });
    unread.harness.sdk.stub("threads.output", async () => {
      throw new Error("output down");
    });
    unread.harness.sdk.stub("threads.events.list", async () => [{ createdAt: staleAt }]);
    const pass = await runStuckOnce(unread);
    assert.equal(pass.notified, 1);
    const sends = sendCalls(unread);
    assert.equal(sends.length, 1);
    assert.match(sends[0]?.text ?? "", /gone/);
    assert.doesNotMatch(sends[0]?.text ?? "", /stuck \(/);
    const again = await runStuckOnce(unread);
    assert.equal(again.notified, 0);
    assert.equal(sendCalls(unread).length, 1);
    const watch = (await unread.bb.storage.kv.get("watch")) as Record<string, { hash?: string; alerted?: string }>;
    assert.equal(watch["c1"]?.hash, "same");
    assert.equal(watch["c1"]?.alerted, "unknown");
  } finally {
    await unread.harness.lifecycle.dispose();
  }
});

test("a startup gap rebases stale watch rows instead of paging", async () => {
  const host = await load();
  try {
    stubBusyCrew(host);
    const staleAt = Date.now() - 31 * 60_000;
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    await host.bb.storage.kv.set("watch", {
      c1: { status: "active", hash: "same", at: staleAt, stuck: false },
    });
    host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: staleAt }]);
    const pass = await runStuckOnce(host, { lastPassAt: Date.now() - 60 * 60_000 });
    assert.equal(pass.notified, 0);
    assert.equal(sendCalls(host).length, 0);
    const watch = (await host.bb.storage.kv.get("watch")) as Record<string, { at: number; stuck: boolean }>;
    assert.equal(watch["c1"]?.stuck, false);
    assert.ok((watch["c1"]?.at ?? 0) > staleAt);
  } finally {
    await host.harness.lifecycle.dispose();
  }

  const missing = await load();
  try {
    stubBusyCrew(missing);
    const staleAt = Date.now() - 31 * 60_000;
    await missing.harness.behavior.setSettings({ supervisionEnabled: true });
    await missing.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    await missing.bb.storage.kv.set("watch", {
      c1: { status: "active", hash: "same", at: staleAt, stuck: false },
    });
    missing.harness.sdk.stub("threads.events.list", async () => [{ createdAt: staleAt }]);
    const pass = await runStuckOnce(missing, { lastPassAt: null });
    assert.equal(pass.notified, 0);
    assert.equal(sendCalls(missing).length, 0);
    const watch = (await missing.bb.storage.kv.get("watch")) as Record<string, { at: number }>;
    assert.ok((watch["c1"]?.at ?? 0) > staleAt);
  } finally {
    await missing.harness.lifecycle.dispose();
  }
});

test("forget drops the crew protocol-nudges row", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    await host.bb.storage.kv.set("protocol-nudges", {
      c1: { generation: "2026-09-18T00:00:00.000Z", count: 2, lastAt: 1, exhausted: false, dueAt: 9 },
      other: { generation: "g", count: 1, lastAt: 1, exhausted: false },
    });
    const result = await host.harness.behavior.runCli(["forget", "c1"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const nudges = (await host.bb.storage.kv.get("protocol-nudges")) as Record<string, unknown>;
    assert.equal(nudges["c1"], undefined);
    assert.ok(nudges["other"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// --- Phase 1: adapter, gates, reconciliation, version-skew, real bearings -----

function shipRow(id: string, threadId: string, parentThreadId: string | null, posture = "direct-PR") {
  return {
    id,
    task: "fix login",
    projectId: "proj_1",
    threadId,
    parentThreadId,
    providerId: null,
    model: null,
    reasoningLevel: null,
    worktree: true,
    shape: "ship" as const,
    posture,
    createdAt: "2026-09-18T00:00:00.000Z",
  };
}

function hostOutput(text: string, code = 0) {
  const body = `\n${text}\n__FM_HOST_RC:${code}\n`;
  return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(body).toString("base64") }] };
}

test("toolbeltPhrase uses computed counts when known, neutral text otherwise", () => {
  assert.match(toolbeltPhrase("175", "21"), /175 bin\/fm-\*\.sh scripts \+ 21 skills/);
  assert.match(toolbeltPhrase("", ""), /full bin\/fm-\*\.sh toolbelt/);
  assert.match(toolbeltPhrase("0", "0"), /full bin\/fm-\*\.sh toolbelt/);
});

test("dispatch forwards reasoningLevel to the spawned thread", async () => {
  const host = await load();
  try {
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_crew" }));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_crew", status: "starting" }));
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--reasoning-level", "xhigh", "--", "fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const args = host.harness.sdk.callsTo("threads.spawn")[0]![0] as { reasoningLevel?: string };
    assert.equal(args.reasoningLevel, "xhigh");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("merge lands a PR with zero checks (no_checks) on the captain's word", async () => {
  const host = await load();
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: "env_wt" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("threads.output", async () => ({ output: "DONE: shipped" }));
    host.harness.sdk.stub("threads.archive", async () => ({}));
    host.harness.sdk.stub("threads.stop", async () => ({}));
    host.harness.sdk.stub("environments.pullRequest", async () => ({
      outcome: "available",
      pullRequest: {
        url: "https://gh/pr/1", number: 1, title: "t", state: "open",
        checks: { state: "no_checks", failedCount: 0, pendingCount: 0, passedCount: 0 },
        mergeability: { mergeable: "MERGEABLE" },
      },
    }));
    let merged = 0;
    host.harness.sdk.stub("environments.mergePullRequest", async () => { merged++; return {}; });
    const result = await host.harness.behavior.runCli(["merge", "c1", "--yes"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(merged, 1);
    assert.match(result.stdout, /Merged https:\/\/gh\/pr\/1/);
    assert.deepEqual((await host.bb.storage.kv.get("crews")) as unknown[], []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("allowRedCheck is separate from authority: no --yes still refuses", async () => {
  const host = await load();
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: "env_wt" }),
    );
    const result = await host.harness.behavior.runCli(["merge", "c1", "--allow-red", "flaky-e2e"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /captain's word/i);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("merge drops the real state meta after landing", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home" },
  });
  await plugin(host.bb);
  try {
    const hostCommands: string[] = [];
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: "env_wt" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("threads.output", async () => ({ output: "DONE: shipped" }));
    host.harness.sdk.stub("threads.archive", async () => ({}));
    host.harness.sdk.stub("threads.stop", async () => ({}));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    host.harness.sdk.stub("environments.pullRequest", async () => ({
      outcome: "available",
      pullRequest: {
        url: "https://gh/pr/1", number: 1, title: "t", state: "open",
        checks: { state: "passing", failedCount: 0, pendingCount: 0, passedCount: 3 },
        mergeability: { mergeable: "MERGEABLE" },
      },
    }));
    host.harness.sdk.stub("environments.mergePullRequest", async () => ({}));
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      if (typeof args.start?.command === "string") hostCommands.push(args.start.command);
      return { id: "term_1" };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.output", async () => hostOutput(""));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    const result = await host.harness.behavior.runCli(["merge", "c1", "--yes"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(
      hostCommands.some((cmd) => cmd.includes("rm -f") && cmd.includes("c1.meta")),
      `no meta drop in ${hostCommands.join("\n---\n")}`,
    );
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("bearings reconciles a crew whose PR merged externally", async () => {
  const host = await load();
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: "env_wt" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("threads.output", async () => ({ output: "DONE: shipped" }));
    host.harness.sdk.stub("threads.archive", async () => ({}));
    host.harness.sdk.stub("threads.stop", async () => ({}));
    host.harness.sdk.stub("environments.pullRequest", async () => ({
      outcome: "available",
      pullRequest: {
        url: "https://gh/pr/1", number: 1, title: "t", state: "merged",
        checks: { state: "passing", failedCount: 0, pendingCount: 0, passedCount: 1 },
        mergeability: { mergeable: "MERGEABLE" },
      },
    }));
    const result = await host.harness.behavior.runCli(["bearings"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual((await host.bb.storage.kv.get("crews")) as unknown[], []);
    assert.equal(host.harness.sdk.callsTo("threads.archive").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("mark-crew tags a thread so the crewmate contract applies", async () => {
  const host = await load();
  try {
    host.harness.sdk.stub("threads.updatePluginMetadata", async (args: unknown) => args);
    const result = await host.harness.behavior.runCli(["mark-crew", "thr_x", "--shape", "scout"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const call = host.harness.sdk.callsTo("threads.updatePluginMetadata")[0]![0] as {
      threadId?: string; set?: Record<string, unknown>;
    };
    assert.equal(call.threadId, "thr_x");
    assert.equal(call.set?.crew, "true");
    assert.equal(call.set?.shape, "scout");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("retry with a new reasoning relaunches in the same worktree", async () => {
  const host = await load();
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "error", environmentId: "env_wt" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("threads.stop", async () => ({}));
    host.harness.sdk.stub("threads.archive", async () => ({}));
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_crew2" }));
    const result = await host.harness.behavior.runCli(["retry", "c1", "--reasoning-level", "max"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const args = host.harness.sdk.callsTo("threads.spawn")[0]![0] as {
      environment?: { type?: string; environmentId?: string }; reasoningLevel?: string;
    };
    assert.equal(args.environment?.type, "reuse");
    assert.equal(args.environment?.environmentId, "env_wt");
    assert.equal(args.reasoningLevel, "max");
    assert.equal(host.harness.sdk.callsTo("threads.retry").length, 0);
    const crews = (await host.bb.storage.kv.get("crews")) as Array<{ threadId: string; reasoningLevel: string | null }>;
    assert.equal(crews[0]?.threadId, "thr_crew2");
    assert.equal(crews[0]?.reasoningLevel, "max");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("retry with no override still resubmits the failed turn on the same thread", async () => {
  const host = await load();
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "error", environmentId: "env_wt" }),
    );
    host.harness.sdk.stub("threads.retry", async () => ({}));
    const result = await host.harness.behavior.runCli(["retry", "c1"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(host.harness.sdk.callsTo("threads.retry").length, 1);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("guide reports computed toolbelt counts when known", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmScriptCount: "175", fmSkillCount: "21" },
  });
  await plugin(host.bb);
  try {
    const result = await host.harness.behavior.runCli(["guide"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /175 bin\/fm-\*\.sh scripts \+ 21 skills/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("deck renders real fm-bearings-snapshot labelled, native digest as cache", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home" },
  });
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_cap", title: null, titleFallback: "/captain", projectId: "proj_1", environmentId: "env_cap" }),
    );
    host.harness.sdk.stub("threads.update", async (args: unknown) => args);
    host.harness.sdk.stub("threads.pin", async (args: unknown) => args);
    host.harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
    host.harness.sdk.stub("projects.get", async () => ({
      id: "proj_1", name: "Proj", kind: "standard" as const, gitRemoteUrl: null, sources: [], createdAt: 0, updatedAt: 0,
    }));
    host.harness.sdk.stub("environments.get", async () => ({ id: "env_cap", hostId: "host_1", path: "/repo", isWorktree: false, status: "ready" }));
    host.harness.sdk.stub("terminals.create", async () => ({ id: "term_1" }));
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.output", async () => hostOutput("FLEET SNAPSHOT: 0 crews"));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    const result = await host.harness.behavior.runCli(["deck"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /real bearings \(fm-bearings-snapshot; authoritative\)/);
    assert.match(result.stdout, /FLEET SNAPSHOT: 0 crews/);
    assert.match(result.stdout, /native digest \(BB KV cache \/ fallback\)/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("bb overlay adapter propagates reasoning, tags crews, drops yolo->full, carves out scouts", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "overlay", "bin", "backends", "bb.sh"),
    "utf8",
  );
  assert.match(src, /--reasoning-level/);
  assert.match(src, /FM_BB_REASONING/);
  assert.match(src, /firstmate mark-crew/);
  // yolo no longer forces BB full permission
  assert.doesNotMatch(src, /perm=full/);
  // scout scratch carve-out in remove_worktree
  assert.match(src, /KIND:-/);
  assert.match(src, /scout\)/);
});

// ── Phase 2 additions ────────────────────────────────────────────────────────

test("formatFmMeta records provider when set, omits it otherwise", () => {
  const withProvider = formatFmMeta({
    id: "p1", threadId: "thr_p", worktree: "/wt", project: "/repo", kind: "ship",
    mode: "direct-PR", yolo: "off", model: "opus", provider: "claude-code", effort: "xhigh", spawnGen: "s1",
  });
  assert.match(withProvider, /^provider=claude-code$/m);
  assert.match(withProvider, /^effort=xhigh$/m);
  const without = formatFmMeta({
    id: "p2", threadId: "thr_p2", worktree: "/wt", project: "/repo", kind: "scout", spawnGen: "s2",
  });
  assert.doesNotMatch(without, /^provider=/m);
});

test("captain sessions load the real AGENTS.md contract; crews never do", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", captainContract: "AHOY-CONTRACT-MARKER: supervise before ending a turn." },
  });
  await plugin(host.bb);
  try {
    const cap = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { captain: "true" } }),
    );
    assert.match(cap.instructions ?? "", /AHOY-CONTRACT-MARKER/);
    const crew = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { crew: "true" } }),
    );
    assert.doesNotMatch(crew.instructions ?? "", /AHOY-CONTRACT-MARKER/);
    assert.deepEqual(crew.tools.map((t) => t.name), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("dispatch scaffolds the real structured brief via fm-brief when real mode is on", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home" },
  });
  await plugin(host.bb);
  try {
    const hostCommands: string[] = [];
    host.harness.sdk.stub("threadSections.list", async () => []);
    host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    host.harness.sdk.stub("environments.get", async () => ({
      id: "env_wt", hostId: "host_1", path: "/wt", isWorktree: true, status: "ready",
    }));
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_crew" }));
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "starting", environmentId: "env_wt" }),
    );
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      if (typeof args.start?.command === "string") hostCommands.push(args.start.command);
      return { id: "term_1" };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.output", async () => hostOutput(""));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const brief = hostCommands.find((c) => c.includes("bin/fm-brief.sh"));
    assert.ok(brief, `no fm-brief scaffold in ${hostCommands.join("\n---\n")}`);
    assert.match(brief, /--mode/);
    assert.match(brief, /direct-PR/);
    assert.match(brief, /\{TASK\}/); // the python fill targets the placeholder
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("migrate-state imports absent crews into real state and is idempotent", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home" },
  });
  await plugin(host.bb);
  try {
    let metaPresent = false;
    const commands: string[] = [];
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: "env_wt" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    const terminalCmd = new Map<string, string>();
    let seq = 0;
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      const id = `term_${seq++}`;
      const cmd = typeof args.start?.command === "string" ? args.start.command : "";
      terminalCmd.set(id, cmd);
      commands.push(cmd);
      return { id };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
      const cmd = terminalCmd.get(args.terminalId) ?? "";
      if (cmd.includes("FM_META_EXISTS")) return hostOutput(metaPresent ? "FM_META_EXISTS" : "FM_META_ABSENT");
      return hostOutput("");
    });
    host.harness.sdk.stub("terminals.close", async () => ({}));

    const first = await host.harness.behavior.runCli(["migrate-state", "--json"]);
    assert.equal(first.exitCode, 0, first.stderr);
    const r1 = JSON.parse(first.stdout) as { imported: string[]; skippedExisting: string[]; failed: string[] };
    assert.deepEqual(r1.imported, ["c1"]);
    assert.ok(commands.some((c) => c.includes("c1.meta") && c.includes("window=thr_crew")), "no meta write");

    metaPresent = true;
    const second = await host.harness.behavior.runCli(["migrate-state", "--json"]);
    const r2 = JSON.parse(second.stdout) as { imported: string[]; skippedExisting: string[] };
    assert.deepEqual(r2.imported, []);
    assert.deepEqual(r2.skippedExisting, ["c1"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_crew folds the full status protocol from crew output", async () => {
  const host = await load();
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("threads.output", async () => ({
      output: "working: setting up\nneeds-decision [key=api]: rename or keep?\nworking: meanwhile",
    }));
    const result = await host.harness.behavior.runCli(["crew", "c1"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /state: working/);
    assert.match(result.stdout, /open needs-decision \[api\]: rename or keep\?/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("bearings surfaces an idle crew's open decision as a Captain's Call", async () => {
  const host = await load();
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("threads.output", async () => ({
      output: "needs-decision [key=schema]: postgres or sqlite?",
    }));
    const result = await host.harness.behavior.runCli(["bearings"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /NEEDS-DECISION \[schema\]/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// ── Phase 2 review fixes ─────────────────────────────────────────────────────

test("bearings does not re-nag a crew that answered its decision then finished DONE", async () => {
  const host = await load();
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: "env_wt" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    // Chat output carries the needs-decision but NOT the resolved close (that only
    // lands in the on-host .status). The crew then finished DONE with a PR.
    host.harness.sdk.stub("threads.output", async () => ({
      output: "needs-decision [key=api]: rename or keep?\nworking: applied captain answer\nDONE: shipped",
    }));
    host.harness.sdk.stub("environments.pullRequest", async () => ({
      outcome: "available",
      pullRequest: {
        url: "https://gh/pr/42", number: 42, title: "t", state: "open",
        checks: { state: "passing", failedCount: 0, pendingCount: 0, passedCount: 1 },
        mergeability: { mergeable: "MERGEABLE" },
      },
    }));
    const result = await host.harness.behavior.runCli(["bearings"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /NEEDS-DECISION \[api\]/);
    assert.match(result.stdout, /PR ready c1/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("migrate-state reports failed when the host/state is unreachable (exists === null)", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home" },
  });
  await plugin(host.bb);
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: "env_wt" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    // Exists-check yields neither EXISTS nor ABSENT -> unreadable -> null -> failed.
    host.harness.sdk.stub("terminals.create", async () => ({ id: "term_1" }));
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.output", async () => hostOutput("garbage-no-marker"));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    const r = JSON.parse((await host.harness.behavior.runCli(["migrate-state", "--json"])).stdout) as {
      imported: string[]; failed: string[];
    };
    assert.deepEqual(r.imported, []);
    assert.deepEqual(r.failed, ["c1"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("migrate-state imports even when the brief scaffold fails; skips terminal crews", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home" },
  });
  await plugin(host.bb);
  try {
    // c1 active (import, brief fails); c2 finished DONE (terminal, skip).
    await host.bb.storage.kv.set("crews", [
      shipRow("c1", "thr_c1", "thr_cap"),
      shipRow("c2", "thr_c2", "thr_cap"),
    ]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async (args: { threadId: string }) =>
      makeThreadResponse({ id: args.threadId, status: "idle", environmentId: "env_wt" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("threads.output", async (args: { threadId: string }) =>
      args.threadId === "thr_c2" ? { output: "DONE: already shipped" } : { output: "working: in progress" },
    );
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    const terminalCmd = new Map<string, string>();
    let seq = 0;
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      const id = `term_${seq++}`;
      terminalCmd.set(id, typeof args.start?.command === "string" ? args.start.command : "");
      return { id };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
      const cmd = terminalCmd.get(args.terminalId) ?? "";
      if (cmd.includes("FM_META_EXISTS")) return hostOutput("FM_META_ABSENT");
      if (cmd.includes("fm-brief.sh")) return hostOutput("brief boom", 1); // brief scaffold fails
      return hostOutput("");
    });
    host.harness.sdk.stub("terminals.close", async () => ({}));
    const r = JSON.parse((await host.harness.behavior.runCli(["migrate-state", "--json"])).stdout) as {
      imported: string[]; skippedTerminal: string[];
    };
    assert.deepEqual(r.imported, ["c1"]); // brief failure did not block the import
    assert.deepEqual(r.skippedTerminal, ["c2"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("tell --resolve-key writes the fm-classify resolved line into real state", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home" },
  });
  await plugin(host.bb);
  try {
    const hostCommands: string[] = [];
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: "env_wt" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      if (typeof args.start?.command === "string") hostCommands.push(args.start.command);
      return { id: "term_1" };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.output", async () => hostOutput(""));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    const result = await host.harness.behavior.runCli(
      ["tell", "c1", "--resolve-key", "api", "--", "use postgres"],
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const close = hostCommands.find((c) => c.includes("c1.status") && c.includes("resolved [key=api]"));
    assert.ok(close, `no resolved append in ${hostCommands.join("\n---\n")}`);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// --- Phase 3: real transport swap, watch ownership, skills manifest ----------

function hostRcPayload(payload: string, code = 0) {
  const text = `${payload}\n__FM_HOST_RC:${code}\n`;
  return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(text).toString("base64") }] };
}

// Wire a fake host whose terminal output is routed by the command text, so a
// dispatch through the real transport can be driven deterministically. `spawnExit`
// is the exit code fm-spawn.sh reports; `threadId` is what state/<id>.meta carries
// for bb_thread_id after a successful spawn ("" means the spawn left no thread).
function stubRealTransportHost(
  host: Awaited<ReturnType<typeof load>>,
  opts: { spawnExit: number; threadIdAfterSpawn: string; threadIdBeforeSpawn?: string },
) {
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [
    { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
  ]);
  host.harness.sdk.stub("environments.get", async () => ({
    id: "env_wt",
    hostId: "host_1",
    path: "/wt",
    isWorktree: true,
    status: "ready",
  }));
  host.harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({ id: "thr_crew", status: "starting", environmentId: "env_wt" }),
  );
  const cmds = new Map<string, string>();
  const seen: string[] = [];
  let n = 0;
  let spawned = false;
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
    const id = `term_${++n}`;
    const cmd = args.start?.command ?? "";
    cmds.set(id, cmd);
    seen.push(cmd);
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const cmd = cmds.get(args.terminalId) ?? "";
    if (cmd.includes("bin/fm-spawn.sh")) {
      spawned = true;
      return hostRcPayload("", opts.spawnExit);
    }
    if (cmd.includes("bb_thread_id")) {
      const tid = spawned ? opts.threadIdAfterSpawn : (opts.threadIdBeforeSpawn ?? "");
      return hostRcPayload(tid === "" ? "FM_META_ABSENT" : tid, 0);
    }
    return hostRcPayload("", 0);
  });
  return { seen };
}

async function crewsKv(host: Awaited<ReturnType<typeof load>>) {
  return (await host.bb.storage.kv.get("crews")) as Array<{ id: string; threadId: string }>;
}

function realHost() {
  return createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", transport: "real" },
  });
}

test("real transport dispatches through fm-spawn.sh and adopts its thread id", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    const { seen } = stubRealTransportHost(host, { spawnExit: 0, threadIdAfterSpawn: "thr_real" });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Dispatched ship crew/);
    assert.ok(seen.some((c) => c.includes("bin/fm-spawn.sh")), "fm-spawn.sh was not invoked");
    assert.ok(seen.some((c) => c.includes("--backend") && c.includes("bb")), "backend=bb not passed");
    // No native BB spawn happened.
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    const crews = await crewsKv(host);
    assert.equal(crews[0]?.threadId, "thr_real");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("real transport falls back to native BB spawn when the spawn leaves no thread", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_crew" }));
    const { seen } = stubRealTransportHost(host, { spawnExit: 1, threadIdAfterSpawn: "" });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(seen.some((c) => c.includes("bin/fm-spawn.sh")), "fm-spawn.sh was not attempted");
    // Real spawn produced no thread → native BB spawn is the fallback.
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1);
    const crews = await crewsKv(host);
    assert.equal(crews[0]?.threadId, "thr_crew");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("real transport never double-spawns when the meta already has a thread", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_crew" }));
    const { seen } = stubRealTransportHost(host, {
      spawnExit: 0,
      threadIdAfterSpawn: "thr_real",
      threadIdBeforeSpawn: "thr_pre",
    });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    // A recorded thread id short-circuits: no fm-spawn, no native spawn.
    assert.ok(!seen.some((c) => c.includes("bin/fm-spawn.sh")), "fm-spawn ran despite an existing thread");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    const crews = await crewsKv(host);
    assert.equal(crews[0]?.threadId, "thr_pre");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

async function stuckHostWithWatchOwner(beat: { beatAge: number; ageOfCheck: number } | null) {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", watchOwner: "fm-watch" },
  });
  await plugin(host.bb);
  stubBusyCrew(host);
  // The crew's host must resolve so per-host suppression (R1) can find its beat.
  host.harness.sdk.stub("environments.list", async () => [
    { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
  ]);
  const now = Date.now();
  await host.harness.behavior.setSettings({ supervisionEnabled: true });
  await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
  await host.bb.storage.kv.set("watch", {
    c1: { status: "active", hash: "same", at: now - 31 * 60_000, stuck: false },
  });
  host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: now - 40 * 60_000 }]);
  if (beat !== null) {
    // R1: per-host beat key.
    await host.bb.storage.kv.set("fm-watch-beat:host_1", {
      beatAge: beat.beatAge,
      checkedAt: now - beat.ageOfCheck,
      grace: 90,
      relaunched: false,
    });
  }
  return host;
}

test("fm-watch owner with a LIVE heartbeat suppresses BB's stuck page (no double-paging)", async () => {
  const host = await stuckHostWithWatchOwner({ beatAge: 10, ageOfCheck: 5_000 });
  try {
    const pass = await runStuckOnce(host);
    assert.equal(pass.notified, 0, "a live fm-watch owns the wedge; BB must not double-page");
    assert.equal(sendCalls(host).length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("fm-watch owner with a STALE heartbeat still lets BB page (no supervision gap)", async () => {
  const host = await stuckHostWithWatchOwner({ beatAge: 600, ageOfCheck: 5_000 });
  try {
    const pass = await runStuckOnce(host);
    assert.equal(pass.notified, 1, "a stale fm-watch is not supervising; BB must page the wedge");
    const sends = sendCalls(host);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.threadId, "thr_cap");
    assert.match(sends[0]?.text ?? "", /stuck \(/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("fm-watch owner with NO heartbeat record still lets BB page (never a silent gap)", async () => {
  const host = await stuckHostWithWatchOwner(null);
  try {
    const pass = await runStuckOnce(host);
    assert.equal(pass.notified, 1, "no fm-watch beat = no supervisor; BB must page");
    assert.equal(sendCalls(host).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the fm-watch supervisor relaunches the real watcher when the beacon is stale", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", watchOwner: "fm-watch", fmHostId: "host_1" },
  });
  await plugin(host.bb);
  try {
    const cmds: string[] = [];
    const ids = new Map<string, string>();
    let n = 0;
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      const id = `term_${++n}`;
      const cmd = args.start?.command ?? "";
      ids.set(id, cmd);
      cmds.push(cmd);
      return { id };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    // Beacon absent → the supervisor must (re)launch fm-watch-arm.sh and report age -1.
    host.harness.sdk.stub("terminals.output", async () =>
      hostRcPayload("FM_BEAT_AGE=-1\nFM_RELAUNCHED=1\n---FM_LOGTAIL---\nstale: fm-abc (escalation 1)", 0),
    );
    const run = host.harness.behavior.runService("fm-watch-supervisor");
    const deadline = Date.now() + 4000;
    let beat: { beatAge: number; relaunched: boolean } | null = null;
    while (Date.now() < deadline) {
      const raw = await host.bb.storage.kv.get("fm-watch-beat");
      if (raw && typeof raw === "object" && "relaunched" in raw) {
        beat = raw as { beatAge: number; relaunched: boolean };
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    run.controller.abort();
    await run.done;
    assert.ok(beat, "supervisor never wrote a heartbeat record");
    assert.equal(beat.relaunched, true);
    assert.ok(
      cmds.some((c) => c.includes("bin/fm-watch-arm.sh") && c.includes("setsid")),
      "supervisor did not detach-launch fm-watch-arm.sh",
    );
    // The watcher's page reason was relayed to the captain.
    const relayed = sendCalls(host).some((s) => (s.text ?? "").includes("fm-watch") && (s.text ?? "").includes("stale: fm-abc"));
    assert.ok(relayed, "supervisor did not relay the fm-watch wake reason to the captain");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("captain sessions get the version-pinned real skills inventory", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: {
      fmSkillsManifest: JSON.stringify({
        head: "abc1234567890",
        skills: [
          { name: "stow", desc: "tiered memory" },
          { name: "afk", desc: "away mandate" },
        ],
      }),
    },
  });
  await plugin(host.bb);
  try {
    const cfg = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { captain: "true" } }),
    );
    assert.match(cfg.instructions ?? "", /Real firstmate skills \(fmHome\/\.agents\/skills @ abc123456789/);
    assert.match(cfg.instructions ?? "", /- stow: tiered memory/);
    assert.match(cfg.instructions ?? "", /- afk: away mandate/);
    // Crews still get nothing.
    const crew = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { crew: "true" } }),
    );
    assert.doesNotMatch(crew.instructions ?? "", /Real firstmate skills/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// --- F2: fallback adopts an orphan thread instead of double-spawning ----------

// Route the real-transport host calls and capture the generated task id from the
// fm-spawn command so the orphan-thread stub can present a matching title.
function stubOrphanTransportHost(
  host: Awaited<ReturnType<typeof load>>,
  opts: { byTitle: boolean },
) {
  const captured = { taskId: "" };
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [
    { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
  ]);
  host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_x", status: "starting" }));
  const cmds = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
    const id = `term_${++n}`;
    const cmd = args.start?.command ?? "";
    cmds.set(id, cmd);
    const m = /\/state\/([A-Za-z0-9]+)\.meta/.exec(cmd);
    if (m) captured.taskId = m[1]!;
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  // fm-spawn exits 0, but the meta never records bb_thread_id (hard-kill window).
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const cmd = cmds.get(args.terminalId) ?? "";
    if (cmd.includes("bb_thread_id")) return hostRcPayload("FM_META_ABSENT", 0);
    return hostRcPayload("", 0);
  });
  // The orphan thread fm-spawn created but did not record.
  host.harness.sdk.stub("threads.list", async () => [
    {
      id: "thr_orphan",
      projectId: "proj_1",
      parentThreadId: "thr_cap",
      title: opts.byTitle ? `fm-${captured.taskId}` : "renamed-window",
    },
  ]);
  host.harness.sdk.stub("threads.getPluginMetadata", async () =>
    opts.byTitle ? {} : { crew: "true", crewId: captured.taskId },
  );
  return captured;
}

test("real transport adopts an orphan thread by title (mark-crew failed) instead of double-spawning", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_native" }));
    stubOrphanTransportHost(host, { byTitle: true });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0, "must not native-spawn a duplicate");
    const crews = await crewsKv(host);
    assert.equal(crews[0]?.threadId, "thr_orphan");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("real transport adopts an orphan thread by recorded task id when the title differs", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_native" }));
    stubOrphanTransportHost(host, { byTitle: false });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    const crews = await crewsKv(host);
    assert.equal(crews[0]?.threadId, "thr_orphan");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// --- item 3: read-through reconciliation against real state/<id>.meta ---------

test("read-through drops a KV crew whose real state/<id>.meta is gone (one batched read)", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", readThrough: true, fmHostId: "host_1" },
  });
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.list", async () => []);
    // Only c1 still has a meta; c2 was torn down in the real plane.
    let metaReads = 0;
    host.harness.sdk.stub("terminals.create", async () => ({ id: "term_1" }));
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    host.harness.sdk.stub("terminals.output", async () => {
      metaReads++;
      return hostRcPayload("c1", 0);
    });
    await host.bb.storage.kv.set("crews", [
      crewRow("c1", "thr_c1", "thr_cap"),
      crewRow("c2", "thr_c2", "thr_cap"),
    ]);
    const result = await host.harness.behavior.runCli(["crews"], { projectId: "proj_1" });
    assert.equal(result.exitCode, 0, result.stderr);
    const crews = (await host.bb.storage.kv.get("crews")) as Array<{ id: string }>;
    assert.deepEqual(crews.map((c) => c.id), ["c1"], "c2 (no real meta) must be reconciled out");
    assert.equal(metaReads >= 1, true, "reconciliation should do at least the one batched meta read");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// ---------------------------------------------------------------------------
// Phase 4: real-plane owners (A1-A5), migration, and fm-watch hardening (R1-R5)
// ---------------------------------------------------------------------------

// A fake host whose terminal output is routed by the command text. `router`
// returns { payload, code } for a command; default is empty payload, rc 0.
function stubRoutedHost(
  host: Awaited<ReturnType<typeof load>>,
  router: (cmd: string) => { payload?: string; code?: number },
) {
  const cmds = new Map<string, string>();
  const seen: string[] = [];
  // Host writes now use the injection-safe chunked-append + atomic-rename mechanism
  // (writeHostBytes): base64 is appended to a temp file in bounded `printf` chunks,
  // then decoded to a sibling and `mv -f`'d over the target. Model it with a virtual
  // filesystem so a file's final bytes are recoverable via decodeHostWrite. The
  // router still owns each command's exit code + read payload (existing-file fixtures
  // and forced write failures).
  const vfs = new Map<string, string>();
  const writes: Array<{ path: string; content: string }> = [];
  let n = 0;
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [
    { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
  ]);
  host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_crew", status: "active", environmentId: null }));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
    const id = `t_${++n}`;
    const cmd = args.start?.command ?? "";
    cmds.set(id, cmd);
    seen.push(cmd);
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const cmd = cmds.get(args.terminalId) ?? "";
    const r = router(cmd);
    const code = r.code ?? 0;
    // Only successful commands mutate the virtual FS (a forced-failure decode never
    // renames over the target — mirrors the atomic write's truncate-safety).
    if (code === 0) simulateHostWrite(unwrapHostCommand(cmd), vfs, writes);
    return hostRcPayload(r.payload ?? "", code);
  });
  return { seen, writes, vfs };
}

// Recover the inner command from wrapHostCommand's `__fm_cmd='<escaped>'; set +e; "…`
// envelope (single quotes escaped as '\'' inside the assignment).
function unwrapHostCommand(wrapped: string): string {
  const m = /^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(wrapped);
  return m ? m[1].replace(/'\\''/g, "'") : wrapped;
}

// Apply a writeHostBytes step to the virtual filesystem. Recognizes the three write
// commands (temp init, base64 chunk append, decode + atomic rename); records the
// final bytes per target path so decodeHostWrite can recover them. base64 carries no
// single quote, so [^']* captures a chunk exactly.
function simulateHostWrite(
  inner: string,
  vfs: Map<string, string>,
  writes: Array<{ path: string; content: string }>,
): void {
  let m = /^mkdir -p '[^']*' && : > '([^']+)'$/.exec(inner);
  if (m) { vfs.set(m[1], ""); return; }
  m = /^printf '%s' '([^']*)' >> '([^']+)'$/.exec(inner);
  if (m) { vfs.set(m[2], (vfs.get(m[2]) ?? "") + m[1]); return; }
  m = /^base64 -d '([^']+)' > '([^']+)' && mv -f '[^']+' '([^']+)'$/.exec(inner);
  if (m) {
    const content = Buffer.from(vfs.get(m[1]) ?? "", "base64").toString("utf8");
    vfs.set(m[3], content);
    vfs.delete(m[1]);
    writes.push({ path: m[3], content });
  }
}

// Recover the bytes last written to a host file whose path contains pathSubstr.
function decodeHostWrite(writes: Array<{ path: string; content: string }>, pathSubstr: string): string | null {
  for (let i = writes.length - 1; i >= 0; i--) {
    if (writes[i]!.path.includes(pathSubstr)) return writes[i]!.content;
  }
  return null;
}

function ownerHost(extra: Record<string, unknown> = {}) {
  return createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", fmHostId: "host_1", ...extra },
  });
}

test("A5 memory real: set-captain and add-learning write the tiered files + KV mirror", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    const { writes } = stubRoutedHost(host, () => ({ payload: "", code: 0 }));
    const set = await host.harness.behavior.runCli(["memory", "set-captain", "prefers", "terse"], { projectId: "proj_1" });
    assert.equal(set.exitCode, 0, set.stderr);
    // R-a: content streams as stdin base64, not in the command; decode to verify.
    assert.equal(decodeHostWrite(writes, "data/captain.md"), "prefers terse", "captain.md not written");
    assert.equal(await host.bb.storage.kv.get("memory-captain"), "prefers terse");

    const add = await host.harness.behavior.runCli(["memory", "add-learning", "flaky", "test", "note"], { projectId: "proj_1" });
    assert.equal(add.exitCode, 0, add.stderr);
    const learn = decodeHostWrite(writes, "data/learnings.md");
    assert.ok(learn !== null && /<!--a:\d{4}-\d{2}-\d{2}-->/.test(learn), "learnings.md not written with stow marker");
    assert.ok(learn!.includes("flaky test note"), "learning text missing");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("R-a memory real: a large learnings file still writes (no command-size ceiling)", async () => {
  // Regression: writeHostFile used to inline base64 in the command (cap 10000), so
  // learnings.md silently froze past ~7.4 KB. Now the payload streams via stdin —
  // an existing 12 KB file must still take a new line.
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    const big = Array.from({ length: 200 }, (_, i) => `- 2026-01-01: old learning number ${i} padded padded padded <!--a:2026-01-01-->`).join("\n");
    assert.ok(Buffer.byteLength(big, "utf8") > 10000, "fixture must exceed the old 10000 ceiling");
    const { writes } = stubRoutedHost(host, (cmd) => {
      if (cmd.includes("cat") && cmd.includes("data/learnings.md")) return { payload: big, code: 0 };
      return { payload: "", code: 0 };
    });
    const add = await host.harness.behavior.runCli(["memory", "add-learning", "fresh", "insight"], { projectId: "proj_1" });
    assert.equal(add.exitCode, 0, add.stderr);
    const written = decodeHostWrite(writes, "data/learnings.md");
    assert.ok(written !== null, "learnings.md write did not happen (still frozen)");
    assert.ok(written!.includes("fresh insight"), "new learning not appended to the large file");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("R-a memory real: learnings cap rotates overflow to the archive, keeps the tail", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    // ~90 KB existing body (well over the 64 KB live cap).
    const huge = Array.from({ length: 900 }, (_, i) => `- 2026-01-01: learning ${i} ${"x".repeat(80)} <!--a:2026-01-01-->`).join("\n");
    assert.ok(Buffer.byteLength(huge, "utf8") > 64000, "fixture must exceed the 64000 cap");
    const { writes } = stubRoutedHost(host, (cmd) => {
      if (cmd.includes("cat") && cmd.includes("data/learnings.md") && !cmd.includes("archive")) return { payload: huge, code: 0 };
      return { payload: "", code: 0 };
    });
    const add = await host.harness.behavior.runCli(["memory", "add-learning", "newest", "line"], { projectId: "proj_1" });
    assert.equal(add.exitCode, 0, add.stderr);
    const live = decodeHostWrite(writes, "data/learnings.md");
    const archive = decodeHostWrite(writes, "data/learnings.archive.md");
    assert.ok(live !== null, "live learnings not written");
    assert.ok(Buffer.byteLength(live!, "utf8") <= 64000, "live learnings must be capped under 64000");
    assert.ok(live!.includes("newest line"), "newest learning must be kept (tail)");
    assert.ok(archive !== null, "overflow must rotate to the archive file");
    assert.ok(archive!.includes("learning 0"), "oldest lines must move to the archive");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("R-a memory real: a failed archive write keeps EVERY learning in the live file (no loss)", async () => {
  // F-rotate: if the overflow can't be archived, the live file must NOT be trimmed
  // to `kept` — it must retain the full body so oldest learnings are never dropped.
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    const huge = Array.from({ length: 900 }, (_, i) => `- 2026-01-01: learning ${i} ${"x".repeat(80)} <!--a:2026-01-01-->`).join("\n");
    assert.ok(Buffer.byteLength(huge, "utf8") > 64000, "fixture must exceed the cap so rotation triggers");
    const { writes } = stubRoutedHost(host, (cmd) => {
      if (cmd.includes("cat") && cmd.includes("data/learnings.md") && !cmd.includes("archive")) return { payload: huge, code: 0 };
      // The archive write FAILS.
      if (cmd.includes("base64 -d") && cmd.includes("archive")) return { code: 1 };
      return { payload: "", code: 0 };
    });
    const add = await host.harness.behavior.runCli(["memory", "add-learning", "newest", "line"], { projectId: "proj_1" });
    assert.equal(add.exitCode, 0, add.stderr);
    const live = decodeHostWrite(writes, "data/learnings.md");
    assert.ok(live !== null, "live learnings must still be written");
    assert.ok(live!.includes("learning 0"), "oldest learning must be RETAINED when archive write fails");
    assert.ok(live!.includes("newest line"), "newest learning must be present");
    // Not trimmed: the full raw body (over the cap) is kept rather than dropping overflow.
    assert.ok(Buffer.byteLength(live!, "utf8") > 64000, "live file must keep the full body (untrimmed) on archive failure");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("atomic write: a failed decode/rename never truncates the existing file", async () => {
  // The old `base64 -d > path` truncated the target to 0 bytes before reading a
  // single byte, so a timeout/failure destroyed the prior contents. writeHostBytes
  // decodes to a sibling temp and `mv -f`'s over the target only on success, so a
  // failed write leaves the previous file byte-for-byte intact.
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    let failCaptainDecode = false;
    const { writes, vfs } = stubRoutedHost(host, (cmd) => {
      // Fail only the atomic decode/rename of captain.md (never the chunk appends).
      if (failCaptainDecode && cmd.includes("base64 -d") && cmd.includes("data/captain.md")) return { code: 1 };
      return { payload: "", code: 0 };
    });
    const first = await host.harness.behavior.runCli(["memory", "set-captain", "ORIGINAL"], { projectId: "proj_1" });
    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal(decodeHostWrite(writes, "data/captain.md"), "ORIGINAL", "first write must land");
    const captainPath = [...vfs.keys()].find((k) => k.endsWith("data/captain.md"));
    assert.ok(captainPath !== undefined, "captain.md must exist on the host FS after the first write");
    assert.equal(vfs.get(captainPath!), "ORIGINAL");

    // Second write's atomic step fails: the target must NOT be truncated or replaced.
    failCaptainDecode = true;
    const before = writes.length;
    const second = await host.harness.behavior.runCli(["memory", "set-captain", "REPLACEMENT"], { projectId: "proj_1" });
    assert.equal(second.exitCode, 0, second.stderr); // CLI still succeeds (KV mirror)
    assert.equal(writes.length, before, "a failed atomic write records no new file bytes");
    assert.equal(vfs.get(captainPath!), "ORIGINAL", "the previous file must survive a failed write (no truncation)");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("A5 memory real: show reads the real files (source=real)", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    stubRoutedHost(host, (cmd) => {
      if (cmd.includes("data/captain.md")) return { payload: "CAP-REAL" };
      if (cmd.includes("data/learnings.md")) return { payload: "- 2026-09-01: L1 <!--a:2026-09-01-->" };
      return {};
    });
    const show = await host.harness.behavior.runCli(["memory", "show", "--json"], { projectId: "proj_1" });
    assert.equal(show.exitCode, 0, show.stderr);
    assert.match(show.stdout, /CAP-REAL/);
    assert.match(show.stdout, /L1/);
    assert.match(show.stdout, /"source":\s*"real"/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("A5 memory real: read failure degrades to the KV cache", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    await host.bb.storage.kv.set("memory-captain", "KV-CAP");
    // A non-zero exit on the cat means readMemoryFile returns null → fall back.
    stubRoutedHost(host, () => ({ payload: "", code: 1 }));
    const show = await host.harness.behavior.runCli(["memory", "show", "--json"], { projectId: "proj_1" });
    assert.equal(show.exitCode, 0, show.stderr);
    assert.match(show.stdout, /KV-CAP/);
    assert.match(show.stdout, /"source":\s*"kv"/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("A5 memory kv default is unchanged (no host calls)", async () => {
  const host = ownerHost(); // memoryOwner defaults to kv
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, () => ({}));
    await host.harness.behavior.runCli(["memory", "set-captain", "x"], { projectId: "proj_1" });
    assert.ok(!seen.some((c) => c.includes("data/captain.md")), "kv owner must not touch real files");
    assert.equal(await host.bb.storage.kv.get("memory-captain"), "x");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("A3 afk real: on proposes+confirms the durable contract and sets the flag", async () => {
  const host = ownerHost({ afkOwner: "real" });
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, () => ({ payload: "", code: 0 }));
    const on = await host.harness.behavior.runCli(["afk", "on", "--words", "back at 5", "--grant", "abc12345"], { projectId: "proj_1" });
    assert.equal(on.exitCode, 0, on.stderr);
    assert.ok(seen.some((c) => c.includes("fm-afk-contract.sh") && c.includes("propose") && c.includes("back at 5")), "no contract propose");
    assert.ok(seen.some((c) => c.includes("fm-afk-contract.sh") && c.includes("--grant") && c.includes("abc12345")), "grant not passed");
    assert.ok(seen.some((c) => c.includes("fm-afk-contract.sh") && c.includes("confirm")), "no contract confirm");
    assert.ok(seen.some((c) => c.includes("state/.afk") && c.includes("away")), "flag not set to away");
    assert.match(on.stdout, /contract confirmed/i);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("A3 afk real: propose failure degrades to the KV flag with a log", async () => {
  const host = ownerHost({ afkOwner: "real" });
  await plugin(host.bb);
  try {
    stubRoutedHost(host, (cmd) => (cmd.includes("propose") ? { code: 3 } : { code: 0 }));
    const on = await host.harness.behavior.runCli(["afk", "on", "--words", "away"], { projectId: "proj_1" });
    assert.equal(on.exitCode, 0, on.stderr);
    assert.match(on.stdout, /not confirmed \(KV flag only\)/);
    const afk = (await host.bb.storage.kv.get("afk")) as { on?: boolean };
    assert.equal(afk.on, true, "KV afk must still be on");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("A4 quiet real: on writes state/.afk quiet, off clears it", async () => {
  const host = ownerHost({ quietOwner: "real" });
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, () => ({ code: 0 }));
    await host.harness.behavior.runCli(["quiet", "on"], { projectId: "proj_1" });
    assert.ok(seen.some((c) => c.includes("state/.afk") && c.includes("quiet")), "quiet flag not written");
    await host.harness.behavior.runCli(["quiet", "off"], { projectId: "proj_1" });
    assert.ok(seen.some((c) => c.includes("rm -f") && c.includes("state/.afk")), "quiet flag not cleared");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("A1 queue real: add owns the row id (add <id> <title> --kind); done drives that id", async () => {
  const host = ownerHost({ queueOwner: "real" });
  await plugin(host.bb);
  try {
    // The plugin now SUPPLIES its own id (native convention) and never parses one
    // back, so arbitrary/prose add stdout can never mis-target a row.
    const { seen } = stubRoutedHost(host, () => ({ payload: "Added your task successfully — enjoy!", code: 0 }));
    const add = await host.harness.behavior.runCli(["queue", "add", "ship it", "--project", "proj_1"], { projectId: "proj_1" });
    assert.equal(add.exitCode, 0, add.stderr);
    const q = (await host.bb.storage.kv.get("queue")) as Array<{ id: string; backlogId?: string }>;
    const qid = q[0]!.id;
    assert.equal(q[0]?.backlogId, qid, "backlog row id must equal the KV item id we supplied");
    // The add command carries our id and --kind, not just the title.
    assert.ok(
      seen.some((c) => c.includes("fm-tasks-axi.sh") && c.includes("add") && c.includes(qid) && c.includes("ship")),
      "add must pass our id and --kind ship",
    );
    const done = await host.harness.behavior.runCli(["queue", "done", qid], { projectId: "proj_1" });
    assert.equal(done.exitCode, 0, done.stderr);
    assert.ok(seen.some((c) => c.includes("fm-tasks-axi.sh") && c.includes("done") && c.includes(qid)), "no tasks-axi done for our id");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("A1 queue real: tasks-axi missing (exit 2) degrades to KV, add still works", async () => {
  const host = ownerHost({ queueOwner: "real" });
  await plugin(host.bb);
  try {
    stubRoutedHost(host, () => ({ code: 2 })); // tasks-axi not on PATH
    const add = await host.harness.behavior.runCli(["queue", "add", "ship it", "--project", "proj_1"], { projectId: "proj_1" });
    assert.equal(add.exitCode, 0, add.stderr);
    const q = (await host.bb.storage.kv.get("queue")) as Array<{ id: string; backlogId?: string }>;
    assert.equal(q.length, 1);
    assert.equal(q[0]?.backlogId, undefined, "no backlog id when tasks-axi is missing");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("A2 decisions real: ask holds a captain-hold row; answer closes it + resolves status", async () => {
  const host = ownerHost({ decisionsOwner: "real" });
  await plugin(host.bb);
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    const { seen } = stubRoutedHost(host, () => ({ code: 0 }));
    const ask = await host.harness.behavior.runCli(["decide", "ask", "which", "db?", "--crew", "c1", "--json"], { projectId: "proj_1" });
    assert.equal(ask.exitCode, 0, ask.stderr);
    assert.ok(seen.some((c) => c.includes("fm-captain-hold.sh") && c.includes("hold")), "no captain-hold hold");
    const decisions = (await host.bb.storage.kv.get("decisions")) as Array<{ id: string }>;
    const did = decisions[0]!.id;
    const ans = await host.harness.behavior.runCli(["decide", "answer", did, "--message", "use postgres"], { projectId: "proj_1" });
    assert.equal(ans.exitCode, 0, ans.stderr);
    assert.ok(seen.some((c) => c.includes("fm-captain-hold.sh") && c.includes("answer")), "no captain-hold answer");
    // Resolved close on the linked crew's own status log (appendResolvedStatus).
    assert.ok(seen.some((c) => c.includes("c1.status") && c.includes("resolved [key=")), "no resolved status line");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("migrate-owners projects KV into the real files and is idempotent", async () => {
  const host = ownerHost({ queueOwner: "real", memoryOwner: "real" });
  await plugin(host.bb);
  try {
    await host.bb.storage.kv.set("memory-captain", "MC");
    await host.bb.storage.kv.set("queue", [
      { id: "q1", title: "t1", detail: "", projectId: "proj_1", shape: "ship", mode: "", blockedBy: [], waitUntil: null, status: "queued", crewId: null, createdAt: "2026-09-01T00:00:00.000Z" },
    ]);
    let addCalls = 0;
    const { writes } = stubRoutedHost(host, (cmd) => {
      if (cmd.includes("fm-tasks-axi.sh") && cmd.includes("'add'")) { addCalls++; return { payload: "ok" }; }
      return { code: 0 };
    });
    const first = await host.harness.behavior.runCli(["migrate-owners"], { projectId: "proj_1" });
    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal(addCalls, 1, "queue row should be projected once");
    assert.equal(decodeHostWrite(writes, "data/captain.md"), "MC", "captain memory not projected");
    const q1 = (await host.bb.storage.kv.get("queue")) as Array<{ id: string; backlogId?: string }>;
    assert.equal(q1[0]?.backlogId, q1[0]?.id, "migrate reuses the KV item id as the backlog row id");
    // Re-run: the queue row already has a backlogId → not projected again.
    const second = await host.harness.behavior.runCli(["migrate-owners"], { projectId: "proj_1" });
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal(addCalls, 1, "idempotent: no second tasks-axi add");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("R1 multi-host: a live watcher on host A does not suppress a stuck crew on host B", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", watchOwner: "fm-watch" },
  });
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
    // Crew c1 lives on host_B; the only live beat is for host_A.
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_B", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    host.harness.sdk.stub("threads.output", async () => ({ output: "same" }));
    host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: Date.now() - 40 * 60_000 }]);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    const now = Date.now();
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    await host.bb.storage.kv.set("watch", { c1: { status: "active", hash: "same", at: now - 31 * 60_000, stuck: false } });
    await host.bb.storage.kv.set("fm-watch-beat:host_A", { beatAge: 5, checkedAt: now, grace: 90, relaunched: false });
    const pass = await runStuckOnce(host);
    assert.equal(pass.notified, 1, "host_B has no live watcher; BB must page even though host_A is live");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("R2 relay: only signal:/stale: lines are relayed; check:/heartbeat are dropped", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", watchOwner: "fm-watch", fmHostId: "host_1" },
  });
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("terminals.create", async () => ({ id: "term_1" }));
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("terminals.output", async () =>
      hostRcPayload("FM_BEAT_AGE=5\nFM_RELAUNCHED=0\n---FM_LOGTAIL---\ncheck: routine\nheartbeat 12\nsignal: c1 wedged", 0),
    );
    const run = host.harness.behavior.runService("fm-watch-supervisor");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (sendCalls(host).length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    run.controller.abort();
    await run.done;
    const relayed = sendCalls(host).map((s) => s.text ?? "").join("\n");
    assert.match(relayed, /signal: c1 wedged/);
    assert.doesNotMatch(relayed, /check: routine/);
    assert.doesNotMatch(relayed, /heartbeat 12/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("R3 relaunch backoff: a persistently stale watcher is not relaunched every cycle", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", watchOwner: "fm-watch", fmHostId: "host_1", watchHeartbeatSec: 30 },
  });
  await plugin(host.bb);
  try {
    let relaunchAttempts = 0;
    const cmds = new Map<string, string>();
    let n = 0;
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      const id = `t_${++n}`;
      const cmd = args.start?.command ?? "";
      cmds.set(id, cmd);
      // A cycle that is allowed to relaunch includes the setsid arm launch clause.
      if (cmd.includes("setsid") && cmd.includes("fm-watch-arm.sh")) relaunchAttempts++;
      return { id };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    // Always stale: beat age huge, RELAUNCHED reported when the clause ran.
    host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
      const cmd = cmds.get(args.terminalId) ?? "";
      const rel = cmd.includes("setsid") ? 1 : 0;
      return hostRcPayload(`FM_BEAT_AGE=9999\nFM_RELAUNCHED=${rel}\n---FM_LOGTAIL---\n`, 0);
    });
    const run = host.harness.behavior.runService("fm-watch-supervisor");
    // Let several supervisor cycles elapse (checkMs ~15s min, but service loops fast on abort). Poll the beat backoff.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const b = await host.bb.storage.kv.get("fm-watch-beat:host_1");
      if (b && typeof b === "object" && "backoffUntil" in b && (b as { backoffUntil?: number }).backoffUntil! > Date.now()) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    run.controller.abort();
    await run.done;
    const beat = (await host.bb.storage.kv.get("fm-watch-beat:host_1")) as { backoffUntil?: number; consecutiveRelaunch?: number };
    assert.ok((beat.consecutiveRelaunch ?? 0) >= 1, "should have recorded a relaunch streak");
    assert.ok((beat.backoffUntil ?? 0) > Date.now(), "backoff should be armed after a relaunch");
    // Exactly one relaunch happened before backoff armed (the loop can only run once in this window).
    assert.ok(relaunchAttempts >= 1, "at least one relaunch attempt");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("R4 orphan adoption via broad list when the thread is not tagged firstmate-origin", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_native" }));
    host.harness.sdk.stub("threadSections.list", async () => []);
    host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_x", status: "starting" }));
    const captured = { taskId: "" };
    const cmds = new Map<string, string>();
    let n = 0;
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      const id = `term_${++n}`;
      const cmd = args.start?.command ?? "";
      cmds.set(id, cmd);
      const m = /\/state\/([A-Za-z0-9]+)\.meta/.exec(cmd);
      if (m) captured.taskId = m[1]!;
      return { id };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    // fm-spawn exits 0 but the meta never records bb_thread_id (SIGKILL window).
    host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
      const cmd = cmds.get(args.terminalId) ?? "";
      if (cmd.includes("bb_thread_id")) return hostRcPayload("FM_META_ABSENT", 0);
      return hostRcPayload("", 0);
    });
    // The origin-FILTERED list is empty (BB hasn't attributed firstmate origin to
    // the CLI-spawned thread yet); only the BROAD list returns the orphan, matched
    // by the crewId that mark-crew stamped.
    host.harness.sdk.stub("threads.list", async (args: { originPluginId?: string }) =>
      args.originPluginId === "firstmate" ? [] : [{ id: "thr_orphan", projectId: "proj_1", parentThreadId: "thr_cap", title: "renamed" }],
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ crew: "true", crewId: captured.taskId }));
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "adopt me"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0, "must adopt the orphan, not native-spawn");
    const crews = await crewsKv(host);
    assert.equal(crews[0]?.threadId, "thr_orphan");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("R5 read-through does not reap a crew whose meta write is known-failed", async () => {
  const host = ownerHost({ readThrough: true });
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    // The real state has NO meta for c1 (empty listing), but c1.metaWritten=false.
    stubRoutedHost(host, () => ({ payload: "", code: 0 }));
    await host.bb.storage.kv.set("crews", [{ ...crewRow("c1", "thr_crew", "thr_cap"), metaWritten: false }]);
    const list = await host.harness.behavior.runCli(["crews"], { projectId: "proj_1" });
    assert.equal(list.exitCode, 0, list.stderr);
    const kept = (await host.bb.storage.kv.get("crews")) as Array<{ id: string }>;
    assert.ok(kept.some((c) => c.id === "c1"), "a known-failed-meta crew must not be reaped");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// --- Secondmate scope routing (Phase 5) --------------------------------------
const smRow = (over: Partial<{ projectId: string; threadId: string; scope: string; projects: string[]; createdAt: string }>) => ({
  projectId: "proj_x",
  threadId: "thr_sm",
  scope: "",
  projects: [] as string[],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

test("pickSecondmate: home project and non-exclusive clone list are both eligible", () => {
  const mates = [smRow({ projectId: "auth", threadId: "thr_auth", projects: ["billing"] })];
  assert.equal(pickSecondmate(mates, "auth", "x")?.threadId, "thr_auth", "home project routes");
  assert.equal(pickSecondmate(mates, "billing", "x")?.threadId, "thr_auth", "clone-list project routes");
  assert.equal(pickSecondmate(mates, "unrelated", "x"), undefined, "no fit → main home");
});

test("pickSecondmate: scope word overlap disambiguates multiple eligible mates", () => {
  const mates = [
    smRow({ threadId: "thr_pay", scope: "payments and billing invoices", projects: ["shared"], createdAt: "2026-01-01T00:00:00.000Z" }),
    smRow({ threadId: "thr_auth", scope: "authentication login sessions", projects: ["shared"], createdAt: "2026-01-02T00:00:00.000Z" }),
  ];
  assert.equal(pickSecondmate(mates, "shared", "fix the invoices billing bug")?.threadId, "thr_pay", "scope match wins over recency");
  // No scope overlap → most recently registered wins the tie.
  assert.equal(pickSecondmate(mates, "shared", "unrelated words here")?.threadId, "thr_auth", "recency breaks a scoreless tie");
});

test("pickSecondmate: equal scope scores break the tie to the most recent registration", () => {
  const mates = [
    smRow({ threadId: "thr_old", scope: "payments", projects: ["shared"], createdAt: "2026-01-01T00:00:00.000Z" }),
    smRow({ threadId: "thr_new", scope: "payments", projects: ["shared"], createdAt: "2026-03-01T00:00:00.000Z" }),
  ];
  // Task hits both scopes equally → newest createdAt wins deterministically.
  assert.equal(pickSecondmate(mates, "shared", "payments work")?.threadId, "thr_new");
});

test("versionAtLeast compares semver numerically", () => {
  assert.equal(versionAtLeast("0.2.5", "0.2.4"), true);
  assert.equal(versionAtLeast("0.2.4", "0.2.4"), true);
  assert.equal(versionAtLeast("0.2.3", "0.2.4"), false);
  assert.equal(versionAtLeast("0.10.0", "0.2.4"), true, "numeric, not lexical");
  assert.equal(versionAtLeast("1.0.0", "0.2.4"), true);
  assert.equal(versionAtLeast("0.2", "0.2.4"), false, "missing patch = 0");
});

test("formatSecondmate renders scope and clone list", () => {
  assert.equal(formatSecondmate(smRow({ projectId: "a", threadId: "t", scope: "pay", projects: ["b", "c"] })), "a → t (pay) [projects: b, c]");
  assert.equal(formatSecondmate(smRow({ projectId: "a", threadId: "t" })), "a → t");
});

// --- Review follow-ups F1/F2/F3 ---------------------------------------------

test("F1: memory content equal to the heredoc delimiter round-trips and never injects", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    const { seen, writes } = stubRoutedHost(host, () => ({ code: 0 }));
    // Exact PoC: lines equal to the OLD heredoc delimiters + a shell payload.
    const poc = "FM_MEM_EOF\nFM_DEC_EOF\n'; touch /tmp/fm_pwned #";
    const set = await host.harness.behavior.runCli(["memory", "set-captain", poc], { projectId: "proj_1" });
    assert.equal(set.exitCode, 0, set.stderr);
    // Content round-trips byte-for-byte (base64 decode of the stdin payload).
    assert.equal(decodeHostWrite(writes, "data/captain.md"), poc, "captain.md content did not round-trip");
    // The dangerous text never appears as executable shell text (only base64).
    const all = seen.join("\n");
    assert.ok(!all.includes("touch /tmp/fm_pwned"), "payload leaked into the shell command text");
    assert.ok(!/\bFM_MEM_EOF\b(?!.*base64)/.test(all.replace(/[A-Za-z0-9+/=]{16,}/g, "B64")), "delimiter leaked outside base64");
    assert.equal(await host.bb.storage.kv.get("memory-captain"), poc);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("F1: decision answer equal to the delimiter round-trips via base64 (no injection)", async () => {
  const host = ownerHost({ decisionsOwner: "real" });
  await plugin(host.bb);
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    const { seen, writes } = stubRoutedHost(host, () => ({ code: 0 }));
    const ask = await host.harness.behavior.runCli(["decide", "ask", "pick?", "--json"], { projectId: "proj_1" });
    assert.equal(ask.exitCode, 0, ask.stderr);
    const did = ((await host.bb.storage.kv.get("decisions")) as Array<{ id: string }>)[0]!.id;
    const poc = "FM_DEC_EOF\n$(touch /tmp/fm_pwned2)";
    const ans = await host.harness.behavior.runCli(["decide", "answer", did, "--message", poc], { projectId: "proj_1" });
    assert.equal(ans.exitCode, 0, ans.stderr);
    assert.equal(decodeHostWrite(writes, ".answer"), poc, "decision answer file did not round-trip");
    assert.ok(!seen.join("\n").includes("touch /tmp/fm_pwned2"), "decision payload leaked into shell text");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Extract the state/.afk flag mutation (write mode or removal) from a command slice.
function afkFlagOp(cmds: string[]): "away" | "quiet" | "removed" | null {
  for (const c of cmds) {
    if (!c.includes("state/.afk") || c.includes(".afk-contract") || c.includes("fm-afk-contract.sh")) continue;
    if (c.includes("rm -f")) return "removed";
    if (/printf[^|]*quiet/.test(c)) return "quiet";
    if (/printf[^|]*away/.test(c)) return "away";
  }
  return null;
}

test("F2: afk + quiet both real never clobber the shared state/.afk flag", async () => {
  const host = ownerHost({ afkOwner: "real", quietOwner: "real" });
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, () => ({ code: 0 }));
    let mark = seen.length;
    const step = async (args: string[]) => {
      mark = seen.length;
      const r = await host.harness.behavior.runCli(args, { projectId: "proj_1" });
      assert.equal(r.exitCode, 0, r.stderr);
      return afkFlagOp(seen.slice(mark));
    };
    assert.equal(await step(["afk", "on", "--words", "bbl"]), "away", "afk on should set away");
    assert.equal(await step(["quiet", "on"]), "away", "quiet on must NOT overwrite away");
    assert.equal(await step(["afk", "off"]), "quiet", "afk off must leave quiet, not delete the flag");
    assert.equal(await step(["quiet", "off"]), "removed", "quiet off with no away removes the flag");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("queue real: id-ownership is robust to arbitrary add output; transitions target our id", async () => {
  // Supersedes the old parse/quarantine tests: we supply the id, so prose or empty
  // add stdout can never mis-target or freeze a row, and start/done always fire.
  const host = ownerHost({ queueOwner: "real" });
  await plugin(host.bb);
  try {
    let transitions: string[] = [];
    const { seen } = stubRoutedHost(host, (cmd) => {
      if (cmd.includes("fm-tasks-axi.sh") && (cmd.includes("'done'") || cmd.includes("'start'") || cmd.includes("'rm'"))) transitions.push(cmd);
      return { payload: "totally unstructured output that could never be parsed", code: 0 };
    });
    const add = await host.harness.behavior.runCli(["queue", "add", "ship it", "--project", "proj_1"], { projectId: "proj_1" });
    assert.equal(add.exitCode, 0, add.stderr);
    const q = (await host.bb.storage.kv.get("queue")) as Array<{ id: string; backlogId?: string }>;
    const qid = q[0]!.id;
    assert.equal(q[0]?.backlogId, qid, "row id is our supplied id regardless of add stdout");
    const done = await host.harness.behavior.runCli(["queue", "done", qid], { projectId: "proj_1" });
    assert.equal(done.exitCode, 0, done.stderr);
    assert.ok(transitions.some((c) => c.includes("done") && c.includes(qid)), "done must transition our id");
    // migrate is idempotent: the already-projected row is not re-added.
    let addCalls = 0;
    stubRoutedHost(host, (cmd) => { if (cmd.includes("'add'")) addCalls++; return { code: 0 }; });
    await host.harness.behavior.runCli(["migrate-owners"], { projectId: "proj_1" });
    assert.equal(addCalls, 0, "already-projected row must not be re-added on migrate");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("queue real: tasks-axi add exit!=0 leaves the row KV-only (no backlog id)", async () => {
  const host = ownerHost({ queueOwner: "real" });
  await plugin(host.bb);
  try {
    stubRoutedHost(host, (cmd) => (cmd.includes("'add'") ? { code: 1 } : { code: 0 }));
    await host.harness.behavior.runCli(["queue", "add", "explicit", "--project", "proj_1"], { projectId: "proj_1" });
    const q = (await host.bb.storage.kv.get("queue")) as Array<{ backlogId?: string }>;
    assert.equal(q[0]?.backlogId, undefined, "a failed add must not record a backlog id");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
