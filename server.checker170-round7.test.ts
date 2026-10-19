import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { mergeAllowedByRequiredStatus } from "./lib/github-protection.ts";
import { createOwnerAsks } from "./lib/owner-asks.ts";
import { OWNER_APPROVAL_CONTEXT, createOwnerGate } from "./lib/owner-gate.ts";
import { createOwnerTasks } from "./lib/owner-tasks.ts";
import { createDeliveries } from "./lib/pr-delivery.ts";
import { createProductionApprovals } from "./lib/production-approval.ts";
import plugin from "./server.ts";

process.env.FM_MERGEABLE_POLL_MS = "0";

const CREW = "9ceeb10f";
const PR = "cyndra-ai/cyndra-saas#2391";
const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
const crew = {
  id: CREW, task: "review fixes", playbook: "babysit", projectId: "proj_1", threadId: "thr_crew",
  parentThreadId: "thr_cap", nativeHome: "/native", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: null,
  worktree: true, shape: "ship", posture: "direct-PR", createdAt: "2026-10-14T00:00:00.000Z",
};
const heads = new Map<number, string>();
const head = (n: number) => heads.get(n) ?? String(n).repeat(10).slice(0, 40);
const url = (n: number) => `https://github.com/Cyndra-AI/cyndra-saas/pull/${n}`;
const prNumber = (command: string) => Number(/\/pull\/(\d+)/.exec(command)?.[1] ?? /gh pr view '?(\d+)/.exec(command)?.[1]);
const envelope = readFileSync(new URL("./test/fixtures/envelopes/live-owner.txt", import.meta.url), "utf8");
type Host = ReturnType<typeof createFakePluginHost>;
type ForgeOut = { code?: number; payload?: string; stderr?: string };
type RpcCall = { method?: string; input?: Record<string, unknown> };

function hostCommands(host: Host, answer: (command: string) => ForgeOut) {
  const commands: string[] = [];
  const byId = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub("terminals.create", async (args: { start: { command: string } }) => {
    const id = `term${++n}`;
    byId.set(id, args.start.command);
    commands.push(args.start.command);
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
    const command = byId.get(terminalId) ?? "";
    const out = answer(command);
    const captured = command.includes("FM_HOST_CAPTURE_V1");
    const payload = captured
      ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: out.code ?? 0, stdout: out.payload ?? "", stderr: out.stderr ?? "" })
      : out.payload ?? "";
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${payload}\n__FM_HOST_RC:${captured ? 0 : out.code ?? 0}\n`).toString("base64") }] };
  });
  return commands;
}

function forge(command: string): ForgeOut {
  if(command.includes("fm-pr-merge.sh")) return {payload:`verified: ${url(2391)} is merged (state=MERGED, merged=true, isInMergeQueue=false)`};
  if (command.includes("gh pr view")) {
    const n = prNumber(command);
    return { payload: JSON.stringify({ number: n, url: url(n), title: `Change ${n}`, headRefName: `fm/${CREW}-change-${n}`, headRefOid: head(n), state: "OPEN", mergeable: "MERGEABLE", isDraft: false, statusCheckRollup: [{name:"build",conclusion:"SUCCESS"}], reviewDecision:"APPROVED", reviews:[{state:"APPROVED",commit:{oid:head(n)}}] }) };
  }
  return { code: 0 };
}

function seen(n: number) {
  return { headSha: head(n), state: "open" as const, draft: false, checks: "passing" as const, review: "approved" as const, reviewHeadSha: head(n), mergeCommitSha: null, mergeable: "mergeable" as const };
}

async function deck() {
  heads.clear();
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["firstmate", "captain"], settings: { fmHome: "/native", fmHostId: "host_1" } });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "idle", environmentId: "env_wt" }));
  host.harness.sdk.stub("environments.list", async () => [{ id: "env_source", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_wt", hostId: "host_1", status: "ready", isWorktree: true, path: "/wt", branchName: `fm/${CREW}-change-2391` }));
  host.harness.sdk.stub("environments.diffFiles", async () => ({ files: [] }));
  host.harness.sdk.stub("environments.pullRequest", async () => ({ outcome: "available", pullRequest: { url: url(2391), state: "open", number:2391, checks:{state:"passing",failedCount:0,pendingCount:0,passedCount:1}, mergeability:{mergeable:"MERGEABLE"} } }));
  host.harness.sdk.stub("threads.output", async () => ({ output: "" }));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.send", async () => ({ delivery: "queued" }));
  host.harness.sdk.stub("plugins.callRpc", async () => ({ ok: true, queued: 1, duplicate: false, mode: "on" }));
  await host.bb.storage.kv.set("crews", [crew]);
  const store = createDeliveries(host.bb.storage.database());
  store.register({ url: url(2391), taskId: CREW, projectId: "proj_1", owner: "thr_cap", home: "/native", worker: "thr_crew", requirement: "merged", title: "Change 2391" });
  store.observe(PR, seen(2391), true);
  store.verify(PR, "thr_crew", head(2391), { driven: "staging app", seen: "it works", surface: "web" }, CREW);
  store.recordCheck(PR,head(2391),{verdict:"pass",crewId:"checker-other",providerId:"codex",model:"checker-model",notes:"Drove and checked the changed staging surface"});
  let answer: (command: string) => ForgeOut = forge;
  const commands = hostCommands(host, (command) => answer(command));
  return {
    host, store, commands,
    setAnswer(next: (command: string) => ForgeOut) { answer = next; },
  };
}

const tool = (host: Host, name: string) => {
  const found = host.harness.inspection.registrations.agentTools.find((item) => item.name === name);
  assert.ok(found, `tool ${name} not registered`);
  return found!;
};
const text = (out: unknown) => typeof out === "string" ? out : (out as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? JSON.stringify(out);
const statuses = (commands: string[]) => commands.filter((command) => command.includes("/statuses/") && command.includes("-X POST"));
const lastStatus = (commands: string[]) => statuses(commands).at(-1) ?? "";
function postedKind(commands: string[]): string {
  const last = lastStatus(commands);
  if (last.includes("Owner Approve at this head")) return "success";
  if (/New author commits after approval/i.test(last)) return "new-author";
  if (last.includes("Needs owner Approve")) return "pending";
  return last;
}
const askApproval = (host: Host) => tool(host, "firstmate_ask").execute({
  kind: "approval", prs: [PR], question: "Merge cyndra-ai/cyndra-saas#2391 to production? Undo: revert the PR.", project: "Cyndra",
}, ctx);
const ownerTap = (host: Host, id: string, answer = "Approve") => {
  host.harness.sdk.stub("plugins.callRpc", async (call: RpcCall) => {
    if (call.method === "ownerAnswer") return { answer, ok: true };
    return { ok: true, queued: 1, duplicate: false, mode: "on" };
  });
  return host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id, resolution: answer });
};


async function dispatch(host: Host, message: string) {
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await host.harness.inspection.registrations.hooks["message.dispatch"]!({
    thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
    attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
    input: { blocks: [], text: message },
  } as never);
}


const tasksOf=(host:Host)=>createOwnerTasks(host.bb.storage.database());
function taskFor(host:Host,title='Task A',refs=['tg:200:1'],prs=[PR]) {return tasksOf(host).open({captain:'thr_cap',project:'Cyndra',projectId:'proj_1',title,sourceRefs:refs,prs,at:Date.now()});}
function preFor(host:Host,task:string,allows:'merge'|'deploy'|'both'='both') {return createOwnerGate(host.bb.storage.database()).recordPreApproval({ownerMessageRef:'tg:200:1',quote:'merge after you finish and deploy to production',task,project:'Cyndra',allows,createdAt:Date.now()});}
const cliCheck=(host:Host,task:string,what='merge',pr=PR)=>host.harness.behavior.runCli(['prod-check','Cyndra',what,'--task',task,'--pr',pr],ctx);

async function reloadedDeck(old:Host){
 const host=await old.harness.lifecycle.reload(plugin);
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async({threadId}:{threadId:string})=>threadId==='thr_cap'?{captain:'true'}:{});
 host.harness.sdk.stub('threads.get',async({threadId}:{threadId:string})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:'env_wt'}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));
 host.harness.sdk.stub('plugins.callRpc',async()=>({ok:true}));
 return {host,commands:hostCommands(host,forge)};
}


async function judgeYes(host:Host) {
 const dir=mkdtempSync(join(tmpdir(),'r3-judge-'));writeFileSync(join(dir,'key.env'),'OPENAI_API_KEY=fake');
 await host.harness.behavior.setSettings({fmHostId:'host_1',decisionsKeyFile:join(dir,'key.env')});
 const real=globalThis.fetch;
 globalThis.fetch=(async()=>new Response(JSON.stringify({answers:[{name:'merge_after_finish',choice:'yes',confidence:0.99},{name:'deploy_to_production',choice:'yes',confidence:0.99}]}))) as typeof fetch;
 return ()=>{globalThis.fetch=real;};
}

function msgFor(id:string,body='Merge after you finish and deploy to production') {return envelope.replace('telegram_message_id: 1669','telegram_message_id: '+id).replace('Status?',body);}
async function authored(host:Host,msg:string,sender:string|null){
 await host.harness.inspection.registrations.hooks['message.dispatch']!({thread:makeThreadResponse({id:'thr_cap',status:'active'}),attempt:'join-turn',initiator:'user',senderThreadId:sender,queuedMessages:[],input:{blocks:[],text:msg}} as never);
}


async function originMessage(host:Host,msg:string,input:{sender:string|null;initiator?:string;origin?:string|null;originPluginId?:string|null}){
 await host.harness.inspection.registrations.hooks['message.dispatch']!({thread:makeThreadResponse({id:'thr_cap',status:'active'}),attempt:'join-turn',initiator:input.initiator??'user',senderThreadId:input.sender,queuedMessages:[],origin:input.origin??null,originPluginId:input.originPluginId??null,experimental_submission:null,input:{blocks:[],text:msg}} as never);
}







async function connectorDeck7(deleted=true){
 const {pathToFileURL}=await import('node:url');
 await import(pathToFileURL('/tmp/firstmate-170-telegram-check-7/test/register.mjs').href);
 const {baseConfig,cycle,makeHarness,openStore}=await import(pathToFileURL('/tmp/firstmate-170-telegram-check-7/test/support.ts').href);
 let {host}=await deck();const {store,db}=openStore();const task=taskFor(host);
 let failReopen=false;let pauseId='';let release=()=>{};let reached=()=>{};let paused=Promise.resolve();
 const rpcTrace:Array<{id:string;resolution:string;at:number}>=[];
 const tg=makeHarness({store,config:baseConfig({captainThreadId:'thr_cap',threadedReplies:'on',pinnedBoard:false}),resolveAsk:async(input:{threadId:string;id:string;resolution:string})=>{
  if(input.id===pauseId){pauseId='';reached();await new Promise<void>(resolve=>{release=resolve;});}
  await new Promise(resolve=>setTimeout(resolve,3));
  const out=await host.harness.behavior.callRpc('resolveAsk',input);rpcTrace.push({id:input.id,resolution:input.resolution,at:Date.now()});return out;
 }});
 const route=()=>host.harness.sdk.stub('plugins.callRpc',async({method,input}:{method:string;input:Record<string,unknown>})=>{
  if(method==='editAsk'&&failReopen)throw new Error('temporary connector RPC unavailable');
  return method==='ask'?tg.engine.enqueueAskRouted(input):method==='ownerAnswer'?tg.engine.ownerAnswer(input):method==='editAsk'?tg.engine.editAsk(input):{ok:true};
 });
 await host.harness.behavior.setSettings({fmReliability:JSON.stringify({inboundLedger:'on',telegramThreading:'on'})});route();await cycle(tg.engine);
 const asks=()=>createOwnerAsks(host.bb.storage.database());
 const card=async()=>{await askApproval(host);const ask=asks().listOpen('thr_cap')[0]!;await cycle(tg.engine);const board=await tg.engine.boardState();const match=board.cards.find((c:{messageId:string})=>store.replyForMessage(c.messageId)?.source_event_id==='ask:'+ask.id);assert.ok(match,'card not rendered');return {id:ask.id,messageId:match.messageId};};
 const tap=async(messageId:string,label:string)=>{const board=await tg.engine.boardState();const c=board.cards.find((x:{messageId:string})=>x.messageId===messageId);assert.ok(c,'card not open on Board');const b=c.buttons.find((x:{text:string})=>x.text===label);assert.ok(b);assert.deepEqual(await tg.engine.boardAnswer({token:b.token}),{ok:true});await cycle(tg.engine);};
 const a=await card();if(deleted)tg.telegram.deleteMessage(Number(a.messageId));await tap(a.messageId,'Approve');
 if(deleted)assert.ok(store.listControls('ask-edit:').length>0);
 const b=await card();
 return {
  tg,store,task,a,b,rpcTrace,asks,
  host:()=>host,cycle:()=>cycle(tg.engine),tap,
  failEdit(value:boolean){failReopen=value;},
  async reopen(){return tool(host,'firstmate_resolve_ask').execute({id:a.id,resolution:'Ask owner again',reopen:true},ctx);},
  async cancel(){return tool(host,'firstmate_resolve_ask').execute({id:a.id,resolution:'Clear card',cancelled:true},ctx);},
  check:()=>cliCheck(host,task.id),
  async replay(){return host.harness.behavior.callRpc('resolveAsk',{threadId:'thr_cap',id:a.id,resolution:'Approve'});},
  async restart(){({host}=await reloadedDeck(host));route();},
  async generation(){await tool(host,'firstmate_task').execute({action:'close',id:task.id,state:'dropped',reason:'stop old work',ref:'tg:200:9701'},ctx);tasksOf(host).attach(task.id,'thr_cap',{crewId:'next-generation',sourceRefs:['tg:200:9702'],at:Date.now()});},
  pauseNext(){paused=new Promise<void>(resolve=>{reached=resolve;});pauseId=a.id;return paused;},
  release(){release();},
  snapshot(label:string){writeFileSync('/tmp/firstmate-170-r7-'+label+'.json',JSON.stringify({rpcTrace,cards:createOwnerGate(host.bb.storage.database()).cardsForPr(PR),pending:store.listControls('ask-edit:'),edits:tg.telegram.edits},null,2));},
  async dispose(){release();await host.harness.lifecycle.dispose();db.close();},
 };
}

for(const noFirst of [false,true])test('ROUND7 cached Approve after captain reopen cannot replace No ('+(noFirst?'No before reopen':'No after reopen')+')',async()=>{
 const d=await connectorDeck7();try{
  if(noFirst){await d.tap(d.b.messageId,'No');assert.equal((await d.check()).exitCode,1);}
  d.failEdit(true);await d.reopen();assert.equal(d.asks().get(d.a.id)?.state,'open');
  if(!noFirst)await d.tap(d.b.messageId,'No');else await d.cycle();
  d.snapshot(noFirst?'no-before-reopen':'no-after-reopen');
  assert.equal((await d.check()).exitCode,1,'cached old Approve renewed after a captain reopen, without a new owner tap');
 }finally{await d.dispose();}
});

test('ROUND7 in-flight edit retry cannot become a new choice when captain reopens during delivery',async()=>{
 const d=await connectorDeck7();let inflight:Promise<void>|undefined;try{
  await d.tap(d.b.messageId,'No');assert.equal((await d.check()).exitCode,1);
  const paused=d.pauseNext();inflight=d.cycle();
  await Promise.race([paused,new Promise((_,reject)=>setTimeout(()=>reject(new Error('retry did not reach pause')),5000).unref())]);
  await d.reopen();assert.equal(d.asks().get(d.a.id)?.state,'open');
  d.release();await inflight;inflight=undefined;
  d.snapshot('inflight-reopen');assert.equal((await d.check()).exitCode,1,'in-flight cached answer became fresh after reopen');
 }finally{d.release();if(inflight)await inflight;await d.dispose();}
});

for(const mode of ['cancel','restart','generation'])test('ROUND7 '+mode+' alone preserves latest No against cached same-choice replay',async()=>{
 const d=await connectorDeck7();try{
  await d.tap(d.b.messageId,'No');assert.equal((await d.check()).exitCode,1);
  if(mode==='cancel')await d.cancel();if(mode==='restart')await d.restart();if(mode==='generation')await d.generation();
  await d.replay();d.snapshot(mode+'-no-reopen');assert.equal((await d.check()).exitCode,1);
 }finally{await d.dispose();}
});

for(const mode of ['cancel-reopen','restart-after-reopen','generation-after-reopen'])test('ROUND7 '+mode+' does not turn old cached Approve into a new owner answer',async()=>{
 const d=await connectorDeck7();try{
  await d.tap(d.b.messageId,'No');assert.equal((await d.check()).exitCode,1);
  d.failEdit(true);if(mode==='cancel-reopen')await d.cancel();await d.reopen();
  if(mode==='restart-after-reopen')await d.restart();if(mode==='generation-after-reopen')await d.generation();
  await d.replay();d.snapshot(mode);assert.equal((await d.check()).exitCode,1,'non-owner reopen state refreshed old permission');
 }finally{await d.dispose();}
});

test('ROUND7 genuine owner re-tap after successful reopen wins over earlier No',async()=>{
 const d=await connectorDeck7(false);try{
  await d.tap(d.b.messageId,'No');assert.equal((await d.check()).exitCode,1);
  await d.reopen();assert.equal(d.asks().get(d.a.id)?.state,'open');
  await d.tap(d.a.messageId,'Approve');d.snapshot('genuine-retap');
  assert.equal((await d.check()).exitCode,0,'genuine owner re-tap did not authorize');
 }finally{await d.dispose();}
});
