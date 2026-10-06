import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { fmWatchKeeperScript } from "./server.ts";
import { createDispatchJobs } from "./lib/async-dispatch.ts";
import { createLaunches } from "./lib/launch.ts";
import { createInboundLedger } from "./lib/inbound-ledger.ts";
import { parseInboundTelegram } from "./lib/telegram-envelope.ts";

type Host = ReturnType<typeof createFakePluginHost>;
const SKILLS = ["captain", "firstmate"];
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

async function load(settings: Record<string, unknown> = {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings });
  await plugin(host.bb);
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

const sentTo = (host: Host, threadId: string) => host.harness.sdk.callsTo("threads.send")
  .map((c) => c[0] as { threadId: string; input: Array<{ text: string }> })
  .filter((a) => a.threadId === threadId)
  .map((a) => a.input.map((b) => b.text).join("\n"));

function hostRc(payload: string, code = 0) {
  return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${payload}\n__FM_HOST_RC:${code}\n`).toString("base64") }] };
}

function hostCommands(host: Host, answer: (command: string) => string) {
  const commands = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
    const id = `t_${++n}`;
    commands.set(id, args.start?.command ?? "");
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => hostRc(answer(commands.get(args.terminalId) ?? "")));
  return commands;
}

async function until(check: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition not reached in time");
}

async function runServiceUntil(host: Host, name: string, check: () => boolean | Promise<boolean>) {
  const run = host.harness.behavior.runService(name);
  const deadline = Date.now() + 4000;
  let hit = false;
  while (!(hit = await check()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  run.controller.abort();
  await run.done;
  return hit;
}

// B1: the watcher poll output carries the keeper log tail after ---FM_LOGTAIL---.

test("the watcher poll ignores an old stale-mirror line in the keeper log tail", async () => {
  const host = await load({ fmHome: "/tmp/fm-home", watchOwner: "fm-watch", fmHostId: "host_1", watchHeartbeatSec: 30 });
  try {
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ status: "active", environmentId: null }));
    hostCommands(host, (cmd) => cmd.includes("FM_BEAT_AGE")
      ? "FM_OWNER_BEAT=ok\nFM_BEAT_AGE=5\nFM_KEEPER=alive\n---FM_LOGTAIL---\nFM_MIRROR_STALE: BB transport payloads stale/missing: backends/bb.sh\nwatcher: attached pid=1 (beacon 4s)"
      : "");
    const polled = await runServiceUntil(host, "fm-watch-supervisor", async () => (await host.bb.storage.kv.get("fm-watch-beat:host_1")) != null);
    assert.equal(polled, true);
    assert.deepEqual(logs(host, "error", /STALE/), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a stale mirror is logged once per state change, not on every script run", async () => {
  const host = await load({ fmHome: "/tmp/fm-home", fmHostId: "host_1" });
  try {
    let stale = true;
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", environmentId: "env_cap" }));
    host.harness.sdk.stub("environments.get", async () => ({ id: "env_cap", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }));
    hostCommands(host, () => (stale ? "FM_MIRROR_STALE: bb mirror built at aaa but HEAD is bbb\n" : "") + "status ok");
    const run = () => tool(host, "firstmate_fm").execute({ script: "status" }, { threadId: "thr_cap", projectId: "proj_1" } as never);
    await run();
    await run();
    await run();
    assert.equal(logs(host, "error", /STALE/).length, 1);
    stale = false;
    await run();
    await run();
    assert.equal(logs(host, "info", /no longer stale/).length, 1);
    stale = true;
    await run();
    assert.equal(logs(host, "error", /STALE/).length, 2);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// B2: background retry loops reach a terminal "needs captain" state.

function commonStubs(host: Host) {
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
    makeThreadResponse({ id: threadId, projectId: "proj_1", status: "idle", environmentId: "env_wt" }));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.queuedMessages.list", async () => []);
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_wt", hostId: "host_1", status: "ready", isWorktree: true, path: "/wt" }));
}

function uncertainLaunch(host: Host) {
  createLaunches(host.bb.storage.database()).save({
    key: JSON.stringify(["proj_1", "thr_cap", "", "4b4adda5", 1]), taskId: "4b4adda5", projectId: "proj_1", owner: "thr_cap", home: "",
    generation: 1, shape: "ship", deliveryMode: "direct-PR", deliveryRequirement: "merged", state: "uncertain", threadId: null, updatedAt: T0,
  });
}

test("an uncertain launch logs once, backs off, then needs the captain once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const host = await load();
  try {
    commonStubs(host);
    uncertainLaunch(host);
    let now = T0;
    for (let pass = 0; pass < 12; pass++) {
      await host.harness.behavior.runSchedule("pr-delivery-follow-up");
      now += 31 * MINUTE;
      t.mock.timers.setTime(now);
    }
    assert.equal(logs(host, "warn", /remains uncertain/).length, 1);
    assert.equal(logs(host, "warn", /Needs captain: Launch 4b4adda5/).length, 1);
    const notices = sentTo(host, "thr_cap").filter((s) => /Needs captain/.test(s));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /Launch 4b4adda5 .*remains uncertain/);
    assert.equal(createLaunches(host.bb.storage.database()).list()[0]!.state, "uncertain");
    const bearings = await host.harness.behavior.runCli(["bearings"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.match(bearings.stdout, /Needs captain: Launch 4b4adda5 \(8 attempts\)/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a crew whose PR discovery keeps failing stops polling after the bound", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const host = await load();
  try {
    commonStubs(host);
    await host.bb.storage.kv.set("crews", [{
      id: "c1", task: "fix login", projectId: "proj_1", threadId: "thr_c1", parentThreadId: "thr_cap", providerId: null, model: null,
      reasoningLevel: null, worktree: true, shape: "ship", posture: "direct-PR", createdAt: "2026-09-18T00:00:00.000Z",
    }]);
    let lists = 0;
    host.harness.sdk.stub("environments.get", async () => { throw new Error("environment read failed"); });
    host.harness.sdk.stub("environments.list", async () => { lists++; throw new Error("HTTP 503: environments unavailable"); });
    let now = T0;
    for (let pass = 0; pass < 12; pass++) {
      await host.harness.behavior.runSchedule("pr-delivery-follow-up");
      now += 31 * MINUTE;
      t.mock.timers.setTime(now);
    }
    assert.equal(logs(host, "warn", /PR discovery c1/).length, 1);
    assert.equal(lists, 8);
    assert.equal(sentTo(host, "thr_cap").filter((s) => /Needs captain: PR discovery for crew c1/.test(s)).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a refused landed-crew cleanup reports the refusal without advisory banners and stops after the bound", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const host = await load();
  try {
    await host.bb.storage.kv.set("crews", [{
      id: "c1", task: "fix login", projectId: "proj_1", threadId: "thr_crew", parentThreadId: "thr_cap", providerId: null, model: null,
      reasoningLevel: null, worktree: true, shape: "ship", posture: "direct-PR", createdAt: "2026-09-18T00:00:00.000Z",
    }]);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.events.list", async () => []);
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", environmentId: "env_wt" }));
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
    host.harness.sdk.stub("threads.output", async () => ({ output: "DONE: shipped" }));
    host.harness.sdk.stub("threads.stop", async () => {
      throw new Error("WARNING: watcher still down (same stale episode; last beat: 371824s ago, grace 300s)\nWARNING: queued wakes pending - drain them with bin/fm-wake-drain.sh before anything else.\nREFUSED: worktree has uncommitted changes");
    });
    host.harness.sdk.stub("environments.pullRequest", async () => ({
      outcome: "available",
      pullRequest: {
        url: "https://github.com/o/r/pull/1", number: 1, title: "t", state: "merged",
        checks: { state: "passing", failedCount: 0, pendingCount: 0, passedCount: 1 },
        mergeability: { mergeable: "MERGEABLE" },
      },
    }));
    let now = T0;
    let last = "";
    for (let pass = 0; pass < 12; pass++) {
      last = (await host.harness.behavior.runCli(["bearings"])).stdout;
      now += 31 * MINUTE;
      t.mock.timers.setTime(now);
    }
    assert.equal(host.harness.sdk.callsTo("threads.stop").length, 8);
    assert.deepEqual(logs(host, "warn", /landed crew retire refused/), [
      "landed crew retire refused crew=c1 pr=https://github.com/o/r/pull/1 (crew kept, attempt 1): REFUSED: worktree has uncommitted changes",
    ]);
    assert.match(last, /Needs captain: Cleanup of landed crew c1 \(8 attempts\): REFUSED: worktree has uncommitted changes/);
    assert.equal(((await host.bb.storage.kv.get("crews")) as unknown[]).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// B3: the keeper script, run for real against a temporary home.

function keeperHome(armBody: string) {
  const home = mkdtempSync(join(tmpdir(), "fm-keeper-"));
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "state"));
  writeFileSync(join(home, "bin", "fm-watch-arm.sh"), `#!/bin/bash\n${armBody}\n`);
  chmodSync(join(home, "bin", "fm-watch-arm.sh"), 0o755);
  writeFileSync(join(home, "state", ".bb-watch-owner.beat"), `${Math.floor(Date.now() / 1000)}\n`);
  writeFileSync(join(home, "state", ".bb-watch-keeper.sh"), fmWatchKeeperScript("host_1", home, 0.1));
  return home;
}

const keepers: ChildProcess[] = [];
function startKeeper(home: string): ChildProcess {
  const child = spawn("bash", [join(home, "state", ".bb-watch-keeper.sh")], { stdio: "ignore", detached: true });
  child.unref();
  keepers.push(child);
  return child;
}
test.afterEach(() => {
  for (const child of keepers.splice(0)) {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
  }
});

const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
  else child.once("exit", (code) => resolve(code));
});

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
}

test("the keeper trims its watch log to a bounded size and keeps the newest lines", async () => {
  const home = keeperHome('echo "armed $(date +%s%N)"');
  const log = join(home, "state", ".bb-watch-arm.log");
  try {
    writeFileSync(log, `${"old line\n".repeat(400_000)}NEWEST-BEFORE-TRIM\n`);
    const keeper = startKeeper(home);
    await until(() => /armed/.test(readFileSync(log, "utf8")), 5000);
    rmSync(join(home, "state", ".bb-watch-keeper.pid"), { force: true });
    assert.notEqual(await withTimeout(exited(keeper), 5000), "timeout");
    const kept = readFileSync(log, "utf8");
    assert.ok(statSync(log).size <= 262_144 + 4096, `log is ${statSync(log).size} bytes`);
    assert.match(kept, /NEWEST-BEFORE-TRIM\n/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the keeper stops a blocked re-arm when its owner beat goes stale", async () => {
  const home = keeperHome('echo $$ > "$FM_HOME/state/arm.pid"; sleep 60');
  try {
    const keeper = startKeeper(home);
    await until(() => existsSync(join(home, "state", "arm.pid")), 5000);
    const arm = Number(readFileSync(join(home, "state", "arm.pid"), "utf8"));
    writeFileSync(join(home, "state", ".bb-watch-owner.beat"), "1\n");
    assert.notEqual(await withTimeout(exited(keeper), 5000), "timeout");
    await until(() => !alive(arm), 3000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a replaced keeper stops its own re-arm and leaves the successor's pidfile", async () => {
  const home = keeperHome('echo $$ > "$FM_HOME/state/arm.pid"; sleep 60');
  const pidfile = join(home, "state", ".bb-watch-keeper.pid");
  try {
    const keeper = startKeeper(home);
    await until(() => existsSync(join(home, "state", "arm.pid")), 5000);
    const arm = Number(readFileSync(join(home, "state", "arm.pid"), "utf8"));
    writeFileSync(pidfile, "424242\n");
    assert.notEqual(await withTimeout(exited(keeper), 5000), "timeout");
    await until(() => !alive(arm), 3000);
    assert.equal(readFileSync(pidfile, "utf8"), "424242\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a terminated keeper also stops its blocked re-arm", async () => {
  const home = keeperHome('echo $$ > "$FM_HOME/state/arm.pid"; sleep 60');
  try {
    const keeper = startKeeper(home);
    await until(() => existsSync(join(home, "state", "arm.pid")), 5000);
    const arm = Number(readFileSync(join(home, "state", "arm.pid"), "utf8"));
    process.kill(keeper.pid!, "SIGTERM");
    assert.notEqual(await withTimeout(exited(keeper), 5000), "timeout");
    await until(() => !alive(arm), 3000);
    assert.equal(existsSync(join(home, "state", ".bb-watch-keeper.pid")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a deleted captain's home stops its keeper and is not re-logged after a reload", async () => {
  let host = await load({ watchOwner: "fm-watch" });
  const stubs = (h: Host, gets: string[]) => {
    h.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      gets.push(threadId);
      if (threadId === "thr_gone") throw new Error("HTTP 404: Thread not found");
      return makeThreadResponse({ id: threadId, status: "idle", archivedAt: "2026-10-01T00:00:00.000Z" } as never);
    });
    return hostCommands(h, () => "");
  };
  try {
    await host.bb.storage.kv.set("native-home:thr_gone", "/tmp/home-gone");
    await host.bb.storage.kv.set("native-home-host:thr_gone", "host_1");
    await host.bb.storage.kv.set("native-home:thr_old", "/tmp/home-old");
    await host.bb.storage.kv.set("native-home-host:thr_old", "host_1");
    let gets: string[] = [];
    let commands = stubs(host, gets);
    const stoppedHome = (cmds: Map<string, string>, home: string) =>
      [...cmds.values()].some((c) => c.includes(`${home}/state/.bb-watch-keeper.pid`) && c.includes("rm -f"));
    assert.equal(await runServiceUntil(host, "captain-home-watch", () => stoppedHome(commands, "/tmp/home-gone") && stoppedHome(commands, "/tmp/home-old")), true);
    assert.equal(logs(host, "info", /thr_gone: thread deleted/).length, 1);

    host = await host.harness.lifecycle.reload(plugin);
    gets = [];
    commands = stubs(host, gets);
    assert.equal(await runServiceUntil(host, "captain-home-watch", () => stoppedHome(commands, "/tmp/home-old")), true);
    assert.deepEqual(gets.filter((id) => id === "thr_gone"), []);
    assert.deepEqual(logs(host, "info", /thr_gone/), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// B4: async dispatch resumes after a reload and honours the provider reset time.

function stubSpawn(host: Host, limited: () => boolean, resetsAt: number) {
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_new" }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "starting" }));
  host.harness.sdk.stub("threads.events.list", async () => limited()
    ? [{ type: "provider/rateLimits/updated", createdAt: T0 - MINUTE, data: { rateLimits: { status: "blocked", windows: [{ status: "blocked", resetsAtMs: resetsAt }] } } }]
    : []);
}

test("a rate-limited async dispatch waits for the provider reset and spawns once after a reload", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const resetsAt = T0 + 5 * MINUTE;
  let limited = true;
  let host = await load({ fmReliability: JSON.stringify({ asyncDispatch: "on" }) });
  try {
    stubSpawn(host, () => limited, resetsAt);
    const reserved = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1", taskId: "job1" }, { projectId: "proj_1", threadId: "thr_cap" } as never);
    assert.match(text(reserved), /Reserved crew job1/);
    await until(() => createDispatchJobs(host.bb.storage.database()).get("job1")?.backoffUntil != null);
    assert.equal(createDispatchJobs(host.bb.storage.database()).get("job1")?.backoffUntil, resetsAt);

    host = await host.harness.lifecycle.reload(plugin);
    stubSpawn(host, () => limited, resetsAt);
    limited = false;
    t.mock.timers.setTime(resetsAt + MINUTE);
    await host.harness.behavior.runSchedule("pr-delivery-follow-up");
    await until(() => createDispatchJobs(host.bb.storage.database()).get("job1")?.state === "started");
    await host.harness.behavior.runSchedule("pr-delivery-follow-up");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a dispatch job interrupted after its worker spawned is not spawned again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  let host = await load({ fmReliability: JSON.stringify({ asyncDispatch: "on" }) });
  try {
    stubSpawn(host, () => false, T0);
    await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1", taskId: "job2" }, { projectId: "proj_1", threadId: "thr_cap" } as never);
    await until(() => createDispatchJobs(host.bb.storage.database()).get("job2")?.state === "started");
    const jobs = createDispatchJobs(host.bb.storage.database());
    jobs.save({ ...jobs.get("job2")!, state: "spawning" });

    host = await host.harness.lifecycle.reload(plugin);
    stubSpawn(host, () => false, T0);
    await host.harness.behavior.runSchedule("pr-delivery-follow-up");
    await until(() => createDispatchJobs(host.bb.storage.database()).get("job2")?.state === "started");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// D3: telegram.reply reports the bridge's threading mode.

function recordTelegram(host: Host, messageId: string) {
  const body = readFileSync(new URL("./test/fixtures/envelopes/live-owner.txt", import.meta.url), "utf8")
    .replace("telegram_message_id: 1669", `telegram_message_id: ${messageId}`);
  createInboundLedger(host.bb.storage.database()).record({
    captainThreadId: "thr_cap", text: body, receivedAt: 1_000, bbThreadId: "thr_cap", initiator: "user", telegram: parseInboundTelegram(body),
  });
}

test("a threading mismatch with the Telegram bridge warns once and shows in bearings until it clears", async () => {
  const host = await load({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on" }) });
  try {
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }));
    let mode = "off";
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode }));
    const reply = (ref: string) => tool(host, "firstmate_reply").execute({ ref, text: "Done." }, { threadId: "thr_cap", projectId: "proj_1" } as never);
    for (const id of ["1669", "1670", "1671"]) recordTelegram(host, id);
    await reply("tg:200:1669");
    await reply("tg:200:1670");
    assert.equal(logs(host, "warn", /threaded replies/).length, 1);
    const during = await host.harness.behavior.runCli(["bearings"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.match(during.stdout, /Needs captain: Telegram threaded replies are off in the Telegram connector/);
    mode = "on";
    await reply("tg:200:1671");
    assert.equal(logs(host, "info", /threaded replies .*match/).length, 1);
    const after = await host.harness.behavior.runCli(["bearings"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.doesNotMatch(after.stdout, /Telegram threaded replies/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
