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

test('ROUND4 origin: ordinary crew tell cannot create pre-approval',async()=>{
 const {host}=await deck();let restore=()=>{};try{
  taskFor(host,'Billing',['tg:200:9101']);restore=await judgeYes(host);
  await originMessage(host,msgFor('9101'),{sender:'thr_crew',initiator:'agent'});
  assert.equal(createOwnerGate(host.bb.storage.database()).listPreApprovals().length,0);
 }finally{restore();await host.harness.lifecycle.dispose();}
});

test('ROUND4 origin: captain self-tell normalized by BB to user with null sender cannot grant permission',async()=>{
 const {host}=await deck();let restore=()=>{};try{
  const task=taskFor(host,'Billing',['tg:200:9102']);restore=await judgeYes(host);
  await originMessage(host,msgFor('9102'),{sender:null,initiator:'user',origin:null,originPluginId:null});
  assert.equal(createOwnerGate(host.bb.storage.database()).listPreApprovals().length,0,'ordinary captain self-tell acquired permission as if Telegram delivered it');
  assert.equal((await cliCheck(host,task.id)).exitCode,1);
 }finally{restore();await host.harness.lifecycle.dispose();}
});

test('ROUND4 origin: another plugin carrying copied Telegram text cannot grant permission',async()=>{
 const {host}=await deck();let restore=()=>{};try{
  taskFor(host,'Billing',['tg:200:9103']);restore=await judgeYes(host);
  await originMessage(host,msgFor('9103'),{sender:null,initiator:'user',origin:'plugin',originPluginId:'other-plugin'});
  assert.equal(createOwnerGate(host.bb.storage.database()).listPreApprovals().length,0,'originPluginId was ignored');
 }finally{restore();await host.harness.lifecycle.dispose();}
});

test('ROUND4 origin: plain owner instruction in the BB app can pre-approve its task',async()=>{
 const {host}=await deck();let restore=()=>{};try{
  // owner decision A, 19 Oct: Telegram only
  const task=taskFor(host,'Billing',['bb:thr_cap:101']);restore=await judgeYes(host);
  globalThis.fetch=(async()=>new Response(JSON.stringify({answers:[{name:'merge_after_finish',choice:'yes',confidence:0.99},{name:'deploy_to_production',choice:'no',confidence:0.99},{name:'matching_task',choice:task.id,confidence:0.99}]}))) as typeof fetch;
  await originMessage(host,'Finish the billing fix and merge after you finish',{sender:null,initiator:'user',origin:'app',originPluginId:null});
  assert.equal(createOwnerGate(host.bb.storage.database()).listPreApprovals().length,0);
  const out=await cliCheck(host,task.id);assert.equal(out.exitCode,1);
 }finally{restore();await host.harness.lifecycle.dispose();}
});

test('ROUND4 replay: consumed owner id stays consumed across restart and a new task generation',async()=>{
 let {host}=await deck();let restore=()=>{};try{
  const task=taskFor(host,'Billing',['tg:200:9201']);restore=await judgeYes(host);
  const msg=msgFor('9201');await originMessage(host,msg,{sender:null,origin:'plugin',originPluginId:'telegram'});
  assert.equal(createOwnerGate(host.bb.storage.database()).listPreApprovals().length,1);
  await tool(host,'firstmate_task').execute({action:'close',id:task.id,state:'dropped',reason:'stop old work',ref:'tg:200:9202'},ctx);
  tasksOf(host).attach(task.id,'thr_cap',{crewId:'new-generation',sourceRefs:['tg:200:9203'],at:Date.now()});
  const restarted=await reloadedDeck(host);host=restarted.host;
  await originMessage(host,msg,{sender:null,origin:'plugin',originPluginId:'telegram'});
  assert.equal(createOwnerGate(host.bb.storage.database()).listPreApprovals().length,1);
  assert.equal((await cliCheck(host,task.id)).exitCode,1);
  const next=taskFor(host,'Replacement task',['tg:200:9201']);
  await originMessage(host,msg,{sender:null,origin:'plugin',originPluginId:'telegram'});
  assert.equal((await cliCheck(host,next.id)).exitCode,1);
 }finally{restore();await host.harness.lifecycle.dispose();}
});

for(const mode of ['cancel','reopen'])test('ROUND4 owner No cannot be removed by captain '+mode,async()=>{
 const {host}=await deck();try{
  const task=taskFor(host);preFor(host,task.id);
  await askApproval(host);const ask=createOwnerAsks(host.bb.storage.database()).listOpen('thr_cap')[0]!;await ownerTap(host,ask.id,'No');
  assert.equal((await cliCheck(host,task.id)).exitCode,1);
  await tool(host,'firstmate_resolve_ask').execute({id:ask.id,resolution:'Captain clearing old card',...(mode==='cancel'?{cancelled:true}:{reopen:true})},ctx);
  assert.equal((await cliCheck(host,task.id)).exitCode,1,'captain correction erased owner No and revived old pre-approval');
 }finally{await host.harness.lifecycle.dispose();}
});

test('ROUND4 task: two open tasks with no unique builder association refuse plainly',async()=>{
 const {host}=await deck();try{
  const first=taskFor(host,'First',['tg:200:1']);preFor(host,first.id);
  taskFor(host,'Second',['tg:200:2']);
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,pr:'2391',yes:true},ctx));assert.match(out,/more than one open task/);assert.doesNotMatch(out,/^Merged/);
 }finally{await host.harness.lifecycle.dispose();}
});

test('ROUND4 task: current builder task pre-approval permits merge instead of the older task',async()=>{
 const {host}=await deck();try{
  const first=taskFor(host,'First',['tg:200:1']);tasksOf(host).attach(first.id,'thr_cap',{crewId:'old-builder',sourceRefs:[],at:Date.now()});
  const current=taskFor(host,'Current',['tg:200:2']);tasksOf(host).attach(current.id,'thr_cap',{crewId:CREW,sourceRefs:[],at:Date.now()});
  createOwnerGate(host.bb.storage.database()).recordPreApproval({ownerMessageRef:'tg:200:2',quote:'merge after you finish',task:current.id,project:'Cyndra',allows:'merge',createdAt:Date.now()});
  const out=text(await tool(host,'firstmate_merge').execute({crewId:CREW,pr:'2391',yes:true},ctx));assert.match(out,/^Merged/);
 }finally{await host.harness.lifecycle.dispose();}
});
