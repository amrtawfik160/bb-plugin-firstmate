import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
    if(state.spawnCreateError && (args.start?.command ?? "").includes("fm-spawn.sh") && !(args.start?.command ?? "").includes("native_command=")) throw state.spawnCreateError;
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const cmd = cmds.get(args.terminalId) ?? "";
    if (cmd.includes("fm-project-mode.sh")) return hostRc("direct-PR off");
    if (cmd.includes("fm-spawn.sh") && !cmd.includes("native_command=")) {
      state.spawned++;
      if (state.onSpawn) await state.onSpawn();
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
  const key = launchKey(ctx.projectId, ctx.threadId, String(patch.home ?? HOME), TASK);
  launchStore(host).save({
    key, taskId: TASK, projectId: ctx.projectId, owner: ctx.threadId, home: HOME,
    generation: 1, shape: "ship", deliveryMode: "direct-PR", deliveryRequirement: "merged",
    state: "uncertain", threadId: null, nativeInvoked: true, hostId: "host_1", updatedAt: Date.now(),
    ...patch,
  } as never);
  return key;
}


async function finishRelease(t, host, until) {
 t.mock.timers.enable({apis:["setTimeout","Date"],now:Date.now()});
 const pending=host.harness.behavior.runCli(["launches","release",TASK],ctx);
 for(let i=0;i<20000 && !until();i++) await Promise.resolve();
 assert.ok(until());
 for(let i=0;i<3000;i++) await Promise.resolve();
 t.mock.timers.tick(30_000);
 return pending;
}
test("probe: legacy worker beyond bounded inventory is wrongly released", async t=>{
 const {host}=await realCaptain();
 try {
  const key=seedUncertain(host,{updatedAt:1});let reads=0;
  host.harness.sdk.stub("threads.list",async ({offset})=>{
   reads++;
   return Array.from({length:50},(_,i)=>makeThreadResponse({id:offset+i===500?"thr_existing_worker":`other_${offset+i}`,projectId:ctx.projectId,parentThreadId:ctx.threadId}));
  });
  host.harness.sdk.stub("threads.getPluginMetadata",async ({threadId})=>threadId===ctx.threadId?{captain:"true"}:threadId==="thr_existing_worker"?{launchKey:key,generation:1,nativeHome:HOME}:{});
  const result=await finishRelease(t,host,()=>reads===11);
  assert.equal(result.exitCode,1,result.stderr);
  assert.equal(launchStore(host).get(key).state,"uncertain");
  assert.match(result.stderr,/thread|inventory|limit|worker/);
  console.log("CONFIRMED: existing worker at offset 500; release refuses a truncated inventory");
 }finally{t.mock.timers.reset();await host.harness.lifecycle.dispose();}
});
test("probe: state changes during second discovery get overwritten",async t=>{
 const {host}=await realCaptain();
 try{
  const key=seedUncertain(host,{updatedAt:1});let reads=0;
  host.harness.sdk.stub("threads.list",async()=>{reads++;if(reads===2)launchStore(host).update(key,{threadId:"thr_existing_worker",state:"provisioning"});return [];});
  const result=await finishRelease(t,host,()=>reads===1);
  assert.equal(result.exitCode,1,result.stderr);
  const r=launchStore(host).get(key);
  assert.equal(r.state,"provisioning");assert.equal(r.threadId,"thr_existing_worker");
  const store=launchStore(host);
  const held=await store.reserve({...r,state:"reserved",threadId:null,creationRequested:undefined},async()=>({cap:10,activeTaskIds:[]}));
  assert.equal(held.state,"provisioning");
  const duplicate=await store.create(key,async()=>({id:"thr_duplicate_worker"}));
  assert.equal(duplicate.threadId,"thr_existing_worker");
  assert.equal(store.get(key).threadId,"thr_existing_worker");
  console.log("CONFIRMED: threadId written during second discovery; release leaves provisioning and same-key retry cannot create thr_duplicate_worker");
 }finally{t.mock.timers.reset();await host.harness.lifecycle.dispose();}
});
test("probe: a launch from a different bound home is released",async t=>{
 const {host}=await realCaptain();
 try{
  const key=seedUncertain(host,{home:"/tmp/previous-captain-home"});let reads=0;
  host.harness.sdk.stub("threads.list",async()=>{reads++;return [];});
  const result=await host.harness.behavior.runCli(["launches","release",TASK],ctx);
  assert.equal(result.exitCode,1,result.stderr);assert.equal(launchStore(host).get(key).state,"uncertain");
  assert.match(result.stderr,/home/);
  console.log("CONFIRMED: record.home differs from captain bound home; release refuses");
 }finally{t.mock.timers.reset();await host.harness.lifecycle.dispose();}
});

test("probe: lost create response retains slot through numbered transient spawn exit",async()=>{
 const {host,state}=await realCaptain();let work;
 try{
  const key=launchKey(ctx.projectId,ctx.threadId,HOME,TASK);
  state.onSpawn=async()=>{
   work=launchStore(host).create(key,()=>new Promise(()=>{}),undefined,1).catch(()=>{});
   assert.equal(launchStore(host).get(key).creationRequested,true);
  };
  const result=await host.harness.behavior.runCli(["dispatch","--project",ctx.projectId,"--task-id",TASK,"--","fix login"],ctx);
  assert.equal(result.exitCode,1);await work;
  const r=launchStore(host).get(key);assert.equal(r.state,"uncertain");assert.equal(r.creationRequested,true);
  console.log("CONFIRMED: same launch key flagged before spawn; lost response plus exit 1 retains uncertain slot");
 }finally{await host.harness.lifecycle.dispose();}
});
test("probe: concurrent releases share one pair of reads",async t=>{
 const {host}=await realCaptain();
 try{
  seedUncertain(host);let reads=0;
  host.harness.sdk.stub("threads.list",async()=>{reads++;return [];});
  t.mock.timers.enable({apis:["setTimeout","Date"],now:Date.now()});
  const one=host.harness.behavior.runCli(["launches","release",TASK],ctx);
  for(let i=0;i<1000 && reads<1;i++)await Promise.resolve();
  const two=host.harness.behavior.runCli(["launches","release",TASK],ctx);
  for(let i=0;i<200;i++)await Promise.resolve();
  t.mock.timers.tick(30_000);
  const results=await Promise.all([one,two]);for(const r of results)assert.equal(r.exitCode,1,r.stderr);
  assert.equal(launchStore(host).forTask(ctx.projectId,ctx.threadId,TASK).state,"uncertain");
  console.log("CONFIRMED: concurrent release callers refuse a legacy record without a process boundary");
 }finally{t.mock.timers.reset();await host.harness.lifecycle.dispose();}
});
test("probe: a create-worker RPC still running before reserve resurrects a failed dispatch",async()=>{
 const {host,state}=await realCaptain();
 let completeRead;let readReached=false;let pendingCreate;
 const readGate=new Promise(resolve=>{completeRead=resolve;});
 try{
  host.harness.sdk.stub("files.read",async()=>{readReached=true;await readGate;return {content:"Native validated brief",contentEncoding:"utf8",sizeBytes:22};});
  host.harness.sdk.stub("threads.spawn",async()=>({id:"thr_late_worker"}));
  state.onSpawn=async()=>{
   pendingCreate=host.harness.behavior.runCli(["create-worker","--json","--task",TASK,"--shape","ship","--project",ctx.projectId,"--home",HOME,"--host","host_1","--path","/repo","--prompt-file","/tmp/brief","--parent",ctx.threadId,"--native-pid","999"],ctx);
   for(let i=0;i<2000&&!readReached;i++)await Promise.resolve();
   assert.ok(readReached,"create RPC must reach prompt read");
   assert.equal(launchStore(host).forTask(ctx.projectId,ctx.threadId,TASK).state,"reserved");
  };
  const result=await host.harness.behavior.runCli(["dispatch","--project",ctx.projectId,"--task-id",TASK,"--","fix login"],ctx);
  assert.equal(result.exitCode,1,result.stderr);
  assert.equal(launchStore(host).forTask(ctx.projectId,ctx.threadId,TASK).state,"uncertain");
  completeRead();
  const created=await pendingCreate;
  assert.equal(created.exitCode,1,created.stderr);
  assert.equal(host.harness.sdk.callsTo("threads.spawn").length,0);
  assert.equal(launchStore(host).forTask(ctx.projectId,ctx.threadId,TASK).threadId,null);
  console.log("CONFIRMED: exit 1 keeps the slot while create-worker is running; that same RPC cannot create thr_late_worker after dispatch");
 }finally{completeRead();if(pendingCreate)await pendingCreate;await host.harness.lifecycle.dispose();}
});

test("probe: native lock pid is recognized by the release command",()=>{
 const root=mkdtempSync("/tmp/checker172-lock-");
 try{
  const file=root+"/fm-spawn.sh";
  writeFileSync(file,`#!/bin/bash
export FM_HOME="${root}"
source /tmp/verify-172-r1/native/bin/fm-wake-lib.sh
fm_lock_try_acquire "$STATE/.spawn-test.lock" || exit 1
pid=$(cat "$STATE/.spawn-test.lock/pid")
kill -0 "$pid" || exit 2
native_command=$(ps -p "$pid" -o command=)
case "$native_command" in *fm-spawn.sh*) echo FM_SPAWN_LOCK=live ;; *) echo FM_SPAWN_LOCK=dead ;; esac
`);
  const r=spawnSync("bash",[file],{encoding:"utf8"});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/FM_SPAWN_LOCK=live/);
  console.log("CONFIRMED: actual native symlink lock and pid file recognized as live");
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("probe: wrapped diagnostic is mistaken for a finished spawn",async()=>{
 const {host,state}=await realCaptain();
 try{
  state.spawnCreateError=new Error("ECONNRESET; context from earlier attempt: fm-spawn exit 1");
  const result=await host.harness.behavior.runCli(["dispatch","--project",ctx.projectId,"--task-id",TASK,"--","fix login"],ctx);
  assert.equal(result.exitCode,1);
  assert.equal(state.spawned,0,"no native exit status was delivered");
  assert.equal(launchStore(host).forTask(ctx.projectId,ctx.threadId,TASK).state,"uncertain");
  console.log("CONFIRMED: no spawn exit status, wrapped transport diagnostic containing fm-spawn exit 1 retains the slot");
 }finally{await host.harness.lifecycle.dispose();}
});
