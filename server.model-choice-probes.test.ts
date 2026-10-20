// Check rounds 1 and 2 on PR #181 (heads 7f4e1d2b and 388ff8fd): the reviewer's probes, kept as tests.
// Each defect probe failed before its fix; its assertions state the safe outcome.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { PROVIDER_CATALOG, stubProviderCatalog } from "./test/provider-catalog.mjs";
import { PROVIDER_UNAVAILABLE_KEY } from "./lib/provider-failover.ts";
import { readBbSubsQuota, weeklyPercent } from "./lib/crew-dispatch.ts";
import { readFileSync, chmodSync } from "node:fs";
import Database from "better-sqlite3";
import { createQueueStore } from "./lib/queue-store.ts";

type Host = ReturnType<typeof createFakePluginHost>;

const tool = (host: Host, name: string) => host.harness.inspection.registrations.agentTools.find((t) => t.name === name)!;
const text = (out: unknown) => (typeof out === "string" ? out : (out as { content?: Array<{ text?: string }> })?.content?.map((c) => c.text ?? "").join("\n") ?? "").replace(/[\s⁡-⁤]+$/u, "");
const capCtx = { threadId: "thr_cap", projectId: "proj_1" };

// The live acp-grok catalog on 20 Oct also lists grok-4.5; the shared test catalog does not.
const WITH_GROK_45 = { ...PROVIDER_CATALOG, "acp-grok": [...PROVIDER_CATALOG["acp-grok"], "grok-4.5"] };

async function dispatchHost(opts: { fmHome?: string; catalog?: Record<string, string[]>; async?: boolean } = {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["firstmate", "captain"], settings: { ...(opts.fmHome ? { fmHome: opts.fmHome } : {}), ...(opts.async ? { fmReliability: JSON.stringify({asyncDispatch:"on"}) } : {}) } });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  stubProviderCatalog(host);
  if (opts.catalog) {
    const catalog = opts.catalog;
    host.harness.sdk.stub("providers.models", async ({ providerId }: { providerId?: string } = {}) => ({
      modelLoadError: null,
      models: (catalog[providerId ?? "claude-code"] ?? []).map((id) => ({ id, model: id })),
    }));
  }
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Areliaa", kind: "repo" }));
  let n = 0;
  host.harness.sdk.stub("threads.spawn", async () => ({ id: `thr_new${++n}` }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "starting" }));
  return host;
}

const spawned = (host: Host) =>
  host.harness.sdk.callsTo("threads.spawn").map(([args]) => {
    const a = args as { providerId?: string; model?: string; reasoningLevel?: string };
    return { providerId: a.providerId, model: a.model, reasoningLevel: a.reasoningLevel };
  });

const dispatch = async (host: Host, input: Record<string, unknown>, ctx: Record<string, unknown> = { projectId: "proj_1" }) =>
  text(await tool(host, "firstmate_dispatch").execute({ projectId: "proj_1", ...input }, ctx));

test("probe: an explicitly named model survives a provider plan-limit mark", async () => {
 const host=await dispatchHost();
 try {
  await host.bb.storage.kv.set(PROVIDER_UNAVAILABLE_KEY, {"claude-code":{until:Date.now()+1800000,reason:"at its plan limit"}});
  const out=await dispatch(host,{task:"review the invoice calculation",model:"claude-opus-5-5",shape:"scout"});
  console.log("NAMED",JSON.stringify({out,spawned:spawned(host)}));
  assert.equal(spawned(host).at(-1)?.model,"claude-opus-5-5");
  assert.match(out,/\nNote: claude-code is at its plan limit until .+ UTC; this crew still runs on it because it was named\./);
 } finally {await host.harness.lifecycle.dispose();}
});
test("probe: checker stays different during plan-limit fallback", async () => {
 const host=await dispatchHost();
 try {
  await dispatch(host,{task:"fix the invoice calculation",taskId:"builder-1",providerId:"codex",model:"gpt-6.1-sol"},capCtx);
  await host.bb.storage.kv.set(PROVIDER_UNAVAILABLE_KEY,{"claude-code":{until:Date.now()+1800000,reason:"at its plan limit"}});
  const out=await dispatch(host,{task:"check the invoice calculation PR",taskId:"checker-1",role:"checker",shape:"scout",taskRef:"T1"},capCtx);
  console.log("CHECKER",JSON.stringify({out,spawned:spawned(host)}));
  assert.notEqual(spawned(host).at(-1)?.model,"gpt-6.1-sol");
  assert.match(out,/codex gpt-6\.1-sol: the builder's model/);
 } finally {await host.harness.lifecycle.dispose();}
});
test("probe: a retired single-model rule still starts on a usable provider", async () => {
 const host=await dispatchHost({catalog:{...PROVIDER_CATALOG,"acp-grok":["grok-4.6"]}});
 try {
  const out=await dispatch(host,{task:"research the new API",rule:"research",shape:"scout"});
  console.log("RETIRED",JSON.stringify({out,spawned:spawned(host)}));
  assert.equal(spawned(host).length,1);
  assert.match(out,/\nTell the owner: rule research cannot run \(acp-grok grok-4\.7: not in the catalog\); this crew runs claude-code claude-opus-5-5 instead\./);
 } finally {await host.harness.lifecycle.dispose();}
});


test("probe: a queue rule survives closing and reopening its database", async () => {
 const dir=mkdtempSync(join(tmpdir(),"a181-queue-"));let db=new Database(join(dir,"queue.sqlite"));
 try {
  let q=createQueueStore(db,async()=>[]);await q.ready();
  q.add({id:"q1",title:"UI task",projectId:"proj_1",shape:"scout",mode:"",blockedBy:[],waitUntil:null,status:"queued",crewId:null,createdAt:new Date().toISOString(),rule:"ui"});
  db.close(); db=new Database(join(dir,"queue.sqlite"));q=createQueueStore(db,async()=>{throw Error("must not reread legacy KV")});await q.ready();
  assert.equal(q.list()[0].rule,"ui");
 } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test("probe: background dispatch exposes its model pick and notices", async () => {
 const host=await dispatchHost({async:true});
 try {
  const out=await dispatch(host,{task:"make a small invoice edit",taskId:"async1",rule:"small-edit",shape:"scout"},capCtx);
  for(let n=0;n<150;n++){if((await host.bb.storage.kv.get("crews"))?.length)break;await new Promise(resolve=>setTimeout(resolve,20));}
  // dispose awaits background work after the fake crew has been recorded.
  await host.harness.lifecycle.dispose();
  const messages=host.harness.sdk.callsTo("threads.send").map(([a])=>JSON.stringify(a));
  console.log("ASYNC",JSON.stringify({out,spawned:spawned(host),messages}));
  assert.equal(spawned(host).length,1);
  assert.match(out+messages.join("\n"),/Picked codex gpt-6-luna/);
 } finally {await host.harness.lifecycle.dispose();}
});

test("probe: provider-default checker model differs from its builder", async () => {
 const dir=mkdtempSync(join(tmpdir(),"a181-model-default-"));const host=await dispatchHost({fmHome:dir});
 try {
  await dispatch(host,{task:"fix the tax rounding",taskId:"builder-2",providerId:"codex",model:"gpt-6.1-sol",sharedEnv:true},capCtx);
  await tool(host,"firstmate_models").execute({action:"set",id:"checker",when:"checker for another crew's PR",use:[{harness:"codex"},{harness:"claude-code",model:"claude-opus-5-5"}]},capCtx);
  // The catalog's model default is what a missing model will run.
  host.harness.sdk.stub("providers.models",async({providerId}: {providerId?:string}={})=>({modelLoadError:null,models:(PROVIDER_CATALOG[providerId??"claude-code"]??[]).map((id,i)=>({id,model:id,isDefault:i===0}))}));
  const out=await dispatch(host,{task:"check the tax rounding PR",role:"checker",shape:"scout",taskRef:"T1",sharedEnv:true},capCtx);
  console.log("IMPLICIT-CHECKER",JSON.stringify({out,spawned:spawned(host)}));
  assert.equal(spawned(host).at(-1)?.providerId,"claude-code");
  assert.match(out,/skipped codex gpt-6\.1-sol: the builder's model/);
 } finally {await host.harness.lifecycle.dispose();rmSync(dir,{recursive:true,force:true});}
});

test("probe: actual quota response parses and exhausted default falls back", async () => {
 const dir=mkdtempSync(join(tmpdir(),"a181-quota-"));
 const oldFlag=process.env.FM_NO_LIVE_NETWORK,oldBin=process.env.BB_CLI;
 let host;
 try {
  const actual=JSON.parse(readFileSync(new URL("./test/fixtures/quota/bb-subs-quota-2026-10-20.json",import.meta.url),"utf8"));
  const parsed=await readBbSubsQuota({env:{},cache:{current:null},execFile:async()=>({stdout:JSON.stringify(actual)})});
  assert.equal(parsed.accounts.length,actual.accounts.length);
  console.log("REAL-SHAPE",JSON.stringify({codex:weeklyPercent(parsed,"codex","gpt-6.1-sol"),grok:weeklyPercent(parsed,"acp-grok","grok-4.7"),claude:weeklyPercent(parsed,"claude-code","claude-opus-5-5")}));
  const bin=join(dir,"quota-cli");
  writeFileSync(bin,'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({accounts:[{provider:"claude",active:true,limits:[{label:"Weekly window",remaining:0,limit:100,unit:"percent"}]},{provider:"codex",active:true,limits:[{label:"Weekly window",remaining:80,limit:100,unit:"percent"}]}]}));\n');chmodSync(bin,0o700);
  process.env.FM_NO_LIVE_NETWORK="0";process.env.BB_CLI=bin;
  host=await dispatchHost();
  const out=await dispatch(host,{task:"fix the invoice calculation",shape:"scout"});
  console.log("EXHAUSTED-DEFAULT",JSON.stringify({out,spawned:spawned(host)}));
  assert.equal(spawned(host).length,1);
  assert.match(out,/\nPicked codex gpt-6\.1-sol \(fallback to a usable provider; the default cannot run: claude-code claude-opus-5-5: none left in weekly window\)\./);
 } finally {
  if(host)await host.harness.lifecycle.dispose();
  if(oldFlag===undefined)delete process.env.FM_NO_LIVE_NETWORK;else process.env.FM_NO_LIVE_NETWORK=oldFlag;
  if(oldBin===undefined)delete process.env.BB_CLI;else process.env.BB_CLI=oldBin;
  rmSync(dir,{recursive:true,force:true});
 }
});

test("probe: a slow quota command returns unknown within its timeout", async () => {
 const dir=mkdtempSync(join(tmpdir(),"a181-slow-quota-"));
 try {
  const bin=join(dir,"slow-cli");writeFileSync(bin,'#!/usr/bin/env node\nsetTimeout(()=>process.stdout.write(JSON.stringify({accounts:[]})),60000);\n');chmodSync(bin,0o700);
  const start=Date.now();const out=await readBbSubsQuota({env:{BB_CLI:bin},cache:{current:null}});const elapsed=Date.now()-start;
  console.log("SLOW-QUOTA",JSON.stringify({elapsedMs:elapsed,out}));assert.equal(out,null);assert.ok(elapsed<35000);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

// Check round 2 (head 388ff8fd).
test("round2: an unreadable provider default cannot bypass checker exclusion", async () => {
 const dir=mkdtempSync(join(tmpdir(),"a181-r2-default-"));const host=await dispatchHost({fmHome:dir});
 try {
  host.harness.sdk.stub("projects.defaultExecutionOptions",async()=>({providerId:"claude-code",model:"claude-opus-5-5"}));
  await dispatch(host,{task:"fix tax rounding",taskId:"builder",providerId:"claude-code",model:"claude-opus-5-5",sharedEnv:true},capCtx);
  await tool(host,"firstmate_models").execute({action:"set",id:"checker",when:"checker",use:[{harness:"claude-code"},{harness:"codex",model:"gpt-6.1-sol"}]},capCtx);
  host.harness.sdk.stub("providers.models",async({providerId}: {providerId?:string}={})=>providerId==="claude-code"?{models:[],modelLoadError:"temporarily unable to load models"}:{modelLoadError:null,models:(PROVIDER_CATALOG[providerId??"claude-code"]??[]).map((id,i)=>({id,model:id,isDefault:i===0}))});
  const out=await dispatch(host,{task:"check tax rounding PR",role:"checker",shape:"scout",taskRef:"T1",sharedEnv:true},capCtx);
  console.log("UNRESOLVED-CHECKER",JSON.stringify({out,spawned:spawned(host)}));
  assert.equal(spawned(host).length,2);assert.equal(spawned(host).at(-1)?.providerId,"codex");assert.equal(spawned(host).at(-1)?.model,"gpt-6.1-sol");
 } finally {await host.harness.lifecycle.dispose();rmSync(dir,{recursive:true,force:true});}
});

test("round2: a model-only named crew remains protected from subsequent automatic failover",async()=>{
 const host=await dispatchHost();
 try {
  await dispatch(host,{task:"inspect tax rounding",taskId:"named",model:"claude-opus-5-5",shape:"scout"},capCtx);
  const crews=await host.bb.storage.kv.get("crews");assert.equal(crews[0].providerNamed,true);
  host.harness.sdk.stub("threads.get",async({threadId}: {threadId:string})=>makeThreadResponse({id:threadId,status:"idle",projectId:"proj_1",providerId:"claude-code"}));
  host.harness.sdk.stub("threads.events.list",async()=>[]);
  const event=await host.harness.behavior.emitThreadEvent("thread.idle",{thread:makeThreadResponse({id:"thr_new1",status:"idle",projectId:"proj_1"}),lastAssistantText:"Upgrade your plan to continue."});
  assert.deepEqual(event.errors,[]);assert.equal(spawned(host).length,1);
  console.log("NAMED-PROTECTED",JSON.stringify({providerNamed:crews[0].providerNamed,spawned:spawned(host)}));
 }finally{await host.harness.lifecycle.dispose();}
});

test("round2: a background pick and Tell the owner notice reach the captain once",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"a181-r2-async-"));mkdirSync(join(dir,"config"));writeFileSync(join(dir,"config","fm-model-rules.json"),"{oops");
 const host=await dispatchHost({fmHome:dir,async:true});
 try{
  const out=await dispatch(host,{task:"fix a tax label",taskId:"async-notice",rule:"small-edit",shape:"scout",sharedEnv:true},capCtx);
  for(let n=0;n<150;n++){if((await host.bb.storage.kv.get("crews"))?.length)break;await new Promise(resolve=>setTimeout(resolve,20));}
  await host.harness.lifecycle.dispose();
  const messages=host.harness.sdk.callsTo("threads.send").map(([a])=>JSON.stringify(a));const picked=messages.filter(m=>m.includes("Picked "));
  console.log("ASYNC-NOTICE",JSON.stringify({out,messages}));assert.equal(picked.length,1);assert.match(picked[0],/Tell the owner: config/);assert.match(picked[0],/is broken/);
 }finally{await host.harness.lifecycle.dispose();rmSync(dir,{recursive:true,force:true});}
});

test("round2: zero five-hour quota blocks a default whose weekly quota remains",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"a181-r2-short-window-"));const oldFlag=process.env.FM_NO_LIVE_NETWORK,oldBin=process.env.BB_CLI;let host;
 try{
  const bin=join(dir,"quota-cli");writeFileSync(bin,'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({accounts:[{provider:"claude",active:true,limits:[{label:"5-hour window",remaining:0,limit:100,unit:"percent"},{label:"Weekly window",remaining:80,limit:100,unit:"percent"}]},{provider:"codex",active:true,limits:[{label:"Weekly window",remaining:80,limit:100,unit:"percent"}]}]}));\n');chmodSync(bin,0o700);
  process.env.FM_NO_LIVE_NETWORK="0";process.env.BB_CLI=bin;host=await dispatchHost();
  const out=await dispatch(host,{task:"fix tax rounding",shape:"scout"});
  console.log("ZERO-SHORT-WINDOW",JSON.stringify({out,spawned:spawned(host)}));assert.equal(spawned(host).at(-1)?.providerId,"codex");
 }finally{
  if(host)await host.harness.lifecycle.dispose();
  if(oldFlag===undefined)delete process.env.FM_NO_LIVE_NETWORK;else process.env.FM_NO_LIVE_NETWORK=oldFlag;
  if(oldBin===undefined)delete process.env.BB_CLI;else process.env.BB_CLI=oldBin;
  rmSync(dir,{recursive:true,force:true});
 }
});

test("round2: no usable provider refuses without spawning",async()=>{
 const host=await dispatchHost();
 try{
  host.harness.sdk.stub("providers.list",async()=>Object.keys(PROVIDER_CATALOG).map(id=>({id,available:false,reasoningLevels:[{id:"high"}]})));
  const out=await dispatch(host,{task:"research invoice standards",rule:"research",shape:"scout"});
  console.log("NO-USABLE",JSON.stringify({out,spawned:spawned(host)}));assert.match(out,/Refusing:/);assert.equal(spawned(host).length,0);
 }finally{await host.harness.lifecycle.dispose();}
});
