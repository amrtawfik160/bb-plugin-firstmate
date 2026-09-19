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
import plugin, { formatFmMeta, toolbeltPhrase } from "./server.ts";

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
