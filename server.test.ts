import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, {
  backlogTitleOf,
  captainWakeDoorbell,
  compareUpstreamScriptSurface,
  crewThreadTitle,
  fmBackendEnv,
  fmWatchKeeperInterval,
  fmWatchKeeperScript,
  fmWatchOwnerBeatTtl,
  formatFmMeta,
  formatSecondmate,
  inboxReapScript,
  normalizeCaptainIntent,
  pickSecondmate,
  rewriteWakeAckLine,
  toolbeltPhrase,
  versionAtLeast,
} from "./server.ts";
import { latestStatus, statusProtocolSummary } from "./lib/policy.ts";
import { UPSTREAM_SCRIPT_NAMES, PINNED_SCRIPT_SUPPORT_FILES, UPSTREAM_SKILL_NAMES } from "./lib/upstream-surface.ts";
import { FIRSTMATE_ROUTINE_MARKER } from "./lib/timeline-noise.ts";

const SKILLS = ["captain", "firstmate", ...UPSTREAM_SKILL_NAMES] as const;

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
    assert.match(result.stdout, /bb firstmate scripts/);
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
    assert.deepEqual([...cfg.skills].sort(), [...SKILLS].sort(), "captain must receive every bundled upstream skill");
    assert.ok(cfg.tools.some((tool) => tool.name === "firstmate_wake"));
    assert.deepEqual(
      cfg.tools.map((tool) => tool.name).sort(),
      host.harness.inspection.registrations.agentTools.map((tool) => tool.name).sort(),
      "captain sessions must expose every registered firstmate tool",
    );
    assert.match(cfg.instructions ?? "", /talk in outcomes, not mechanics/i);
    assert.match(cfg.instructions ?? "", /Do not narrate tool calls/);
    assert.match(cfg.instructions ?? "", /automatic fixes, retries, routine progress/);
    assert.match(cfg.instructions ?? "", /call firstmate_watch once per batch/i);
    assert.match(cfg.instructions ?? "", /private durable wakes/i);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("complete upstream script surface is pinned and drift is reported", () => {
  const complete = compareUpstreamScriptSurface(UPSTREAM_SCRIPT_NAMES, "", PINNED_SCRIPT_SUPPORT_FILES);
  assert.equal(complete.expected, 177);
  assert.equal(complete.installed, 177);
  assert.deepEqual(complete.missing, []);
  assert.deepEqual(complete.extra, []);
  assert.equal(complete.expectedSupport, 20);
  assert.equal(complete.installedSupport, 20);
  assert.deepEqual(complete.missingSupport, []);
  assert.deepEqual(complete.extraSupport, []);
  assert.deepEqual(complete.matches, [...UPSTREAM_SCRIPT_NAMES]);

  const drift = compareUpstreamScriptSurface(
    [...UPSTREAM_SCRIPT_NAMES.slice(1), "future-script"],
    "afk",
    [...PINNED_SCRIPT_SUPPORT_FILES.slice(1), "future-helper.py"],
  );
  assert.deepEqual(drift.missing, ["afk-contract"]);
  assert.deepEqual(drift.extra, ["future-script"]);
  assert.deepEqual(drift.missingSupport, ["backends/bb.sh"]);
  assert.deepEqual(drift.extraSupport, ["future-helper.py"]);
  assert.ok(drift.matches.every((name) => name.includes("afk")));
});

test("every pinned upstream skill is bundled under its registered name", () => {
  const root = dirname(fileURLToPath(import.meta.url));
  for (const name of UPSTREAM_SKILL_NAMES) {
    const path = join(root, "skills", name, "SKILL.md");
    assert.ok(existsSync(path), `missing bundled skill ${name}`);
    assert.match(readFileSync(path, "utf8"), new RegExp(`^---\\nname: ${name}\\n`));
  }
});

test("captain tool activity is folded by default", async () => {
  const host = await load();
  try {
    const tools = host.harness.inspection.registrations.agentTools;
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      assert.equal(tool.presentation?.suppress, true, `${tool.name} should be low-noise`);
    }
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_watch hands off to private wakes without opening a blocking transport wait", async () => {
  const host = await load();
  try {
    await seedCrew(host);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "active", projectId: "proj_1" }),
    );
    host.harness.sdk.stub("threads.wait", async () => {
      throw new Error("blocking watch transport must not be opened");
    });
    const watch = host.harness.inspection.registrations.agentTools.find(
      (tool) => tool.name === "firstmate_watch",
    );
    assert.ok(watch);

    const result = await watch.execute(
      { crewIds: ["c1"], timeoutSec: 300 },
      { threadId: "thr_cap", projectId: "proj_1" } as never,
    );
    const text = typeof result === "string"
      ? result
      : result.content.map((item) => item.type === "text" ? item.text : "").join("\n");

    assert.equal(host.harness.sdk.callsTo("threads.wait").length, 0);
    assert.match(text, /private event-driven supervision/i);
    assert.match(text, /do not call firstmate_watch again/i);
    assert.ok(text.includes(FIRSTMATE_ROUTINE_MARKER), "handoff row must stay hidden");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("fleet RPC identifies and scopes the current captain thread", async () => {
  const host = await load();
  try {
    host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (
      threadId === "thr_captain" ? { captain: "true" } : {}
    ));
    const fleet = await host.harness.behavior.callRpc("fleet", { threadId: "thr_captain" }) as {
      captain: boolean;
    };
    assert.equal(fleet.captain, true);
    const legacy = await host.harness.behavior.callRpc("fleet", null) as { captain: boolean };
    assert.equal(legacy.captain, false, "already-open tabs may keep the old null input until refresh");
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
      title?: string;
      visibility?: string;
    };
    assert.equal(args.environment?.type, "host");
    assert.equal(args.environment?.hostId, "host_1");
    assert.equal(args.environment?.workspace?.type, "managed-worktree");
    assert.match(args.title ?? "", /^Ship · Fix flaky login · [a-f0-9]{8}$/);
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

test("backlogTitleOf strips the Captain label and uses the first line, capped", () => {
  assert.equal(backlogTitleOf("Captain's intent: fix flaky login\n\ndetails"), "fix flaky login");
  assert.equal(backlogTitleOf("Captain's intent:\nsurvey the auth flow"), "survey the auth flow");
  assert.equal(backlogTitleOf("   \n\nplain task"), "plain task");
  assert.equal(backlogTitleOf(""), "crew task");
  assert.equal(backlogTitleOf("x".repeat(500)).length, 200);
});

test("crewThreadTitle makes concise work-first ship and scout names", () => {
  assert.equal(
    crewThreadTitle("Captain's intent: fix flaky login\n\nmore detail", "ship", "abc12def"),
    "Ship · Fix flaky login · abc12def",
  );
  assert.equal(
    crewThreadTitle("ignored", "scout", "de45f678", "# audit the auth flow"),
    "Scout · Audit the auth flow · de45f678",
  );
  assert.ok(crewThreadTitle("x".repeat(300), "ship", "abc12def").length <= 100);
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
      input?: Array<{ text?: string; visibility?: string }>;
    };
    return {
      threadId: args.threadId,
      mode: args.mode,
      text: args.input?.[0]?.text ?? "",
      visibility: args.input?.[0]?.visibility,
    };
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

test("D1: an in-band FAILED doorbell renders ❌ failed, never ✅ done, and never offers deliver", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    const emitted = await emitIdle(host, "FAILED: contradictory requirements, cannot proceed");
    assert.deepEqual(emitted.errors, []);
    const sends = sendCalls(host);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.threadId, "thr_cap");
    const text = sends[0]?.text ?? "";
    assert.match(text, /❌ crew c1 failed/);
    assert.doesNotMatch(text, /✅ crew c1 done/);
    assert.doesNotMatch(text, /next: bb firstmate deliver/);
    assert.match(text, /next: bb firstmate retry\|tell\|forget c1/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D1: an in-band BLOCKED doorbell renders 🚧 blocked, never ✅ done, and never offers deliver", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    const emitted = await emitIdle(host, "BLOCKED: no git remote; gh-axi unavailable");
    assert.deepEqual(emitted.errors, []);
    const sends = sendCalls(host);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.threadId, "thr_cap");
    const text = sends[0]?.text ?? "";
    assert.match(text, /🚧 crew c1 blocked/);
    assert.doesNotMatch(text, /✅ crew c1 done/);
    assert.doesNotMatch(text, /next: bb firstmate deliver/);
    assert.match(text, /next: bb firstmate tell\|retry\|forget c1/);
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

// ---- tell defaults to STEER (course correction lands in the running turn) ----

const STEER_PREFIX_TEST =
  "STEER from captain — this is a course correction, NOT a stop. Keep working on your current task and fold this in without tearing down or discarding work: ";

function stubActiveSdk(host: Awaited<ReturnType<typeof load>>) {
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({ id: "thr_crew", status: "active", environmentId: null }),
  );
}

test("tell steers a running crew mid-turn by default (mode:steer + course-correction framing)", async () => {
  const host = await load();
  try {
    stubActiveSdk(host);
    await seedCrew(host);
    const res = await host.harness.behavior.runCli(
      ["tell", "c1", "--message=Correction from captain: the company is Straightline, not Streetline"],
      { projectId: "proj_1" },
    );
    assert.equal(res.exitCode, 0, res.stderr);
    const sends = sendCalls(host).filter((s) => s.threadId === "thr_crew");
    assert.equal(sends.length, 1);
    // The whole bug: a correction to an ACTIVE crew must land in its running turn.
    // Reverting to mode:"queue-if-active" makes this assertion die.
    assert.equal(sends[0]?.mode, "steer");
    assert.ok(sends[0]?.text.startsWith(STEER_PREFIX_TEST), "steer must carry the not-a-stop framing");
    assert.match(sends[0]?.text ?? "", /Straightline, not Streetline/);
    // Honest status: the captain is told it steered, not that it "told" (queued).
    assert.match(res.stdout, /Steered into crew c1's running turn/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("tell --queue opts out to a non-disturbing queued note (mode:queue-if-active, no steer prefix)", async () => {
  const host = await load();
  try {
    stubActiveSdk(host);
    await seedCrew(host);
    const res = await host.harness.behavior.runCli(
      ["tell", "c1", "--queue", "--message=non-urgent FYI for later"],
      { projectId: "proj_1" },
    );
    assert.equal(res.exitCode, 0, res.stderr);
    const sends = sendCalls(host).filter((s) => s.threadId === "thr_crew");
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.mode, "queue-if-active");
    assert.equal(sends[0]?.text, "non-urgent FYI for later");
    assert.match(res.stdout, /Queued for crew c1/);
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
    // D3: afk posture is scoped to the crew's captain (thr_cap).
    await host.bb.storage.kv.set("afk:cap-thr_cap", {
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
    const afk = (await host.bb.storage.kv.get("afk:cap-thr_cap")) as { held?: string[] };
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

test("F2: the real afk contract + .afk flag write to the HOST-LEVEL path native reads (never cap-scoped)", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", fmHostId: "host_1", afkOwner: "real" },
  });
  await plugin(host.bb);
  try {
    const hostCommands: string[] = [];
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      if (typeof args.start?.command === "string") hostCommands.push(args.start.command);
      return { id: "term_1" };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.output", async () => hostRcOutput(0));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    const result = await host.harness.behavior.runCli(["afk", "on", "--words", "out"], { threadId: "thr_capA", projectId: "proj_1" });
    assert.equal(result.exitCode, 0, result.stderr);
    // The .afk flag + the fm-afk-contract.sh invocation must target the host-level
    // state dir the native fm-watch keeper reads — NEVER a cap-<captain> subdir.
    const afkWrite = hostCommands.find((c) => c.includes("/state/.afk"));
    assert.ok(afkWrite, `no .afk flag write in:\n${hostCommands.join("\n---\n")}`);
    assert.match(afkWrite, /\/tmp\/fm-home\/state\/\.afk/);
    for (const cmd of hostCommands) {
      assert.doesNotMatch(cmd, /state\/cap-/, `real afk path must not be cap-scoped: ${cmd}`);
      assert.doesNotMatch(cmd, /FM_STATE_OVERRIDE=.*cap-/, `contract must not scope FM_STATE_OVERRIDE per captain: ${cmd}`);
    }
    // The KV posture, by contrast, IS per-captain.
    assert.ok(await host.bb.storage.kv.get("afk:cap-thr_capA"), "KV posture must be captain-scoped");
    assert.equal(await host.bb.storage.kv.get("afk"), undefined, "no global KV posture key");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D3: afk is per-captain — captain A going away never holds captain B's doorbell", async () => {
  const host = await load();
  try {
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: null }),
    );
    await host.bb.storage.kv.set("crews", [
      { ...crewRow("cA", "thr_crewA", "thr_capA") },
      { ...crewRow("cB", "thr_crewB", "thr_capB") },
    ]);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    // Only captain A is away.
    await host.bb.storage.kv.set("afk:cap-thr_capA", {
      on: true, words: "out", since: "2026-09-18T00:00:00.000Z", held: [],
    });
    // A's crew finishes: held for A (routine done ping), no doorbell to A.
    await emitIdle(host, "DONE: A shipped", { id: "thr_crewA" });
    assert.equal(sendCalls(host).filter((s) => s.threadId === "thr_capA").length, 0, "A is away → held");
    const afkA = (await host.bb.storage.kv.get("afk:cap-thr_capA")) as { held?: string[] };
    assert.match(afkA.held?.join("\n") ?? "", /DONE: A shipped/);
    // B's crew finishes: B is NOT away, so B is doorbelled normally.
    await emitIdle(host, "DONE: B shipped", { id: "thr_crewB" });
    const toB = sendCalls(host).filter((s) => s.threadId === "thr_capB");
    assert.equal(toB.length, 1, "B is present → doorbelled despite A being away");
    assert.match(toB[0]?.text ?? "", /DONE: B shipped/);
    // B's posture record must be untouched by A's afk.
    assert.equal(await host.bb.storage.kv.get("afk:cap-thr_capB"), undefined);
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
    await host.bb.storage.kv.set("quiet:cap-thr_cap", true);
    await host.bb.storage.kv.set("afk:cap-thr_cap", {
      on: false,
      words: "",
      since: "2026-09-18T00:00:00.000Z",
      held: ["stale-afk"],
    });
    const emitted = await emitIdle(host, "DONE: batched");
    assert.deepEqual(emitted.errors, []);
    assert.equal(sendCalls(host).filter((send) => send.threadId === "thr_cap").length, 0);
    const quiet = (await host.bb.storage.kv.get("quiet:cap-thr_cap")) as { on?: boolean; held?: string[] };
    assert.equal(quiet.on, true);
    assert.match(quiet.held?.join("\n") ?? "", /DONE: batched/);
    const afk = (await host.bb.storage.kv.get("afk:cap-thr_cap")) as { held?: string[] };
    assert.deepEqual(afk.held, ["stale-afk"]);
    const off = await host.harness.behavior.runCli(["quiet", "off"], { threadId: "thr_cap" });
    assert.equal(off.exitCode, 0, off.stderr);
    assert.match(off.stdout, /Quiet off/);
    assert.match(off.stdout, /DONE: batched/);
    const cleared = (await host.bb.storage.kv.get("quiet:cap-thr_cap")) as { on?: boolean; held?: string[] };
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
    await host.bb.storage.kv.set("afk:cap-thr_cap", {
      on: true,
      words: "",
      since: "2026-09-18T00:00:00.000Z",
      held: [],
    });
    for (let i = 0; i < 21; i++) {
      const emitted = await emitIdle(host, `DONE: item ${i}`);
      assert.deepEqual(emitted.errors, []);
    }
    const afk = (await host.bb.storage.kv.get("afk:cap-thr_cap")) as { held?: string[] };
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

function stubForgetSdk(
  host: Awaited<ReturnType<typeof load>>,
  opts: { dirty: string[]; committed?: string[]; prUrl?: string; isWorktree?: boolean },
) {
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: "env_wt" }),
  );
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.archive", async () => ({}));
  host.harness.sdk.stub("threads.stop", async () => ({}));
  host.harness.sdk.stub("threads.output", async () => ({ output: "DONE: shipped" }));
  host.harness.sdk.stub("environments.get", async () => ({
    id: "env_wt",
    hostId: "host_1",
    path: "/wt",
    isWorktree: opts.isWorktree ?? true,
    status: "ready",
    mergeBaseBranch: "main",
  }));
  // diffFiles is asked for two targets: uncommitted (dirty guard) and
  // branch_committed (F1 committed-unpushed guard). Answer each independently.
  host.harness.sdk.stub("environments.diffFiles", async (args: { target?: string }) => {
    const paths = args.target === "branch_committed" ? (opts.committed ?? []) : opts.dirty;
    return { files: paths.map((path) => ({ path })) };
  });
  host.harness.sdk.stub("environments.pullRequest", async () => ({
    pullRequest: opts.prUrl !== undefined ? { url: opts.prUrl, state: "open" } : null,
  }));
  host.harness.sdk.stub("environments.delete", async () => ({ ok: true as const }));
}

test("D2: forget --stop on a clean crew removes the managed worktree", async () => {
  const host = await load();
  try {
    await seedCrew(host); // worktree: true
    stubForgetSdk(host, { dirty: [] });
    const result = await host.harness.behavior.runCli(["forget", "c1", "--stop"], { projectId: "proj_1" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /worktree removed/);
    const del = host.harness.sdk.callsTo("environments.delete");
    assert.equal(del.length, 1, "worktree env must be deleted exactly once");
    assert.equal((del[0]?.[0] as { environmentId?: string }).environmentId, "env_wt");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D2: forget --stop on a DIRTY crew refuses and leaves the worktree intact", async () => {
  const host = await load();
  try {
    await seedCrew(host);
    stubForgetSdk(host, { dirty: ["src/a.ts", "src/b.ts"] });
    const result = await host.harness.behavior.runCli(["forget", "c1", "--stop"], { projectId: "proj_1" });
    assert.notEqual(result.exitCode, 0, "must refuse a dirty tree");
    assert.match(result.stderr + result.stdout, /uncommitted file/);
    // The worktree must NOT be deleted (no discarding uncommitted work), and the
    // crew record must survive the refusal.
    assert.equal(host.harness.sdk.callsTo("environments.delete").length, 0);
    const crews = (await host.bb.storage.kv.get("crews")) as Array<{ id: string }>;
    assert.ok(crews.some((c) => c.id === "c1"), "crew record must survive a refusal");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D2: forget --stop --force on a dirty crew still removes the worktree", async () => {
  const host = await load();
  try {
    await seedCrew(host);
    stubForgetSdk(host, { dirty: ["src/a.ts"] });
    const result = await host.harness.behavior.runCli(["forget", "c1", "--stop", "--force"], { projectId: "proj_1" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(host.harness.sdk.callsTo("environments.delete").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D2: forget --stop on a SHARED-ENV crew never deletes the shared project environment", async () => {
  const host = await load();
  try {
    // shared-env crew: worktree false → runs in project-default, must not be deleted.
    await host.bb.storage.kv.set("crews", [
      { ...shipRow("c1", "thr_crew", "thr_cap"), worktree: false, posture: "local-only" },
    ]);
    stubForgetSdk(host, { dirty: [], isWorktree: false });
    const result = await host.harness.behavior.runCli(["forget", "c1", "--stop"], { projectId: "proj_1" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(host.harness.sdk.callsTo("environments.delete").length, 0, "shared env must never be deleted");
    assert.doesNotMatch(result.stdout, /worktree removed/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("F1: forget --stop refuses a crew with committed-but-UNPUSHED work (worktree intact)", async () => {
  const host = await load();
  try {
    await seedCrew(host);
    // Clean tree, but the branch has commits vs base and NO PR → unpushed, unlanded.
    stubForgetSdk(host, { dirty: [], committed: ["src/feature.ts", "src/feature.test.ts"] });
    const result = await host.harness.behavior.runCli(["forget", "c1", "--stop"], { projectId: "proj_1" });
    assert.notEqual(result.exitCode, 0, "must refuse committed-unpushed work");
    assert.match(result.stderr + result.stdout, /committed but UNPUSHED/);
    assert.equal(host.harness.sdk.callsTo("environments.delete").length, 0, "worktree must survive the refusal");
    const crews = (await host.bb.storage.kv.get("crews")) as Array<{ id: string }>;
    assert.ok(crews.some((c) => c.id === "c1"), "crew record must survive the refusal");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("F1: forget --stop ALLOWS a crew whose committed work is pushed to a PR (recoverable)", async () => {
  const host = await load();
  try {
    await seedCrew(host);
    // Committed vs base, but a PR exists → the commits are on the forge, recoverable.
    stubForgetSdk(host, { dirty: [], committed: ["src/feature.ts"], prUrl: "https://github.com/x/y/pull/9" });
    const result = await host.harness.behavior.runCli(["forget", "c1", "--stop"], { projectId: "proj_1" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /worktree removed/);
    assert.equal(host.harness.sdk.callsTo("environments.delete").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("F1: forget --stop --force removes the worktree despite committed-unpushed work", async () => {
  const host = await load();
  try {
    await seedCrew(host);
    stubForgetSdk(host, { dirty: [], committed: ["src/feature.ts"] });
    const result = await host.harness.behavior.runCli(["forget", "c1", "--stop", "--force"], { projectId: "proj_1" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(host.harness.sdk.callsTo("environments.delete").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
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
    assert.match(result.stdout, /real bearings \(fm-bearings-snapshot; authoritative, host-wide\)/);
    assert.match(result.stdout, /FLEET SNAPSHOT: 0 crews/);
    assert.match(result.stdout, /native digest \(BB KV cache \/ fallback\)/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("bb overlay adapter propagates reasoning, names and tags crews, drops yolo->full, carves out scouts", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "overlay", "bin", "backends", "bb.sh"),
    "utf8",
  );
  assert.match(src, /--reasoning-level/);
  assert.match(src, /FM_BB_REASONING/);
  assert.match(src, /FM_BB_THREAD_TITLE/);
  assert.match(src, /\$role · \$subject · \$id/);
  assert.match(src, /firstmate mark-crew/);
  // yolo no longer forces BB full permission
  assert.doesNotMatch(src, /perm=full/);
  // scout scratch carve-out in remove_worktree
  assert.match(src, /KIND:-/);
  assert.match(src, /scout\)/);
});

// ── Overlay must NEVER edit tracked native files (mirror-bin invariant) ───────
// The overlay registers backend=bb through a parallel "mirror bin" (bin-bb), never
// by patching the tracked bin/fm-backend.sh / fm-spawn.sh / fm-teardown.sh in place.
// An in-place patch permanently dirties the firstmate clone and freezes the
// fetch + ff-only auto-update. These guards fail loudly if that regresses.

const OVERLAY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "overlay");
const INSTALLER_SRC = readFileSync(join(OVERLAY_ROOT, "install-bb-backend.py"), "utf8");
const PATCH_BASE = readFileSync(join(OVERLAY_ROOT, "patch-base.txt"), "utf8").trim();
const UPSTREAM_URL = "https://github.com/kunchenguid/firstmate";

// Clone `checkout` into `home` and detach at the PINNED patch base (overlay/patch-base.txt).
// The overlay patches are refreshed against that exact upstream commit, so the installer
// only applies there — not against whatever the local checkout's HEAD happens to be. A
// --local clone carries every object (including the base commit even when it is
// unreachable from the checkout HEAD); if the base is still missing, fetch it from origin.
// Returns null on success or a skip reason string.
function cloneAtPatchBase(checkout: string, home: string): string | null {
  if (spawnSync("git", ["clone", "--quiet", "--local", checkout, home]).status !== 0) return "clone failed";
  if (spawnSync("git", ["-C", home, "cat-file", "-e", PATCH_BASE]).status !== 0) {
    if (spawnSync("git", ["-C", home, "fetch", "--quiet", UPSTREAM_URL, PATCH_BASE]).status !== 0) {
      return `patch base ${PATCH_BASE.slice(0, 12)} unavailable (no local object, fetch failed)`;
    }
  }
  if (spawnSync("git", ["-C", home, "checkout", "--quiet", "--detach", PATCH_BASE]).status !== 0) {
    return `could not checkout patch base ${PATCH_BASE.slice(0, 12)}`;
  }
  return null;
}

test("installer applies patches to a scratch tree only — never against the home's tracked bin/", () => {
  // The old installer ran `patch ... cwd=home`; that is the exact regression to block.
  assert.doesNotMatch(
    INSTALLER_SRC,
    /cwd\s*=\s*home\b/,
    "installer must not run patch (or anything) with cwd=home — that edits tracked files",
  );
  // Patches are applied inside a throwaway temp tree.
  assert.match(INSTALLER_SRC, /tempfile\.TemporaryDirectory/);
  assert.match(INSTALLER_SRC, /cwd=tmproot/);
  // The three patched files are written into the MIRROR (dest_dir), not home/bin.
  assert.match(INSTALLER_SRC, /\(dest_dir \/ f\)\.write_text\(rewritten\)/);
  // F4: internal dispatch self-references are rewritten to $SCRIPT_DIR in the copies.
  assert.match(INSTALLER_SRC, /SELF_REF_RE/);
  assert.match(INSTALLER_SRC, /\$SCRIPT_DIR/);
  // F2: a manifest is written so staleness can be detected, and a --verify mode exists.
  assert.match(INSTALLER_SRC, /def write_manifest/);
  assert.match(INSTALLER_SRC, /def verify_mirror/);
  assert.match(INSTALLER_SRC, /--verify/);
});

test("installer builds a mirror bin and keeps the tree clean via .git/info/exclude", () => {
  assert.match(INSTALLER_SRC, /MIRROR_DIRNAME\s*=\s*"bin-bb"/);
  // Every non-patched bin entry is symlinked (inherits upstream on ff-update).
  assert.match(INSTALLER_SRC, /os\.symlink\(/);
  // The overlay's untracked paths are registered in the per-clone git exclude so
  // `git status --porcelain` stays empty and ff-only stops skipping.
  assert.match(INSTALLER_SRC, /info.*exclude/s);
  assert.match(INSTALLER_SRC, /\/\{MIRROR_DIRNAME\}\//);
  // config/ is already gitignored upstream, so the marker is safe.
  assert.match(INSTALLER_SRC, /"bb-overlay"/);
});

test("plugin routes fm scripts through the bb mirror bin (FM_BINDIR), not hardcoded bin/", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "server.ts"), "utf8");
  // The routing helper resolves bin-bb when the overlay marker is present.
  assert.match(src, /function fmBinDirAssign/);
  assert.match(src, /config\/bb-overlay/);
  assert.match(src, /\/bin-bb/);
  // runFmScript invokes via the resolved FM_BINDIR, and the watch keeper arms through it.
  assert.match(src, /"\$FM_BINDIR\/\$\{scriptLeaf\}"/);
  assert.match(src, /ARM="\$FM_BINDIR\/fm-watch-arm\.sh"/);
});

test("plugin emits a loud stale-mirror guard on use and surfaces FM_MIRROR_STALE (F2)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "server.ts"), "utf8");
  // The guard compares the mirror manifest HEAD to the clone HEAD and prints FM_MIRROR_STALE.
  assert.match(src, /function fmMirrorStaleGuard/);
  assert.match(src, /FM_MIRROR_STALE/);
  assert.match(src, /\.mirror-manifest/);
  assert.match(src, /rev-parse HEAD/);
  // runFmScript and the brief scaffold both wire the guard and log it loudly.
  assert.match(src, /fmMirrorStaleGuard\(input\.fmHome\)/);
  assert.match(src, /fmMirrorStaleGuard\(fmHome\)/);
  assert.match(src, /bb mirror is STALE/);
  // F2: the fm-brief scaffold must NOT swallow stderr with `>/dev/null 2>&1 || exit 0`.
  assert.doesNotMatch(src, /\$\{scaffold\} >\/dev\/null 2>&1 \|\| exit 0/);
  assert.match(src, /fm-brief scaffold failed: \$__fm_err/);
});

test("stale-mirror guard is wired into the SUPERVISION paths (keeper + checkWatcher), loud (F2 re-review)", () => {
  // Keeper: the pure builder embeds the guard, so a stale re-arm is recorded to the
  // watch log (which checkWatcher tails and surfaces). fm-watch is re-armed FROM the
  // mirror, so an unguarded keeper would degrade supervision silently.
  const keeper = fmWatchKeeperScript("host_1", "/h", 15);
  assert.match(keeper, /FM_MIRROR_STALE/, "keeper does not check the mirror on re-arm");
  assert.match(keeper, /\.mirror-manifest/);
  assert.match(keeper, /rev-parse HEAD/);
  assert.match(keeper, /\} >> "\$LOG" 2>&1/, "keeper guard output must land in the watch log");

  // checkWatcher: the supervision poll runs the guard and logs a loud, supervision-specific
  // error when the mirror is stale.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "server.ts"), "utf8");
  assert.match(src, /Check on every supervision poll/);
  assert.match(src, /fm-watch-supervisor: bb mirror is STALE/);
});

// Behavioral guard: when a real firstmate checkout is reachable, actually run the
// installer against a fresh clone and assert the tracked tree stays clean. Skips
// (rather than fails) where no checkout is available so it never blocks CI, while
// still catching a real in-place-patch regression on any dev/host that has one.
function discoverFirstmateCheckout(): string | null {
  for (const p of [process.env.FM_TEST_HOME, process.env.FM_HOME, "/root/firstmate"]) {
    if (p && existsSync(join(p, "bin", "fm-backend.sh")) && existsSync(join(p, ".git"))) return p;
  }
  return null;
}

test("installer leaves a real firstmate clone's tracked tree clean", (t) => {
  const checkout = discoverFirstmateCheckout();
  if (checkout === null) {
    t.skip("no firstmate checkout discoverable (set FM_TEST_HOME to enable)");
    return;
  }
  const work = mkdtempSync(join(tmpdir(), "fm-bb-clean-"));
  try {
    const home = join(work, "home");
    const skip = cloneAtPatchBase(checkout, home);
    if (skip) {
      t.skip(skip);
      return;
    }
    const run = spawnSync("python3", [
      join(OVERLAY_ROOT, "install-bb-backend.py"),
      "--home", home,
      "--overlay", OVERLAY_ROOT,
      "--project-id", "proj_test",
    ], { encoding: "utf8" });
    assert.equal(run.status, 0, `installer failed:\n${run.stdout}\n${run.stderr}`);
    const status = spawnSync("git", ["-C", home, "status", "--porcelain"], { encoding: "utf8" });
    assert.equal(status.stdout.trim(), "", `overlay dirtied the tracked tree:\n${status.stdout}`);
    // The three dispatch files must be byte-identical to HEAD.
    const diff = spawnSync("git", ["-C", home, "diff", "--stat", "--",
      "bin/fm-backend.sh", "bin/fm-spawn.sh", "bin/fm-teardown.sh"], { encoding: "utf8" });
    assert.equal(diff.stdout.trim(), "", `tracked backend files were modified:\n${diff.stdout}`);
    // The mirror bin exists and carries the bb dispatch registration.
    assert.ok(existsSync(join(home, "bin-bb", "fm-spawn.sh")), "mirror bin missing");
    const patched = readFileSync(join(home, "bin-bb", "fm-backend.sh"), "utf8");
    assert.match(patched, /FM_BACKEND_KNOWN="[^"]*\bbb\b/, "mirror fm-backend.sh lacks bb registration");
    // F4: internal dispatch self-references in the mirror copy stay in the mirror
    // ($SCRIPT_DIR), so batch/array dispatch does not re-invoke pristine native bin.
    const mirrorSpawn = readFileSync(join(home, "bin-bb", "fm-spawn.sh"), "utf8");
    assert.doesNotMatch(mirrorSpawn, /\$FM_ROOT\/bin\/fm-spawn\.sh/, "mirror fm-spawn still re-invokes native bin");
    assert.match(mirrorSpawn, /\$SCRIPT_DIR\/fm-spawn\.sh/, "mirror fm-spawn self-ref not redirected to $SCRIPT_DIR");
    // F2: the manifest exists and `--verify` reports the fresh mirror healthy.
    assert.ok(existsSync(join(home, "bin-bb", ".mirror-manifest")), "mirror manifest missing");
    const okVerify = spawnSync("python3", [join(OVERLAY_ROOT, "install-bb-backend.py"), "--home", home, "--verify"], { encoding: "utf8" });
    assert.equal(okVerify.status, 0, `fresh mirror should verify clean:\n${okVerify.stdout}\n${okVerify.stderr}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("installer --verify fails LOUD after an out-of-band fast-forward leaves the mirror stale (F2)", (t) => {
  const checkout = discoverFirstmateCheckout();
  if (checkout === null) {
    t.skip("no firstmate checkout discoverable (set FM_TEST_HOME to enable)");
    return;
  }
  const work = mkdtempSync(join(tmpdir(), "fm-bb-stale-"));
  try {
    const home = join(work, "home");
    // Clone at the patch base (a full clone we can advance to simulate an out-of-band ff).
    const skip = cloneAtPatchBase(checkout, home);
    if (skip) {
      t.skip(skip);
      return;
    }
    assert.equal(spawnSync("python3", [join(OVERLAY_ROOT, "install-bb-backend.py"), "--home", home, "--overlay", OVERLAY_ROOT]).status, 0);
    // Verify healthy first (control).
    assert.equal(spawnSync("python3", [join(OVERLAY_ROOT, "install-bb-backend.py"), "--home", home, "--verify"]).status, 0);
    // Simulate an out-of-band upstream fast-forward: a new tracked bin/ file + an edit
    // to one of the frozen sources, committed so HEAD advances underneath the mirror.
    writeFileSync(join(home, "bin", "fm-newmod.sh"), "#!/usr/bin/env bash\n");
    writeFileSync(join(home, "bin", "fm-spawn.sh"), readFileSync(join(home, "bin", "fm-spawn.sh"), "utf8") + "\n# DRIFT_MARKER\n");
    spawnSync("git", ["-C", home, "add", "bin/fm-newmod.sh", "bin/fm-spawn.sh"]);
    spawnSync("git", ["-C", home, "-c", "user.email=x@x", "-c", "user.name=x", "commit", "-q", "-m", "oob ff"]);
    const stale = spawnSync("python3", [join(OVERLAY_ROOT, "install-bb-backend.py"), "--home", home, "--verify"], { encoding: "utf8" });
    assert.notEqual(stale.status, 0, "stale mirror must make --verify fail");
    assert.match(stale.stderr, /FM_MIRROR_STALE/, `--verify must be loud:\n${stale.stderr}`);
    assert.match(stale.stderr, /missing sibling 'fm-newmod\.sh'|HEAD moved|frozen copy 'fm-spawn\.sh' is stale/);
    // Re-install re-mirrors → verify healthy again (self-heal).
    assert.equal(spawnSync("python3", [join(OVERLAY_ROOT, "install-bb-backend.py"), "--home", home, "--overlay", OVERLAY_ROOT]).status, 0);
    assert.equal(spawnSync("python3", [join(OVERLAY_ROOT, "install-bb-backend.py"), "--home", home, "--verify"]).status, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// B1 source guards: the installer builds the mirror in a STAGING dir and atomically
// swaps it in only on full success, and treats any patch-hunk failure as a loud,
// non-zero abort (not just a trusted `patch` exit code). Reverting either behaviour
// trips one of these.
test("installer source builds atomically in staging and swaps on success (B1)", () => {
  assert.match(INSTALLER_SRC, /\.staging/, "installer must build into a staging dir");
  assert.match(INSTALLER_SRC, /def _atomic_swap/, "installer must have an atomic swap step");
  assert.match(INSTALLER_SRC, /os\.rename\(staging, mirror\)/, "installer must rename staging into place");
  // The old in-place rebuild (rmtree the live mirror, then rebuild) is the exact
  // regression that caused the outage; it must be gone.
  assert.doesNotMatch(INSTALLER_SRC, /shutil\.rmtree\(mirror\)/, "installer must not rmtree the live mirror before rebuilding");
  // Loud, belt-and-suspenders failure detection: not just the patch exit code.
  assert.match(INSTALLER_SRC, /def die_loud/);
  assert.match(INSTALLER_SRC, /rglob\("\*\.rej"\)/, "installer must scan for reject files, not trust patch's exit code alone");
  assert.match(INSTALLER_SRC, /INSTALL FAILED/);
});

// Fingerprint a directory's bytes + symlink targets, so an atomic install failure can
// be proven not to have mutated a single byte of the working mirror.
function fingerprintDir(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      const key = `${rel}/${name}`;
      if (st.isSymbolicLink()) h.update(`L ${key} -> ${readlinkSync(abs)}\n`);
      else if (st.isDirectory()) { h.update(`D ${key}\n`); walk(abs, key); }
      else h.update(`F ${key} ${createHash("sha256").update(readFileSync(abs)).digest("hex")}\n`);
    }
  };
  walk(root, "");
  return h.digest("hex");
}

// B1 behavioural + mutation proof: a re-install whose patch no longer applies must abort
// ATOMICALLY — exit non-zero and loud, print no "ready", leave no staging/backup litter,
// and leave the previously-working mirror byte-for-byte intact and still dispatching bb.
// Reverting the staging-and-swap (rebuilding in place) makes the "mirror untouched"
// assertion fail: an in-place rebuild rmtrees/repopulates the live mirror before the
// patch fails, so the fingerprint changes.
test("failed re-install is atomic: working mirror is preserved byte-for-byte (B1, mutation-proven)", (t) => {
  const checkout = discoverFirstmateCheckout();
  if (checkout === null) {
    t.skip("no firstmate checkout discoverable (set FM_TEST_HOME to enable)");
    return;
  }
  const work = mkdtempSync(join(tmpdir(), "fm-bb-atomic-"));
  try {
    const home = join(work, "home");
    const skip = cloneAtPatchBase(checkout, home);
    if (skip) {
      t.skip(skip);
      return;
    }
    // A first, good install → a healthy working mirror.
    assert.equal(
      spawnSync("python3", [join(OVERLAY_ROOT, "install-bb-backend.py"), "--home", home, "--overlay", OVERLAY_ROOT, "--project-id", "proj_test"]).status,
      0,
      "initial install should succeed at the patch base",
    );
    const before = fingerprintDir(join(home, "bin-bb"));

    // A broken overlay whose backend patch can no longer apply (a corrupted REMOVED
    // line — a fuzz-tolerated context change would still apply and would not fail).
    const broken = join(work, "broken-overlay");
    cpSync(OVERLAY_ROOT, broken, { recursive: true });
    const bp = join(broken, "firstmate-bb-backend.patch");
    const patchText = readFileSync(bp, "utf8");
    const needle = '-FM_BACKEND_KNOWN="tmux herdr zellij orca cmux"';
    assert.ok(patchText.includes(needle), "anchor to corrupt must exist in the backend patch");
    writeFileSync(bp, patchText.replace(needle, '-FM_BACKEND_KNOWN="THIS_LINE_DOES_NOT_EXIST_UPSTREAM"'));

    const failed = spawnSync("python3", [join(OVERLAY_ROOT, "install-bb-backend.py"), "--home", home, "--overlay", broken, "--project-id", "proj_test"], { encoding: "utf8" });

    // (a) loud + non-zero, never "ready".
    assert.notEqual(failed.status, 0, "a patch-apply failure must exit non-zero");
    assert.match(failed.stderr, /INSTALL FAILED/, `failure must be loud:\n${failed.stderr}`);
    assert.match(failed.stderr, /did not apply/);
    assert.doesNotMatch(`${failed.stdout}${failed.stderr}`, /BB backend ready/, "must not print 'ready' over a failure");
    // (b) atomic: no litter, working mirror byte-identical.
    assert.ok(!existsSync(join(home, "bin-bb.staging")), "no staging dir may be left behind");
    assert.ok(!existsSync(join(home, "bin-bb.old")), "no backup dir may be left behind");
    assert.equal(fingerprintDir(join(home, "bin-bb")), before, "the working mirror must be untouched by a failed install");
    // (c) the mirror still dispatches bb.
    const validate = spawnSync("bash", ["-c", `. "${join(home, "bin-bb", "fm-backend.sh")}"; fm_backend_validate bb`], { encoding: "utf8" });
    assert.equal(validate.status, 0, "the preserved mirror must still validate bb");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// fmHome is shared host-global across captains, so the migration off the in-place patch
// must never have a moment when no bb-capable path exists (another captain could dispatch
// and hit `unknown backend 'bb'`). scripts/live-migration-zero-window-check.mjs reproduces
// the live dirty state and probes a dispatch at every migration step. This test runs it
// both ways: NEW order must expose ZERO windows; --old-order (the mutation) must expose a
// window — proving the probe is load-bearing, not vacuous.
test("migration off the in-place patch has zero bb-less window (mutation-proven)", (t) => {
  const checkout = discoverFirstmateCheckout();
  if (checkout === null) {
    t.skip("no firstmate checkout discoverable (set FM_TEST_HOME to enable)");
    return;
  }
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "scripts", "live-migration-zero-window-check.mjs");
  const runCheck = (extraArgs: string[]) =>
    spawnSync("node", ["--experimental-strip-types", scriptPath, ...extraArgs], { encoding: "utf8", timeout: 240_000 });

  const neu = runCheck([]);
  if (/^SKIP:/m.test(neu.stdout)) {
    t.skip(neu.stdout.trim());
    return;
  }
  assert.equal(neu.status, 0, `NEW-order migration must have zero windows:\n${neu.stdout}\n${neu.stderr}`);
  assert.match(neu.stdout, /ZERO-WINDOW CONFIRMED/);
  assert.match(neu.stdout, /windows \(unknown backend 'bb'\): 0/);
  // The NEW order now also exercises a FAILED atomic re-install: it must abort loud and
  // non-zero, leave the working mirror untouched, and keep dispatching bb (no window).
  assert.match(neu.stdout, /FAILED re-install: exit=1 loud=true notReady=true noLeftover=true mirrorUntouched=true/);
  assert.match(neu.stdout, /probe\[ok\] G: after a FAILED atomic re-install/);

  // Mutation: the OLD ("restore first") order MUST expose a window; the script exits 0
  // only when it detects one, so this asserts the probe actually catches the gap.
  const old = runCheck(["--old-order"]);
  assert.equal(old.status, 0, `old-order mutation should detect a window:\n${old.stdout}\n${old.stderr}`);
  assert.match(old.stdout, /OLD-ORDER MUTATION CONFIRMED/);
  assert.doesNotMatch(old.stdout, /windows \(unknown backend 'bb'\): 0\b/);
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
    const brief = hostCommands.find((c) => c.includes("fm-brief.sh"));
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

// Wiring regression: the fold's kind must be resolved from the crew's on-host
// state/<id>.meta the way native `_fm_status_kind` does — NOT hardcoded "ship".
// These drive the real host-status path (fmHome set) with a stream that ends
// `needs-decision → done → working`: latest is non-terminal so the fold runs, and
// the mid-stream `done` collapses ONLY under a collapsing kind.
function crewFoldHost(host: ReturnType<typeof createFakePluginHost>, statusStream: string, metaExitOrBody: { absent: true } | { body: string }) {
  const cmdById = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_crew", status: "idle" }));
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.output", async () => ({ output: "" }));
  host.harness.sdk.stub("environments.list", async () => [
    { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
  ]);
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
    const id = `term_${++n}`;
    cmdById.set(id, args.start?.command ?? "");
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const cmd = cmdById.get(args.terminalId) ?? "";
    if (cmd.includes("/state/c1.status")) return hostOutput(statusStream, 0);
    if (cmd.includes("/state/c1.meta")) {
      return "absent" in metaExitOrBody ? hostOutput("", 3) : hostOutput(metaExitOrBody.body, 0);
    }
    return hostRcOutput(0);
  });
  host.harness.sdk.stub("terminals.close", async () => ({}));
}

const HOLD_STREAM = [
  "needs-decision [key=deploy-freeze]: HOLD all merges to main",
  "done [at=1790000000]: apply complete",
  "working [at=1790000100]: retry after redeploy",
].join("\n");

test("crew fold: a metaless crew folds as native `unknown` — mid-stream terminal does NOT suppress the open decision", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { fmHome: "/tmp/fm-home" } });
  await plugin(host.bb);
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    crewFoldHost(host, HOLD_STREAM, { absent: true }); // no .meta → native `unknown` → no collapse
    const result = await host.harness.behavior.runCli(["crew", "c1"]);
    assert.equal(result.exitCode, 0, result.stderr);
    // The real captain call survives — hardcoding kind="ship" here would collapse it.
    assert.match(result.stdout, /open needs-decision \[deploy-freeze\]: HOLD all merges to main/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("crew fold: a ship-meta crew collapses the mid-stream terminal, matching native ship", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { fmHome: "/tmp/fm-home" } });
  await plugin(host.bb);
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    crewFoldHost(host, HOLD_STREAM, { body: "id=c1\nkind=ship\n" }); // ship meta → collapse
    const result = await host.harness.behavior.runCli(["crew", "c1"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /open needs-decision \[deploy-freeze\]/);
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

test("D4: bearings scopes backlog + landed to the calling captain, --all shows every captain's", async () => {
  const host = await load();
  try {
    host.harness.sdk.stub("threads.list", async () => []);
    await host.bb.storage.kv.set("queue", [
      { id: "qA", title: "MINE-queued", projectId: "proj_1", status: "queued", parentThreadId: "thr_cap", createdAt: "2026-09-18T00:00:00.000Z" },
      { id: "qB", title: "THEIRS-queued", projectId: "proj_2", status: "queued", parentThreadId: "thr_other", createdAt: "2026-09-18T00:00:00.000Z" },
    ]);
    await host.bb.storage.kv.set("done", [
      { id: "dA", task: "MINE-landed", crewId: "cA", parentThreadId: "thr_cap", at: "2026-09-18T00:00:00.000Z" },
      { id: "dB", task: "THEIRS-landed", crewId: "cB", parentThreadId: "thr_other", at: "2026-09-18T00:00:00.000Z" },
    ]);
    const mine = await host.harness.behavior.runCli(["bearings"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(mine.exitCode, 0, mine.stderr);
    assert.match(mine.stdout, /MINE-queued/);
    assert.match(mine.stdout, /MINE-landed/);
    assert.doesNotMatch(mine.stdout, /THEIRS-queued/);
    assert.doesNotMatch(mine.stdout, /THEIRS-landed/);
    const all = await host.harness.behavior.runCli(["bearings", "--all"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(all.exitCode, 0, all.stderr);
    assert.match(all.stdout, /MINE-queued/);
    assert.match(all.stdout, /THEIRS-queued/);
    assert.match(all.stdout, /THEIRS-landed/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D1: bearings lists an idle FAILED crew as a Captain's Call, not ready to review", async () => {
  const host = await load();
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("threads.output", async () => ({
      output: "working: tried\nFAILED: contradictory requirements",
    }));
    const result = await host.harness.behavior.runCli(["bearings"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /FAILED: retry\/investigate/);
    // A FAILED crew must never be offered as ready to review/deliver.
    assert.doesNotMatch(result.stdout, /c1.*ready to review/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D1: firstmate crew/crews render a distinct verdict marker for an idle FAILED crew", async () => {
  const host = await load();
  try {
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_crew", status: "idle" }),
    );
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("threads.output", async () => ({
      output: "FAILED: contradictory requirements",
    }));
    const crew = await host.harness.behavior.runCli(["crew", "c1"]);
    assert.equal(crew.exitCode, 0, crew.stderr);
    assert.match(crew.stdout, /❌ FAILED/);
    const crews = await host.harness.behavior.runCli(["crews"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(crews.exitCode, 0, crews.stderr);
    assert.match(crews.stdout, /❌ FAILED/);
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
    if (cmd.includes("fm-spawn.sh")) {
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
  // Real transport is backlog-first: it requires queueOwner=real so the plugin can
  // create+own the native backlog row before fm-spawn.sh (which refuses a task with
  // no record). The real-transport tests therefore run with both flags set.
  return createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", transport: "real", queueOwner: "real" },
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
    assert.ok(seen.some((c) => c.includes("fm-spawn.sh")), "fm-spawn.sh was not invoked");
    assert.ok(seen.some((c) => c.includes("--backend") && c.includes("bb")), "backend=bb not passed");
    // Harness pinned to bb: without it fm-harness.sh's own-runtime detection returns
    // 'unknown' in a BB host terminal and fm-spawn aborts with "no launch template".
    assert.ok(
      seen.some((c) => c.includes("fm-spawn.sh") && c.includes("--harness") && c.includes("bb")),
      "ship spawn did not pin --harness bb",
    );
    // No native BB spawn happened.
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    const crews = await crewsKv(host);
    assert.equal(crews[0]?.threadId, "thr_real");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("real transport pins --harness bb for a scout too (else fm-spawn aborts on 'unknown')", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    const { seen } = stubRealTransportHost(host, { spawnExit: 0, threadIdAfterSpawn: "thr_scout" });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--shape", "scout", "--", "survey the auth flow"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const spawn = seen.find((c) => c.includes("fm-spawn.sh"));
    assert.ok(spawn, "fm-spawn.sh was not invoked for the scout");
    assert.ok(spawn!.includes("--scout"), "scout flag not passed");
    assert.ok(spawn!.includes("--harness") && spawn!.includes("bb"), "scout spawn did not pin --harness bb");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
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
    assert.ok(seen.some((c) => c.includes("fm-spawn.sh")), "fm-spawn.sh was not attempted");
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
    assert.ok(!seen.some((c) => c.includes("fm-spawn.sh")), "fm-spawn ran despite an existing thread");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    const crews = await crewsKv(host);
    assert.equal(crews[0]?.threadId, "thr_pre");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Record-after-spawn race: the real transport learns the thread id only after
// fm-spawn.sh returns (~30s), and a fast crew can end its first turn — firing
// thread.idle/thread.failed — before writeCrews persists that id. At that instant
// findCrewByThread returns undefined and the live event is dropped for good, so the
// captain gets no doorbell and no durable wake. `status`/`output` are what the
// worker thread reports by the time dispatch finishes recording the crew.
function stubRaceHost(
  host: Awaited<ReturnType<typeof load>>,
  opts: { status: string; output: string; threadIdAfterSpawn?: string },
) {
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [
    { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
  ]);
  host.harness.sdk.stub("environments.get", async () => ({
    id: "env_wt", hostId: "host_1", path: "/wt", isWorktree: true, status: "ready",
  }));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({ id: opts.threadIdAfterSpawn ?? "thr_real", status: opts.status, environmentId: "env_wt" }),
  );
  host.harness.sdk.stub("threads.output", async () => ({ output: opts.output }));
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
    if (cmd.includes("fm-spawn.sh")) {
      spawned = true;
      return hostRcPayload("", 0);
    }
    if (cmd.includes("bb_thread_id")) {
      const tid = spawned ? (opts.threadIdAfterSpawn ?? "thr_real") : "";
      return hostRcPayload(tid === "" ? "FM_META_ABSENT" : tid, 0);
    }
    return hostRcPayload("", 0);
  });
  return { seen };
}

test("reconcile: a BLOCKED crew idle before its record existed still doorbells the captain", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    const blocked = "BLOCKED: cannot proceed — the captain expects this";
    stubRaceHost(host, { status: "idle", output: blocked });
    // The live thread.idle the fast crew fired lands BEFORE the record exists: no
    // crew owns thr_real yet, so it is dropped (this must NOT prime any dedup guard).
    const dropped = await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_real", status: "idle", projectId: "proj_1" }),
      lastAssistantText: blocked,
    });
    assert.deepEqual(dropped.errors, []);
    assert.equal(sendCalls(host).filter((s) => s.threadId === "thr_cap").length, 0, "dropped live event must not reach the captain");
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--shape", "scout", "--", "Captain's intent: verify blocked alert"],
      { projectId: "proj_1", threadId: "thr_cap" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const captain = sendCalls(host).filter((s) => s.threadId === "thr_cap");
    assert.equal(captain.length, 1, "reconcile must deliver exactly one captain alert");
    assert.match(captain[0]?.text ?? "", /BLOCKED: cannot proceed/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("reconcile: an in-band FAILED verdict on a fast crew also reaches the captain", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    stubRaceHost(host, { status: "idle", output: "FAILED: build broke — see log" });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--shape", "scout", "--", "Captain's intent: verify failed alert"],
      { projectId: "proj_1", threadId: "thr_cap" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const captain = sendCalls(host).filter((s) => s.threadId === "thr_cap");
    assert.equal(captain.length, 1);
    assert.match(captain[0]?.text ?? "", /FAILED: build broke/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("reconcile: notifyOwner=real enqueues the durable wake for a raced BLOCKED crew", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", transport: "real", queueOwner: "real", notifyOwner: "real", supervisionEnabled: true },
  });
  await plugin(host.bb);
  try {
    const { seen } = stubRaceHost(host, { status: "idle", output: "BLOCKED: needs a secret" });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--shape", "scout", "--", "Captain's intent: verify durable wake"],
      { projectId: "proj_1", threadId: "thr_cap" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const crewId = crewIdFromStdout(result.stdout);
    assert.ok(
      seen.some((c) => c.includes("fm_wake_append") && c.includes(`${crewId}.status`)),
      `no durable wake enqueued for ${crewId}: ${seen.join(" | ")}`,
    );
    // The BLOCKED alert is not a plain DONE, so it also rings the doorbell.
    assert.equal(sendCalls(host).filter((s) => s.threadId === "thr_cap").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("reconcile: a still-active crew at dispatch is not prematurely reported", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    stubRaceHost(host, { status: "active", output: "still working" });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--shape", "scout", "--", "Captain's intent: long job"],
      { projectId: "proj_1", threadId: "thr_cap" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(sendCalls(host).filter((s) => s.threadId === "thr_cap").length, 0, "an active crew must not trigger a terminal alert");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("reconcile: does not wedge the live path — a later thread.idle still reaches the captain", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    const blocked = "BLOCKED: waiting on approval";
    stubRaceHost(host, { status: "idle", output: blocked });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--shape", "scout", "--", "Captain's intent: verify no double"],
      { projectId: "proj_1", threadId: "thr_cap" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    // Reconcile already delivered once during dispatch.
    assert.equal(sendCalls(host).filter((s) => s.threadId === "thr_cap").length, 1);
    // A live thread.idle now arriving for the SAME crew/thread must still be handled
    // by the live path (the record exists) — proving the reconcile did not wedge the
    // live path — but it is a distinct turn-end, so this asserts the paths coexist.
    const live = await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_real", status: "idle", projectId: "proj_1" }),
      lastAssistantText: blocked,
    });
    assert.deepEqual(live.errors, []);
    assert.equal(sendCalls(host).filter((s) => s.threadId === "thr_cap").length, 2, "the live path stays live once the record exists");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// C1: a real-transport dispatch that lets us tune the tasks-axi add exit code, the
// fm-spawn exit, the bb_thread_id the meta carries afterwards, and the orphan-list
// contents. Records every host command in `seen` so ordering (add BEFORE spawn)
// can be asserted.
function stubRealTransportBacklog(
  host: Awaited<ReturnType<typeof load>>,
  opts: {
    addExit?: number;
    spawnExit?: number;
    threadIdAfterSpawn?: string;
    orphan?: boolean;
  },
) {
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [
    { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
  ]);
  host.harness.sdk.stub("environments.get", async () => ({
    id: "env_wt", hostId: "host_1", path: "/wt", isWorktree: true, status: "ready",
  }));
  host.harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({ id: "thr_crew", status: "starting", environmentId: "env_wt" }),
  );
  host.harness.sdk.stub("threads.list", async () =>
    opts.orphan ? [{ id: "thr_orphan", projectId: "proj_1", parentThreadId: "thr_cap", title: "renamed" }] : [],
  );
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
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
    if (cmd.includes("fm-tasks-axi.sh") && cmd.includes("'add'")) return hostRcPayload("", opts.addExit ?? 0);
    if (cmd.includes("fm-spawn.sh")) {
      spawned = true;
      return hostRcPayload("", opts.spawnExit ?? 0);
    }
    if (cmd.includes("bb_thread_id")) {
      const tid = spawned ? (opts.threadIdAfterSpawn ?? "") : "";
      return hostRcPayload(tid === "" ? "FM_META_ABSENT" : tid, 0);
    }
    return hostRcPayload("", 0);
  });
  return { seen };
}

function crewIdFromStdout(stdout: string): string {
  const m = /Dispatched (?:ship|scout) crew (\S+)/.exec(stdout);
  assert.ok(m, `no crew id in: ${stdout}`);
  return m![1]!;
}

test("C1: real transport adds the backlog row (id=crew id, --kind ship) BEFORE fm-spawn", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    const { seen } = stubRealTransportBacklog(host, { threadIdAfterSpawn: "thr_real" });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "Captain's intent: fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const crewId = crewIdFromStdout(result.stdout);
    const addIdx = seen.findIndex(
      (c) => c.includes("fm-tasks-axi.sh") && c.includes("'add'") && c.includes(`'${crewId}'`) && c.includes("'--kind'") && c.includes("'ship'"),
    );
    const spawnIdx = seen.findIndex((c) => c.includes("fm-spawn.sh"));
    assert.ok(addIdx >= 0, `no backlog add for ${crewId}: ${seen.join(" | ")}`);
    assert.ok(spawnIdx >= 0, "fm-spawn.sh never ran");
    assert.ok(addIdx < spawnIdx, "backlog add must run BEFORE fm-spawn (backlog-first)");
    assert.ok(seen[spawnIdx]!.includes("FM_BB_THREAD_TITLE="), "real transport must pass an explicit title");
    assert.ok(
      seen[spawnIdx]!.includes("Ship · Fix flaky login ·") && seen[spawnIdx]!.includes(crewId),
      "real transport must pass the same work-first title to its BB backend",
    );
    // fm-spawn owns the queued→In-flight start; the plugin must not double-start.
    assert.ok(!seen.some((c) => c.includes("fm-tasks-axi.sh") && c.includes("'start'")), "plugin double-started the row");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0, "must not native-spawn");
    assert.equal((await crewsKv(host))[0]?.threadId, "thr_real");
    // D5: the backlog-first step emits a positive signature, BEFORE the spawn-ok
    // line — so a captain can see the ordering directly in the log, not infer it.
    const addLogIdx = host.harness.logEntries.findIndex(
      (e) => e.level === "info" && e.message === `real transport backlog add crew=${crewId} ok`,
    );
    const spawnLogIdx = host.harness.logEntries.findIndex(
      (e) => e.level === "info" && e.message === `real transport spawn crew=${crewId} ok`,
    );
    assert.ok(addLogIdx >= 0, `missing backlog-add log:\n${host.harness.logEntries.map((e) => `${e.level}: ${e.message}`).join("\n")}`);
    assert.ok(spawnLogIdx >= 0, "missing spawn-ok log");
    assert.ok(addLogIdx < spawnLogIdx, "backlog-add log must precede the spawn-ok log");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("C1: real transport adds the backlog row with --kind scout for a scout", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    const { seen } = stubRealTransportBacklog(host, { threadIdAfterSpawn: "thr_scout" });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--shape", "scout", "--", "Captain's intent: survey the auth flow"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const crewId = crewIdFromStdout(result.stdout);
    const addIdx = seen.findIndex(
      (c) => c.includes("fm-tasks-axi.sh") && c.includes("'add'") && c.includes(`'${crewId}'`) && c.includes("'--kind'") && c.includes("'scout'"),
    );
    const spawnIdx = seen.findIndex((c) => c.includes("fm-spawn.sh"));
    assert.ok(addIdx >= 0, `no scout backlog add for ${crewId}`);
    assert.ok(addIdx < spawnIdx, "scout backlog add must run BEFORE fm-spawn");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("C1: real transport requires queueOwner=real — falls back to native when kv", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", transport: "real" }, // queueOwner defaults kv
  });
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_native" }));
    const { seen } = stubRealTransportBacklog(host, { threadIdAfterSpawn: "thr_real" });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "Captain's intent: fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(!seen.some((c) => c.includes("fm-spawn.sh")), "must not run fm-spawn without queueOwner=real");
    assert.ok(!seen.some((c) => c.includes("fm-tasks-axi.sh") && c.includes("'add'")), "must not add a backlog row without queueOwner=real");
    // The early guard logs the exact actionable refusal — this uniquely proves the
    // guard fired (rather than the generic failed-add fallback catching it later).
    assert.ok(
      host.harness.logEntries.some((e) => e.level === "error" && /real transport requires queueOwner=real/.test(e.message)),
      `expected the queueOwner=real refusal log:\n${host.harness.logEntries.map((e) => `${e.level}: ${e.message}`).join("\n")}`,
    );
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1, "must fall back to native spawn");
    assert.equal((await crewsKv(host))[0]?.threadId, "thr_native");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("C1: a failed backlog add never spawns a worker — falls back to native", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_native" }));
    const { seen } = stubRealTransportBacklog(host, { addExit: 2, threadIdAfterSpawn: "thr_real" });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "Captain's intent: fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(seen.some((c) => c.includes("fm-tasks-axi.sh") && c.includes("'add'")), "add was attempted");
    assert.ok(!seen.some((c) => c.includes("fm-spawn.sh")), "must NOT spawn a worker the backlog does not own");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1, "falls back to native dispatch");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("C1: a spawn that leaves no thread/orphan removes the seeded backlog row", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_native" }));
    const { seen } = stubRealTransportBacklog(host, { spawnExit: 1, threadIdAfterSpawn: "", orphan: false });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "Captain's intent: fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const crewId = crewIdFromStdout(result.stdout);
    const addIdx = seen.findIndex((c) => c.includes("fm-tasks-axi.sh") && c.includes("'add'") && c.includes(`'${crewId}'`));
    const rmIdx = seen.findIndex((c) => c.includes("fm-tasks-axi.sh") && c.includes("'rm'") && c.includes(`'${crewId}'`));
    assert.ok(addIdx >= 0, "row was added");
    assert.ok(rmIdx > addIdx, "orphan row must be removed when no worker exists");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1, "falls back to native dispatch");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("C2: the plugin writes NO canned intake-judgement essay to the brief (native's notice stands)", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    // A ship dispatched below the standing posture: the plugin must NOT synthesize a
    // boilerplate "intake judgement" on the brief. The honest record is native
    // fm-spawn's own stderr notice, which the plugin never suppresses. The brief's
    // Firstmate-spec fill must carry only the fixed spec, no judgement essay, and no
    // false PR attestation (which would be wrong for a mode like local-only).
    const { seen } = stubRealTransportBacklog(host, { threadIdAfterSpawn: "thr_real" });
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "Captain's intent: fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    // The brief is filled by a python fill carrying the base64 intent (FM_INTENT).
    const briefCmd = seen.find((c) => c.includes("FM_INTENT="));
    assert.ok(briefCmd, "brief fill command not seen");
    assert.ok(!briefCmd!.includes("FM_SPEC="), "no separate judgement-bearing spec should be injected");
    assert.ok(!/[Ii]ntake judgement/.test(briefCmd!), "no canned intake-judgement essay");
    // The plugin also runs no fm-project-mode.sh probe — posture reconciliation is
    // left entirely to native (mode is carried on the brief's Delivery contract).
    assert.ok(!seen.some((c) => c.includes("fm-project-mode.sh")), "plugin must not synthesize a posture judgement");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("F2: a crew's backlog row is closed on land even after settings flip to native mid-flight", async () => {
  const host = realHost();
  await plugin(host.bb);
  try {
    const { seen } = stubRealTransportBacklog(host, { threadIdAfterSpawn: "thr_real" });
    const dispatched = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "Captain's intent: fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(dispatched.exitCode, 0, dispatched.stderr);
    const crewId = crewIdFromStdout(dispatched.stdout);
    // The crew recorded that it owns a real backlog row.
    assert.equal((await crewsKv(host))[0]?.backlogRow, true, "dispatch must record backlog-row ownership");
    // Flip the live feature flags AWAY from real transport / real queue mid-flight.
    await host.harness.behavior.setSettings({ transport: "native", queueOwner: "kv" });
    seen.length = 0;
    // Land the crew (idle → forget without --stop retires/closes it).
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: "thr_real", status: "idle", environmentId: "env_wt" }),
    );
    const forgotten = await host.harness.behavior.runCli(["forget", crewId], { projectId: "proj_1" });
    assert.equal(forgotten.exitCode, 0, forgotten.stderr);
    // The row is ownership: it must still be closed (rm) despite the flip to kv.
    assert.ok(
      seen.some((c) => c.includes("fm-tasks-axi.sh") && c.includes("'rm'") && c.includes(`'${crewId}'`)),
      `the owned row must be closed after the flip:\n${seen.join(" | ")}`,
    );
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
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    // Beacon absent + keeper dead → the supervisor must write the keeper script and
    // detach-launch it, and report age -1. Writes are simulated so the keeper script
    // content (written via writeHostFile) is recoverable with decodeHostWrite.
    const { seen, writes } = stubRoutedHost(host, (cmd) => {
      if (cmd.includes("FM_BEAT_AGE")) {
        return { payload: "FM_BEAT_AGE=-1\nFM_KEEPER=dead\n---FM_LOGTAIL---\nstale: fm-abc (escalation 1)", code: 0 };
      }
      return { code: 0 };
    });
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
    assert.equal(beat.relaunched, true, "a dead keeper must be relaunched");
    // It detach-launches the keeper SCRIPT (setsid + bash <keeper.sh>).
    const launch = seen.find((c) => c.includes("setsid") && c.includes(".bb-watch-keeper.sh"));
    assert.ok(launch, "supervisor did not detach-launch the keeper script");
    // The keeper is a DURABLE self-re-arming loop (not a one-shot arm): its script
    // carries the pidfile, the re-arm loop, and a sleep. fm-watch exits on every
    // wake, so a one-shot arm would leave a growing unwatched gap.
    const keeper = decodeHostWrite(writes, ".bb-watch-keeper.sh");
    assert.ok(keeper, "keeper script was not written");
    assert.ok(keeper!.includes("fm-watch-arm.sh"), "keeper does not re-arm fm-watch");
    assert.ok(keeper!.includes(".bb-watch-keeper.pid"), "keeper does not track a pidfile");
    assert.ok(/while \[/.test(keeper!) && /sleep /.test(keeper!), "keeper is not a re-arming loop");
    // The watcher's page reason was relayed to the captain.
    const relayed = sendCalls(host).some((s) => (s.text ?? "").includes("fm-watch") && (s.text ?? "").includes("stale: fm-abc"));
    assert.ok(relayed, "supervisor did not relay the fm-watch wake reason to the captain");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("fm-watch supervisor does NOT back off while the keeper is alive (watcher exiting on a wake is normal)", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", watchOwner: "fm-watch", fmHostId: "host_1" },
  });
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("terminals.create", async () => ({ id: "term_k" }));
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
    host.harness.sdk.stub("environments.list", async () => [
      { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
    ]);
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", "thr_cap")]);
    // Keeper alive, but the beat is momentarily stale (fm-watch just exited on a wake,
    // keeper about to re-arm). The old code (relaunch-on-stale + backoff) would climb
    // the ladder here; the keeper-aware code must keep the ladder at zero.
    host.harness.sdk.stub("terminals.output", async () =>
      hostRcPayload("FM_BEAT_AGE=600\nFM_RELAUNCHED=0\nFM_KEEPER=alive\n---FM_LOGTAIL---\n", 0),
    );
    // Seed a prior backoff streak to prove it RESETS when the keeper is alive.
    await host.bb.storage.kv.set("fm-watch-beat:host_1", {
      beatAge: 600, checkedAt: Date.now() - 1000, grace: 90, relaunched: true,
      backoffUntil: Date.now() + 300_000, consecutiveRelaunch: 3,
    });
    const run = host.harness.behavior.runService("fm-watch-supervisor");
    const deadline = Date.now() + 4000;
    let beat: { backoffUntil?: number; consecutiveRelaunch?: number } | null = null;
    while (Date.now() < deadline) {
      const raw = await host.bb.storage.kv.get("fm-watch-beat:host_1");
      if (raw && typeof raw === "object" && "consecutiveRelaunch" in raw) {
        const r = raw as { consecutiveRelaunch?: number; backoffUntil?: number };
        if (r.consecutiveRelaunch === 0) { beat = r; break; }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    run.controller.abort();
    await run.done;
    assert.ok(beat, "supervisor never reset the backoff ladder for a live keeper");
    assert.equal(beat!.consecutiveRelaunch, 0, "a live keeper must reset the backoff streak");
    assert.equal(beat!.backoffUntil, 0, "a live keeper must clear the backoff window");
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
      title: opts.byTitle ? `Ship · Fix flaky login · ${captured.taskId}` : "renamed-window",
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

// ---- D1: migrate-owners is direction-safe (never clobbers non-empty real files) ----

test("D1 migrate-owners: never overwrites non-empty real memory with the KV cache; mirrors file→KV", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    const fullLearn = "- 2026-01-01: FIRST authoritative learning (the head) <!--a:2026-01-01-->\n- 2026-01-02: second";
    // KV holds only a TRUNCATED tail (a D2 decapitation) — the old migrate wrote this back over the real file.
    await host.bb.storage.kv.set("memory-learnings", "tative learning (the head) <!--a:2026-01-01-->\n- 2026-01-02: second");
    await host.bb.storage.kv.set("memory-captain", "STALE-KV-CAP");
    const { writes } = stubRoutedHost(host, (cmd) => {
      if (cmd.includes("cat") && cmd.includes("data/learnings.md") && !cmd.includes("archive")) return { payload: fullLearn, code: 0 };
      if (cmd.includes("cat") && cmd.includes("data/captain.md")) return { payload: "REAL captain prefs", code: 0 };
      return { payload: "", code: 0 };
    });
    const res = await host.harness.behavior.runCli(["migrate-owners"], { projectId: "proj_1" });
    assert.equal(res.exitCode, 0, res.stderr);
    // The authoritative files must NOT be overwritten by the (lossy) KV cache.
    const learnWrite = decodeHostWrite(writes, "data/learnings.md");
    assert.ok(learnWrite === null || learnWrite === fullLearn, `migrate must never write the KV cache over non-empty real learnings (wrote: ${JSON.stringify(learnWrite)})`);
    const capWrite = decodeHostWrite(writes, "data/captain.md");
    assert.ok(capWrite === null || capWrite === "REAL captain prefs", `migrate must never clobber real captain.md with KV (wrote: ${JSON.stringify(capWrite)})`);
    // Direction is file→KV: the cache is refreshed from the authoritative file.
    assert.equal(await host.bb.storage.kv.get("memory-learnings"), fullLearn, "KV must mirror the full real learnings file");
    assert.equal(await host.bb.storage.kv.get("memory-captain"), "REAL captain prefs", "KV must mirror the full real captain file");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D1 migrate-owners: refuses to touch memory when the real file is unreadable", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    await host.bb.storage.kv.set("memory-learnings", "KV would-be-clobber");
    const { writes } = stubRoutedHost(host, (cmd) => {
      // learnings read FAILS (unreadable) → migrate must refuse, never seed from KV.
      if (cmd.includes("cat") && cmd.includes("data/learnings.md") && !cmd.includes("archive")) return { code: 1 };
      return { payload: "", code: 0 };
    });
    const res = await host.harness.behavior.runCli(["migrate-owners", "--json"], { projectId: "proj_1" });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(decodeHostWrite(writes, "data/learnings.md"), null, "unreadable real file must never be written from KV");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// D1 sentinel family: absence is out-of-band (exit code), never a substring of file
// CONTENT, and a read FAILURE is never conflated with an empty/absent file. All
// callers (migrate, D3 recall/memoryShow, D5 clear/archive, add/drop) go through the
// one hardened readMemoryFile, so fixing it there covers every caller.
const SENTINEL_LINE = "- 2026-01-01: reproduce the FM_MEM_ABSENT bug end-to-end <!--a:2026-01-01-->";

test("D1 sentinel (a): file content containing the literal FM_MEM_ABSENT round-trips byte-exact and is not empty", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    stubRoutedHost(host, (cmd) => {
      if (cmd.includes("data/captain.md")) return { payload: "CAP-REAL", code: 0 };
      if (cmd.includes("data/learnings.md") && !cmd.includes("archive")) return { payload: SENTINEL_LINE, code: 0 };
      return { payload: "", code: 0 };
    });
    const show = await host.harness.behavior.runCli(["memory", "show", "--json"], { projectId: "proj_1" });
    assert.equal(show.exitCode, 0, show.stderr);
    const json = JSON.parse(show.stdout) as { learnings?: string; source?: string };
    assert.equal(json.source, "real", "must read the real files");
    assert.equal(json.learnings, SENTINEL_LINE, "content containing the sentinel literal must round-trip byte-exact");
    assert.notEqual(json.learnings, "", "a file with content must never read as empty");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D1 sentinel (b): migrate never overwrites a real file whose content contains the sentinel literal", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    await host.bb.storage.kv.set("memory-learnings", "SHORT-KV-CACHE"); // KV shorter than the real file
    const { writes } = stubRoutedHost(host, (cmd) => {
      if (cmd.includes("cat") && cmd.includes("data/learnings.md") && !cmd.includes("archive")) return { payload: SENTINEL_LINE, code: 0 };
      return { payload: "", code: 0 };
    });
    const mig = await host.harness.behavior.runCli(["migrate-owners"], { projectId: "proj_1" });
    assert.equal(mig.exitCode, 0, mig.stderr);
    assert.equal(decodeHostWrite(writes, "data/learnings.md"), null, "a file containing the sentinel literal must NOT be overwritten (not treated as empty)");
    assert.equal(await host.bb.storage.kv.get("memory-learnings"), SENTINEL_LINE, "KV must mirror the real file (file→KV), not the stale short cache");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D1 sentinel (c): a genuinely-absent real file reads as absent and is seeded from KV", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    await host.bb.storage.kv.set("memory-learnings", "SEEDME-FROM-KV");
    const { writes } = stubRoutedHost(host, (cmd) => {
      // Absent file → the read exits with the dedicated absence code (42), never 0.
      if (cmd.includes("cat") && cmd.includes("data/learnings.md") && !cmd.includes("archive")) return { code: 42 };
      return { payload: "", code: 0 };
    });
    const mig = await host.harness.behavior.runCli(["migrate-owners"], { projectId: "proj_1" });
    assert.equal(mig.exitCode, 0, mig.stderr);
    assert.equal(decodeHostWrite(writes, "data/learnings.md"), "SEEDME-FROM-KV", "a genuinely-absent real file must be seeded from KV (KV→file is safe when the file is truly absent)");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D1 sentinel (d): a read FAILURE is distinct from empty — migrate refuses, never seeds/overwrites", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    await host.bb.storage.kv.set("memory-learnings", "WOULD-CLOBBER");
    const { writes } = stubRoutedHost(host, (cmd) => {
      // A host/read FAILURE (exit 1) — must NOT look like an empty or absent file.
      if (cmd.includes("cat") && cmd.includes("data/learnings.md") && !cmd.includes("archive")) return { code: 1 };
      return { payload: "", code: 0 };
    });
    const mig = await host.harness.behavior.runCli(["migrate-owners"], { projectId: "proj_1" });
    assert.equal(mig.exitCode, 0, mig.stderr);
    assert.equal(decodeHostWrite(writes, "data/learnings.md"), null, "a read failure must never be treated as empty/absent → migrate must refuse to write");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// ---- D2: the KV mirror is the FULL file, never a mid-line -4000 slice ----

test("D2 add-learning: KV mirrors the FULL learnings file — no mid-line -4000 slice decapitation", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    const head = "- 2026-01-01: HEADLEARNING captain still owns the runtime rollout <!--a:2026-01-01-->";
    const filler = Array.from({ length: 60 }, (_, i) => `- 2026-01-02: filler learning ${i} ${"y".repeat(50)} <!--a:2026-01-02-->`).join("\n");
    const existing = `${head}\n${filler}`;
    assert.ok(Buffer.byteLength(existing, "utf8") > 4000, "fixture must exceed 4000 bytes so a -4000 slice would decapitate the head");
    const { writes } = stubRoutedHost(host, (cmd) => {
      if (cmd.includes("cat") && cmd.includes("data/learnings.md") && !cmd.includes("archive")) return { payload: existing, code: 0 };
      return { payload: "", code: 0 };
    });
    const add = await host.harness.behavior.runCli(["memory", "add-learning", "newest", "one"], { projectId: "proj_1" });
    assert.equal(add.exitCode, 0, add.stderr);
    const live = decodeHostWrite(writes, "data/learnings.md");
    const kv = await host.bb.storage.kv.get("memory-learnings");
    assert.ok(live !== null, "live learnings must be written");
    assert.equal(kv, live, "KV mirror must equal the full live file exactly");
    assert.ok(typeof kv === "string" && kv.includes("HEADLEARNING"), "the head learning must survive in KV (not decapitated by a byte slice)");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// ---- D3: recall (session digest) reads the real files, not the stale KV cache ----

test("D3 session digest: recall reads the real files, not a stale KV cache (native /stow edits show)", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    // KV is STALE (as after a native /stow file edit that never touched KV).
    await host.bb.storage.kv.set("memory-captain", "STALE_KV_CAPTAIN");
    await host.bb.storage.kv.set("memory-learnings", "STALE_KV_LEARN");
    stubRoutedHost(host, (cmd) => {
      if (cmd.includes("cat") && cmd.includes("data/captain.md")) return { payload: "FRESH_REAL_CAPTAIN", code: 0 };
      if (cmd.includes("cat") && cmd.includes("data/learnings.md") && !cmd.includes("archive")) return { payload: "FRESH_REAL_LEARN", code: 0 };
      return { payload: "", code: 0 };
    });
    const res = await host.harness.behavior.runCli(["session"], { projectId: "proj_1" });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stdout, /FRESH_REAL_CAPTAIN/, "recall must show the real captain file");
    assert.match(res.stdout, /FRESH_REAL_LEARN/, "recall must show the real learnings file");
    assert.doesNotMatch(res.stdout, /STALE_KV_CAPTAIN/, "recall must not serve the stale KV cache");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// ---- D4: a fresh captain session receives stored memory, within a deliberate budget ----

test("D4 captain instructions: inject stored memory (prefs + learnings); crews get none; budget bounded", async () => {
  const bigContract = "C".repeat(3000);
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: {
      captainMemory: "== Captain memory (recall; fmHome/data) ==\n-- prefs (captain.md) --\nMEMPREF ships terse\n-- recent learnings (learnings.md; newest 1) --\n- 2026-01-01: MEMLEARN flaky tests",
      captainContract: bigContract,
      fmSkillsManifest: JSON.stringify({ head: "abc1234567890", skills: [{ name: "stow", desc: "tiered memory" }] }),
    },
  });
  await plugin(host.bb);
  try {
    const cfg = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { captain: "true" } }),
    );
    const instr = cfg.instructions ?? "";
    assert.match(instr, /MEMPREF ships terse/, "captain prefs must be injected into a fresh captain session");
    assert.match(instr, /MEMLEARN flaky tests/, "recent learnings must be injected");
    // Budget: even with an oversized contract, memory AND skills survive (not first-come-scissored).
    assert.match(instr, /- stow: tiered memory/, "skills manifest must survive the budget alongside memory");
    assert.ok(instr.length <= 4096, `captain instructions must stay within the 4096 budget (was ${instr.length})`);
    const crew = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { crew: "true" } }),
    );
    assert.doesNotMatch(crew.instructions ?? "", /MEMPREF/, "crews must never receive captain memory");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// ---- D5: clear archives before wiping, and refuses to wipe if it cannot archive ----

test("D5 memory clear: archives current contents before wiping the real file", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    const existing = "- 2026-01-01: important learning to preserve <!--a:2026-01-01-->";
    await host.bb.storage.kv.set("memory-learnings", existing);
    const { writes } = stubRoutedHost(host, (cmd) => {
      if (cmd.includes("cat") && cmd.includes("data/learnings.md") && !cmd.includes("archive")) return { payload: existing, code: 0 };
      return { payload: "", code: 0 };
    });
    const res = await host.harness.behavior.runCli(["memory", "clear", "learnings"], { projectId: "proj_1" });
    assert.equal(res.exitCode, 0, res.stderr);
    const archive = decodeHostWrite(writes, "data/learnings.archive.md");
    assert.ok(archive !== null && archive.includes("important learning to preserve"), "clear must archive current learnings before wiping");
    assert.ok(archive!.includes("<!--cleared:"), "archive must carry a cleared marker");
    assert.equal(decodeHostWrite(writes, "data/learnings.md"), "", "live learnings wiped only AFTER the archive");
    assert.equal(await host.bb.storage.kv.get("memory-learnings"), "", "KV cleared");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D5 memory clear: refuses to wipe (no loss) when the archive write fails", async () => {
  const host = ownerHost({ memoryOwner: "real" });
  await plugin(host.bb);
  try {
    const existing = "- 2026-01-01: must not be lost <!--a:2026-01-01-->";
    await host.bb.storage.kv.set("memory-learnings", existing);
    const { writes } = stubRoutedHost(host, (cmd) => {
      if (cmd.includes("cat") && cmd.includes("data/learnings.md") && !cmd.includes("archive")) return { payload: existing, code: 0 };
      // The archive write FAILS → clear must be refused and nothing wiped.
      if (cmd.includes("base64 -d") && cmd.includes("archive")) return { code: 1 };
      return { payload: "", code: 0 };
    });
    const res = await host.harness.behavior.runCli(["memory", "clear", "learnings"], { projectId: "proj_1" });
    assert.equal(res.exitCode, 1, "clear must fail when it cannot archive first");
    assert.equal(decodeHostWrite(writes, "data/learnings.md"), null, "the live learnings file must be untouched when archive fails");
    assert.equal(await host.bb.storage.kv.get("memory-learnings"), existing, "KV must not be cleared when archive fails");
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

test("R2 relay: actionable stale:/check: lines wake the manager; signal:/heartbeat stay dropped", async () => {
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
      hostRcPayload("FM_BEAT_AGE=5\nFM_RELAUNCHED=0\n---FM_LOGTAIL---\ncheck: routine\nheartbeat 12\nsignal: state/c1.status\nstale: c1 wedged", 0),
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
    // The stale: wedge line is the actionable backstop and IS relayed.
    assert.match(relayed, /stale: c1 wedged/);
    // A routine signal: line is only a status-file-changed pointer whose content is already
    // delivered by notifyCaptain — it must NOT be relayed (reverting the extractWatchReasons
    // stale-only filter re-relays it and fails this assertion).
    assert.doesNotMatch(relayed, /signal:/);
    assert.match(relayed, /check: routine/);
    assert.doesNotMatch(relayed, /heartbeat 12/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("inbox check wakes the deck manager even when no crews exist", async () => {
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
    host.harness.sdk.stub("environments.list", async () => []);
    await host.bb.storage.kv.set("crews", []);
    await host.bb.storage.kv.set("fm-watch-captain:host_1", "thr_cap");
    host.harness.sdk.stub("terminals.output", async () =>
      hostRcPayload("FM_BEAT_AGE=5\nFM_RELAUNCHED=0\n---FM_LOGTAIL---\ncheck: captain inbox note 17\ncheck: captain inbox note 18", 0),
    );
    const run = host.harness.behavior.runService("fm-watch-supervisor");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (sendCalls(host).length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    run.controller.abort();
    await run.done;
    assert.ok(
      sendCalls(host).some((s) => {
        const text = s.text ?? "";
        return s.threadId === "thr_cap" && text.includes("check: captain inbox note 17") && text.includes("check: captain inbox note 18");
      }),
      "the remembered /captain thread must receive every distinct home-wide inbox wake with an empty fleet",
    );
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D6 relay: an fm-watch page reaches ONLY the owning captain; unattributable lines are not fanned across captains", async () => {
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
    // Two captains, each owning a crew on the SAME host.
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew1", "thr_capA"), crewRow("c2", "thr_crew2", "thr_capB")]);
    host.harness.sdk.stub("terminals.output", async () =>
      hostRcPayload("FM_BEAT_AGE=5\nFM_RELAUNCHED=0\n---FM_LOGTAIL---\nstale: c2 wedged on rebase\nstale: mystery wedge no crew id", 0),
    );
    const run = host.harness.behavior.runService("fm-watch-supervisor");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (sendCalls(host).length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    run.controller.abort();
    await run.done;
    const sends = sendCalls(host);
    // c2's page goes to its OWNER (capB) only.
    assert.ok(sends.some((s) => s.threadId === "thr_capB" && (s.text ?? "").includes("c2 wedged on rebase")), "owning captain B must receive c2's page");
    assert.ok(!sends.some((s) => s.threadId === "thr_capA" && (s.text ?? "").includes("c2 wedged")), "captain A must NOT receive captain B's crew page");
    // The unattributable line must NOT be fanned to any captain (2 captains on host = ambiguous).
    assert.ok(!sends.some((s) => (s.text ?? "").includes("mystery wedge")), "an unattributable line must not be broadcast across captains");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D8 relay: a MULTI-crew stale line is split/filtered per owner (no cross-captain crew-id leak)", async () => {
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
    // Two captains on one host; a single fm-watch signal line names BOTH crews.
    await host.bb.storage.kv.set("crews", [crewRow("1f4c7c2a", "thr_crew1", "thr_capA"), crewRow("79da4929", "thr_crew2", "thr_capB")]);
    host.harness.sdk.stub("terminals.output", async () =>
      hostRcPayload("FM_BEAT_AGE=5\nFM_RELAUNCHED=0\n---FM_LOGTAIL---\nstale: state/1f4c7c2a.status state/79da4929.status wedged", 0),
    );
    const run = host.harness.behavior.runService("fm-watch-supervisor");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (sendCalls(host).length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    run.controller.abort();
    await run.done;
    const sends = sendCalls(host);
    const toA = sends.filter((s) => s.threadId === "thr_capA").map((s) => s.text ?? "").join("\n");
    const toB = sends.filter((s) => s.threadId === "thr_capB").map((s) => s.text ?? "").join("\n");
    assert.match(toA, /1f4c7c2a/, "captain A must receive its own crew's page");
    assert.doesNotMatch(toA, /79da4929/, "captain A must NOT see captain B's crew id in a multi-crew line");
    assert.match(toB, /79da4929/, "captain B must receive its own crew's page");
    assert.doesNotMatch(toB, /1f4c7c2a/, "captain B must NOT see captain A's crew id in a multi-crew line");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("D7: the keeper script self-exits when the owner beat goes stale (owner gone)", () => {
  const script = fmWatchKeeperScript("host_1", "/fm", fmWatchKeeperInterval(90));
  assert.match(script, /OWNER_BEAT=/, "keeper must reference the owner beat");
  assert.match(script, /OWNER_TTL=\d+/, "keeper must carry an owner TTL");
  // Loop breaks when the beat is missing (0) or older than the TTL.
  assert.match(script, /"\$OB" -eq 0 \]\s*\|\|\s*\[ \$\(\( NOW - OB \)\) -gt "\$OWNER_TTL" \]/, "keeper must break on a stale/absent owner beat");
});

test("D7: watchOwner=native tears the keeper down on the first tick even after a reload (empty in-memory state)", async () => {
  // Reproduces the live bug: the plugin came back up (reload → in-memory keeperHosts
  // empty) with watchOwner already flipped to native; teardown must still fire, seeded
  // from the configured fmHostId (and the KV-persisted set).
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", watchOwner: "native", fmHostId: "host_1" },
  });
  await plugin(host.bb);
  try {
    const cmds: string[] = [];
    let n = 0;
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("terminals.create", async (a: { start?: { command?: string } }) => {
      cmds.push(a.start?.command ?? "");
      return { id: `t_${++n}` };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "exited" }));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    host.harness.sdk.stub("terminals.output", async () => hostRcPayload("", 0));
    const teardownSeen = () => cmds.some((c) => unwrapHostCommand(c).includes(".bb-watch-keeper.pid") && unwrapHostCommand(c).includes("rm -f"));
    const run = host.harness.behavior.runService("fm-watch-supervisor");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (teardownSeen()) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    run.controller.abort();
    await run.done;
    assert.ok(teardownSeen(), `watchOwner=native must remove the keeper pidfile on the host:\n${cmds.map(unwrapHostCommand).join("\n---\n")}`);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("B3(c): dispose with the feature OFF tears the keeper down", async () => {
  // watchOwner=native means the fm-watch keeper should not be running; dispose sweeps
  // the configured host so a keeper left over from a prior on-stretch is torn down.
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", watchOwner: "native", fmHostId: "host_1" },
  });
  await plugin(host.bb);
  const cmds: string[] = [];
  let n = 0;
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("terminals.create", async (a: { start?: { command?: string } }) => {
    cmds.push(a.start?.command ?? "");
    return { id: `t_${++n}` };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "exited" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async () => hostRcPayload("", 0));
  // dispose() invokes bb.onDispose — which must stop the keeper on the configured host.
  await host.harness.lifecycle.dispose();
  assert.ok(
    cmds.some((c) => unwrapHostCommand(c).includes(".bb-watch-keeper.pid") && unwrapHostCommand(c).includes("rm -f")),
    `dispose must remove the keeper pidfile on the host:\n${cmds.map(unwrapHostCommand).join("\n---\n")}`,
  );
});

test("B3(c): dispose during a hot reload (watchOwner still fm-watch) LEAVES the keeper", async () => {
  // A hot reload is dispose+re-init with the SAME config. Stopping the keeper here made
  // it flap on every reload (killed, then re-launched next tick, leaving a gap). With
  // the feature still on, dispose must NOT remove the keeper pidfile — the reloaded
  // plugin re-adopts it, and the owner-beat self-exit is the backstop.
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", watchOwner: "fm-watch", fmHostId: "host_1" },
  });
  await plugin(host.bb);
  const cmds: string[] = [];
  let n = 0;
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("terminals.create", async (a: { start?: { command?: string } }) => {
    cmds.push(a.start?.command ?? "");
    return { id: `t_${++n}` };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "exited" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async () => hostRcPayload("", 0));
  await host.harness.lifecycle.dispose();
  assert.ok(
    !cmds.some((c) => unwrapHostCommand(c).includes(".bb-watch-keeper.pid") && unwrapHostCommand(c).includes("rm -f")),
    `dispose during a hot reload must NOT remove the keeper pidfile:\n${cmds.map(unwrapHostCommand).join("\n---\n")}`,
  );
});

// ---------------------------------------------------------------------------
// B1: brief-intent normalisation (why real transport never spawned)
// ---------------------------------------------------------------------------

// The EXACT operator-address rule native fm-spawn.sh refuses on, ported verbatim
// from fm-dod-lib.sh's fm_brief_intent_address_line awk. The scratch-FM_HOME live
// proof (scripts/live-brief-intent-check.mjs) binds to the real file; this unit
// keeps the same rule so a drift is caught in `npm test` too.
const NATIVE_INTENT_ADDRESS = /^[ \t]*(Captain('s (words|ask|intent))?:|Captain,)/;

test("B1: normalizeCaptainIntent strips EXACTLY the labels native refuses, nothing native accepts", () => {
  // Every form native REFUSES → the label is stripped, words kept verbatim.
  const refused: Array<[string, string]> = [
    ["Captain's intent: live check the transport", "live check the transport"],
    ["Captain: do the thing", "do the thing"],
    ["Captain, please do X", "please do X"],
    ["Captain's words: hi there", "hi there"],
    ["Captain's ask: fix it", "fix it"],
  ];
  for (const [input, firstLine] of refused) {
    assert.ok(NATIVE_INTENT_ADDRESS.test(input), `sanity: native must refuse ${JSON.stringify(input)}`);
    const out = normalizeCaptainIntent(input);
    assert.equal(out.split("\n")[0], firstLine, `strip label from: ${input}`);
    for (const line of out.split("\n")) {
      assert.ok(!NATIVE_INTENT_ADDRESS.test(line), `result still trips native refusal: ${JSON.stringify(line)}`);
    }
  }
  // Every form native ACCEPTS → left COMPLETELY untouched (the words are the captain's
  // provenance record; editing them when native would accept is a defect).
  const accepted = [
    "Captain's intent (verbatim): live check the transport",
    "Captain's ask (per the spec): fix it",
    "Captains: a plural noun, not an address",
    "implement the scout's path",
    "Note from Captain: this is mid-sentence, not a leading label",
  ];
  for (const input of accepted) {
    assert.ok(!NATIVE_INTENT_ADDRESS.test(input), `sanity: native must ACCEPT ${JSON.stringify(input)}`);
    assert.equal(normalizeCaptainIntent(input), input, `must not touch a form native accepts: ${input}`);
  }
  // Native scans EVERY line, so EVERY refused line is stripped — not just the first.
  assert.equal(
    normalizeCaptainIntent("Captain's intent: do items 1 and 2\nCaptain: and item 3\nAcceptance: both land"),
    "do items 1 and 2\nand item 3\nAcceptance: both land",
  );
  // A standalone label line is dropped entirely.
  assert.equal(normalizeCaptainIntent("Captain's intent:\nDo the thing"), "Do the thing");
});

test("B1: dispatch normalises the leading Captain-label out of the brief intent body", async () => {
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
    // The bare "Captain's intent:" label is the exact form native REFUSES (and the form
    // the captain skill + auto-dispatches emit); it must be stripped before the brief.
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--", "Captain's intent: fix flaky login"],
      { projectId: "proj_1" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const scaffold = hostCommands.find((c) => c.includes("FM_INTENT="));
    assert.ok(scaffold, `no brief fill command in ${hostCommands.join("\n---\n")}`);
    const m = /FM_INTENT=([A-Za-z0-9+/=]+)/.exec(scaffold!);
    assert.ok(m, "no FM_INTENT b64 in the scaffold command");
    const decoded = Buffer.from(m![1]!, "base64").toString("utf8");
    assert.equal(decoded, "fix flaky login", `brief intent body must be normalised, got ${JSON.stringify(decoded)}`);
    assert.ok(!NATIVE_INTENT_ADDRESS.test(decoded), "brief intent body still trips native refusal");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// ---------------------------------------------------------------------------
// B2 (D9): the surfaced ack instruction must name the partition-safe bb command
// ---------------------------------------------------------------------------

test("B2: rewriteWakeAckLine strips the raw script from ALL FIVE native emission sites", () => {
  // Verbatim native strings (fm-wake-drain.sh) with %s rendered — the consuming forms
  // AND the present/re-run forms. After rewrite NONE may still name the raw script.
  const NATIVE_SITES = [
    // :860 — main consuming ACK line
    "WAKE_ACK_REQUIRED: after handling completes run bin/fm-wake-drain.sh --ack-through 16 --recovery-generation 3986370",
    // :782 — recovery-only consuming ACK line
    "WAKE_ACK_REQUIRED: after handling completes run bin/fm-wake-drain.sh --ack-through 0 --recovery-generation 3986370",
    // :748 — stale-ack advisory, the CONSUMING form with NO WAKE_ACK_REQUIRED prefix
    "wake drain: nothing was acknowledged through 12 (none of your presented wake rows is at or below it); the current wake is row 16: run bin/fm-wake-drain.sh --ack-through 16 --recovery-generation 3986370 after handling it",
    // :752 — present/re-run form
    "wake drain: nothing was acknowledged through 12 (none of your presented wake rows is at or below it); the current wake is row 16: re-run bin/fm-wake-drain.sh and use the WAKE_ACK_REQUIRED command it prints",
    // :757 — present/re-run form
    "wake drain: acknowledged wakes through 12 (3 row(s) consumed), but a newer recovery episode is pending; re-run bin/fm-wake-drain.sh and use the new WAKE_ACK_REQUIRED command",
    // :715 — present/re-run form
    "wake drain: recovery episode could not be retired safely; re-run bin/fm-wake-drain.sh and use the new WAKE_ACK_REQUIRED command",
  ];
  const out = rewriteWakeAckLine(NATIVE_SITES.join("\n"));
  // Not a single surfaced line may name the raw script.
  assert.ok(!/bin\/fm-wake-drain\.sh/.test(out), `raw script survived somewhere:\n${out}`);
  // The consuming forms now name the partition-safe bb command with the same args.
  assert.match(out, /run bb firstmate wake --ack-through 16 --recovery-generation 3986370/);
  assert.match(out, /run bb firstmate wake --ack-through 0 --recovery-generation 3986370/);
  assert.match(out, /run bb firstmate wake --ack-through 16 --recovery-generation 3986370 after handling it/);
  // The present/re-run forms now name the bb command too.
  assert.match(out, /re-run bb firstmate wake and use the WAKE_ACK_REQUIRED command it prints/);
});

test("B2: `bb firstmate wake` presents the ack instruction as the bb command, not the raw script", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", notifyOwner: "real", fmHostId: "host_1" },
  });
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("terminals.create", async () => ({ id: "term_1" }));
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    // Both the WAKE_ACK_REQUIRED consuming line AND the stale-ack advisory (the
    // consuming form the captain hit live, no WAKE_ACK_REQUIRED prefix) come through.
    host.harness.sdk.stub("terminals.output", async () =>
      hostOutput(
        [
          "wake drain: nothing was acknowledged through 2 (none of your presented wake rows is at or below it); the current wake is row 4: run bin/fm-wake-drain.sh --ack-through 4 --recovery-generation g99 after handling it",
          "WAKE_ACK_REQUIRED: after handling completes run bin/fm-wake-drain.sh --ack-through 4 --recovery-generation g99",
        ].join("\n"),
      ),
    );
    const result = await host.harness.behavior.runCli(["wake"], { projectId: "proj_1", threadId: "thr_cap" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /bb firstmate wake --ack-through 4 --recovery-generation g99/);
    assert.ok(
      !/bin\/fm-wake-drain\.sh/.test(result.stdout),
      `no surfaced line may name the raw script:\n${result.stdout}`,
    );
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// ---------------------------------------------------------------------------
// B3: keeper robustness (self-exit tolerance, beat-write SPOF)
// ---------------------------------------------------------------------------

test("B3(a): the owner-beat self-exit TTL tolerates transient host slowness", () => {
  // The supervisor refreshes the beat ~every 15–30s; the self-exit must survive many
  // missed refreshes so transient slowness cannot kill a healthy keeper. Old formula
  // (max(120, interval*6)) gave a flat 120s (~4 refreshes) for every interval 10–20.
  for (const interval of [10, 15, 20]) {
    assert.ok(
      fmWatchOwnerBeatTtl(interval) >= 600,
      `TTL for interval ${interval} must give generous tolerance, got ${fmWatchOwnerBeatTtl(interval)}`,
    );
  }
});

test("B3(b): a failed owner-beat write is surfaced loudly, not swallowed", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", watchOwner: "fm-watch", fmHostId: "host_1", watchHeartbeatSec: 30 },
  });
  await plugin(host.bb);
  try {
    const cmds = new Map<string, string>();
    let n = 0;
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      const id = `t_${++n}`;
      cmds.set(id, args.start?.command ?? "");
      return { id };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
      const cmd = cmds.get(args.terminalId) ?? "";
      // The owner-beat write fails on this host (full / read-only state dir).
      if (cmd.includes("FM_BEAT_AGE")) {
        return hostRcPayload("FM_OWNER_BEAT=fail\nFM_BEAT_AGE=5\nFM_KEEPER=alive\n---FM_LOGTAIL---\n", 0);
      }
      return hostRcPayload("", 0);
    });
    const run = host.harness.behavior.runService("fm-watch-supervisor");
    const deadline = Date.now() + 2000;
    const hit = () =>
      host.harness.logEntries.some((e) => e.level === "error" && /owner-beat write FAILED/.test(e.message));
    while (Date.now() < deadline && !hit()) await new Promise((r) => setTimeout(r, 10));
    run.controller.abort();
    await run.done;
    assert.ok(
      hit(),
      `a failed owner-beat write must be logged at error:\n${host.harness.logEntries.map((e) => `${e.level}: ${e.message}`).join("\n")}`,
    );
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
      // A cycle that is allowed to relaunch detach-launches the keeper script.
      if (cmd.includes("setsid") && cmd.includes(".bb-watch-keeper.sh")) relaunchAttempts++;
      return { id };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    // Keeper always dead → each allowed cycle relaunches it, then backoff must gate.
    host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
      const cmd = cmds.get(args.terminalId) ?? "";
      if (cmd.includes("FM_BEAT_AGE")) return hostRcPayload("FM_BEAT_AGE=9999\nFM_KEEPER=dead\n---FM_LOGTAIL---\n", 0);
      return hostRcPayload("", 0);
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


// --- Phase 6: durable messaging planes — real-script integration + flag gating ---
//
// F6: these run the REAL firstmate bin/ scripts (fm-wake-lib, fm-wake-drain,
// fm-task-inbox-lib) against a scratch FM_HOME by making the fake host terminal
// actually execute each command. They assert the captain-facing RESULT (what drain
// presents, what the crew's durable record contains), not just the emitted command
// string. Skipped when the real scripts are absent (e.g. CI without them).

const FM_TEST_BIN = process.env.FM_TEST_BIN ?? "/root/firstmate/bin";
const FM_INTEGRATION =
  existsSync(join(FM_TEST_BIN, "fm-wake-lib.sh")) &&
  existsSync(join(FM_TEST_BIN, "fm-wake-drain.sh")) &&
  existsSync(join(FM_TEST_BIN, "fm-task-inbox-lib.sh"));

function scratchFmHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fm-it-"));
  mkdirSync(join(home, "state"), { recursive: true });
  symlinkSync(FM_TEST_BIN, join(home, "bin"));
  return home;
}

// Make the fake host terminal EXECUTE each command for real (recovering the inner
// command from the RC wrapper and running it in a fresh shell), so the plugin drives
// the actual scripts. threads.send stays a recording no-op.
function stubRealExecHost(host: Awaited<ReturnType<typeof load>>) {
  const cmds = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec" }));
  host.harness.sdk.stub("environments.list", async () => [
    { hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" },
  ]);
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: null }));
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
    const id = `t_${++n}`;
    cmds.set(id, args.start?.command ?? "");
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const inner = unwrapHostCommand(cmds.get(args.terminalId) ?? "");
    const r = spawnSync("bash", ["-c", inner], { encoding: "utf8", timeout: 30_000 });
    return hostRcPayload((r.stdout ?? "") + (r.stderr ?? ""), typeof r.status === "number" ? r.status : 1);
  });
}

function itHost(home: string, extra: Record<string, unknown>) {
  return createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { fmHome: home, fmHostId: "host_1", ...extra },
  });
}

// ---- flag gating (cheap, defaults inert) ----

test("notifyOwner=kv (default) sends the full report and enqueues no wake", async () => {
  const host = ownerHost();
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, () => ({ code: 0 }));
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await emitIdle(host, "DONE: shipped the branch");
    assert.ok(!seen.some((c) => c.includes("fm_wake_append")), "kv default must not enqueue a wake");
    const sends = sendCalls(host);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.mode, "steer", "crew outcome must enter the active captain turn, never queue");
    assert.equal(sends[0]?.visibility, "agent-only", "internal crew wakes must never render in captain chat");
    assert.match(sends[0]?.text ?? "", /Check the crew's current state because this event may already be resolved/);
    assert.match(sends[0]?.text ?? "", /DONE: shipped the branch/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("tellOwner=kv (default) uses a bare doorbell, no durable record", async () => {
  const host = ownerHost();
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, () => ({ code: 0 }));
    await seedCrew(host);
    const res = await host.harness.behavior.runCli(["tell", "c1", "--message=please rebase"], { projectId: "proj_1" });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.ok(!seen.some((c) => c.includes("fm_task_inbox_write")), "kv default writes no durable record");
    assert.equal(sendCalls(host).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// ---- supervision-model + ack-loop + doorbell + reaper characterization ----

test("fmBackendEnv declares FM_SUPERVISION_MODEL=autoarm on every bb firstmate invocation", () => {
  const env = fmBackendEnv({ fmHome: "/h", hostId: "host_1" });
  assert.ok(env.includes("export FM_SUPERVISION_MODEL=autoarm"), env.join("\n"));
  assert.ok(env.includes("export FM_BACKEND=bb"));
  // no accidental successor flag on the generic invocation path (keeper-only concern)
  assert.ok(!env.some((l) => l.includes("FM_WATCH_HANDLING_SUCCESSOR")));
});

test("bb firstmate fm routes with FM_SUPERVISION_MODEL=autoarm in the real command", async () => {
  const host = ownerHost();
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, () => ({ code: 0 }));
    host.harness.sdk.stub("hosts.list", async () => [{ id: "host_1", name: "host_1" }]);
    const res = await host.harness.behavior.runCli(["fm", "--machine=host_1", "true"], { projectId: "proj_1" });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.ok(
      seen.some((c) => c.includes("export FM_SUPERVISION_MODEL=autoarm")),
      `no autoarm export in routed fm command:\n${seen.join("\n---\n")}`,
    );
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("fmWatchKeeperScript declares autoarm AND arms fm-watch as a handling successor", () => {
  const s = fmWatchKeeperScript("host_1", "/h", 15);
  assert.ok(s.includes("export FM_SUPERVISION_MODEL=autoarm"), s);
  assert.ok(s.includes("export FM_WATCH_HANDLING_SUCCESSOR=1"), s);
  assert.ok(s.includes("fm-watch-arm.sh"));
});

// Part C: the drain hint is appended only when draining surfaces something the doorbell
// line does not already carry (drainHint=true), never as a fixed footer.
test("Part C: captainWakeDoorbell appends the drain hint only when drainHint=true", () => {
  const plain = captainWakeDoorbell("✅ crew c1 done", "shipped the branch");
  assert.match(plain, /^🔔 ✅ crew c1 done — shipped the branch$/, plain);
  assert.ok(!plain.includes("firstmate_wake"), `a plain doorbell must carry no drain footer: ${plain}`);
  const withHint = captainWakeDoorbell("⚖️ crew c1 NEEDS DECISION", "pick a base branch", { drainHint: true });
  assert.match(withHint, /firstmate_wake/, withHint);
  // Reverting the conditional (always append CAPTAIN_WAKE_DRAIN_HINT) makes the plain case
  // carry the footer and fails the assertion above.
});

// Part B: one crew completion = one plugin-owned live wake. The durable queue is
// recovery; the steer is immediate delivery even while the captain is busy.
test("Part B: notifyOwner=real — a plain done is durably stored and steered into the captain turn", async () => {
  const host = ownerHost({ notifyOwner: "real" });
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, () => ({ code: 0 }));
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await emitIdle(host, "DONE: shipped the branch");
    // The report still lands in the durable queue (drain recovers it).
    assert.ok(seen.some((c) => c.includes("fm_wake_append")), "real must still enqueue the durable wake (the store)");
    const sends = sendCalls(host).filter((s) => s.threadId === "thr_cap");
    assert.equal(sends.length, 1, `a plain done must proactively reach the captain: ${sends.map((s) => s.text).join(" | ")}`);
    assert.equal(sends[0]?.mode, "steer", "a busy captain must receive the outcome in its current turn");
    assert.match(sends[0]?.text ?? "", /shipped the branch/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Part B: a NON-plain event (a failure) is NOT covered by "the crew just delivered its report",
// so the plugin doorbell must still fire — the suppression must not silence real alerts.
test("Part B: notifyOwner=real — a failure still doorbells the captain (non-plain is never suppressed), no drain footer", async () => {
  const host = ownerHost({ notifyOwner: "real" });
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, () => ({ code: 0 }));
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_crew", status: "error", projectId: "proj_1" }),
      error: "boom: the build blew up",
    });
    assert.ok(seen.some((c) => c.includes("fm_wake_append")), "a failure must enqueue the durable wake");
    const sends = sendCalls(host).filter((s) => s.threadId === "thr_cap");
    assert.equal(sends.length, 1, "a failure must still reach the captain");
    const text = sends[0]?.text ?? "";
    assert.match(text, /^🔔 /, text);
    assert.match(text, /crew c1 failed/, text);
    // A failure is self-sufficient (head + summary + next: retry|tell|forget) — no drain footer.
    assert.ok(!text.includes("firstmate_wake"), `a failure doorbell needs no drain footer: ${text}`);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Part B BLOCKER regression: a crew that reports BLOCKED/FAILED *in-band* (the normal firstmate
// way) fires thread.idle and stays kind="idle" — it must NOT be swept up by the plain-done
// suppression. Only a genuine DONE verdict is suppressed. These emit the verdict via thread.idle
// (not thread.failed) — the exact path that regressed — and die if the gate widens back to
// `kind === "idle"` alone.
test("Part B: notifyOwner=real — an in-band BLOCKED (via thread.idle) still doorbells the captain", async () => {
  const host = ownerHost({ notifyOwner: "real" });
  await plugin(host.bb);
  try {
    stubRoutedHost(host, () => ({ code: 0 }));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: null }));
    host.harness.sdk.stub("threads.list", async () => []);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await emitIdle(host, "BLOCKED: waiting on prod credentials, cannot proceed");
    const sends = sendCalls(host).filter((s) => s.threadId === "thr_cap");
    assert.equal(sends.length, 1, "a BLOCKED crew must still proactively reach the captain");
    assert.match(sends[0]?.text ?? "", /BLOCKED: waiting on prod credentials/, sends[0]?.text);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Part B: notifyOwner=real — an in-band FAILED (via thread.idle) still doorbells the captain", async () => {
  const host = ownerHost({ notifyOwner: "real" });
  await plugin(host.bb);
  try {
    stubRoutedHost(host, () => ({ code: 0 }));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: null }));
    host.harness.sdk.stub("threads.list", async () => []);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await emitIdle(host, "FAILED: the migration is irrecoverable, aborting");
    const sends = sendCalls(host).filter((s) => s.threadId === "thr_cap");
    assert.equal(sends.length, 1, "a FAILED crew must still proactively reach the captain");
    assert.match(sends[0]?.text ?? "", /FAILED: the migration is irrecoverable/, sends[0]?.text);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Part C end-to-end: a needs-decision IS the one event whose full context (the decision to
// answer) lives in the durable queue, so its real-mode doorbell keeps the drain hint.
test("Part C: notifyOwner=real — a NEEDS DECISION doorbell keeps the drain hint (open decision lives in the queue)", async () => {
  const host = ownerHost({ notifyOwner: "real", nudgeMaxPerCrew: 1, nudgeCooldownSeconds: 0 });
  await plugin(host.bb);
  try {
    stubRoutedHost(host, () => ({ code: 0 }));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: null }));
    host.harness.sdk.stub("threads.list", async () => []);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    // Prime the nudge ladder at the cap so the next verdict-less idle exhausts → NEEDS DECISION.
    await host.bb.storage.kv.set("protocol-nudges", {
      c1: { generation: "2026-09-18T00:00:00.000Z", count: 1, lastAt: 0, exhausted: false },
    });
    await emitIdle(host, "still working");
    const captain = sendCalls(host).filter((s) => s.threadId === "thr_cap");
    assert.equal(captain.length, 1, "the cap must surface NEEDS DECISION");
    const text = captain[0]?.text ?? "";
    assert.match(text, /NEEDS DECISION/, text);
    assert.match(text, /firstmate_wake/, text);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Part D: captain-facing views default to the CALLING captain's own crews. A shared register
// with crews of many captains must not show captain A the crews owned by captain B; --all is the
// explicit opt-in for the whole host.
test("Part D: `crews` defaults to the calling captain's own crews; --all opts into host-wide", async () => {
  const host = await load();
  try {
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "idle", environmentId: null }));
    await host.bb.storage.kv.set("crews", [
      crewRow("crewalpha", "thr_crewA", "thr_capA"),
      crewRow("crewbravo", "thr_crewB", "thr_capB"),
    ]);
    // Captain A sees ONLY its own crew — reverting the listCrews owner filter shows crewbravo too.
    const own = await host.harness.behavior.runCli(["crews"], { threadId: "thr_capA", projectId: "proj_1" });
    assert.equal(own.exitCode, 0, own.stderr);
    assert.match(own.stdout, /crewalpha/, own.stdout);
    assert.doesNotMatch(own.stdout, /crewbravo/, `captain A must not see captain B's crew: ${own.stdout}`);
    // --all is the explicit host-wide opt-in.
    const all = await host.harness.behavior.runCli(["crews", "--all"], { threadId: "thr_capA", projectId: "proj_1" });
    assert.equal(all.exitCode, 0, all.stderr);
    assert.match(all.stdout, /crewalpha/, all.stdout);
    assert.match(all.stdout, /crewbravo/, all.stdout);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Part D empty-state: a captain running `crews` from a thread that dispatched nothing, while the
// host DOES have crews under other threads, must not see a bare "No crews." that reads as an empty
// fleet — it must say the view is scoped and name the --all opt-in.
test("Part D: a cross-thread empty `crews` view is self-explaining (scoped + names --all), not a bare No crews.", async () => {
  const host = await load();
  try {
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "idle", environmentId: null }));
    // The only crews on the host belong to OTHER threads.
    await host.bb.storage.kv.set("crews", [
      crewRow("crewbravo", "thr_crewB", "thr_capB"),
      crewRow("crewcharlie", "thr_crewC", "thr_capC"),
    ]);
    const own = await host.harness.behavior.runCli(["crews"], { threadId: "thr_capA", projectId: "proj_1" });
    assert.equal(own.exitCode, 0, own.stderr);
    // Not a bare "No crews." — it explains the scoping and names the opt-in (dies if the empty
    // hint is dropped back to a bare "No crews.").
    assert.match(own.stdout, /scoped to your own crews/, own.stdout);
    assert.match(own.stdout, /--all/, own.stdout);
    assert.doesNotMatch(own.stdout, /crewbravo/, "still must not leak other captains' crew ids");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Item 2: `deck --all` genuinely opts into the whole host (the PR claimed deck supports --all).
test("Part D: `deck --all` shows every captain's crews; default deck is scoped to this thread", async () => {
  const host = await load();
  try {
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "idle", environmentId: null }));
    host.harness.sdk.stub("threads.update", async () => ({}));
    host.harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
    await host.bb.storage.kv.set("crews", [
      crewRow("crewalpha", "thr_crewA", "thr_capA"),
      crewRow("crewbravo", "thr_crewB", "thr_capB"),
    ]);
    const scoped = await host.harness.behavior.runCli(["deck"], { threadId: "thr_capA", projectId: "proj_1" });
    assert.equal(scoped.exitCode, 0, scoped.stderr);
    assert.doesNotMatch(scoped.stdout, /crewbravo/, `default deck must be scoped to this thread: ${scoped.stdout}`);
    const all = await host.harness.behavior.runCli(["deck", "--all"], { threadId: "thr_capA", projectId: "proj_1" });
    assert.equal(all.exitCode, 0, all.stderr);
    assert.match(all.stdout, /crewbravo/, `deck --all must show host-wide crews: ${all.stdout}`);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Part D: the @crew mention menu is scoped to the composing captain's own crews", async () => {
  const host = await load();
  try {
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "idle", environmentId: null }));
    await host.bb.storage.kv.set("crews", [
      crewRow("crewalpha", "thr_crewA", "thr_capA"),
      crewRow("crewbravo", "thr_crewB", "thr_capB"),
    ]);
    const crewProvider = host.harness.registrations.mentionProviders.find((p) => p.id === "crew");
    assert.ok(crewProvider, "the @crew mention provider must be registered");
    const rows = await crewProvider!.search({ trigger: "@", query: "", projectId: "proj_1", threadId: "thr_capA" });
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes("crewalpha"), `captain A must see its own crew: ${ids.join(",")}`);
    assert.ok(!ids.includes("crewbravo"), `captain A must not see captain B's crew in the mention menu: ${ids.join(",")}`);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("inboxReapScript reaps ONLY fire-and-forget beyond the cap; keeps a normal record, handled/, and non-.msg", () => {
  const dir = mkdtempSync(join(tmpdir(), "fm-reap-"));
  mkdirSync(join(dir, "handled"), { recursive: true });
  const writeRec = (seq: number, ff: boolean, body: string) => {
    const header = ["schema=fm-task-inbox.v1", "at=2026-01-01T00:00:00Z", ...(ff ? ["delivery=fire-and-forget"] : []), "--"];
    writeFileSync(join(dir, `${String(seq).padStart(3, "0")}.msg`), `${header.join("\n")}\n${body}`);
  };
  writeRec(1, false, "OLD NORMAL unhandled steer — must survive"); // oldest overall, NOT ff
  for (let seq = 2; seq <= 6; seq += 1) writeRec(seq, true, `ff steer ${seq}`); // 5 ff records
  writeFileSync(join(dir, "handled", "003.msg"), "handled marker"); // handled/ subdir untouched
  writeFileSync(join(dir, "readme.txt"), "not a msg"); // non-.msg untouched
  const r = spawnSync("bash", ["-c", inboxReapScript(dir, 3)], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const alive = (p: string) => existsSync(join(dir, p));
  // ff-vs-normal distinction: the oldest record is a NORMAL steer and MUST survive
  assert.ok(alive("001.msg"), "normal (non-ff) record must never be reaped");
  // 200-cap (here 3): only the newest 3 ff survive; older ff are pruned
  assert.ok(!alive("002.msg") && !alive("003.msg"), "oldest ff beyond cap must be reaped");
  assert.ok(alive("004.msg") && alive("005.msg") && alive("006.msg"), "newest ff within cap must survive");
  // handled/ and non-.msg left alone
  assert.ok(alive("handled/003.msg"), "handled/ subdir must be untouched");
  assert.ok(alive("readme.txt"), "non-.msg files must be untouched");
  rmSync(dir, { recursive: true, force: true });
});

// ---- F1: two distinct reports both survive present + ack ----

test("IT F1: notifyOwner=real — two DISTINCT crew reports both survive wake present+ack", { skip: !FM_INTEGRATION }, async () => {
  const home = scratchFmHome();
  const host = itHost(home, { notifyOwner: "real" });
  await plugin(host.bb);
  try {
    stubRealExecHost(host);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await emitIdle(host, "DONE: REPORTONE milestone reached");
    await emitIdle(host, "BLOCKED: REPORTTWO missing credentials");
    const live = sendCalls(host).filter((s) => s.threadId === "thr_cap");
    assert.equal(live.length, 2, "each crew update must reach the manager even while it is already active");
    assert.ok(live.every((s) => s.mode === "steer"), "no manager update may queue behind the active turn");
    assert.match(live[0]?.text ?? "", /REPORTONE/);
    assert.match(live[1]?.text ?? "", /REPORTTWO/);
    // D6: the captain (crew.parentThreadId=thr_cap) drains its OWN scoped plane.
    const present = await host.harness.behavior.runCli(["wake"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(present.exitCode, 0, present.stderr);
    assert.match(present.stdout, /REPORTONE/, present.stdout);
    assert.match(present.stdout, /REPORTTWO/, present.stdout);
    const m = /--ack-through (\d+) --recovery-generation (\S+)/.exec(present.stdout);
    assert.ok(m, `no WAKE_ACK line in:\n${present.stdout}`);
    const acked = await host.harness.behavior.runCli(["wake", "--ack-through", m[1]!, "--recovery-generation", m[2]!], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(acked.exitCode, 0, acked.stderr);
    const after = await host.harness.behavior.runCli(["wake"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.doesNotMatch(after.stdout, /REPORTONE/);
    assert.doesNotMatch(after.stdout, /REPORTTWO/);
  } finally {
    await host.harness.lifecycle.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test("IT live delivery settlement: a completed captain turn acknowledges steered wakes without a duplicate backstop", { skip: !FM_INTEGRATION }, async () => {
  const home = scratchFmHome();
  const host = itHost(home, { notifyOwner: "real", turnEndGuard: "re-ring" });
  await plugin(host.bb);
  try {
    stubRealExecHost(host);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await emitIdle(host, "DONE: FIRSTLIVE handled in captain turn");
    await emitIdle(host, "BLOCKED: SECONDLIVE handled in captain turn");
    assert.equal(sendCalls(host).filter((s) => s.threadId === "thr_cap").length, 2);

    // The captain has incorporated both live steers and completed the turn. The
    // plugin should perform native present+ack internally before the turn-end guard.
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: { id: "thr_cap", status: "idle", runtime: { displayStatus: "idle" } },
      lastAssistantText: "Handled both crew outcomes.",
    });

    const capSends = sendCalls(host).filter((s) => s.threadId === "thr_cap");
    assert.equal(capSends.length, 2, `no duplicate turn-end backstop expected: ${capSends.map((s) => s.text).join(" | ")}`);
    const after = await host.harness.behavior.runCli(["wake"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(after.exitCode, 0, after.stderr);
    assert.doesNotMatch(after.stdout, /FIRSTLIVE|SECONDLIVE|WAKE_ACK_REQUIRED/, after.stdout);
  } finally {
    await host.harness.lifecycle.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// IT Part B (live): the durable queue remains recovery behind the live steer.
// This drives the REAL fm-wake scripts (scratch FM_HOME): a plain DONE must be
// recoverable — the report survives in the durable queue and drains via `bb firstmate wake`, and
// the queue entry names the crew even when the crew's own output is empty (so an empty/truncated
// BB delivery can never open a silent hole). Proves live delivery + recovery together.
test("IT Part B: notifyOwner=real — a live-steered plain DONE is recoverable from the durable queue (incl. empty output)", { skip: !FM_INTEGRATION }, async () => {
  const home = scratchFmHome();
  const host = itHost(home, { notifyOwner: "real" });
  await plugin(host.bb);
  try {
    stubRealExecHost(host);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });

    // A plain DONE with an outcome is steered live…
    await emitIdle(host, "DONE: shipped clean REPORTDONE");
    const capSends = sendCalls(host).filter((s) => s.threadId === "thr_cap");
    assert.equal(capSends.length, 1, `a plain DONE must reach the captain live: ${capSends.map((s) => s.text).join(" | ")}`);
    assert.equal(capSends[0]?.mode, "steer");

    // …but the report provably survives in the durable queue and drains.
    const present = await host.harness.behavior.runCli(["wake"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(present.exitCode, 0, present.stderr);
    assert.match(present.stdout, /REPORTDONE/, `live report must survive the durable queue:\n${present.stdout}`);
    // The entry names the crew, so an empty/truncated child output cannot make it anonymous.
    assert.match(present.stdout, /c1/, present.stdout);
    const m = /--ack-through (\d+) --recovery-generation (\S+)/.exec(present.stdout);
    assert.ok(m, `no WAKE_ACK line in:\n${present.stdout}`);
    const acked = await host.harness.behavior.runCli(["wake", "--ack-through", m[1]!, "--recovery-generation", m[2]!], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(acked.exitCode, 0, acked.stderr);
  } finally {
    await host.harness.lifecycle.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- D6: per-captain isolation — two captains never see/consume each other's wakes ----

test("IT D6: two captains — neither sees nor consumes the other's wakes (per-captain state plane)", { skip: !FM_INTEGRATION }, async () => {
  const home = scratchFmHome();
  const host = itHost(home, { notifyOwner: "real" });
  await plugin(host.bb);
  try {
    stubRealExecHost(host);
    await host.bb.storage.kv.set("crews", [
      { id: "cA", task: "task A", projectId: "proj_1", threadId: "thr_crewA", parentThreadId: "thr_capA", providerId: null, worktree: true, shape: "ship", posture: "local-only", createdAt: "2026-09-18T00:00:00.000Z" },
      { id: "cB", task: "task B", projectId: "proj_1", threadId: "thr_crewB", parentThreadId: "thr_capB", providerId: null, worktree: true, shape: "ship", posture: "local-only", createdAt: "2026-09-18T00:00:00.000Z" },
    ]);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await emitIdle(host, "DONE: AONLY captain-A report", { id: "thr_crewA" });
    await emitIdle(host, "DONE: BONLY captain-B report", { id: "thr_crewB" });
    // Captain A drains its OWN plane: sees A, never B.
    const a = await host.harness.behavior.runCli(["wake"], { threadId: "thr_capA", projectId: "proj_1" });
    assert.equal(a.exitCode, 0, a.stderr);
    assert.match(a.stdout, /AONLY/, a.stdout);
    assert.doesNotMatch(a.stdout, /BONLY/, `captain A must NOT see captain B's report:\n${a.stdout}`);
    // Captain A acks through its own max seq.
    const m = /--ack-through (\d+) --recovery-generation (\S+)/.exec(a.stdout);
    assert.ok(m, `no WAKE_ACK line for A:\n${a.stdout}`);
    await host.harness.behavior.runCli(["wake", "--ack-through", m[1]!, "--recovery-generation", m[2]!], { threadId: "thr_capA", projectId: "proj_1" });
    // Captain B still sees BONLY — A's ack could not consume B's rows.
    const b = await host.harness.behavior.runCli(["wake"], { threadId: "thr_capB", projectId: "proj_1" });
    assert.equal(b.exitCode, 0, b.stderr);
    assert.match(b.stdout, /BONLY/, `captain B must still see its own report after A acked:\n${b.stdout}`);
    assert.doesNotMatch(b.stdout, /AONLY/, "captain B must never see captain A's report");
  } finally {
    await host.harness.lifecycle.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- D1/D2 LIVE: real host file I/O (base64 + atomic mv), not the virtual-FS stub ----

test("IT D1/D2: migrate + add-learning preserve the real file head and mirror it to KV (real file I/O)", { skip: !FM_INTEGRATION }, async () => {
  const home = scratchFmHome();
  const host = itHost(home, { memoryOwner: "real" });
  await plugin(host.bb);
  try {
    stubRealExecHost(host);
    // Seed a real data/learnings.md head line through the plugin's own writer (real cat/base64/mv).
    const add = await host.harness.behavior.runCli(["memory", "add-learning", "HEADLEARN authoritative head"], { projectId: "proj_1" });
    assert.equal(add.exitCode, 0, add.stderr);
    const seeded = readFileSync(join(home, "data", "learnings.md"), "utf8");
    assert.match(seeded, /HEADLEARN authoritative head/, "seed write must land in the real file");
    // D2: the KV mirror equals the full real file (no mid-line -4000 decapitation).
    assert.equal(await host.bb.storage.kv.get("memory-learnings"), seeded.replace(/\n$/, ""), "KV must mirror the full real file after add-learning");
    // Simulate a decapitated KV cache (the D2 bug) — shorter than the authoritative file.
    await host.bb.storage.kv.set("memory-learnings", "EARN authoritative head");
    // D1: migrate must NOT clobber the real file with the truncated KV; direction is file→KV.
    const mig = await host.harness.behavior.runCli(["migrate-owners"], { projectId: "proj_1" });
    assert.equal(mig.exitCode, 0, mig.stderr);
    const afterFile = readFileSync(join(home, "data", "learnings.md"), "utf8");
    assert.match(afterFile, /HEADLEARN authoritative head/, "real learnings head must survive migrate (never clobbered by the KV cache)");
    assert.equal(await host.bb.storage.kv.get("memory-learnings"), afterFile.replace(/\n$/, ""), "KV must mirror the full real file after migrate");
  } finally {
    await host.harness.lifecycle.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- F2: quiet hold surfaces the held report at quiet-off ----

test("IT F2: quiet hold + notifyOwner=real surfaces the held report at quiet-off", { skip: !FM_INTEGRATION }, async () => {
  const home = scratchFmHome();
  const host = itHost(home, { notifyOwner: "real" });
  await plugin(host.bb);
  try {
    stubRealExecHost(host);
    await seedCrew(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    // D6: the captain (crew.parentThreadId=thr_cap) drains its OWN scoped queue —
    // pass the captain thread id exactly as production does (ctx.threadId).
    await host.harness.behavior.runCli(["quiet", "on"], { threadId: "thr_cap", projectId: "proj_1" });
    await emitIdle(host, "DONE: HELDREPORT while quiet");
    const off = await host.harness.behavior.runCli(["quiet", "off"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(off.exitCode, 0, off.stderr);
    assert.match(off.stdout, /HELDREPORT/, `quiet-off must surface the held durable report:\n${off.stdout}`);
  } finally {
    await host.harness.lifecycle.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- F3: no-meta crew stays steerable ----

test("IT F3: tellOwner=real steers a crew with NO state/<id>.meta (durable record + delivery)", { skip: !FM_INTEGRATION }, async () => {
  const home = scratchFmHome();
  const host = itHost(home, { tellOwner: "real" });
  await plugin(host.bb);
  try {
    stubRealExecHost(host);
    await seedCrew(host);
    // deliberately no state/c1.meta written
    const res = await host.harness.behavior.runCli(["tell", "c1", "--message=please rebase on main"], { projectId: "proj_1" });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(sendCalls(host).length, 1, "literal doorbell still delivered");
    const rec = readFileSync(join(home, "state", "c1.inbox", "handled", "001.msg"), "utf8");
    assert.match(rec, /please rebase on main/, "durable record written despite no meta");
    assert.ok(!existsSync(join(home, "state", "c1.meta")), "no meta was needed");
  } finally {
    await host.harness.lifecycle.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- F4: steer text stored verbatim for every hazardous prefix + multiline ----

test("IT F4: tellOwner=real stores steer text VERBATIM for --key / --resolve-key / slash / $ / multiline", { skip: !FM_INTEGRATION }, async () => {
  const home = scratchFmHome();
  const host = itHost(home, { tellOwner: "real" });
  await plugin(host.bb);
  try {
    stubRealExecHost(host);
    await seedCrew(host);
    // A default tell now steers with a standard course-correction prefix; the
    // user's hazardous content must still be stored/delivered VERBATIM after it.
    const STEER_PREFIX =
      "STEER from captain — this is a course correction, NOT a stop. Keep working on your current task and fold this in without tearing down or discarding work: ";
    const bodies = ["--resolve-key foo bar", "--key Enter then act", "/deploy to prod now", "$env special skill", "line one\nline two\nline three"];
    let seq = 0;
    for (const body of bodies) {
      const res = await host.harness.behavior.runCli(["tell", "c1", `--message=${body}`], { projectId: "proj_1" });
      assert.equal(res.exitCode, 0, res.stderr);
      seq += 1;
      const rec = readFileSync(join(home, "state", "c1.inbox", "handled", `${String(seq).padStart(3, "0")}.msg`), "utf8");
      const bodyOnDisk = rec.slice(rec.indexOf("\n--\n") + 4);
      assert.equal(bodyOnDisk, STEER_PREFIX + body, `verbatim record mismatch for [${body}]`);
      assert.equal(bodyOnDisk.slice(STEER_PREFIX.length), body, `content mangled after prefix for [${body}]`);
    }
    const texts = sendCalls(host).map((s) => s.text);
    for (const body of bodies) assert.ok(texts.includes(STEER_PREFIX + body), `steer doorbell missing for [${body}]`);
  } finally {
    await host.harness.lifecycle.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- F5: turn-end guard never abandons — slow floor after budget ----

test("IT F5: turnEndGuard keeps re-ringing at a slow floor after the budget (never abandons)", { skip: !FM_INTEGRATION }, async () => {
  const home = scratchFmHome();
  const host = itHost(home, { turnEndGuard: "re-ring", turnEndGuardBudget: 2 });
  await plugin(host.bb);
  try {
    stubRealExecHost(host);
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ captain: "true" }));
    // a real undrained signal wake so the REAL countUndrainedWakes awk sees pending>0.
    // D6: the count is read from the captain-SCOPED state plane (state/cap-thr_cap).
    const epoch = Math.floor(Date.now() / 1000);
    mkdirSync(join(home, "state", "cap-thr_cap"), { recursive: true });
    writeFileSync(join(home, "state", "cap-thr_cap", ".wake-queue"), `${epoch}\t1\tsignal\tc1.status\tpending\n`);
    const emitCaptainIdle = () =>
      host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: "thr_cap", status: "idle", projectId: "proj_1" }),
        lastAssistantText: "done",
      });
    // budget already spent; lastRingAt old → must STILL re-ring (floor), not abandon
    await host.bb.storage.kv.set("turnend-budget:thr_cap", { count: 5, lastRingAt: 0 });
    let before = sendCalls(host).length;
    await emitCaptainIdle();
    assert.equal(sendCalls(host).length, before + 1, "must re-ring at the slow floor, not abandon");
    // immediately again → within the floor cooldown → NO new ring
    before = sendCalls(host).length;
    await emitCaptainIdle();
    assert.equal(sendCalls(host).length, before, "throttled within the slow floor");
    // queue drained → budget resets to zero
    writeFileSync(join(home, "state", "cap-thr_cap", ".wake-queue"), "");
    await emitCaptainIdle();
    const st = (await host.bb.storage.kv.get("turnend-budget:thr_cap")) as { count?: number };
    assert.equal(st?.count, 0, "budget resets when the queue drains");
  } finally {
    await host.harness.lifecycle.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- re-review: tellOwner steer must not be weaponized by fm-watch ----

test("note: report lines never override the crew's real terminal verb (latestStatus/summary)", () => {
  // A crew's real verb followed by our appended report note: latestStatus must still
  // report `done`, and the summary must not show the note as the crew's state.
  const lines = ["working: building", "done: shipped PR #9", "note: crew c1 update REPORTX"];
  assert.deepEqual(latestStatus(lines), { verb: "done", note: "shipped PR #9" });
  const summary = statusProtocolSummary(lines);
  assert.match(summary ?? "", /state: done/);
  assert.doesNotMatch(summary ?? "", /REPORTX/);
});

test("IT F3b: tellOwner=real acknowledges a normal record after BB confirms delivery", { skip: !FM_INTEGRATION }, async () => {
  const home = scratchFmHome();
  const host = itHost(home, { tellOwner: "real" });
  await plugin(host.bb);
  try {
    stubRealExecHost(host);
    await seedCrew(host);
    const res = await host.harness.behavior.runCli(["tell", "c1", "--message=please rebase"], { projectId: "proj_1" });
    assert.equal(res.exitCode, 0, res.stderr);
    const handled = join(home, "state", "c1.inbox", "handled", "001.msg");
    const rec = readFileSync(handled, "utf8");
    assert.doesNotMatch(rec, /delivery=fire-and-forget/, "ordinary steer must use upstream's normal record");
    assert.ok(!existsSync(join(home, "state", "c1.inbox", "001.msg")), "delivery acknowledgement must move the record to handled/");
    // The REAL ladder sees no unhandled record, so it stays quiet.
    const due = spawnSync(
      "bash",
      ["-c", `export FM_HOME=${home} FM_ROOT=${home} FM_TASK_INBOX_GRACE_SECS=0; . ${home}/bin/fm-task-inbox-lib.sh; fm_task_inbox_due_action ${home}/state c1`],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal((due.stdout ?? "").trim(), "quiet", `due_action must be quiet, got: ${due.stdout} / ${due.stderr}`);
  } finally {
    await host.harness.lifecycle.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

// --- crew-watch abort-awareness (backlog 4c1b0ea5) ------------------------------
// The live incident: `bb plugin reload firstmate` failed repeatedly with "service
// crew-watch did not stop" while a stuckPass was in flight over a host-global crew
// register (~50-67 crews), pinning the plugin DEGRADED and `bb firstmate` UNAVAILABLE to
// every captain on the host. Root cause: the crew-watch loop checked signal.aborted between
// cycles and its sleep was abortable, but `await stuckPass()` had NO abort awareness inside.
// These tests prove the pass now stops within the shutdown grace on the FIRST attempt, and
// mutation-prove each load-bearing abort check.

// Each test below uses an inline hand-resolved barrier (two bare promises: one tripped when
// the stub is entered, one the test resolves to release it) so a reload can be triggered
// deterministically while a specific host read is in flight — no timers, so nothing dangles
// at process exit.

test("ACCEPTANCE: a reload mid slow stuckPass stops crew-watch within the grace, on the first attempt, repeatedly", async () => {
  const host = await load();
  try {
    const N = 40;
    const crews = [];
    for (let i = 0; i < N; i++) crews.push(crewRow(`c${i}`, `thr_${i}`, "thr_cap"));
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.bb.storage.kv.set("crews", crews);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.output", async () => ({ output: "same" }));
    host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: Date.now() }]);
    let slow = true;
    // A deliberately slow per-crew host read: one uninterrupted pass is 40 * 150ms = ~6s,
    // far past the grace we assert. crewStatus (threads.get) is the read exercised on every
    // crew, including the rebase path, so this makes the WHOLE pass slow.
    host.harness.sdk.stub("threads.get", async () => {
      if (slow) await new Promise((r) => setTimeout(r, 150));
      return makeThreadResponse({ status: "active", environmentId: null });
    });
    const GRACE_MS = 1500;
    for (let round = 0; round < 5; round++) {
      await host.bb.storage.kv.set("watch-meta", { lastPassAt: Date.now(), checked: -1, notified: -1, cursor: 0 });
      const base = host.harness.sdk.callsTo("threads.get").length;
      const run = host.harness.behavior.runService("crew-watch");
      const waitUntil = Date.now() + 5000;
      // Wait until the pass is genuinely mid-flight (several crews inspected) before reloading.
      while (host.harness.sdk.callsTo("threads.get").length < base + 4 && Date.now() < waitUntil) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(
        host.harness.sdk.callsTo("threads.get").length >= base + 3,
        `round ${round}: slow pass never got mid-flight`,
      );
      const t0 = Date.now();
      run.controller.abort();
      // awaitWithin turns a would-be wedge (the loop tail-sleep entered post-abort) into a
      // prompt assertion instead of hanging the suite — the mutation that removes the sleep
      // guard makes THIS line fail red rather than time out the whole run.
      await awaitWithin(run.done, GRACE_MS, `round ${round}: crew-watch did not stop within ${GRACE_MS}ms`);
      const stopMs = Date.now() - t0;
      assert.ok(stopMs < GRACE_MS, `round ${round}: crew-watch took ${stopMs}ms to stop (grace ${GRACE_MS}ms)`);
    }
    // The plugin is not wedged after the aborted reloads: a clean pass completes normally.
    slow = false;
    const meta = await runStuckOnce(host);
    assert.equal(meta.checked, N, "a clean pass after the reloads still inspects every crew");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("ABORT WIRING (post-crewStatus): a reload while reading a crew's status fires no spurious captain page", async () => {
  const host = await load();
  try {
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_1", "thr_cap")]);
    // prev present and NOT alerted-unknown: a degraded "unknown" status WOULD page the captain.
    await host.bb.storage.kv.set("watch", { c1: { status: "active", hash: "h", at: Date.now(), stuck: false } });
    await host.bb.storage.kv.set("watch-meta", { lastPassAt: Date.now(), checked: -1, notified: -1, cursor: 0 });
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.output", async () => ({ output: "h" }));
    host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: Date.now() }]);
    let enter!: () => void;
    let unblock!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    const blocked = new Promise<void>((r) => (unblock = r));
    host.harness.sdk.stub("threads.get", async () => {
      enter();
      await blocked; // hold crewStatus in flight; abort (via the passed signal) interrupts the await
      return makeThreadResponse({ status: "error", environmentId: null });
    });
    const run = host.harness.behavior.runService("crew-watch");
    await entered; // deterministic: abort exactly while crewStatus is in flight
    run.controller.abort();
    await run.done;
    assert.equal(sendCalls(host).length, 0, "a reload mid status-read must not page the captain");
    unblock();
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("ABORT WIRING (post-crewExcerpt): a reload while reading a crew's output fires no spurious captain page", async () => {
  const host = await load();
  try {
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_1", "thr_cap")]);
    // lastPassAt recent → no rebase, so the pass reaches the excerpt read; prev not
    // alerted-unknown so a degraded excerpt (ok:false) WOULD page "unknown".
    await host.bb.storage.kv.set("watch", { c1: { status: "active", hash: "h", at: Date.now(), stuck: false } });
    await host.bb.storage.kv.set("watch-meta", { lastPassAt: Date.now(), checked: -1, notified: -1, cursor: 0 });
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
    host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: Date.now() }]);
    let enter!: () => void;
    let unblock!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    const blocked = new Promise<void>((r) => (unblock = r));
    host.harness.sdk.stub("threads.output", async () => {
      enter();
      await blocked;
      return { output: "different-so-would-not-page-normally" };
    });
    const run = host.harness.behavior.runService("crew-watch");
    await entered;
    run.controller.abort();
    await run.done;
    assert.equal(sendCalls(host).length, 0, "a reload mid output-read must not page the captain");
    unblock();
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("ABORT WIRING (post-suppress): a reload while resolving a crew's host fires no spurious stuck page", async () => {
  const host = await load();
  try {
    // watchOwner=fm-watch makes the stuck path consult suppressForCrew → resolveHostForProject.
    await host.harness.behavior.setSettings({
      supervisionEnabled: true,
      watchOwner: "fm-watch",
      fmHome: "/tmp/fm-home-abort",
    });
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_1", "thr_cap")]);
    const staleAt = Date.now() - 40 * 60_000; // older than the 30m stuck window
    await host.bb.storage.kv.set("watch", { c1: { status: "active", hash: "h", at: staleAt, stuck: false } });
    await host.bb.storage.kv.set("watch-meta", { lastPassAt: Date.now(), checked: -1, notified: -1, cursor: 0 });
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.send", async () => ({}));
    // environmentId null → resolveHostForProject skips environments.get and blocks on list.
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
    host.harness.sdk.stub("threads.output", async () => ({ output: "h" })); // === prev.hash → stalled
    host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: staleAt }]); // stale activity
    let enter!: () => void;
    let unblock!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    const blocked = new Promise<void>((r) => (unblock = r));
    host.harness.sdk.stub("environments.list", async () => {
      enter();
      await blocked;
      return [];
    });
    const run = host.harness.behavior.runService("crew-watch");
    await entered;
    run.controller.abort();
    await run.done;
    assert.equal(sendCalls(host).length, 0, "a reload mid host-resolve must not fire a stuck page");
    unblock();
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Reject if `p` has not settled within `ms` — turns a would-be hang (a service that did not
// stop) into a prompt, legible assertion failure instead of a whole-suite timeout.
async function awaitWithin<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("ACCEPTANCE (prologue): a reload while listCrewsAll is in flight stops crew-watch within the grace, repeatedly", async () => {
  const host = await load();
  try {
    const crews = [];
    for (let i = 0; i < 10; i++) crews.push(crewRow(`c${i}`, `thr_${i}`, "thr_cap"));
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.bb.storage.kv.set("crews", crews);
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
    host.harness.sdk.stub("threads.output", async () => ({ output: "same" }));
    host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: Date.now() }]);
    // The PROLOGUE host sweep (listCrewsAll -> threads.list) is blocked mid-flight; without an
    // abort-aware prologue this pins crew-watch exactly like the original incident.
    let enter!: () => void;
    let unblock!: () => void;
    host.harness.sdk.stub("threads.list", async () => {
      enter();
      await new Promise<void>((r) => (unblock = r));
      return [];
    });
    const GRACE_MS = 1500;
    for (let round = 0; round < 5; round++) {
      await host.bb.storage.kv.set("watch-meta", { lastPassAt: Date.now(), checked: -1, notified: -1, cursor: 0 });
      const entered = new Promise<void>((r) => (enter = r));
      const run = host.harness.behavior.runService("crew-watch");
      await entered; // deterministic: reload exactly while the prologue sweep is in flight
      const t0 = Date.now();
      run.controller.abort();
      await awaitWithin(run.done, GRACE_MS, `round ${round}: a reload during the prologue did not stop crew-watch within ${GRACE_MS}ms`);
      const stopMs = Date.now() - t0;
      assert.ok(stopMs < GRACE_MS, `round ${round}: crew-watch took ${stopMs}ms to stop (grace ${GRACE_MS}ms)`);
      assert.equal(sendCalls(host).length, 0, `round ${round}: a reload during the prologue must not page the captain`);
      unblock(); // release the abandoned prologue sweep so nothing dangles
    }
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("ABORT WIRING (notify): a reload during a stuck-page send stops within grace and DEFERS the page (never dropped)", async () => {
  const host = await load();
  try {
    await host.harness.behavior.setSettings({ supervisionEnabled: true });
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_1", "thr_cap")]);
    const staleAt = Date.now() - 40 * 60_000; // past the 30m stuck window
    await host.bb.storage.kv.set("watch", { c1: { status: "active", hash: "h", at: staleAt, stuck: false } });
    await host.bb.storage.kv.set("watch-meta", { lastPassAt: Date.now(), checked: -1, notified: -1, cursor: 0 });
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
    host.harness.sdk.stub("threads.output", async () => ({ output: "h" })); // === prev.hash → stalled
    host.harness.sdk.stub("threads.events.list", async () => [{ createdAt: staleAt }]); // stale activity → stuck
    // The captain-page SEND is the last await inside the loop; block it mid-flight and reload.
    let enter!: () => void;
    let unblock!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    host.harness.sdk.stub("threads.send", async () => {
      enter();
      await new Promise<void>((r) => (unblock = r));
      return {};
    });
    const run = host.harness.behavior.runService("crew-watch");
    await entered;
    const t0 = Date.now();
    run.controller.abort();
    await awaitWithin(run.done, 1500, "a reload during a stuck-page send did not stop crew-watch within 1500ms");
    assert.ok(Date.now() - t0 < 1500, "the send must not pin the service on a reload");
    // DEFER, not drop: the crew's stuck flag was NOT committed, so the next pass re-pages.
    const watch = (await host.bb.storage.kv.get("watch")) as Record<string, { stuck: boolean; at: number }>;
    assert.equal(watch["c1"]?.stuck, false, "an aborted stuck-page must be deferred (not committed), so it re-pages next pass");
    assert.equal(watch["c1"]?.at, staleAt, "the crew's stuck clock must not be reset by the aborted pass");
    unblock();
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("ACCEPTANCE (fm-watch-supervisor): a reload during a keeper relaunch-write stops the sibling service within the grace", async () => {
  // Covers BOTH the fourth wedge (superviseFmWatch's keeper WRITE ran without the signal, so a
  // reload waited out runHostCommand's 15s deadline) AND the fm-watch-supervisor sleep guard
  // (a sleep entered post-abort would wait out its ~30s interval). Either revert makes this red.
  const host = createFakePluginHost({
    pluginId: "firstmate",
    agentSkillIds: SKILLS,
    settings: { watchOwner: "fm-watch", fmHome: "/tmp/fm-home", fmHostId: "host_1" },
  });
  await plugin(host.bb);
  try {
    let writeStarted = false;
    let seq = 0;
    const cmds = new Map<string, string>();
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
      const cmd = args.start?.command ?? "";
      const id = `term_${seq++}`;
      cmds.set(id, cmd);
      if (cmd.includes(".fm-b64-")) writeStarted = true; // a keeper-script WRITE chunk is in flight
      return { id };
    });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
      const cmd = cmds.get(args.terminalId) ?? "";
      // The keeper-liveness READ completes reporting a DEAD keeper with the arm present, so the
      // supervisor proceeds to relaunch (write the keeper script).
      if (cmd.includes("FM_BEAT_AGE")) {
        return hostOutput("FM_OWNER_BEAT=ok\nFM_BEAT_AGE=999\nFM_KEEPER=dead\n---FM_LOGTAIL---\n");
      }
      // Every other command (the keeper-script write chunks) never returns an RC — it blocks,
      // so only an abort can end it.
      return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from("\nrunning\n").toString("base64") }] };
    });
    host.harness.sdk.stub("terminals.close", async () => ({}));
    const run = host.harness.behavior.runService("fm-watch-supervisor");
    const waitUntil = Date.now() + 5000;
    while (!writeStarted && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 5));
    assert.ok(writeStarted, "the supervisor never reached the keeper relaunch-write");
    const t0 = Date.now();
    run.controller.abort();
    await awaitWithin(run.done, 2000, "a reload during the keeper relaunch-write did not stop fm-watch-supervisor within 2000ms");
    assert.ok(Date.now() - t0 < 2000, "fm-watch-supervisor must stop within the grace on a reload");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
