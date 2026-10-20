import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";
import plugin from "./server.ts";
import { createLaunches } from "./lib/launch.ts";
import { createOwnerPromises } from "./lib/owner-promises.ts";

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
  await host.bb.storage.kv.set('captain-project:thr_cap','proj_1');
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

test('verify180: next captain turn restarts a stopped watcher', async () => {
 const host=await load();
 try {
  await bindHome(host);stubCaptain(host,'idle');
  const commands=hostCommands(host,cmd=>answerHost(cmd,()=> 'none'));
  assert.equal(await runWatchUntil(host,()=>commands.some(isStopCommand)),true);
  await host.harness.behavior.emitThreadEvent('thread.active',{thread:makeThreadResponse({id:CAPTAIN,status:'active',projectId:'proj_1'})});
  assert.ok(commands.some(isSuperviseCommand));
  assert.match(logs(host,'info',/watcher restarted/).join('\n'),/captain turn/);
 } finally {await host.harness.lifecycle.dispose();}
});

test('verify180: cold reload restarts a durably stopped home for a queued wake',async()=>{
 const host=await load();
 try {
  await bindHome(host);stubCaptain(host,'idle');
  await host.bb.storage.kv.set(`captain-watch-stopped:${CAPTAIN}`,true);
  const commands=hostCommands(host,cmd=>answerHost(cmd,()=> 'wake-queue'));
  assert.equal(await runWatchUntil(host,()=>commands.some(isSuperviseCommand)),true);
  assert.equal(commands.some(isStopCommand),false);
  assert.equal(await host.bb.storage.kv.get(`captain-watch-stopped:${CAPTAIN}`),undefined);
 } finally {await host.harness.lifecycle.dispose();}
});

test('verify180: external wake survives a stopped watcher and is found after cache expiry',async()=>{
 const host=await load();const clock=Date.now;
 try {
  await bindHome(host);stubCaptain(host,'idle');
  let source='none';const commands=hostCommands(host,cmd=>answerHost(cmd,()=>source));
  assert.equal(await runWatchUntil(host,()=>commands.some(isStopCommand)),true);
  const probes=commands.filter(isSourceProbe).length;
  source='wake-queue';Date.now=()=>clock()+601000;
  assert.equal(await runWatchUntil(host,()=>commands.some(isSuperviseCommand)),true);
  assert.ok(commands.filter(isSourceProbe).length>probes);
  assert.match(logs(host,'info',/watcher restarted/).join('\n'),/queued wake/);
 } finally {Date.now=clock;await host.harness.lifecycle.dispose();}
});

test('verify180: away-only captain loses watcher but due promise still sends exactly one wake',async()=>{
 const host=await load();
 try {
  await bindHome(host);stubCaptain(host,'idle');
  await host.bb.storage.kv.set('afk:cap-thr_cap',{on:true,words:'away',since:new Date().toISOString(),held:[]});
  const commands=hostCommands(host,cmd=>answerHost(cmd,()=> 'none'));
  assert.equal(await runWatchUntil(host,()=>commands.some(isStopCommand)),true);
  createOwnerPromises(host.bb.storage.database()).add({captain:CAPTAIN,by:Date.now()-1000,what:'Verify reminder',ref:null,task:null,source:'reply',at:Date.now()-2000});
  const wakes:unknown[]=[];
  host.harness.sdk.stub('threads.send',async(args:unknown)=>{wakes.push(args);return {};});
  for(let pass=0;pass<2;pass++) {
   const run=host.harness.behavior.runService('captain-wake-release');
   await new Promise(resolve=>setTimeout(resolve,200));
   run.controller.abort();await run.done;
  }
  assert.equal(wakes.filter(wake=>JSON.stringify(wake).includes('Promise P1 is due')).length,1);
  assert.equal(commands.some(isSuperviseCommand),false);
 } finally {await host.harness.lifecycle.dispose();}
});

