import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";
import plugin from "./server.ts";
import { manifestSkillIds } from "./scripts/plugin-skill-fixture.mjs";
import { createInboundLedger } from "./lib/inbound-ledger.ts";
import { createOwnerTasks } from "./lib/owner-tasks.ts";
import { createOwnerPromises } from "./lib/owner-promises.ts";

// Owner decisions Q3, Q7 and Q8 (18 Oct): nothing the owner asked for lives only in the captain's head.
// Every owner message is linked to a task or marked "no work", every dispatch and tell lands on a task,
// a dated promise is a record that wakes the captain, and an open PR no task holds is adopted.

type Host = ReturnType<typeof createFakePluginHost>;

const capCtx = { threadId: "thr_cap", projectId: "proj_1" } as never;
const envelope = readFileSync(new URL("./test/fixtures/envelopes/live-owner.txt", import.meta.url), "utf8");

async function captainHost(answerHost: (command: string) => { code?: number; payload?: string } = () => ({ code: 0 })) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: manifestSkillIds(new URL(".", import.meta.url).pathname) });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb); stubProviderCatalog(host);
  await host.harness.behavior.setSettings({ fmHostId: "host_1", repairThreadId: "thr_repair", fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on", asyncDispatch: "on" }) });
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "idle" }));
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_new" }));
  const sent: Array<{ threadId: string; text: string }> = [];
  host.harness.sdk.stub("threads.send", async ({ threadId, input }: { threadId: string; input: Array<{ text?: string }> }) => { sent.push({ threadId, text: input.map((part) => part.text ?? "").join("") }); return {}; });
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Safi", kind: "repo" }));
  host.harness.sdk.stub("plugins.callRpc", async () => ({ ok: true, queued: 1, duplicate: false, mode: "on" }));
  const commands: string[] = [];
  const terminals = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub("terminals.create", async (args: { start: { command: string } }) => { const id = `term${++n}`; terminals.set(id, args.start.command); commands.push(args.start.command); return { id }; });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
    const command = terminals.get(terminalId)!;
    const out = answerHost(command);
    const captured = command.includes("FM_HOST_CAPTURE_V1");
    const payload = captured ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: out.code ?? 0, stdout: out.payload ?? "", stderr: "" }) : out.payload ?? "";
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${payload}\n__FM_HOST_RC:${captured ? 0 : out.code ?? 0}\n`).toString("base64") }] };
  });
  return { host, sent, commands };
}

function tool(host: Host, name: string) {
  const found = host.harness.inspection.registrations.agentTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not registered`);
  return found!;
}

function text(result: unknown): string {
  const raw = typeof result === "string" ? result : (result as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n");
  return raw.replace(/[\s⁡-⁤]+$/u, "");
}

const isError = (result: unknown) => typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;

const ownerSays = (host: Host, messageId: string, words: string) => host.harness.inspection.registrations.hooks["message.dispatch"]!({
  thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
  attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
  input: { blocks: [], text: envelope.replace("telegram_message_id: 1669", `telegram_message_id: ${messageId}`).replace("Status?", words) },
} as never);

const crewPings = (host: Host) => host.harness.inspection.registrations.hooks["message.dispatch"]!({
  thread: makeThreadResponse({ id: "thr_cap", status: "idle" }),
  attempt: "start-turn", initiator: "agent", senderThreadId: null, queuedMessages: [],
  input: { blocks: [], text: "crew c9 finished" },
} as never);

const reply = (host: Host, input: Record<string, unknown>) => tool(host, "firstmate_reply").execute(input, capCtx);
const dispatch = (host: Host, input: Record<string, unknown>) => tool(host, "firstmate_dispatch").execute({ projectId: "proj_1", ...input }, capCtx);
const row = (host: Host, messageId: string) => createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: "200", messageId });
const cli = (host: Host, argv: string[]) => host.harness.behavior.runCli(argv, capCtx) as Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

test("Q7: a reply to an owner message with no task and no 'no work' is refused, names the message, and sends nothing", async () => {
  const { host } = await captainHost();
  try {
    await ownerSays(host, "4389", "All users pay with credits so the monthly add on they can pay it with credits");
    const refused = await reply(host, { ref: "tg:200:4389", text: "Understood." });
    assert.ok(isError(refused));
    assert.equal(text(refused), "Not sent: tg:200:4389 has no owner task. Pass task (T<n>) when it asks for work (dispatch it first, or firstmate_task open), or noWork=true when it asks for none. tg:200:4389 stays open.");
    assert.notEqual(row(host, "4389")?.state, "answered");
    const noWork = await reply(host, { ref: "tg:200:4389", text: "Understood.", noWork: true });
    assert.ok(!isError(noWork), text(noWork));
    assert.equal(row(host, "4389")?.work, "no-work");
    assert.equal(row(host, "4389")?.state, "answered");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Q7: the task an owner message started links it; a reply naming a task records that link for later replies", async () => {
  const { host } = await captainHost();
  try {
    await ownerSays(host, "4463", "The agents not working, fix it asap");
    await dispatch(host, { task: "Fix the agents", taskId: "agents-fix", title: "Fix the agents", sourceRefs: ["tg:200:4463"] });
    assert.ok(!isError(await reply(host, { ref: "tg:200:4463", text: "The agents fail on the proxy; a crew fixes it.", more: true })));
    assert.equal(row(host, "4463")?.work, "T1");
    await ownerSays(host, "4464", "And the logs too");
    assert.ok(!isError(await reply(host, { ref: "tg:200:4464", text: "The same crew reads the logs.", task: "T1", more: true })));
    assert.equal(row(host, "4464")?.work, "T1");
    assert.ok(!isError(await reply(host, { ref: "tg:200:4464", text: "Logs show the proxy timeout." })), "the recorded link holds for the next reply");
    const both = await reply(host, { ref: "tg:200:4463", text: "x", task: "T1", noWork: true });
    assert.ok(isError(both));
    assert.equal(text(both), "Not sent: pass task or noWork, not both. tg:200:4463 stays open.");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Q7: each covered message needs its own task or 'no work'; the reply's own task or noWork covers a plain ref", async () => {
  const { host } = await captainHost();
  try {
    await ownerSays(host, "4479", "Read jasher chat and send him update");
    await dispatch(host, { task: "Update Jasher", taskId: "jasher", title: "Update Jasher", sourceRefs: ["tg:200:4479"] });
    await ownerSays(host, "4480", "with the report md");
    await ownerSays(host, "4481", "thanks");
    // The anchor's task came from its own message, not from this reply: it does not reach a plain cover.
    const refused = await reply(host, { ref: "tg:200:4479", text: "Sent Jasher the update with the report.", covers: ["tg:200:4480"] });
    assert.ok(isError(refused));
    assert.equal(text(refused), "Not sent: tg:200:4480 has no owner task. Pass task (T<n>) when it asks for work (dispatch it first, or firstmate_task open), or noWork=true when it asks for none. tg:200:4479 stays open.");
    const sent = await reply(host, { ref: "tg:200:4479", text: "Sent Jasher the update with the report.", covers: [{ ref: "tg:200:4480", task: "T1" }, { ref: "tg:200:4481", noWork: true }] });
    assert.ok(!isError(sent), text(sent));
    assert.deepEqual(["4479", "4480", "4481"].map((id) => [row(host, id)?.state, row(host, id)?.work]), [["answered", "T1"], ["answered", "T1"], ["answered", "no-work"]]);
    await ownerSays(host, "4482", "ok");
    await ownerSays(host, "4483", "ok ok");
    assert.ok(!isError(await reply(host, { ref: "tg:200:4482", text: "Noted.", noWork: true, covers: ["tg:200:4483"] })));
    assert.equal(row(host, "4483")?.work, "no-work", "a plain cover takes the reply's own noWork");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("R4: a dispatch with origin, or with no owner ref, opens a task; a dispatch in an owner turn takes that turn's one message", async () => {
  const { host } = await captainHost();
  try {
    await crewPings(host);
    const fromThread = await dispatch(host, { task: "Deploy and merge #2155", taskId: "deploy-2155", title: "Deploy + merge #2155", origin: { kind: "thread", threadId: "thr_u6n35axzg5" } });
    assert.match(text(fromThread), / Owner task T1 tracks it /);
    const bare = await dispatch(host, { task: "Clean the host disk", taskId: "disk-clean", title: "Clean the host disk" });
    assert.match(text(bare), / Owner task T2 tracks it /);
    await ownerSays(host, "4437", "Use the proxies that we already have");
    const untagged = await dispatch(host, { task: "Switch the scraper to our proxies", taskId: "proxies", title: "Scraper on our proxies" });
    assert.match(text(untagged), / Owner task T3 tracks it /);
    const tasks = createOwnerTasks(host.bb.storage.database()).list("thr_cap");
    assert.deepEqual(tasks.map((task) => [task.id, task.crewIds, task.sourceRefs]), [
      ["T1", ["deploy-2155"], []], ["T2", ["disk-clean"], []], ["T3", ["proxies"], ["tg:200:4437"]],
    ]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("R4: an owner message passed to an existing crew with firstmate_tell joins that crew's task", async () => {
  const { host } = await captainHost();
  try {
    await ownerSays(host, "4508", "Fix the Metricool sync");
    await dispatch(host, { task: "Fix the Metricool sync", taskId: "metricool", title: "Metricool sync", sourceRefs: ["tg:200:4508"] });
    await ownerSays(host, "4516", "send the report md too");
    // The background spawn records the crew a few ticks after the dispatch returns.
    let told: unknown;
    for (let i = 0; i < 200; i++) {
      told = await tool(host, "firstmate_tell").execute({ crewId: "metricool", message: "Also send the report md.", sourceRefs: ["tg:200:4516"] }, capCtx);
      if (!text(told).startsWith("No crew")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(text(told), / Owner message tg:200:4516 is on owner task T1\.$/);
    assert.deepEqual(createOwnerTasks(host.bb.storage.database()).get("T1")?.sourceRefs, ["tg:200:4508", "tg:200:4516"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Q8: a promise on a reply is a record on the board that wakes the captain once at its time", async (t) => {
  const { host, sent } = await captainHost();
  try {
    const start = Date.now();
    await ownerSays(host, "5540", "Tell me when BB is back");
    const by = new Date(start + 125 * 60_000).toISOString();
    const replied = await reply(host, { ref: "tg:200:5540", text: "I will tell you when the rollout settles.", noWork: true, promise: { by, what: "Tell the owner BB is back after the 0.46.1 rollout" } });
    assert.ok(!isError(replied), text(replied));
    assert.match(text(replied), /Promise P1 is recorded: the captain is woken at /);
    const promises = createOwnerPromises(host.bb.storage.database());
    assert.deepEqual(promises.list("thr_cap").map((p) => [p.id, p.ref, p.what, p.state]), [["P1", "tg:200:5540", "Tell the owner BB is back after the 0.46.1 rollout", "open"]]);
    const boardRpc = await host.harness.behavior.callRpc("telegramCommand", { command: "board", threadId: "thr_cap" }) as { text: string; promises?: Array<{ id: string; by: number; what: string }> };
    assert.deepEqual(boardRpc.promises?.map((p) => [p.id, p.by, p.what]), [["P1", Date.parse(by), "Tell the owner BB is back after the 0.46.1 rollout"]]);
    assert.match(boardRpc.text, /⏰ Promised \(1\)\n- P1 · Tell the owner BB is back after the 0\.46\.1 rollout — due in 2 h/);
    const idle = () => host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    await idle();
    assert.equal(sent.filter((s) => s.text.includes("P1")).length, 0, "not due yet");
    t.mock.method(Date, "now", () => start + 125 * 60_000 + 1000);
    await idle();
    await idle();
    const wakes = sent.filter((s) => s.threadId === "thr_cap" && s.text.includes("Promise P1 is due"));
    assert.equal(wakes.length, 1, "one wake per promise");
    assert.match(wakes[0]!.text, /Promise P1 is due: Tell the owner BB is back after the 0\.46\.1 rollout \(promised in reply to tg:200:5540\)\. Do it now, or tell the owner the new time; then close it with firstmate_promise\./);
    const kept = await tool(host, "firstmate_promise").execute({ action: "kept", id: "P1", reason: "Told the owner" }, capCtx);
    assert.equal(text(kept), "Promise P1 is kept.");
    assert.deepEqual(promises.list("thr_cap"), []);
    const past = await reply(host, { ref: "tg:200:5540", text: "Later.", noWork: true, promise: { by: "2020-01-01T00:00:00Z", what: "x" } });
    assert.ok(isError(past));
    assert.match(text(past), /^Not sent: promise\.by 2020-01-01T00:00:00Z is in the past\./);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Q8: the follow-ups import is a dry run until --apply, and applying twice records each promise once", async () => {
  const followups = [
    "- 2551 Stripe renewals: W4 is due 21 Oct 2099 about 14:40 UTC.",
    "- PR 2547 contains PR 2534. When 2547 merges, close 2534. (17 Oct 2020)",
    "- 2099-10-24 22:13 UTC: delete S2.",
  ].join("\n");
  const { host } = await captainHost();
  host.harness.sdk.stub("files.read", async ({ path }: { path: string }) => {
    if (path === "/homes/cap/data/followups.md") return { content: followups };
    throw new Error("ENOENT");
  });
  try {
    await host.bb.storage.kv.set("native-home:thr_cap", "/homes/cap");
    const dry = await cli(host, ["promises", "import", "--captain", "thr_cap"]);
    assert.equal(dry.exitCode, 0, dry.stderr);
    assert.match(dry.stdout ?? "", /^Dry run: 2 dated promises in \/homes\/cap\/data\/followups\.md for thr_cap; nothing recorded\./);
    assert.match(dry.stdout ?? "", /line 1 · 2099-10-21T14:40Z · 2551 Stripe renewals/);
    assert.match(dry.stdout ?? "", /Not dated \(1\): line 2/);
    const promises = createOwnerPromises(host.bb.storage.database());
    assert.deepEqual(promises.list("thr_cap"), []);
    const applied = await cli(host, ["promises", "import", "--captain", "thr_cap", "--apply", "--skip", "3"]);
    assert.match(applied.stdout ?? "", /^Recorded 1 promise for thr_cap \(1 skipped on request\)\./);
    await cli(host, ["promises", "import", "--captain", "thr_cap", "--apply"]);
    assert.deepEqual(promises.list("thr_cap").map((p) => [p.id, p.source, new Date(p.by).toISOString()]), [
      ["P1", "followups", "2099-10-21T14:40:00.000Z"], ["P2", "followups", "2099-10-24T22:13:00.000Z"],
    ]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Q3: the hourly sweep adopts every open PR no open task links, wakes the captain once, and lists an unlisted repo to the repair thread once", async () => {
  const search = [
    { url: "https://github.com/amrtawfik160/Safi/pull/41", title: "Legend dashes", createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z", draft: false },
    { url: "https://github.com/amrtawfik160/Safi/pull/42", title: "Glass glitch", createdAt: "2026-10-03T10:00:00Z", updatedAt: "2026-10-04T10:00:00Z", draft: false },
    { url: "https://github.com/xtawfik/parknwash-api/pull/7", title: "Coupons", createdAt: "2026-10-05T10:00:00Z", updatedAt: "2026-10-06T10:00:00Z", draft: true },
    { url: "https://github.com/someone/side-project/pull/3", title: "Side", createdAt: "2026-10-05T10:00:00Z", updatedAt: "2026-10-06T10:00:00Z", draft: false },
  ].map((item) => JSON.stringify(item)).join("\n");
  const { host, sent, commands } = await captainHost((command) => command.includes("search/issues") ? { payload: search } : { code: 0 });
  try {
    await ownerSays(host, "4402", "Fix the glass glitch");
    await dispatch(host, { task: "Fix the glass glitch", taskId: "glass", title: "Glass glitch", sourceRefs: ["tg:200:4402"] });
    await tool(host, "firstmate_task").execute({ action: "link", id: "T1", pr: "amrtawfik160/safi#42" }, capCtx);
    const swept = await cli(host, ["prs", "sweep"]);
    assert.equal(swept.exitCode, 0, swept.stderr);
    const searches = commands.filter((c) => c.includes("search/issues"));
    assert.equal(searches.length, 3, "two searches over the listed repos and one for this account's own PRs, one page each");
    assert.ok(searches.some((c) => c.includes("repo:amrtawfik160/safi") && c.includes("user:cyndra-ai")) && searches.some((c) => c.includes("author:@me")), searches.join("\n"));
    const tasks = createOwnerTasks(host.bb.storage.database()).list("thr_cap");
    assert.deepEqual(tasks.map((task) => [task.id, task.state, task.prs, task.project]), [
      ["T1", "working", ["amrtawfik160/safi#42"], "Safi"],
      ["T2", "check", ["amrtawfik160/safi#41"], "Safi"],
      ["T3", "check", ["xtawfik/parknwash-api#7"], "Parknwash"],
    ]);
    assert.equal(tasks[1]!.outcome, "Adopted open PR https://github.com/amrtawfik160/safi/pull/41 that no task tracked. Next: decide merge, fix or close it.");
    const wakes = sent.filter((s) => s.threadId === "thr_cap" && s.text.includes("Adopted"));
    assert.equal(wakes.length, 1, "one captain wake for the sweep");
    assert.match(wakes[0]!.text, /^Adopted 2 open PRs that no task tracked; each is now a task in "check"\. Give each a next step: merge, fix, or close\.\n- T2 · Safi · amrtawfik160\/safi#41 Legend dashes, opened 2026-10-01\n- T3 · Parknwash · xtawfik\/parknwash-api#7 Coupons \(draft\), opened 2026-10-05\n/);
    const repair = sent.filter((s) => s.threadId === "thr_repair");
    assert.equal(repair.length, 1);
    assert.equal(repair[0]!.text, "Firstmate: open PRs in repos no project in owner/projects.json lists, so no task adopts them: someone/side-project (1 open PR). Add the repo to a project, or leave it out on purpose.");
    await host.bb.storage.kv.delete("stray-pr-sweep-at");
    await cli(host, ["prs", "sweep"]);
    assert.equal(createOwnerTasks(host.bb.storage.database()).list("thr_cap").length, 3, "an adopted PR is not adopted again");
    assert.equal(sent.filter((s) => s.threadId === "thr_cap" && s.text.includes("Adopted")).length, 1, "no wake when nothing is adopted");
    assert.equal(sent.filter((s) => s.threadId === "thr_repair").length, 1, "an unlisted repo is listed once");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Checker round 1 (161-verdict-1.md): its fixtures, kept as written.
const idle = (host: Host) => host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });

test("checker: connector reconciliation must not close an unclassified owner message", async () => {
 const {host}=await captainHost();
 try {
  await ownerSays(host,"7001","Implement the feature");
  host.harness.sdk.stub("plugins.callRpc", async ({method}: {method:string}) => method === "replied" ? {replied:["7001"]} : {ok:true,queued:1,duplicate:false,mode:"on"});
  await idle(host);
  const current=row(host,"7001");
  assert.ok(current?.state !== "answered" || current.work, JSON.stringify(current));
 } finally {await host.harness.lifecycle.dispose();}
});

test("checker: an edited answered owner message must reopen for fresh classification", async () => {
 const {host}=await captainHost();
 try {
  await ownerSays(host,"7002","Thanks");
  await reply(host,{ref:"tg:200:7002",text:"You are welcome.",noWork:true});
  await ownerSays(host,"7002","Build the payment flow");
  assert.notEqual(row(host,"7002")?.state,"answered",JSON.stringify(row(host,"7002")));
 } finally {await host.harness.lifecycle.dispose();}
});

test("checker: concurrent due checks send one reminder", async () => {
 const {host,sent}=await captainHost();
 try {
  createOwnerPromises(host.bb.storage.database()).add({captain:"thr_cap",by:Date.now()-1000,what:"Concurrent check",ref:null,task:null,source:"reply",at:Date.now()-2000});
  await Promise.all([idle(host),idle(host)]);
  assert.equal(sent.filter(s=>s.text.includes("Promise P1 is due")).length,1);
 } finally {await host.harness.lifecycle.dispose();}
});

test("checker: PR already held by a crew delivery needs no duplicate owner task", async () => {
 const search=JSON.stringify({url:"https://github.com/amrtawfik160/Safi/pull/77",title:"Existing crew PR"});
 const {host}=await captainHost(command=>command.includes("search/issues")?{payload:search}:{code:0});
 try {
  const {createDeliveries}=await import("./lib/pr-delivery.ts");
  const ledger=createDeliveries(host.bb.storage.database());
  ledger.register({url:"https://github.com/amrtawfik160/Safi/pull/77",taskId:"legacy-crew",owner:"thr_cap",projectId:"proj_1",home:"/tmp/legacy",worker:"thr_legacy"});
  await cli(host,["prs","sweep"]);
  const tasks=createOwnerTasks(host.bb.storage.database()).list("thr_cap");
  assert.ok(tasks.length===0 || tasks.every(t=>t.crewIds.includes("legacy-crew")),JSON.stringify(tasks));
 } finally {await host.harness.lifecycle.dispose();}
});

test("checker: first sweep with 28 PRs emits one captain wake and no connector messages", async () => {
 const search=Array.from({length:28},(_,i)=>JSON.stringify({url:`https://github.com/amrtawfik160/Safi/pull/${100+i}`,title:`Change ${i}`})).join("\n");
 const {host,sent}=await captainHost(command=>command.includes("search/issues")?{payload:search}:{code:0});
 let connectorSends=0;
 host.harness.sdk.stub("plugins.callRpc",async({method}: {method:string})=>{if(method!=="refreshBoard") connectorSends++;return {ok:true,queued:1,duplicate:false,mode:"on"};});
 try {
  const result=await cli(host,["prs","sweep"]);
  assert.equal(result.exitCode,0,result.stderr);
  assert.equal(createOwnerTasks(host.bb.storage.database()).list("thr_cap").length,28);
  assert.equal(sent.filter(s=>s.threadId==="thr_cap"&&s.text.includes("Adopted")).length,1);
  assert.equal(connectorSends,0);
 } finally {await host.harness.lifecycle.dispose();}
});

test("checker: an interrupted promise insert is recoverable by repeating the same reply", async () => {
 const {host}=await captainHost();
 try {
  await ownerSays(host,"7003","Check tomorrow");
  const db=host.bb.storage.database();
  db.exec("CREATE TRIGGER checker_insert_failure BEFORE INSERT ON owner_promise BEGIN SELECT RAISE(ABORT, 'injected promise write failure'); END");
  const args={ref:"tg:200:7003",text:"I will check tomorrow.",noWork:true,promise:{by:new Date(Date.now()+86400000).toISOString(),what:"Check tomorrow"}};
  try {await reply(host,args);} catch {}
  db.exec("DROP TRIGGER checker_insert_failure");
  await reply(host,args);
  assert.equal(createOwnerPromises(db).list("thr_cap").length,1);
 } finally {await host.harness.lifecycle.dispose();}
});


test("checker: every listed-repo PR is swept, including a collaborator PR", async () => {
 const external=JSON.stringify({url:"https://github.com/amrtawfik160/Safi/pull/88",title:"Collaborator change"});
 const {host}=await captainHost(command=>command.includes("search/issues") ? {payload:command.includes("author:@me")?"":external} : {code:0});
 try {
  await cli(host,["prs","sweep"]);
  assert.ok(createOwnerTasks(host.bb.storage.database()).list("thr_cap").some(t=>t.prs.includes("amrtawfik160/safi#88")),"An open collaborator PR in a listed repo must be adopted");
 } finally {await host.harness.lifecycle.dispose();}
});


test("checker: promise persistence survives reopening an isolated database", async () => {
 const {DatabaseSync}=await import("node:sqlite");
 const {mkdtempSync,rmSync}=await import("node:fs");
 const dir=mkdtempSync("/tmp/verify161-promise-");
 const connect=()=>{const raw=new DatabaseSync(`${dir}/promises.sqlite`);return Object.assign(raw,{transaction:<T>(fn:()=>T)=>()=>{raw.exec("BEGIN");try{const out=fn();raw.exec("COMMIT");return out;}catch(error){raw.exec("ROLLBACK");throw error;}}});};
 let db=connect();
 try {
  createOwnerPromises(db).add({captain:"thr_cap",by:1000,what:"Survive reload",ref:null,task:null,source:"reply",at:0});
  db.close();db=connect();
  let promises=createOwnerPromises(db);
  assert.equal(promises.due("thr_cap",1000).length,1);
  promises.markWoken(["P1"],1000);
  db.close();db=connect();promises=createOwnerPromises(db);
  assert.equal(promises.due("thr_cap",2000).length,0);
  promises.close("P1","thr_cap","kept","Checked",2000);
  assert.equal(promises.list("thr_cap").length,0);
 } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test("checker: replay after classification write failure cannot close an unclassified message", async () => {
 const {host}=await captainHost();
 try {
  await ownerSays(host,"7004","Thanks");
  const db=host.bb.storage.database();
  db.exec("CREATE TRIGGER checker_work_failure BEFORE UPDATE ON inbound_ledger WHEN json_extract(NEW.record, '$.work') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected work write failure'); END");
  const args={ref:"tg:200:7004",text:"You are welcome.",noWork:true};
  assert.ok(isError(await reply(host,args)));
  db.exec("DROP TRIGGER checker_work_failure");
  await reply(host,args);
  const current=row(host,"7004");
  assert.ok(current?.state!=="answered" || current.work,JSON.stringify(current));
 } finally {await host.harness.lifecycle.dispose();}
});

test("checker round 1, finding 7: each search page is its own charged read, and paging stops at a short page", async () => {
  const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => JSON.stringify({ url: `https://github.com/amrtawfik160/Safi/pull/${n * 1000 + i}`, title: `P${n}-${i}` })).join("\n");
  const { host, commands } = await captainHost((command) => {
    if (!command.includes("search/issues")) return { code: 0 };
    if (!command.includes("repo:amrtawfik160/dr.woo")) return { payload: "" };
    return { payload: command.includes("page=1 ") ? page(1, 100) : command.includes("page=2 ") ? page(2, 100) : page(3, 1) };
  });
  try {
    await cli(host, ["prs", "sweep"]);
    const reads = commands.filter((c) => c.includes("search/issues"));
    assert.deepEqual(reads.filter((c) => c.includes("repo:amrtawfik160/dr.woo")).map((c) => /-f page=(\d+)/.exec(c)?.[1]), ["1", "2", "3"], "201 PRs are three page reads");
    assert.equal(reads.length, 5, "three pages, then one page for each other query");
    assert.equal(createOwnerTasks(host.bb.storage.database()).list("thr_cap").length, 201);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("checker round 1, finding 1: a message the connector answered stays open until its link is recorded, and the reply sends nothing again", async () => {
  const { host } = await captainHost();
  const calls: string[] = [];
  host.harness.sdk.stub("plugins.callRpc", async ({ method }: { method: string }) => { calls.push(method); return method === "replied" ? { replied: ["7011"] } : { ok: true, queued: 1, duplicate: false, mode: "on" }; });
  try {
    await ownerSays(host, "7011", "Implement the feature");
    await idle(host);
    assert.equal(row(host, "7011")?.state, "acked");
    assert.ok(row(host, "7011")?.repliedAt);
    const before = calls.filter((m) => m === "reply").length;
    const linked = await reply(host, { ref: "tg:200:7011", text: "Noted.", noWork: true });
    assert.equal(text(linked), "Not sent again: the connector already answered tg:200:7011. Its link (no-work) is recorded and it is closed.");
    assert.equal(calls.filter((m) => m === "reply").length, before, "no second Telegram reply");
    assert.deepEqual([row(host, "7011")?.state, row(host, "7011")?.work], ["answered", "no-work"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Checker round 2 (161-verdict-2.md), finding 2, kept as written.
test("round 2: an edit inside a batch must reopen an answered message", async () => {
 const {host}=await captainHost();
 try {
  await ownerSays(host,"8001","Thanks");
  await reply(host,{ref:"tg:200:8001",text:"You are welcome.",noWork:true});
  const text=envelope.replace("telegram_message_id: 1669","telegram_message_id: 8001\ntelegram_message_ids: 8001,8002\ntelegram_items: 8001=text 8002=text").replace("Status?","Build the payment flow");
  await host.harness.inspection.registrations.hooks["message.dispatch"]!({thread:makeThreadResponse({id:"thr_cap",status:"active"}),attempt:"join-turn",initiator:"user",senderThreadId:null,queuedMessages:[],input:{blocks:[],text}} as never);
  assert.notEqual(row(host,"8001")?.state,"answered",JSON.stringify(row(host,"8001")));
 } finally {await host.harness.lifecycle.dispose();}
});

test("round 2: first edit of a pre-upgrade answered row must reopen it", async () => {
 const {host}=await captainHost();
 try {
  await ownerSays(host,"8003","Thanks");
  await reply(host,{ref:"tg:200:8003",text:"You are welcome.",noWork:true});
  const old=row(host,"8003")!;
  delete old.bodyHash;
  host.bb.storage.database().prepare("UPDATE inbound_ledger SET record=? WHERE message_id=?").run(JSON.stringify(old),"8003");
  // Round 4: a pre-upgrade row reopens only on a real edit, which carries Telegram's edit date.
  const edited=envelope.replace("telegram_message_id: 1669","telegram_message_id: 8003\ntelegram_edit_date: 1792500000").replace("Status?","Build the payment flow");
  await host.harness.inspection.registrations.hooks["message.dispatch"]!({thread:makeThreadResponse({id:"thr_cap",status:"active"}),attempt:"join-turn",initiator:"user",senderThreadId:null,queuedMessages:[],input:{blocks:[],text:edited}} as never);
  assert.notEqual(row(host,"8003")?.state,"answered",JSON.stringify(row(host,"8003")));
 } finally {await host.harness.lifecycle.dispose();}
});

// Checker round 3 (161-verdict-3.md), kept as written.
test("round 3: a legacy message edited after its 80-character preview must reopen", async () => {
 const {host}=await captainHost();
 try {
  const prefix="For the weekly report, keep the existing context and the earlier notes available for reference. ";
  await ownerSays(host,"8101",prefix+"No action is needed.");
  await reply(host,{ref:"tg:200:8101",text:"Understood.",noWork:true});
  const old=row(host,"8101")!;
  delete old.bodyHash;
  host.bb.storage.database().prepare("UPDATE inbound_ledger SET record=? WHERE message_id=?").run(JSON.stringify(old),"8101");
  // Round 4: a legacy row reopens only on a real edit, which carries the edit marker (Telegram's edit_date).
  const edited=envelope.replace("telegram_message_id: 1669","telegram_message_id: 8101\ntelegram_edit_date: 1792500000").replace("Status?",prefix+"Also build the payment flow.");
  await host.harness.inspection.registrations.hooks["message.dispatch"]!({thread:makeThreadResponse({id:"thr_cap",status:"active"}),attempt:"join-turn",initiator:"user",senderThreadId:null,queuedMessages:[],input:{blocks:[],text:edited}} as never);
  assert.notEqual(row(host,"8101")?.state,"answered",JSON.stringify(row(host,"8101")));
 } finally {await host.harness.lifecycle.dispose();}
});

// Checker round 4 (161-verdict-4.md), kept as written.
test("round 4: identical replay of an answered legacy message must stay answered", async () => {
 const {host}=await captainHost();
 try {
  await ownerSays(host,"8201","Thanks for the report");
  await reply(host,{ref:"tg:200:8201",text:"You are welcome.",noWork:true});
  const old=row(host,"8201")!;
  delete old.bodyHash;
  host.bb.storage.database().prepare("UPDATE inbound_ledger SET record=? WHERE message_id=?").run(JSON.stringify(old),"8201");
  await ownerSays(host,"8201","Thanks for the report");
  const replayed=row(host,"8201")!;
  assert.equal(replayed.textHash,old.textHash,"The full incoming envelope is identical, so this is a replay, not an edit");
  assert.deepEqual([replayed.state,replayed.work],["answered","no-work"]);
 } finally {await host.harness.lifecycle.dispose();}
});

test("round 4: identical replay of a message with a body hash stays answered", async () => {
 const {host}=await captainHost();
 try {
  await ownerSays(host,"8202","Thanks for the report");
  await reply(host,{ref:"tg:200:8202",text:"You are welcome.",noWork:true});
  await ownerSays(host,"8202","Thanks for the report");
  assert.deepEqual([row(host,"8202")?.state,row(host,"8202")?.work],["answered","no-work"]);
 } finally {await host.harness.lifecycle.dispose();}
});

test("round 4: a legacy row reopens once per newer edit; the same edit replayed does not reopen it again", async () => {
  const { host } = await captainHost();
  try {
    await ownerSays(host, "8203", "Thanks");
    await reply(host, { ref: "tg:200:8203", text: "You are welcome.", noWork: true });
    const old = row(host, "8203")!;
    delete old.bodyHash;
    host.bb.storage.database().prepare("UPDATE inbound_ledger SET record=? WHERE message_id=?").run(JSON.stringify(old), "8203");
    const edit = (at: number, words: string) => host.harness.inspection.registrations.hooks["message.dispatch"]!({ thread: makeThreadResponse({ id: "thr_cap", status: "active" }), attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
      input: { blocks: [], text: envelope.replace("telegram_message_id: 1669", `telegram_message_id: 8203\ntelegram_edit_date: ${at}`).replace("Status?", words) } } as never);
    await edit(1792500000, "Build the payment flow");
    assert.equal(row(host, "8203")?.state, "acked");
    await reply(host, { ref: "tg:200:8203", text: "A crew builds it.", noWork: true });
    await edit(1792500000, "Build the payment flow");
    assert.deepEqual([row(host, "8203")?.state, row(host, "8203")?.work], ["answered", "no-work"], "the same edit again is a replay");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
