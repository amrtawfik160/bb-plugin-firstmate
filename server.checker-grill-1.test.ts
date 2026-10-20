import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createInboundLedger } from "./lib/inbound-ledger.ts";
import { createOwnerAsks } from "./lib/owner-asks.ts";
import { parseInboundTelegram } from "./lib/telegram-envelope.ts";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";

type Host = ReturnType<typeof createFakePluginHost>;
type RpcCall = { pluginId: string; method: string; input: Record<string, unknown> };

async function load(seed: (host: Host) => Promise<void> = async () => {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"] });
  await seed(host);
  await plugin(host.bb);
  stubProviderCatalog(host);
  return host;
}

function tool(host: Host, name: string) {
  const found = host.harness.inspection.registrations.agentTools.find((item) => item.name === name);
  assert.ok(found, `tool ${name} not registered`);
  return found!;
}

function text(result: unknown): string {
  if (typeof result === "string") return result;
  return (result as { content: Array<{ text?: string }> }).content.map((part) => part.text ?? "").join("\n");
}

function isError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
}

const rpcCalls = (host: Host) => host.harness.sdk.callsTo("plugins.callRpc").map((call) => call[0] as RpcCall);
const asks = (host: Host) => createOwnerAsks(host.bb.storage.database());

async function roundHost() {
  const host = await load(async (item) => { await item.bb.storage.kv.set("captain-project:thr_cap", "proj_1"); });
  await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on" }) });
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }));
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("plugins.callRpc", async (args: RpcCall) => (
    args.method === "refreshBoard" ? { ok: true } : { queued: 1, duplicate: false, mode: "on" }
  ));
  return host;
}

const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
const askTool = (host: Host, params: Record<string, unknown>) => tool(host, "firstmate_ask").execute({ project: "Safi", ...params }, ctx);
const resolveTool = (host: Host, params: Record<string, unknown>) => tool(host, "firstmate_resolve_ask").execute(params, ctx);

const ROUND = [
  { question: "What is the goal of Reels?", options: [{ label: "Grow reach" }, { label: "Convert sales" }, { label: "Test ideas" }], recommended: 0 },
  { question: "Who is the audience?", options: [{ label: "Existing customers" }, { label: "New viewers" }, { label: "Both" }], recommended: 1 },
  { question: "How often should we post?", options: [{ label: "Daily" }, { label: "Three times a week" }, { label: "Weekly" }], recommended: 1 },
  { question: "What is the first series?", options: [{ label: "Product tips" }, { label: "Customer stories" }, { label: "Behind the scenes" }], recommended: 2 },
];

const ROUND_TEXT = [
  "1. What is the goal of Reels?",
  "✓ A. Grow reach",
  "B. Convert sales",
  "C. Test ideas",
  "",
  "2. Who is the audience?",
  "A. Existing customers",
  "✓ B. New viewers",
  "C. Both",
  "",
  "3. How often should we post?",
  "A. Daily",
  "✓ B. Three times a week",
  "C. Weekly",
  "",
  "4. What is the first series?",
  "A. Product tips",
  "B. Customer stories",
  "✓ C. Behind the scenes",
  "",
  "Answer like 1A 2C, or 'yes' to accept all recommended.",
].join("\n");

const envelope = (name: string) => readFileSync(new URL(`./test/fixtures/envelopes/${name}.txt`, import.meta.url), "utf8");
const askReply = (askId: string, body: string) => envelope("live-reply")
  .replace('"sourceEventId":"evt_1"', `"sourceEventId":"ask:${askId}"`)
  .replace(/Roll it back$/, body);


test("checker: twelve questions fit; oversize is refused without RPC or persistence", async () => {
  const host = await roundHost();
  try {
    const round = Array.from({length:12}, (_,i)=>({...ROUND[0],question:`Question ${i+1}: choose the audience?`}));
    const result = await askTool(host,{kind:"question",round});
    assert.ok(!isError(result),text(result));
    const sent = rpcCalls(host).filter(c=>c.method==="ask");
    assert.equal(sent.length,1);
    assert.ok(String(sent[0].input.text).includes("12. Question 12"));
    assert.ok(String(sent[0].input.text).length<=3000);
    const oversized=round.map(q=>({...q,question:"q".repeat(500)}));
    const rejected=await askTool(host,{kind:"question",round:oversized});
    assert.ok(isError(rejected),text(rejected));
    assert.equal(rpcCalls(host).filter(c=>c.method==="ask").length,1);
    assert.equal(asks(host).listOpen("thr_cap").length,1);
  } finally { await host.harness.lifecycle.dispose(); }
});
test("checker: bad numbers and letters are atomic; yes recommendations and reopen reset",async()=>{
 const host=await roundHost();
 try {
  const opened=await askTool(host,{kind:"question",round:ROUND});
  const id=/ask (a[0-9a-z]{6})/.exec(text(opened))![1];
  for(const answers of [[{n:1,choice:"A"},{n:5,choice:"A"}],[{n:1,choice:"A"},{n:2,choice:"D"}]]){
   assert.ok(isError(await resolveTool(host,{id,answers})));
   assert.equal(asks(host).get(id)?.roundAnswers,undefined);
  }
  const yes=ROUND.map((q,i)=>({n:i+1,choice:String.fromCharCode(65+q.recommended)}));
  assert.ok(!isError(await resolveTool(host,{id,answers:yes})));
  assert.equal(asks(host).get(id)?.resolution,"1A 2B 3B 4C");
  assert.ok(!isError(await resolveTool(host,{id,reopen:true,resolution:"New attempt"})));
  assert.equal(asks(host).get(id)?.roundAnswers,undefined);
  await resolveTool(host,{id,answers:[{n:2,choice:"C"}]});
  assert.equal(asks(host).get(id)?.state,"open");
  assert.deepEqual(asks(host).get(id)?.roundAnswers,{2:"Both"});
 }finally{await host.harness.lifecycle.dispose();}
});
test("checker: round choice identity survives repeated labels",async()=>{
 const host=await roundHost();
 try {
  const round=ROUND.slice(0,2).map(q=>({...q,options:[{label:"Custom",value:"custom-a"},{label:"Custom",value:"custom-b"}]}));
  const opened=await askTool(host,{kind:"question",round});
  assert.ok(!isError(opened),text(opened));
  const id=/ask (a[0-9a-z]{6})/.exec(text(opened))![1];
  await resolveTool(host,{id,answers:[{n:1,choice:"B"},{n:2,choice:"B"}]});
  assert.equal(asks(host).get(id)?.resolution,"1B 2B");
 }finally{await host.harness.lifecycle.dispose();}
});

test("checker: file database restart retains partial answers and later rounds stay isolated",async()=>{
 const {default:Database}=await import("better-sqlite3");
 const {mkdtempSync,rmSync}=await import("node:fs");
 const dir=mkdtempSync("/tmp/grill-state-");
 let db=new Database(`${dir}/round.sqlite`);
 try{
  let store=createOwnerAsks(db);
  store.create({id:"round-one",captain:"thr_cap",kind:"question",text:"Round",options:[],round:ROUND.map(q=>({...q,options:q.options.map((o,i)=>({...o,value:String.fromCharCode(65+i)}))})),createdAt:1});
  store.recordRoundAnswers("round-one","thr_cap",[{n:1,choice:"A"}],2);
  db.close(); db=new Database(`${dir}/round.sqlite`); store=createOwnerAsks(db);
  assert.equal(store.get("round-one")?.round?.length,4);
  assert.deepEqual(store.get("round-one")?.roundAnswers,{1:"Grow reach"});
  store.create({id:"round-two",captain:"thr_cap",kind:"question",text:"Round",options:[],round:store.get("round-one")!.round,createdAt:3});
  assert.equal(store.get("round-two")?.roundAnswers,undefined);
  store.resolve("round-one","thr_cap","open","Retry",4);
  assert.equal(store.get("round-one")?.roundAnswers,undefined);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test("checker: accepted round does not silently cut the impact sentence",async()=>{
 const host=await roundHost();
 try{
  const impact="This changes "+"the plan for the next campaign ".repeat(12)+"END-OF-IMPACT";
  const result=await askTool(host,{kind:"question",round:ROUND.slice(0,2),impact});
  if(isError(result)) { assert.equal(rpcCalls(host).filter(c=>c.method==="ask").length,0); return; }
  const sent=rpcCalls(host).find(c=>c.method==="ask")!;
  assert.ok(String(sent.input.text).includes("END-OF-IMPACT"),"successful round silently dropped the end of impact");
 }finally{await host.harness.lifecycle.dispose();}
});

test("checker: status-question repair preserves a valid open grilling round",async()=>{
 const host=await roundHost();
 try{
  const opened=await askTool(host,{kind:"question",round:ROUND});
  const id=/ask (a[0-9a-z]{6})/.exec(text(opened))![1];
  const {repairStatusQuestionCards}=await import("./lib/repair-status-question-cards.ts");
  const repaired=repairStatusQuestionCards(host.bb.storage.database());
  assert.equal(asks(host).get(id)?.state,"open",JSON.stringify(repaired));
 }finally{await host.harness.lifecycle.dispose();}
});
