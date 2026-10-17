import assert from "node:assert/strict";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { manifestSkillIds } from "./scripts/plugin-skill-fixture.mjs";

type Host = ReturnType<typeof createFakePluginHost>;
type Rpc = { pluginId: string; method: string; input: Record<string, unknown> };

const capCtx = { threadId: "thr_cap", projectId: "proj_cyndra" } as never;
const envelope = readFileSync(new URL("./test/fixtures/envelopes/live-owner.txt", import.meta.url), "utf8");
const PROJECTS: Record<string, string> = { proj_cyndra: "Cyndra SaaS", proj_woo: "woo-app" };

/** A captain thread in the Cyndra SaaS project, as on 17 Oct, and a Telegram connector that records every call. */
async function captainHost() {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: manifestSkillIds(new URL(".", import.meta.url).pathname) });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_cyndra");
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

    const alerted = await tool(host, "firstmate_alert").execute({ level: "alarm", text: "Safi is down for all users.", task: "T1" }, capCtx);
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
