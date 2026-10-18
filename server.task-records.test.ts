import assert from "node:assert/strict";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { manifestSkillIds } from "./scripts/plugin-skill-fixture.mjs";
import { createInboundLedger } from "./lib/inbound-ledger.ts";

type Host = ReturnType<typeof createFakePluginHost>;
type Rpc = { pluginId: string; method: string; input: Record<string, unknown> };

const capCtx = { threadId: "thr_cap", projectId: "proj_cyndra" } as never;
const envelope = readFileSync(new URL("./test/fixtures/envelopes/live-owner.txt", import.meta.url), "utf8");
const PROJECTS: Record<string, string> = { proj_cyndra: "Cyndra SaaS", proj_woo: "woo-app" };

/** A captain thread in the Cyndra SaaS project, as on 17 Oct, and a Telegram connector that records every call. */
async function captainHost(otherCaptains: string[] = []) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: manifestSkillIds(new URL(".", import.meta.url).pathname) });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_cyndra");
  for (const other of otherCaptains) await host.bb.storage.kv.set(`captain-project:${other}`, "proj_woo");
  await plugin(host.bb); stubProviderCatalog(host);
  await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on", asyncDispatch: "on" }) });
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_cyndra", status: "starting" }));
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_new" }));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("projects.get", async ({ projectId }: { projectId: string }) => ({ id: projectId, name: PROJECTS[projectId] ?? projectId, kind: "repo" }));
  const calls: Rpc[] = [];
  host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
    calls.push(args);
    return { ok: true, queued: 1, duplicate: false, mode: "on" };
  });
  return { host, calls };
}

function tool(host: Host, name: string) {
  const found = host.harness.inspection.registrations.agentTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not registered`);
  return found!;
}

const isErrorResult = (result: unknown) => typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;

function text(result: unknown): string {
  const raw = typeof result === "string" ? result : (result as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n");
  return raw.replace(/[\s⁡-⁤]+$/u, "");
}

/** The Telegram connector hands one owner message to the captain's running turn. */
const ownerSays = (host: Host, messageId: string, words: string) => host.harness.inspection.registrations.hooks["message.dispatch"]!({
  thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
  attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
  input: { blocks: [], text: envelope.replace("telegram_message_id: 1669", `telegram_message_id: ${messageId}`).replace("Status?", words) },
} as never);

const tasks = async (host: Host) => (await host.harness.behavior.callRpc("telegramCommand", { command: "tasks", threadId: "thr_cap" }) as { tasks: Array<Record<string, unknown>> }).tasks;

test("17 Oct repro: two owner messages in one turn each keep their own task; the Dr Woo crews are tracked under the woo-app project id, not the captain's", async () => {
  const { host } = await captainHost();
  try {
    await ownerSays(host, "5438", "Redesign the Dr Woo app with two crews");
    await ownerSays(host, "5439", "Review the inactive agents and their costs");
    const gemini = await tool(host, "firstmate_dispatch").execute({ projectId: "proj_woo", task: "Dr Woo redesign on Gemini", taskId: "woo-gemini", title: "Dr Woo redesign", sourceRefs: ["tg:200:5438"] }, capCtx);
    const grok = await tool(host, "firstmate_dispatch").execute({ projectId: "proj_woo", task: "Dr Woo redesign on Grok", taskId: "woo-grok", title: "Dr Woo redesign", sourceRefs: ["tg:200:5438"], taskRef: "T1" }, capCtx);
    const review = await tool(host, "firstmate_dispatch").execute({ projectId: "proj_cyndra", task: "Inactive agents review", taskId: "agents-review", title: "Inactive agents review", sourceRefs: ["tg:200:5439"] }, capCtx);
    assert.doesNotMatch(text(gemini), /no owner task tracks this crew/, text(gemini));
    assert.match(text(gemini), /Owner task T1 tracks it/);
    assert.match(text(grok), /Owner task T1 \(working\) tracks it/);
    assert.match(text(review), /Owner task T2 tracks it/);
    const listed = await tasks(host);
    const woo = listed.find((task) => task.id === "T1")!;
    assert.deepEqual({ projectId: woo.projectId, project: woo.project, refs: woo.refs }, { projectId: "proj_woo", project: "woo-app", refs: ["tg:200:5438"] }, "the task carries its crews' BB project id, and only its own owner message");
    assert.equal(woo.crews, 2, "both crews count while they start: the line never says 0 crews");
    assert.deepEqual(listed.find((task) => task.id === "T2")!.refs, ["tg:200:5439"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a task opened by hand has no project until its first crew, then takes the crew's project, never the captain thread's", async () => {
  const { host } = await captainHost();
  try {
    await ownerSays(host, "5500", "Check the Dr Woo build");
    const opened = await tool(host, "firstmate_task").execute({ action: "open", title: "Dr Woo build check", refs: ["tg:200:5500"] }, capCtx);
    assert.equal(text(opened), "Task T1 is open (working).");
    assert.deepEqual((await tasks(host)).map((task) => [task.projectId, task.project]), [[null, null]], "not Cyndra SaaS, the captain thread's project");
    await tool(host, "firstmate_dispatch").execute({ projectId: "proj_woo", task: "Check the Dr Woo build", taskId: "woo-check", taskRef: "T1" }, capCtx);
    assert.deepEqual((await tasks(host)).map((task) => [task.projectId, task.project, task.crews]), [["proj_woo", "woo-app", 1]]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply result=true sends the task's result to its first owner message; firstmate_alert sends a typed alarm", async () => {
  const { host, calls } = await captainHost();
  try {
    await ownerSays(host, "5600", "Ship Safi build 21");
    await tool(host, "firstmate_dispatch").execute({ projectId: "proj_woo", task: "Ship it", taskId: "ship-21", title: "Safi build 21", sourceRefs: ["tg:200:5600"] }, capCtx);
    assert.equal((await tasks(host))[0]!.projectId, "proj_woo", "the dispatch that opens a task records its crew's project");
    const replied = await tool(host, "firstmate_reply").execute({ task: "T1", result: true, text: "Build 21 is in TestFlight, in the public group." }, capCtx);
    assert.match(text(replied), /^Replied to tg:200:5600/, text(replied));
    const reply = calls.find((call) => call.method === "reply" && call.input.kind !== "ack")!;
    assert.deepEqual({ messageId: reply.input.messageId, task: reply.input.task, result: reply.input.result }, { messageId: "5600", task: "T1", result: true });

    const alerted = await tool(host, "firstmate_alert").execute({ level: "alarm", text: "Safi is down for all users.", task: "T1", incident: "safi-down-1" }, capCtx);
    assert.equal(text(alerted), "Sent the alarm to the owner in task T1's topic.");
    const alert = calls.find((call) => call.method === "alert")!;
    assert.deepEqual({ level: alert.input.level, text: alert.input.text, task: alert.input.task }, { level: "alarm", text: "Safi is down for all users.", task: "T1" });
    assert.match(String(alert.input.alertId), /^[0-9a-f]{32}$/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a refused second result tells the captain, and nothing is recorded as delivered", async () => {
  const { host } = await captainHost();
  try {
    host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => (args.method === "reply" ? { queued: 0, duplicate: false, mode: "on", refused: "result" } : { ok: true }));
    await ownerSays(host, "5700", "Ship it");
    await tool(host, "firstmate_dispatch").execute({ projectId: "proj_woo", task: "Ship it", taskId: "ship-it", title: "Ship it", sourceRefs: ["tg:200:5700"] }, capCtx);
    const replied = await tool(host, "firstmate_reply").execute({ task: "T1", result: true, text: "Shipped again." }, capCtx);
    assert.match(text(replied), /already has its result/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the captain's Telegram guide says free text never reaches the owner and names the tool for each message", () => {
  const guide = readFileSync(new URL("./entry-skills/captain/references/telegram.md", import.meta.url), "utf8");
  assert.match(guide, /It never reaches Telegram, with\s+topics on or off/);
  for (const name of ["firstmate_reply", "result=true", "firstmate_ask", "firstmate_alert"]) assert.ok(guide.includes(name), name);
  assert.doesNotMatch(guide, /final text already\s+reaches Telegram/);
});

// Round 2 of the independent check (FF1-verdict-1.md).

test("check F1: an alarm's identity is its incident and project: the same words for two projects or two incidents are two alarms; a retry of one incident is one", async () => {
  const { host, calls } = await captainHost();
  try {
    await ownerSays(host, "5800", "hi");
    const alert = (input: Record<string, unknown>) => tool(host, "firstmate_alert").execute({ level: "alarm", text: "Production is unavailable.", ...input }, capCtx);
    await alert({ project: "Dr Woo", incident: "woo-outage-17oct" });
    await alert({ project: "Cyndra", incident: "cyndra-outage-17oct" });
    await alert({ project: "Cyndra", incident: "cyndra-outage-18oct" });
    await alert({ project: "Cyndra", incident: "cyndra-outage-18oct" });
    const ids = calls.filter((call) => call.method === "alert").map((call) => String(call.input.alertId));
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids.slice(0, 3)).size, 3, "two projects, two incidents: three alarms");
    assert.equal(ids[3], ids[2], "the retry of one incident keeps its id");
    assert.ok(isErrorResult(await tool(host, "firstmate_alert").execute({ level: "alarm", text: "x" }, capCtx)), "an incident id is required");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("check F2: with a connector that has no alert method yet, the alarm goes out as a card the old connector sends", async () => {
  const { host, calls } = await captainHost();
  try {
    host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
      calls.push(args);
      if (args.method === "alert") throw Object.assign(new Error('plugin "telegram" has no rpc method "alert"'), { code: "unknown_method" });
      return { ok: true, queued: 1, duplicate: false, mode: "on" };
    });
    await ownerSays(host, "5900", "hi");
    const sent = await tool(host, "firstmate_alert").execute({ level: "alarm", text: "Safi is down for all users.", project: "Safi", incident: "safi-down" }, capCtx);
    assert.match(text(sent), /as a card/);
    const card = calls.find((call) => call.method === "ask")!;
    assert.ok(card, "the old connector's ask method carries it");
    assert.match(String(card.input.text), /^🚨 Safi is down for all users\./);
    assert.equal(card.input.project, "Safi");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("check T4: a reply the connector reports undelivered reopens the owner message and tells the captain", async () => {
  const { host, calls } = await captainHost();
  try {
    let undelivered = [{ chatId: "200", messageId: "6000", reason: "Telegram refused the message: Bad Request" }];
    host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
      calls.push(args);
      if (args.method === "undelivered") { const rows = undelivered; undelivered = []; return { undelivered: rows }; }
      if (args.method === "replied") return { replied: [] };
      if (args.method === "freeText") return { obligations: [] };
      return { ok: true, queued: 1, duplicate: false, mode: "on" };
    });
    await ownerSays(host, "6000", "Status?");
    await tool(host, "firstmate_reply").execute({ ref: "tg:200:6000", text: "All green." }, capCtx);
    assert.equal(createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: "200", messageId: "6000" })?.state, "answered");
    const sends: string[] = [];
    host.harness.sdk.stub("threads.send", async (args: { input: Array<{ text: string }> }) => { sends.push(args.input[0]?.text ?? ""); return {}; });
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    assert.notEqual(createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: "200", messageId: "6000" })?.state, "answered", "open again");
    assert.ok(sends.some((line) => /tg:200:6000/.test(line) && /not delivered/i.test(line)), sends.join("\n"));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("free-text safety: the captain is told of each free text the connector holds, by its ref, and resolves it with firstmate_free_text", async () => {
  const { host, calls } = await captainHost();
  try {
    let obligations = [{ ref: "agent:i9", text: "Safi is down: Convex disabled the account.", at: 1 }];
    host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
      calls.push(args);
      // As the connector: each is returned again until ackFreeText confirms the tell.
      if (args.method === "freeText") return { obligations, captainThreadId: "thr_cap" };
      if (args.method === "ackFreeText") { obligations = []; return { told: 1 }; }
      if (args.method === "undelivered") return { undelivered: [] };
      if (args.method === "replied") return { replied: [] };
      if (args.method === "resolveFreeText") return { resolved: (args.input.refs as string[]).length };
      return { ok: true, queued: 1, duplicate: false, mode: "on" };
    });
    await ownerSays(host, "6100", "hi");
    const sends: string[] = [];
    host.harness.sdk.stub("threads.send", async (args: { input: Array<{ text: string }> }) => { sends.push(args.input[0]?.text ?? ""); return {}; });
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    assert.ok(!sends.some((line) => line.includes("agent:i9")), "an idle starts no reminder turn of its own");
    // The reminder rides on the captain's next real wake.
    await host.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_cap", status: "active" }) });
    const told = sends.find((line) => line.includes("agent:i9"));
    assert.ok(told, sends.join("\n"));
    assert.match(told!, /firstmate_free_text/);
    const resolved = await tool(host, "firstmate_free_text").execute({ refs: ["agent:i9"], disposition: "no-send" }, capCtx);
    assert.match(text(resolved), /1/);
    assert.deepEqual(calls.find((call) => call.method === "resolveFreeText")!.input, { refs: ["agent:i9"], disposition: "no-send" });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("check round 2: a free text is confirmed to the connector only after the captain was told; a failed tell is tried again", async () => {
  const { host, calls } = await captainHost();
  try {
    const due = [{ ref: "agent:i9", text: "Safi is down: Convex disabled the account.", at: 1 }];
    let acked: string[] = [];
    host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
      calls.push(args);
      if (args.method === "freeText") return { obligations: due.filter((row) => !acked.includes(row.ref)), captainThreadId: "thr_cap" };
      if (args.method === "ackFreeText") { acked = [...acked, ...(args.input.refs as string[])]; return { told: (args.input.refs as string[]).length }; }
      if (args.method === "undelivered") return { undelivered: [] };
      if (args.method === "replied") return { replied: [] };
      return { ok: true, queued: 1, duplicate: false, mode: "on" };
    });
    await ownerSays(host, "6200", "hi");
    const sends: string[] = [];
    let fail = true;
    host.harness.sdk.stub("threads.send", async (args: { input: Array<{ text: string }> }) => {
      const line = args.input[0]?.text ?? "";
      if (fail && line.includes("agent:i9")) throw new Error("BB send failed");
      sends.push(line);
      return {};
    });
    // A real wake: a turn of the captain started.
    const wake = () => host.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_cap", status: "active" }) });
    await wake();
    assert.deepEqual(acked, [], "nothing confirmed when the tell failed");
    fail = false;
    await wake();
    assert.ok(sends.some((line) => line.includes("agent:i9")), sends.join("\n"));
    assert.deepEqual(acked, ["agent:i9"], "confirmed after the tell");
    await wake();
    assert.equal(sends.filter((line) => line.includes("agent:i9")).length, 1, "told once");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("check round 2: a reopened owner message stays open though the connector still sees the earlier answer, until a new reply", async () => {
  const { host, calls } = await captainHost();
  try {
    let undelivered = [{ id: "out_1", chatId: "200", messageId: "6300", reason: "Telegram refused the message: Bad Request" }];
    const ackedUndelivered: string[] = [];
    host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
      calls.push(args);
      if (args.method === "undelivered") return { undelivered: undelivered.filter((row) => !ackedUndelivered.includes(row.id)) };
      if (args.method === "ackUndelivered") { ackedUndelivered.push(...(args.input.ids as string[])); return { acked: (args.input.ids as string[]).length }; }
      // An older connector: the first answer was sent, so it says the message was replied to.
      if (args.method === "replied") return { replied: ["6300"] };
      if (args.method === "freeText") return { obligations: [] };
      return { ok: true, queued: 1, duplicate: false, mode: "on" };
    });
    await ownerSays(host, "6300", "Status?");
    await tool(host, "firstmate_reply").execute({ ref: "tg:200:6300", text: "All green." }, capCtx);
    const ledger = () => createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: "200", messageId: "6300" });
    const idle = () => host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    await idle();
    assert.notEqual(ledger()?.state, "answered", "open again");
    assert.deepEqual(ackedUndelivered, ["out_1"], "confirmed after the captain was told");
    await idle();
    await idle();
    assert.notEqual(ledger()?.state, "answered", "the earlier answer does not close it again");
    undelivered = [];
    await tool(host, "firstmate_reply").execute({ ref: "tg:200:6300", text: "The rest: the logs are clean." }, capCtx);
    assert.equal(ledger()?.state, "answered", "a new reply closes it");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("check round 3: a failure whose confirmation was lost is applied once: it never reopens an owner message answered after it", async () => {
  const { host, calls } = await captainHost();
  try {
    const failures = [{ id: "out_9", chatId: "200", messageId: "6400", reason: "Telegram refused the message: Bad Request", at: 0 }];
    const acked: string[] = [];
    let ackFails = true;
    host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
      calls.push(args);
      if (args.method === "undelivered") return { undelivered: failures.filter((row) => !acked.includes(row.id)) };
      if (args.method === "ackUndelivered") {
        if (ackFails) { ackFails = false; throw new Error("temporary ack transport failure"); }
        acked.push(...(args.input.ids as string[]));
        return { acked: (args.input.ids as string[]).length };
      }
      if (args.method === "replied") return { replied: [] };
      if (args.method === "freeText") return { obligations: [] };
      return { ok: true, queued: 1, duplicate: false, mode: "on" };
    });
    await ownerSays(host, "6400", "Report");
    await tool(host, "firstmate_reply").execute({ ref: "tg:200:6400", text: "Here it is." }, capCtx);
    // Telegram refuses that reply after it was accepted.
    await new Promise((resolve) => setTimeout(resolve, 5));
    failures[0]!.at = Date.now();
    const ledger = () => createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: "200", messageId: "6400" });
    const sends: string[] = [];
    host.harness.sdk.stub("threads.send", async (args: { input: Array<{ text: string }> }) => { sends.push(args.input[0]?.text ?? ""); return {}; });
    const idle = () => host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    await idle();
    assert.notEqual(ledger()?.state, "answered", "open again");
    assert.deepEqual(acked, [], "the confirmation was lost");
    // The captain sends a corrected reply; Telegram takes it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tool(host, "firstmate_reply").execute({ ref: "tg:200:6400", text: "Here it is, corrected." }, capCtx);
    assert.equal(ledger()?.state, "answered");
    await idle();
    await idle();
    assert.equal(ledger()?.state, "answered", "the old failure does not reopen the repaired message");
    assert.deepEqual(acked, ["out_9"], "it is confirmed on the next drain");
    assert.equal(sends.filter((line) => /tg:200:6400/.test(line) && /not delivered/i.test(line)).length, 1, "the captain is told once");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("check round 3: a failure the captain was never told of does not reopen a message answered after it; an old connector's failure is applied once", async () => {
  const { host, calls } = await captainHost();
  try {
    const failures: Array<{ id: string; chatId: string; messageId: string; reason: string; at?: number }> = [];
    const acked: string[] = [];
    host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
      calls.push(args);
      if (args.method === "undelivered") return { undelivered: failures.filter((row) => !acked.includes(row.id)) };
      if (args.method === "ackUndelivered") { acked.push(...(args.input.ids as string[])); return { acked: (args.input.ids as string[]).length }; }
      if (args.method === "replied") return { replied: [] };
      if (args.method === "freeText") return { obligations: [] };
      return { ok: true, queued: 1, duplicate: false, mode: "on" };
    });
    const ledger = (id: string) => createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: "200", messageId: id });
    const idle = () => host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    // The failure is reported, but the message to the captain fails, so nothing is applied.
    await ownerSays(host, "6500", "Report");
    await tool(host, "firstmate_reply").execute({ ref: "tg:200:6500", text: "Here it is." }, capCtx);
    await pause();
    failures.push({ id: "out_10", chatId: "200", messageId: "6500", reason: "Telegram refused the message", at: Date.now() });
    let steerFails = true;
    host.harness.sdk.stub("threads.send", async (args: { input: Array<{ text: string }> }) => {
      if (steerFails && /not delivered/i.test(args.input[0]?.text ?? "")) throw new Error("BB send failed");
      return {};
    });
    await idle();
    steerFails = false;
    // The captain answers again anyway, after the failure.
    await pause();
    await tool(host, "firstmate_reply").execute({ ref: "tg:200:6500", text: "Here it is, again." }, capCtx);
    await idle();
    assert.equal(ledger("6500")?.state, "answered", "a failure older than the answer does not reopen it");
    assert.ok(acked.includes("out_10"));
    // An older connector gives no time: the failure is applied once, so a later answer is never reopened by it.
    await ownerSays(host, "6501", "And the costs?");
    await tool(host, "firstmate_reply").execute({ ref: "tg:200:6501", text: "Costs are fine." }, capCtx);
    failures.push({ id: "out_11", chatId: "200", messageId: "6501", reason: "Telegram refused the message" });
    let ackFails = true;
    host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
      if (args.method === "ackUndelivered" && ackFails) { ackFails = false; throw new Error("temporary ack transport failure"); }
      if (args.method === "undelivered") return { undelivered: failures.filter((row) => !acked.includes(row.id)) };
      if (args.method === "ackUndelivered") { acked.push(...(args.input.ids as string[])); return { acked: 1 }; }
      if (args.method === "replied") return { replied: [] };
      if (args.method === "freeText") return { obligations: [] };
      return { ok: true, queued: 1, duplicate: false, mode: "on" };
    });
    await idle();
    assert.notEqual(ledger("6501")?.state, "answered", "open again");
    await tool(host, "firstmate_reply").execute({ ref: "tg:200:6501", text: "Costs are fine, corrected." }, capCtx);
    await idle();
    assert.equal(ledger("6501")?.state, "answered", "applied once");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Live 18 Oct: the free-text check ran for every known captain. An archived one logged
// "HTTP 409: Thread is archived" about 20 times an hour, and a second live captain would have been
// told, and confirmed to the connector, the free texts of the captain Telegram is bound to.
class ArchivedThreadError extends Error {
  override name = "BbHttpError";
  readonly status = 409;
  readonly code = "thread_not_writable";
  readonly body = { code: "thread_not_writable", message: "Thread is archived", details: { reason: "archived" } };
  constructor() { super("HTTP 409: Thread is archived"); }
}

/** A Telegram connector holding one free text, recording each ack; `bound` is the binding's captain when the connector names it. */
function freeTextConnector(host: Host, calls: Rpc[], bound?: string) {
  const due = [{ ref: "agent:i9", text: "Safi is down: Convex disabled the account.", at: 1 }];
  const acked: string[] = [];
  host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
    calls.push(args);
    if (args.method === "freeText") return { obligations: due.filter((row) => !acked.includes(row.ref)), ...(bound ? { captainThreadId: bound } : {}) };
    if (args.method === "ackFreeText") { acked.push(...(args.input.refs as string[])); return { told: (args.input.refs as string[]).length }; }
    if (args.method === "undelivered") return { undelivered: [] };
    if (args.method === "replied") return { replied: [] };
    return { ok: true, queued: 1, duplicate: false, mode: "on" };
  });
  return acked;
}

const activeOn = (host: Host, threadId: string) => host.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: threadId, status: "active" }) });
const idleOn = (host: Host, threadId: string) => host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId, status: "idle" }), lastAssistantText: "ok" });

test("free-text binding: a connector that does not name its bound captain tells no captain and confirms nothing, with one warning", async () => {
  const { host, calls } = await captainHost(["thr_cap2"]);
  try {
    // An older connector: freeText has no captainThreadId. An owner message reaching thr_cap proves nothing about the current binding.
    const acked = freeTextConnector(host, calls);
    await ownerSays(host, "6600", "hi");
    const sends: Array<{ threadId: string; text: string }> = [];
    host.harness.sdk.stub("threads.send", async (args: { threadId: string; input: Array<{ text: string }> }) => { sends.push({ threadId: args.threadId, text: args.input[0]?.text ?? "" }); return {}; });
    await idleOn(host, "thr_cap2");
    await idleOn(host, "thr_cap");
    await idleOn(host, "thr_cap");
    assert.deepEqual(sends.filter((s) => s.text.includes("agent:i9")), [], "no captain is told");
    assert.deepEqual(acked, [], "nothing is confirmed");
    const warns = host.harness.logEntries.filter((e) => JSON.stringify(e).includes("bound captain"));
    assert.equal(warns.length, 1, JSON.stringify(warns));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("free-text binding: a connector that names its bound captain decides who is told", async () => {
  const { host, calls } = await captainHost(["thr_cap2"]);
  try {
    // An owner message reached thr_cap earlier, but the binding moved to thr_cap2.
    const acked = freeTextConnector(host, calls, "thr_cap2");
    await ownerSays(host, "6610", "hi");
    const sends: Array<{ threadId: string; text: string }> = [];
    host.harness.sdk.stub("threads.send", async (args: { threadId: string; input: Array<{ text: string }> }) => { sends.push({ threadId: args.threadId, text: args.input[0]?.text ?? "" }); return {}; });
    await activeOn(host, "thr_cap");
    assert.deepEqual(acked, []);
    await activeOn(host, "thr_cap2");
    assert.deepEqual(sends.filter((s) => s.text.includes("agent:i9")).map((s) => s.threadId), ["thr_cap2"]);
    assert.deepEqual(acked, ["agent:i9"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("free-text binding: an archived known captain gets no send and no warning, and later drains skip it", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: manifestSkillIds(new URL(".", import.meta.url).pathname) });
  await host.bb.storage.kv.set("captain-project:thr_old", "proj_cyndra");
  await plugin(host.bb); stubProviderCatalog(host);
  try {
    await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on", asyncDispatch: "on" }) });
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ captain: "true" }));
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_cyndra", status: "idle", archivedAt: "2026-10-14T02:54:29.000Z" } as never));
    const calls: Rpc[] = [];
    const acked = freeTextConnector(host, calls);
    const sends: string[] = [];
    host.harness.sdk.stub("threads.send", async (args: { threadId: string }) => { sends.push(args.threadId); throw new ArchivedThreadError(); });
    const run = host.harness.behavior.runService("captain-wake-release");
    try {
      for (let n = 0; n < 100 && !host.harness.sdk.callsTo("threads.get").some((c) => (c[0] as { threadId: string }).threadId === "thr_old"); n++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 50));
    } finally { run.controller.abort(); await run.done; }
    assert.deepEqual(sends, [], "no send to the archived captain");
    assert.deepEqual(acked, []);
    assert.equal(calls.filter((c) => c.method === "freeText").length, 0, "no free-text call for it");
    const warns = host.harness.logEntries.filter((e) => /thr_old|free-text|Thread is archived/.test(JSON.stringify(e)) && /warn/.test(JSON.stringify(e)));
    assert.deepEqual(warns, []);
    const rpcBefore = calls.length;
    await idleOn(host, "thr_old");
    assert.deepEqual({ sends, rpc: calls.length }, { sends: [], rpc: rpcBefore }, "a later idle does not drain it");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("free-text binding: a 409 'Thread is archived' drops the captain, so its next idle costs no calls", async () => {
  const { host, calls } = await captainHost();
  try {
    const acked = freeTextConnector(host, calls, "thr_cap");
    await ownerSays(host, "6620", "hi");
    let sends = 0;
    host.harness.sdk.stub("threads.send", async () => { sends += 1; throw new ArchivedThreadError(); });
    await activeOn(host, "thr_cap");
    assert.deepEqual(acked, [], "a failed tell is not confirmed");
    const before = { sends, rpc: calls.length };
    await idleOn(host, "thr_cap");
    assert.deepEqual({ sends, rpc: calls.length }, before, "an archived captain is not drained again");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("free-text binding: a deleted captain (HTTP 404) leaves the sweep before any Telegram call; a 502 keeps it", async () => {
  for (const [label, error, kept] of [
    ["404", Object.assign(new Error("HTTP 404: Thread not found"), { status: 404, code: "not_found" }), false],
    ["502", Object.assign(new Error("HTTP 502: Bad Gateway"), { status: 502 }), true],
  ] as const) {
    const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: manifestSkillIds(new URL(".", import.meta.url).pathname) });
    await host.bb.storage.kv.set("captain-project:thr_old", "proj_cyndra");
    await plugin(host.bb); stubProviderCatalog(host);
    try {
      await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on", asyncDispatch: "on" }) });
      host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ captain: "true" }));
      host.harness.sdk.stub("threads.list", async () => []);
      host.harness.sdk.stub("threads.get", async () => { throw error; });
      host.harness.sdk.stub("threads.send", async () => ({}));
      const calls: Rpc[] = [];
      freeTextConnector(host, calls, "thr_old");
      const run = host.harness.behavior.runService("captain-wake-release");
      try {
        for (let n = 0; n < 100 && host.harness.sdk.callsTo("threads.get").length === 0; n++) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 50));
      } finally { run.controller.abort(); await run.done; }
      const sweepFreeText = calls.filter((c) => c.method === "freeText").length;
      assert.equal(sweepFreeText, kept ? 1 : 0, `${label}: sweep free-text calls`);
      await idleOn(host, "thr_old");
      assert.equal(calls.filter((c) => c.method === "freeText").length - sweepFreeText, kept ? 1 : 0, `${label}: a later idle drains it only if kept`);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  }
});
