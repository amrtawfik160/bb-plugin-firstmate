import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { formatFmMeta } from "./server.ts";

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
