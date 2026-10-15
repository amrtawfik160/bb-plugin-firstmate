import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createDispatchJobs } from "./lib/async-dispatch.ts";
import { createDoorbellHold } from "./lib/doorbell-hold.ts";
import { createInboundLedger } from "./lib/inbound-ledger.ts";
import { createLaunches } from "./lib/launch.ts";
import { createDeliveries } from "./lib/pr-delivery.ts";
import { CAPTAIN_RULES, createOwnerAsks, OWNER_DECISION_RULE } from "./lib/owner-asks.ts";
import { parseInboundTelegram } from "./lib/telegram-envelope.ts";

type Host = ReturnType<typeof createFakePluginHost>;

async function load(seed: (host: Host) => Promise<void> = async () => {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"] });
  await seed(host);
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

function isError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
}

const envelope = (name: string) => readFileSync(new URL(`./test/fixtures/envelopes/${name}.txt`, import.meta.url), "utf8");

async function telegramFlags(host: Host) {
  await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on" }) });
}

function recordTelegram(host: Host, captain: string, messageId: string, receivedAt = 1_000) {
  const body = envelope("live-owner").replace("telegram_message_id: 1669", `telegram_message_id: ${messageId}`);
  return createInboundLedger(host.bb.storage.database()).record({
    captainThreadId: captain, text: body, receivedAt, bbThreadId: captain, initiator: "user", telegram: parseInboundTelegram(body),
  })!;
}

const ledgerRow = (host: Host, messageId: string) =>
  createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: "200", messageId });

const reply = (host: Host, captain: string, ref: string) =>
  tool(host, "firstmate_reply").execute({ ref, text: "Rolled back." }, { threadId: captain, projectId: "proj_1" } as never);

test("firstmate_reply keeps the item open when telegram.reply queues nothing", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669");
    let result = { queued: 0, duplicate: false, mode: "on" };
    host.harness.sdk.stub("plugins.callRpc", async () => result);
    const refused = await reply(host, "thr_cap", "tg:200:1669");
    assert.ok(isError(refused), text(refused));
    assert.equal(ledgerRow(host, "1669")?.state, "received");
    result = { queued: 1, duplicate: false, mode: "on" };
    const sent = await reply(host, "thr_cap", "tg:200:1669");
    assert.ok(!isError(sent), text(sent));
    assert.equal(ledgerRow(host, "1669")?.state, "answered");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply reports a failed telegram.reply instead of claiming delivery", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669");
    host.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("Telegram API unavailable"); });
    const refused = await reply(host, "thr_cap", "oldest");
    assert.ok(isError(refused), text(refused));
    assert.match(text(refused), /unavailable/);
    assert.equal(ledgerRow(host, "1669")?.state, "received");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply reserves the reply before sending, so a repeat never sends twice", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669");
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    assert.ok(!isError(await reply(host, "thr_cap", "tg:200:1669")));
    const again = await reply(host, "thr_cap", "tg:200:1669");
    assert.match(text(again), /Already replied/);
    assert.equal(host.harness.sdk.callsTo("plugins.callRpc").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply only answers items owned by the calling captain", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_capA", "1669", 1_000);
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const oldest = await reply(host, "thr_capB", "oldest");
    assert.ok(isError(oldest), text(oldest));
    const explicit = await reply(host, "thr_capB", "tg:200:1669");
    assert.ok(isError(explicit), text(explicit));
    assert.equal(host.harness.sdk.callsTo("plugins.callRpc").length, 0);
    assert.equal(ledgerRow(host, "1669")?.state, "received");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

async function captainHost() {
  const host = await load(async (h) => { await h.bb.storage.kv.set("captain-project:thr_cap", "proj_1"); });
  await telegramFlags(host);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }));
  return host;
}

const ownerMessage = (host: Host) => host.harness.inspection.registrations.hooks["message.dispatch"]!({
  thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
  attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
  input: { blocks: [], text: envelope("live-owner") },
} as never);

for (const [label, result] of [
  ["threaded replies are off", { queued: 0, duplicate: false, mode: "off" }],
  ["telegram.reply queues nothing", { queued: 0, duplicate: false, mode: "on" }],
] as const) {
  test(`an ack is not recorded as sent when ${label}`, async () => {
    const host = await captainHost();
    try {
      host.harness.sdk.stub("plugins.callRpc", async () => result);
      await ownerMessage(host);
      assert.equal(host.harness.sdk.callsTo("plugins.callRpc").length, 1);
      assert.equal(ledgerRow(host, "1669")?.state, "received");
      assert.equal(createInboundLedger(host.bb.storage.database()).outboxGet({ source: "telegram", chatId: "200", messageId: "1669" }, "ack"), undefined);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
}

for (const [label, threading, stub] of [
  ["Firstmate's threading flag is off", "off", null],
  ["the connector has no reply method", "on", async () => { throw Object.assign(new Error("unknown method"), { code: "unknown_method" }); }],
] as const) {
  test(`an ack is not recorded as sent when ${label}: nothing sends it`, async () => {
    const host = await captainHost();
    try {
      await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: threading }) });
      host.harness.sdk.stub("plugins.callRpc", stub ?? (async () => ({ queued: 1, duplicate: false, mode: "on" })));
      await ownerMessage(host);
      await ownerMessage(host);
      assert.equal(ledgerRow(host, "1669")?.state, "received");
      assert.equal(createInboundLedger(host.bb.storage.database()).outboxGet({ source: "telegram", chatId: "200", messageId: "1669" }, "ack"), undefined);
      assert.ok(host.harness.sdk.callsTo("plugins.callRpc").filter(([args]) => (args as { method: string }).method === "reply").length <= 1, "a missing sender is not asked again");
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
}

test("a delivered ack marks the item acknowledged", async () => {
  const host = await captainHost();
  try {
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    await ownerMessage(host);
    assert.equal(ledgerRow(host, "1669")?.state, "acked");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("captain idles repeat an unanswered-item reminder only after backoff", async () => {
  const host = await captainHost();
  try {
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.events.list", async () => []);
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ captain: "true" }));
    recordTelegram(host, "thr_cap", "1669", Date.now() - 4 * 60_000);
    recordTelegram(host, "thr_other", "1670", Date.now() - 4 * 60_000);
    const reminders = () => host.harness.sdk.callsTo("threads.send")
      .map((c) => c[0] as { threadId: string; input: Array<{ text: string }> })
      .filter((a) => /Unanswered/.test(a.input[0]?.text ?? ""));
    for (let i = 0; i < 3; i++) {
      await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    }
    assert.equal(reminders().length, 1);
    assert.equal(reminders()[0]!.threadId, "thr_cap");
    assert.match(reminders()[0]!.input[0]!.text, /1669/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("live repro: no reminder for an owner message the connector already answered with the captain's turn text", async () => {
  const host = await captainHost();
  try {
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.events.list", async () => []);
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ captain: "true" }));
    const asked: unknown[] = [];
    host.harness.sdk.stub("plugins.callRpc", async (args: { method: string; input: { messageIds: string[] } }) => {
      asked.push(args.input);
      return args.method === "replied" ? { replied: args.input.messageIds.filter((id) => id === "1926") } : { queued: 1, duplicate: false, mode: "on" };
    });
    recordTelegram(host, "thr_cap", "1926", Date.now() - 4 * 60_000);
    recordTelegram(host, "thr_cap", "1927", Date.now() - 4 * 60_000);
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    const reminders = host.harness.sdk.callsTo("threads.send")
      .map((c) => (c[0] as { input: Array<{ text: string }> }).input[0]?.text ?? "")
      .filter((text) => /Unanswered/.test(text));
    assert.deepEqual(asked, [{ chatId: "200", messageIds: ["1926", "1927"] }]);
    assert.equal(reminders.length, 1, reminders.join("\n"));
    assert.match(reminders[0]!, /1927/);
    assert.equal(ledgerRow(host, "1926")?.state, "answered");
    assert.equal(ledgerRow(host, "1927")?.state, "received");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

const asyncOn = (host: Host, extra: Record<string, string> = {}) =>
  host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ asyncDispatch: "on", ...extra }) });

function stubSpawn(host: Host, status: (threadId: string) => string = () => "starting") {
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_new" }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: status(threadId) }));
}

async function until(check: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition not reached in time");
}

const capCtx = { projectId: "proj_1", threadId: "thr_cap" } as never;
const spawnArgs = (host: Host) => host.harness.sdk.callsTo("threads.spawn").map((c) => c[0] as {
  providerId?: string; environment?: { workspace?: { type?: string } };
});

function crewRow(id: string, threadId: string) {
  return { id, task: "fix login", projectId: "proj_1", threadId, parentThreadId: "thr_cap", providerId: null, model: null, reasoningLevel: null, worktree: true, shape: "ship", posture: "direct-PR", createdAt: "2026-09-18T00:00:00.000Z" };
}

test("an async dispatch does not block the per-minute follow-up after it finishes", async () => {
  const host = await load();
  try {
    await asyncOn(host);
    stubSpawn(host);
    const reserved = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1" }, capCtx);
    assert.match(text(reserved), /Reserved crew/);
    await until(() => host.harness.sdk.callsTo("threads.spawn").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = host.harness.inspection.realtimeSignals.length;
    await host.harness.behavior.runSchedule("pr-delivery-follow-up");
    assert.ok(host.harness.inspection.realtimeSignals.length > before, "the follow-up pass ran and published the fleet");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an async dispatch uses the same worktree, provider, and posture setup as a direct dispatch", async () => {
  const host = await load();
  try {
    await asyncOn(host);
    await host.harness.behavior.setSettings({ defaultProvider: "codex" });
    stubSpawn(host);
    await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1" }, capCtx);
    await until(() => host.harness.sdk.callsTo("threads.spawn").length === 1);
    const [args] = spawnArgs(host);
    assert.equal(args!.environment?.workspace?.type, "managed-worktree");
    assert.equal(args!.providerId, "codex");
    const crews = await host.bb.storage.kv.get<Array<{ posture: string }>>("crews");
    assert.equal(crews?.[0]?.posture, "no-mistakes");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

async function captainIdle(host: Host) {
  await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
}

async function knownCaptainHost() {
  const host = await load(async (h) => { await h.bb.storage.kv.set("captain-project:thr_cap", "proj_1"); });
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ captain: "true" }));
  return host;
}

test("a captain idle drains only over-cap dispatches, never the queued backlog", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    stubSpawn(host);
    const added = await tool(host, "firstmate_queue").execute({ action: "add", title: "later: tidy docs" }, capCtx);
    assert.match(text(added), /Queued/);
    await captainIdle(host);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an over-cap dispatch starts with its own provider and a worktree once a slot opens", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    await host.bb.storage.kv.set("crews", Array.from({ length: 10 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
    let busy = true;
    stubSpawn(host, () => (busy ? "active" : "idle"));
    const queued = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1", providerId: "codex" }, capCtx);
    assert.match(text(queued), /Queued as/);
    busy = false;
    await captainIdle(host);
    const [args] = spawnArgs(host);
    assert.ok(args, "the over-cap item started");
    assert.equal(args.providerId, "codex");
    assert.equal(args.environment?.workspace?.type, "managed-worktree");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an over-cap dispatch starts with the permission mode, worktree choice and visibility it was given", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    host.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ permissionMode: "full" }));
    await host.harness.behavior.setSettings({ defaultPermissionMode: "accept-edits" });
    await host.bb.storage.kv.set("crews", Array.from({ length: 10 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
    let busy = true;
    stubSpawn(host, () => (busy ? "active" : "idle"));
    // This scout would default to the shared checkout, accept-edits and a visible thread.
    const queued = await tool(host, "firstmate_dispatch").execute({
      task: "map the login flow", projectId: "proj_1", shape: "scout", permissionMode: "full", worktree: true, visible: false,
    }, capCtx);
    assert.match(text(queued), /Queued as/);
    busy = false;
    await captainIdle(host);
    const [args] = host.harness.sdk.callsTo("threads.spawn").map((c) => c[0] as {
      permissionMode?: string; visibility?: string; environment?: { workspace?: { type?: string } };
    });
    assert.ok(args, "the over-cap item started");
    assert.equal(args.permissionMode, "full");
    assert.equal(args.environment?.workspace?.type, "managed-worktree");
    assert.equal(args.visibility, "hidden");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an over-cap queue record without the three stored options starts with the defaults", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    host.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ permissionMode: "full" }));
    await host.harness.behavior.setSettings({ defaultPermissionMode: "accept-edits" });
    await host.bb.storage.kv.set("crews", Array.from({ length: 10 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
    let busy = true;
    stubSpawn(host, () => (busy ? "active" : "idle"));
    const queued = await tool(host, "firstmate_dispatch").execute({ task: "map the login flow", projectId: "proj_1", shape: "scout" }, capCtx);
    assert.match(text(queued), /Queued as/);
    busy = false;
    await captainIdle(host);
    const [args] = host.harness.sdk.callsTo("threads.spawn").map((c) => c[0] as {
      permissionMode?: string; visibility?: string; environment?: { workspace?: { type?: string } };
    });
    assert.ok(args, "the over-cap item started");
    assert.equal(args.permissionMode, "accept-edits");
    assert.notEqual(args.environment?.workspace?.type, "managed-worktree");
    assert.equal(args.visibility, "visible");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

async function fullCaptainHost() {
  const host = await knownCaptainHost();
  await asyncOn(host);
  await host.bb.storage.kv.set("crews", Array.from({ length: 10 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
  return host;
}

test("an over-cap dispatch keeps the provider the owner asked for, from the tool and from the command line", async () => {
  for (const entry of ["tool", "cli"] as const) {
    const host = await fullCaptainHost();
    try {
      let busy = true;
      stubSpawn(host, () => (busy ? "active" : "idle"));
      if (entry === "tool") {
        const queued = await tool(host, "firstmate_dispatch").execute({
          task: "fix flaky login", projectId: "proj_1", providerId: "acp-antigravity", ownerRequestedProvider: true,
        }, capCtx);
        assert.match(text(queued), /Queued as/);
      } else {
        const queued = await host.harness.behavior.runCli(
          ["dispatch", "--project", "proj_1", "--provider", "acp-antigravity", "--owner-requested-provider", "--", "fix flaky login"], capCtx);
        assert.equal(queued.exitCode, 0, queued.stderr);
        assert.match(queued.stdout, /Queued as/);
      }
      busy = false;
      await captainIdle(host);
      const [args] = spawnArgs(host);
      assert.ok(args, `the over-cap item started (${entry})`);
      assert.equal(args.providerId, "acp-antigravity", entry);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  }
});

test("an over-cap queue record without the owner-requested-provider flag starts on the project default", async () => {
  const host = await fullCaptainHost();
  try {
    let busy = true;
    stubSpawn(host, () => (busy ? "active" : "idle"));
    const queued = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1", providerId: "acp-antigravity" }, capCtx);
    assert.match(text(queued), /Queued as/);
    busy = false;
    await captainIdle(host);
    const [args] = spawnArgs(host);
    assert.ok(args, "the over-cap item started");
    assert.equal(args.providerId, undefined);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the command line keeps the provider the owner asked for when a crew slot is free", async () => {
  const host = await knownCaptainHost();
  try {
    stubSpawn(host);
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--provider", "acp-antigravity", "--owner-requested-provider", "--", "fix flaky login"], capCtx);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(spawnArgs(host)[0]?.providerId, "acp-antigravity");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an over-cap dispatch with a scheduled send time is refused and nothing is queued", async () => {
  const host = await fullCaptainHost();
  try {
    stubSpawn(host, () => "active");
    const result = await host.harness.behavior.runCli(
      ["dispatch", "--project", "proj_1", "--send-at", String(Date.now() + 3_600_000), "--", "fix flaky login"], capCtx);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.match(result.stderr, /sendAt is unsupported for Firstmate launch/);
    assert.match(text(await tool(host, "firstmate_queue").execute({ action: "list" }, capCtx)), /Queue empty/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the queue list shows an over-cap dispatch waiting for a slot and a background dispatch that has no crew yet", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    await host.bb.storage.kv.set("crews", Array.from({ length: 9 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
    stubSpawn(host, () => "active");
    host.harness.sdk.stub("threads.spawn", () => new Promise(() => {}));
    const reserved = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", taskId: "job-a", projectId: "proj_1" }, capCtx);
    assert.match(text(reserved), /Reserved crew job-a/);
    await until(() => host.harness.sdk.callsTo("threads.spawn").length === 1);
    const queued = await tool(host, "firstmate_dispatch").execute({ task: "tidy the docs", taskId: "job-b", projectId: "proj_1" }, capCtx);
    assert.match(text(queued), /Queued as job-b/);
    const list = text(await tool(host, "firstmate_queue").execute({ action: "list" }, capCtx));
    assert.match(list, /^job-b \[queued\] ship :: tidy the docs — waiting for a crew slot; starts by itself$/m);
    assert.match(list, /^job-a \[background spawning\] :: fix flaky login — crew is being created/m);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a crew whose status read fails still holds a cap slot", async () => {
  const host = await load();
  try {
    await asyncOn(host);
    await host.bb.storage.kv.set("crews", Array.from({ length: 10 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
    stubSpawn(host);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (threadId.startsWith("thr_c")) throw new Error("host unreachable");
      return makeThreadResponse({ id: threadId, status: "starting" });
    });
    const result = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1" }, capCtx);
    assert.match(text(result), /Queued as/);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a held crew doorbell reaches the captain once", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }));
    const doorbell = "🔔 crew c1 done [ship] :: fix login";
    const decision = await host.harness.inspection.registrations.hooks["message.dispatch"]!({
      thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
      attempt: "join-turn", initiator: "system", senderThreadId: null, queuedMessages: [],
      input: { blocks: [], text: doorbell },
    } as never);
    assert.equal(decision.action, "wait", "BB holds the original doorbell and re-delivers it");
    await captainIdle(host);
    const copies = host.harness.sdk.callsTo("threads.send").filter((c) => JSON.stringify(c[0]).includes("crew c1 done"));
    assert.equal(copies.length, 0, "the plugin must not send a second copy");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

async function watchedCrewHost() {
  const host = await load();
  await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ honestStatus: "on" }), supervisionEnabled: true });
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", environmentId: null }));
  await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew")]);
  return host;
}

const crewIdle = (host: Host, lastAssistantText: string) => host.harness.behavior.emitThreadEvent("thread.idle", {
  thread: makeThreadResponse({ id: "thr_crew", status: "idle", projectId: "proj_1" }), lastAssistantText,
});
const watchdogNotes = (host: Host) => host.harness.sdk.callsTo("threads.send")
  .map((c) => JSON.stringify(c[0])).filter((t) => /[Ww]atchdog/.test(t));

test("the loop watchdog ignores crews that keep producing new output", async () => {
  const host = await watchedCrewHost();
  try {
    for (let i = 0; i < 10; i++) await crewIdle(host, `working: step ${i} edited file ${i}`);
    assert.deepEqual(watchdogNotes(host), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the loop watchdog notes repeated empty turns once and says the crew still runs", async () => {
  const host = await watchedCrewHost();
  try {
    for (let i = 0; i < 12; i++) await crewIdle(host, "");
    const notes = watchdogNotes(host);
    assert.equal(notes.length, 1);
    assert.doesNotMatch(notes[0]!, /stopped crew/);
    assert.match(notes[0]!, /not stopped/);
    assert.equal(host.harness.sdk.callsTo("threads.stop").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

async function interruptedCrewHost() {
  const host = await load();
  await host.harness.behavior.setSettings({ supervisionEnabled: true, nudgeEnabled: false });
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.output", async () => ({ output: "" }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", environmentId: null }));
  await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew")]);
  return host;
}

const section = (out: string, name: string) => out.split(`== ${name} ==`)[1]?.split("\n==")[0] ?? "";

test("issue 47: a crew that goes idle with no outcome is not reported done", async () => {
  const host = await interruptedCrewHost();
  try {
    await crewIdle(host, "");
    const pings = host.harness.sdk.callsTo("threads.send").filter((c) => (c[0] as { threadId?: string }).threadId === "thr_cap").map((c) => JSON.stringify(c[0]));
    assert.equal(pings.length, 1);
    assert.doesNotMatch(pings[0]!, /crew c1 done/);
    assert.doesNotMatch(pings[0]!, /firstmate deliver/);
    assert.match(pings[0]!, /no outcome/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("issue 47: bearings lists an idle crew with no outcome under Captain's Call, not Ready to review", async () => {
  const host = await interruptedCrewHost();
  try {
    const result = await host.harness.behavior.runCli(["bearings"], capCtx);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(section(result.stdout, "Captain's Call"), /c1 .*no outcome/);
    assert.doesNotMatch(result.stdout, /c1 .*ready to review/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("issue 47: a crew that reported DONE is still ready to review", async () => {
  const host = await interruptedCrewHost();
  try {
    host.harness.sdk.stub("threads.output", async () => ({ output: "DONE: shipped the fix" }));
    const result = await host.harness.behavior.runCli(["bearings"], capCtx);
    assert.match(result.stdout, /c1 .*ready to review/);
    assert.doesNotMatch(section(result.stdout, "Captain's Call"), /c1/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply answers one message with several questions as one quoted reply per question", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669");
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    const send = (quote: string, more?: boolean) =>
      tool(host, "firstmate_reply").execute({ ref: "tg:200:1669", text: `About: ${quote}`, quote, ...(more === undefined ? {} : { more }) }, ctx);
    const first = await send("Is the deploy done?", true);
    assert.ok(!isError(first), text(first));
    assert.equal(ledgerRow(host, "1669")?.state, "received", "more=true keeps the message open");
    assert.match(text(first), /tg:200:1669/, "the result lists what is still waiting");
    assert.ok(!isError(await send("Who owns billing?")));
    assert.equal(ledgerRow(host, "1669")?.state, "answered");
    assert.match(text(await send("Who owns billing?")), /Already replied to tg:200:1669 for that quote/);
    const quotes = host.harness.sdk.callsTo("plugins.callRpc").map((call) => (call[0] as { input: { quote?: string } }).input.quote);
    assert.deepEqual(quotes, ["Is the deploy done?", "Who owns billing?"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply answers a later message while an older one is still open, and lists the older one", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669", 1_000);
    recordTelegram(host, "thr_cap", "1670", 2_000);
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const result = await reply(host, "thr_cap", "tg:200:1670");
    assert.ok(!isError(result), text(result));
    assert.equal(ledgerRow(host, "1670")?.state, "answered");
    assert.equal(ledgerRow(host, "1669")?.state, "received");
    assert.match(text(result), /1 owner message\(s\) still need a final answer:\n- tg:200:1669/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// 15 Oct: the owner forwarded 9 messages for one task; the captain sent one real reply and 7 "Included." replies.
test("firstmate_reply covers: one Telegram reply answers several owner messages and closes the covered ones silently", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669", 1_000);
    recordTelegram(host, "thr_cap", "1670", 2_000);
    recordTelegram(host, "thr_cap", "1671", 3_000);
    recordTelegram(host, "thr_cap", "1672", 4_000);
    createInboundLedger(host.bb.storage.database()).markDelegated({ source: "telegram", chatId: "200", messageId: "1671" }, "thr_crew", 3_500);
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    const result = await tool(host, "firstmate_reply").execute({ ref: "tg:200:1669", text: "Research started with all your filters.", covers: ["tg:200:1670", "tg:200:1671"] }, ctx);
    assert.ok(!isError(result), text(result));
    assert.equal(host.harness.sdk.callsTo("plugins.callRpc").length, 1, "one Telegram reply");
    assert.equal((host.harness.sdk.callsTo("plugins.callRpc")[0]![0] as { input: { messageId: string } }).input.messageId, "1669");
    for (const id of ["1669", "1670", "1671"]) assert.equal(ledgerRow(host, id)?.state, "answered", id);
    assert.equal(ledgerRow(host, "1670")?.coveredBy, "tg:200:1669");
    assert.equal(ledgerRow(host, "1671")?.coveredBy, "tg:200:1669");
    assert.equal(ledgerRow(host, "1671")?.crewId, "thr_crew", "a covered item handed to a crew keeps its crew link");
    assert.equal(ledgerRow(host, "1669")?.coveredBy ?? null, null);
    assert.match(text(result), /tg:200:1670/);
    assert.match(text(result), /1 owner message\(s\) still need a final answer:\n- tg:200:1672/);
    const inbox = text(await tool(host, "firstmate_inbox").execute({}, ctx));
    assert.doesNotMatch(inbox, /1670|1671/);
    const reminders = createInboundLedger(host.bb.storage.database()).openForSweep(60 * 60_000, "thr_cap").map((action) => action.row.messageId);
    assert.deepEqual(reminders, ["1672"], "covered items get no turn-end reminder");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply covers: refuses a covered ref that is not open, another captain's, or the ref itself, and sends nothing", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669", 1_000);
    recordTelegram(host, "thr_cap", "1670", 2_000);
    recordTelegram(host, "thr_cap", "1671", 3_000);
    recordTelegram(host, "thr_other", "1672", 4_000);
    createInboundLedger(host.bb.storage.database()).markAnswered({ source: "telegram", chatId: "200", messageId: "1671" }, 3_500);
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    const send = (ref: string, covers: string[]) => tool(host, "firstmate_reply").execute({ ref, text: "Started.", covers }, ctx);
    for (const [ref, bad] of [
      ["tg:200:1669", "tg:200:1671"],
      ["tg:200:1669", "tg:200:1672"],
      ["tg:200:1669", "tg:200:1669"],
      ["oldest", "tg:200:1669"],
      ["tg:200:1669", "tg:200:9999"],
      ["tg:200:1669", "nonsense"],
    ] as const) {
      const refused = await send(ref, ["tg:200:1670", bad]);
      assert.ok(isError(refused), `${ref} covers ${bad}: ${text(refused)}`);
      assert.ok(text(refused).includes(bad), text(refused));
    }
    assert.equal(host.harness.sdk.callsTo("plugins.callRpc").length, 0, "no reply is sent when a covered ref is refused");
    for (const id of ["1669", "1670"]) assert.equal(ledgerRow(host, id)?.state, "received", id);
    assert.equal(ledgerRow(host, "1672")?.state, "received");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply covers: a reply that is not delivered leaves the covered items open", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669", 1_000);
    recordTelegram(host, "thr_cap", "1670", 2_000);
    host.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("Telegram API unavailable"); });
    const refused = await tool(host, "firstmate_reply").execute({ ref: "tg:200:1669", text: "Started.", covers: ["tg:200:1670"] }, { threadId: "thr_cap", projectId: "proj_1" } as never);
    assert.ok(isError(refused), text(refused));
    assert.equal(ledgerRow(host, "1670")?.state, "received");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Independent check of PR #133: with no sender the tool said "Replied ... via envelope", sent nothing, and closed every message.
for (const [name, threading, stub] of [
  ["threaded replies are off", "off", null],
  ["the connector has no reply method", "on", async () => { throw Object.assign(new Error("unknown method"), { code: "unknown_method" }); }],
] as const) {
  test(`firstmate_reply covers: when ${name}, nothing reaches the owner, so the reply and its covered items stay open`, async () => {
    const host = await load();
    try {
      await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: threading }) });
      recordTelegram(host, "thr_cap", "1669", 1_000);
      recordTelegram(host, "thr_cap", "1670", 2_000);
      recordTelegram(host, "thr_cap", "1671", 3_000);
      createInboundLedger(host.bb.storage.database()).markDelegated({ source: "telegram", chatId: "200", messageId: "1671" }, "thr_crew", 3_500);
      host.harness.sdk.stub("plugins.callRpc", stub ?? (async () => ({ queued: 1, duplicate: false, mode: "on" })));
      const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
      const args = { ref: "tg:200:1669", text: "Research started with all your filters.", covers: ["tg:200:1670", "tg:200:1671"] };
      const result = await tool(host, "firstmate_reply").execute(args, ctx);
      assert.ok(isError(result), text(result));
      assert.match(text(result), /not delivered/);
      assert.doesNotMatch(text(result), /Replied to/);
      assert.match(text(result), /tg:200:1669, tg:200:1670, tg:200:1671 stay open/);
      assert.equal(host.harness.sdk.callsTo("threads.send").length, 0);
      assert.equal(ledgerRow(host, "1669")?.state, "received");
      assert.equal(ledgerRow(host, "1670")?.state, "received");
      assert.equal(ledgerRow(host, "1671")?.state, "delegated");
      assert.equal(ledgerRow(host, "1670")?.coveredBy ?? null, null);
      // Once a sender works, the same call goes through: the failed attempt reserved nothing.
      await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on" }) });
      host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
      const retried = await tool(host, "firstmate_reply").execute(args, ctx);
      assert.ok(!isError(retried), text(retried));
      for (const id of ["1669", "1670", "1671"]) assert.equal(ledgerRow(host, id)?.state, "answered", id);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
}

test("firstmate_reply covers: repeating a successful call with the same covers reports Already replied", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669", 1_000);
    recordTelegram(host, "thr_cap", "1670", 2_000);
    recordTelegram(host, "thr_cap", "1671", 3_000);
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    const args = { ref: "tg:200:1669", text: "Research started with all your filters.", covers: ["tg:200:1670", "tg:200:1671"] };
    assert.ok(!isError(await tool(host, "firstmate_reply").execute(args, ctx)));
    const before = ["1669", "1670", "1671"].map((id) => ledgerRow(host, id));
    const repeat = await tool(host, "firstmate_reply").execute(args, ctx);
    assert.ok(!isError(repeat), text(repeat));
    assert.match(text(repeat), /^Already replied to tg:200:1669\./);
    assert.doesNotMatch(text(repeat), /stays open|not open/);
    assert.equal(host.harness.sdk.callsTo("plugins.callRpc").length, 1, "the repeat sends nothing");
    assert.deepEqual(["1669", "1670", "1671"].map((id) => ledgerRow(host, id)), before);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Independent check of PR #133, round 2: a new quoted reply went out although every cover was already answered.
test("firstmate_reply covers: a different reply to the same message refuses covers an earlier reply closed, and sends nothing", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669", 1_000);
    recordTelegram(host, "thr_cap", "1670", 2_000);
    recordTelegram(host, "thr_cap", "1671", 3_000);
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    const args = { ref: "tg:200:1669", text: "All filters are included in the research.", covers: ["tg:200:1670", "tg:200:1671"] };
    const first = await tool(host, "firstmate_reply").execute({ ...args, more: true }, ctx);
    assert.ok(!isError(first), text(first));
    assert.equal(ledgerRow(host, "1669")?.state, "received");
    const quoted = await tool(host, "firstmate_reply").execute({ ...args, quote: "Status?" }, ctx);
    assert.ok(isError(quoted), text(quoted));
    assert.match(text(quoted), /covers refused/);
    assert.match(text(quoted), /tg:200:1670 is not open/);
    assert.equal(host.harness.sdk.callsTo("plugins.callRpc").length, 1, "the new reply is not sent");
    assert.equal(ledgerRow(host, "1669")?.state, "received");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Independent check of PR #133, round 2: a failed write after the send left covers open, and the identical retry could not close them.
test("firstmate_reply covers: a ledger write failure after the send leaves every message open, and the identical retry closes them with no second send", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669", 1_000);
    recordTelegram(host, "thr_cap", "1670", 2_000);
    recordTelegram(host, "thr_cap", "1671", 3_000);
    recordTelegram(host, "thr_cap", "1672", 4_000);
    createInboundLedger(host.bb.storage.database()).markDelegated({ source: "telegram", chatId: "200", messageId: "1671" }, "thr_crew", 3_500);
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    const args = { ref: "tg:200:1669", text: "All filters are included in the research.", covers: ["tg:200:1670", "tg:200:1671", "tg:200:1672"] };
    const db = host.bb.storage.database();
    db.exec("CREATE TRIGGER fail_cover BEFORE UPDATE ON inbound_ledger WHEN NEW.message_id='1671' AND NEW.state='answered' BEGIN SELECT RAISE(ABORT, 'simulated cover write failure'); END;");
    const faulted = await tool(host, "firstmate_reply").execute(args, ctx);
    assert.ok(isError(faulted), text(faulted));
    assert.match(text(faulted), /Repeat the same call/);
    assert.deepEqual(["1669", "1670", "1671", "1672"].map((id) => ledgerRow(host, id)?.state), ["received", "received", "delegated", "received"], "all or none closed");
    db.exec("DROP TRIGGER fail_cover;");
    const retried = await tool(host, "firstmate_reply").execute(args, ctx);
    assert.ok(!isError(retried), text(retried));
    assert.match(text(retried), /^Already replied to tg:200:1669\./);
    assert.deepEqual(["1669", "1670", "1671", "1672"].map((id) => ledgerRow(host, id)?.state), ["answered", "answered", "answered", "answered"]);
    assert.equal(ledgerRow(host, "1671")?.coveredBy, "tg:200:1669");
    assert.equal(ledgerRow(host, "1671")?.crewId, "thr_crew");
    assert.equal(host.harness.sdk.callsTo("plugins.callRpc").length, 1, "the retry sends nothing");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply and the captain Telegram guide tell the captain to answer forwarded messages once with covers", () => {
  const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const description = source.slice(source.indexOf('name: "firstmate_reply"'), source.indexOf("parameters:", source.indexOf('name: "firstmate_reply"')));
  assert.match(description, /covers/);
  const guide = readFileSync(new URL("./entry-skills/captain/references/telegram.md", import.meta.url), "utf8").replace(/\s*\n\s*/g, " ");
  assert.ok(guide.includes("`covers`"), guide);
  assert.doesNotMatch(guide, /reply once to the oldest and say which later messages it also answers/);
});

test("firstmate_inbox lists open and delegated owner messages for the calling captain only", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669", 1_000);
    recordTelegram(host, "thr_cap", "1670", 2_000);
    recordTelegram(host, "thr_other", "1671", 3_000);
    createInboundLedger(host.bb.storage.database()).markDelegated({ source: "telegram", chatId: "200", messageId: "1670" }, "thr_crew", 2_500);
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    const listed = text(await tool(host, "firstmate_inbox").execute({}, ctx));
    assert.match(listed, /^2 owner message\(s\) still need a final answer:/);
    assert.match(listed, /tg:200:1669 \(\d+ min, needs your reply\)/);
    assert.match(listed, /tg:200:1670 \(\d+ min, with crew thr_crew\)/);
    assert.equal(listed.includes("1671"), false);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("telegramCommand answers /inbox and /workers for the captain only", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (
      threadId === "thr_cap" ? { captain: "true" } : {}
    ));
    host.harness.sdk.stub("threads.list", async () => []);
    recordTelegram(host, "thr_cap", "1669");
    const inbox = await host.harness.behavior.callRpc("telegramCommand", { command: "inbox", threadId: "thr_cap" }) as { text: string };
    assert.match(inbox.text, /^1 owner message\(s\) still need a final answer:\n- tg:200:1669/);
    const workers = await host.harness.behavior.callRpc("telegramCommand", { command: "workers", threadId: "thr_cap" }) as { text: string };
    assert.equal(typeof workers.text, "string");
    assert.ok(workers.text.length > 0, workers.text);
    const stranger = await host.harness.behavior.callRpc("telegramCommand", { command: "inbox", threadId: "thr_other" }) as { text: string };
    assert.match(stranger.text, /not a Firstmate captain/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

type RpcCall = { pluginId: string; method: string; input: Record<string, unknown> };
const rpcCalls = (host: Host) => host.harness.sdk.callsTo("plugins.callRpc").map((c) => c[0] as RpcCall);
const asks = (host: Host) => createOwnerAsks(host.bb.storage.database());
const askTool = (host: Host, params: Record<string, unknown>, captain = "thr_cap") =>
  tool(host, "firstmate_ask").execute({ impact: "Customers can use this feature.", ...params }, { threadId: captain, projectId: "proj_1" } as never);
const connectorOk = (host: Host) => host.harness.sdk.stub("plugins.callRpc", async (args: RpcCall) => (
  args.method === "refreshBoard" ? { ok: true } : { queued: 1, duplicate: false, mode: "on" }
));
const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);

test("firstmate_ask records the ask and sends the connector a question card with its options and recommendation", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    await host.harness.behavior.setSettings({ askDefaultMinutes: 30 });
    connectorOk(host);
    const result = await askTool(host, {
      question: "Dark mode by default?", kind: "question",
      options: [{ label: "Yes" }, { label: "No", value: "no" }], recommended: 0,
    });
    assert.ok(!isError(result), text(result));
    const id = /ask (a[0-9a-z]{6})/.exec(text(result))?.[1];
    assert.ok(id, text(result));
    assert.match(text(result), /Keep working on other things/);
    const stored = asks(host).get(id)!;
    assert.equal(stored.state, "open");
    assert.equal(stored.captain, "thr_cap");
    assert.equal(stored.defaultAt! - stored.createdAt, 30 * 60_000, "the deadline comes from askDefaultMinutes");
    const calls = rpcCalls(host);
    assert.deepEqual(calls.map((c) => [c.pluginId, c.method]), [["telegram", "ask"], ["telegram", "refreshBoard"]]);
    assert.deepEqual(calls[0]!.input, {
      askId: id,
      text: `❓ Dark mode by default?\nCustomers can use this feature.\n\nIf no answer by ${hhmm(stored.defaultAt!)} UTC, I go with ✓.`,
      options: [{ label: "Yes", value: "A" }, { label: "No", value: "no" }],
      recommended: 0,
      // What the connector needs to fold this card into a pack with others sent within a minute.
      card: { kind: "question", question: "Dark mode by default?", impact: "Customers can use this feature.", defaultAt: stored.defaultAt, gated: false },
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_ask keeps the ask open and warns when the connector cannot send the card", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    host.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("Telegram API unavailable"); });
    const result = await askTool(host, { question: "Need the Stripe key.", kind: "blocker" });
    assert.ok(!isError(result), text(result));
    assert.match(text(result), /Warning: the question card was not sent to Telegram \(Telegram API unavailable\)/);
    const id = /ask (a[0-9a-z]{6})/.exec(text(result))![1]!;
    assert.equal(asks(host).get(id)?.state, "open");
    assert.equal(asks(host).get(id)?.defaultAt, null);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_ask refuses a deadline on an approval or an irreversible ask, and never gives one a default", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    connectorOk(host);
    const options = [{ label: "Deploy" }, { label: "Wait" }];
    const approval = await askTool(host, { question: "Deploy billing?", kind: "approval", options, recommended: 0, defaultAfterMinutes: 30 });
    assert.ok(isError(approval), text(approval));
    assert.match(text(approval), /defaultAfterMinutes is not allowed for an approval/);
    const gated = await askTool(host, { question: "Delete old data?", kind: "question", options, recommended: 1, defaultAfterMinutes: 30, irreversible: true });
    assert.ok(isError(gated), text(gated));
    assert.match(text(gated), /defaultAfterMinutes is not allowed for an irreversible ask/);
    assert.deepEqual(asks(host).listOpen("thr_cap"), []);
    assert.equal(rpcCalls(host).length, 0);
    const waiting = await askTool(host, { question: "Delete old data?", kind: "question", options, recommended: 1, irreversible: true });
    const id = /ask (a[0-9a-z]{6})/.exec(text(waiting))![1]!;
    assert.equal(asks(host).get(id)?.defaultAt, null, "askDefaultMinutes never applies to an irreversible ask");
    assert.equal(rpcCalls(host)[0]!.input.text, "❓ Delete old data?\nCustomers can use this feature.");
    assert.equal((rpcCalls(host)[0]!.input.card as { gated: boolean }).gated, true, "an irreversible ask never joins a pack");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

const askReply = (askId: string, body = "Roll it back") => envelope("live-reply")
  .replace('"sourceEventId":"evt_1"', `"sourceEventId":"ask:${askId}"`)
  .replace(/Roll it back$/, body);

test("only a letter reply to an ask card answers that ask and refreshes the board; another captain's ask is untouched", async () => {
  const host = await captainHost();
  try {
    connectorOk(host);
    const opts = [{ label: "Yes", value: "yes" }];
    asks(host).create({ id: "a000001", captain: "thr_cap", kind: "question", text: "Ship it?", options: opts, recommended: 0, createdAt: 1 });
    asks(host).create({ id: "a000002", captain: "thr_other", kind: "question", text: "Other?", options: opts, createdAt: 2 });
    const hook = host.harness.inspection.registrations.hooks["message.dispatch"]!;
    const send = (body: string) => hook({
      thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
      attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
      input: { blocks: [], text: body },
    } as never);
    await send(askReply("a000002"));
    assert.equal(asks(host).get("a000002")?.state, "open");
    assert.equal(rpcCalls(host).filter((c) => c.method === "refreshBoard").length, 0);
    await send(askReply("a000001", "What?"));
    assert.equal(asks(host).get("a000001")?.state, "open");
    const pending = createInboundLedger(host.bb.storage.database()).listPending("thr_cap");
    assert.equal(pending.length, 1);
    await send(askReply("a000001", "a."));
    const answered = asks(host).get("a000001")!;
    assert.equal(answered.state, "answered");
    assert.equal(answered.resolution, "Yes");
    assert.equal(rpcCalls(host).filter((c) => c.method === "refreshBoard").length, 1);
    const header = parseInboundTelegram(askReply("a000001", "Yes"))!;
    const row = createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: header.chatId, messageId: header.messageId });
    assert.equal(row?.state, "answered", "an answer to a card raises no unanswered reminder");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Telegram folds cards sent within a minute into one pack; "Accept all recommended" or "1A 3C" answers several at once.
test("a pack answer resolves each card it lists and raises no unanswered reminder", async () => {
  const host = await captainHost();
  try {
    connectorOk(host);
    const opts = [{ label: "A. 30 days, then delete", value: "A" }, { label: "C. 90 days, then delete", value: "C" }];
    asks(host).create({ id: "apx0v8q", captain: "thr_cap", kind: "question", text: "Lower the caps?", options: [{ label: "A. Lower", value: "A" }], recommended: 0, createdAt: 1 });
    asks(host).create({ id: "agqtl7j", captain: "thr_cap", kind: "question", text: "Keep data how long?", options: opts, recommended: 0, createdAt: 2 });
    asks(host).create({ id: "a1bhepn", captain: "thr_cap", kind: "question", text: "Pricing?", options: opts, recommended: 0, createdAt: 3 });
    asks(host).create({ id: "aforeign", captain: "thr_other", kind: "question", text: "Other?", options: opts, createdAt: 4 });
    const hook = host.harness.inspection.registrations.hooks["message.dispatch"]!;
    const body = "1A 3C\nAnswers recorded on the cards:\n- ask apx0v8q: A. Lower\n- ask agqtl7j: C. 90 days, then delete\n- ask aforeign: C. 90 days, then delete";
    const message = envelope("live-reply").replace('"sourceEventId":"evt_1"', '"sourceEventId":"pack:apx0v8q"').replace(/Roll it back$/, body);
    await hook({
      thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
      attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
      input: { blocks: [], text: message },
    } as never);
    assert.equal(asks(host).get("apx0v8q")?.resolution, "A. Lower");
    assert.equal(asks(host).get("agqtl7j")?.resolution, "C. 90 days, then delete");
    assert.equal(asks(host).get("a1bhepn")?.state, "open", "a card the answer does not list stays open");
    assert.equal(asks(host).get("aforeign")?.state, "open", "another captain's card is untouched");
    const header = parseInboundTelegram(message)!;
    const row = createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: header.chatId, messageId: header.messageId });
    assert.equal(row?.state, "answered", "a pack answer needs action, not a reply");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a captain idle defaults an overdue reversible ask once and never an irreversible one", async () => {
  const host = await knownCaptainHost();
  try {
    await telegramFlags(host);
    connectorOk(host);
    host.harness.sdk.stub("threads.list", async () => []);
    const opts = [{ label: "Use Postgres", value: "pg" }, { label: "Use SQLite", value: "sqlite" }];
    const past = Date.now() - 60_000;
    asks(host).create({ id: "a000001", captain: "thr_cap", kind: "question", text: "Which DB?", options: opts, recommended: 0, defaultAt: past, createdAt: 1 });
    asks(host).create({ id: "a000002", captain: "thr_cap", kind: "question", text: "Drop table?", options: opts, recommended: 1, defaultAt: past, irreversible: true, createdAt: 2 });
    asks(host).create({ id: "a000003", captain: "thr_cap", kind: "question", text: "Later?", options: opts, recommended: 0, defaultAt: Date.now() + 3_600_000, createdAt: 3 });
    await captainIdle(host);
    await captainIdle(host);
    const steers = host.harness.sdk.callsTo("threads.send")
      .map((c) => c[0] as { threadId: string; input: Array<{ text: string; visibility?: string }> })
      .filter((a) => /No answer to ask/.test(a.input[0]?.text ?? ""));
    assert.equal(steers.length, 1);
    assert.equal(steers[0]!.threadId, "thr_cap");
    assert.equal(steers[0]!.input[0]!.visibility, "agent-only");
    assert.equal(steers[0]!.input[0]!.text, 'No answer to ask a000001 by its deadline: go ahead with "Use Postgres" as recommended, and tell the captain in one short message that you did.');
    assert.equal(asks(host).get("a000001")?.state, "defaulted");
    assert.equal(asks(host).get("a000001")?.resolution, "Use Postgres");
    assert.equal(asks(host).get("a000002")?.state, "open");
    assert.equal(asks(host).get("a000003")?.state, "open");
    assert.equal(rpcCalls(host).filter((c) => c.method === "refreshBoard").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

async function boardHost() {
  const host = await load();
  await telegramFlags(host);
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.list", async () => []);
  return host;
}
const board = (host: Host) => host.harness.behavior.callRpc("telegramCommand", { command: "board", threadId: "thr_cap" }) as Promise<{ text: string; away?: boolean }>;

test("telegramCommand board says nothing needs the owner and reports the captain is not away", async () => {
  const host = await boardHost();
  try {
    assert.deepEqual(await board(host), { text: "📌 Needs you: nothing right now.\n\n✅ Done since you last looked: nothing new.\n\n🔧 In progress: nothing open.", away: false });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("telegramCommand board lists open asks then crew items, and reports /afk as away", async () => {
  const host = await boardHost();
  try {
    await host.bb.storage.kv.set("afk:cap-thr_cap", { on: true, words: "", since: "2026-10-07T00:00:00.000Z", held: [] });
    await host.bb.storage.kv.set("telegram-threading", { mismatch: true, since: 1 });
    const created = Date.now() - 5 * 60_000;
    const at = Date.UTC(2026, 9, 7, 14, 30);
    asks(host).create({ id: "a000001", captain: "thr_cap", kind: "blocker", text: "Need the Stripe key.", options: [], createdAt: created });
    asks(host).create({ id: "a000002", captain: "thr_cap", kind: "question", text: "Dark mode?", options: [{ label: "Yes", value: "y" }], recommended: 0, defaultAt: at, createdAt: created + 1 });
    asks(host).create({ id: "a000003", captain: "thr_other", kind: "question", text: "Not mine", options: [], createdAt: created });
    assert.deepEqual(await board(host), {
      away: true,
      text: [
        "📌 Needs you (3)",
        "1. ⛔ Need the Stripe key. (5 min, ask a000001)",
        "2. ❓ Dark mode? (5 min, ask a000002) Recommended: Yes. Auto at 14:30 UTC.",
        "3. Needs captain: Telegram threaded replies are off in the Telegram connector, but Firstmate's telegramThreading flag is on, so replies arrive unthreaded. Turn th…",
        "Tap a question's button or reply with just its letter.",
        "",
        "✅ Done since you last looked: nothing new.",
        "",
        "🔧 In progress: nothing open.",
      ].join("\n"),
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("telegramCommand board caps the list at 15 lines", async () => {
  const host = await boardHost();
  try {
    const created = Date.now() - 5 * 60_000;
    for (let i = 1; i <= 17; i++) {
      asks(host).create({ id: `a0000${String(i).padStart(2, "0")}`, captain: "thr_cap", kind: "question", text: `Question ${i}?`, options: [], createdAt: created + i });
    }
    assert.deepEqual(await board(host), {
      away: false,
      text: [
        "📌 Needs you (17)",
        ...Array.from({ length: 15 }, (_, i) => `${i + 1}. ❓ Question ${i + 1}? (5 min, ask a0000${String(i + 1).padStart(2, "0")})`),
        "…and 2 more",
        "Tap a question's button or reply with just its letter.",
        "",
        "✅ Done since you last looked: nothing new.",
        "",
        "🔧 In progress: nothing open.",
      ].join("\n"),
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("telegramCommand board keeps decisions, drops launch bookkeeping, and lists this captain's open pull requests", async () => {
  const host = await boardHost();
  try {
    const db = host.bb.storage.database();
    createLaunches(db).save({ key: "k1", taskId: "rebase-2118-2129", projectId: "proj_1", owner: "thr_cap", home: "", generation: 1, shape: "ship", state: "uncertain", threadId: null, error: "Error: reply lost", updatedAt: 1 } as never);
    createLaunches(db).save({ key: "k2", taskId: "runants-playbook-ui-polish", projectId: "proj_1", owner: "thr_cap", home: "", generation: 2, shape: "ship", state: "reserved", threadId: null, updatedAt: 2 } as never);
    await host.bb.storage.kv.set("decisions", [{ id: "d1", question: "Use Postgres?", options: ["yes", "no"], crewId: null, parentThreadId: "thr_cap", status: "open", createdAt: "2026-10-07T00:00:00.000Z" }]);
    const store = createDeliveries(db);
    store.register({ url: "https://github.com/acme/repo/pull/7", taskId: "c1", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_c1", title: "Fix the login form", openedAt: 1 });
    store.register({ url: "https://github.com/acme/repo/pull/8", taskId: "c2", projectId: "proj_1", owner: "thr_other", home: "", worker: "thr_c2", title: "Not mine" });
    const merged = store.register({ url: "https://github.com/acme/repo/pull/9", taskId: "c3", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_c3" });
    store.save({ ...merged, status: "complete" });
    assert.deepEqual(await board(host), {
      away: false,
      text: [
        "📌 Needs you (1)",
        '1. ? d1 :: Use Postgres? (yes / no) — answer: decide answer d1 -- "<answer>"',
        "",
        "✅ Done since you last looked: nothing new.",
        "",
        "🔧 In progress: nothing open.",
        "Other PRs: [repo#7](https://github.com/acme/repo/pull/7) checks running",
      ].join("\n"),
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});


test("long option text stays whole and defaults to a short letter value", async () => {
  const host = await captainHost();
  try {
    connectorOk(host);
    const label = "Find and verify the addresses the business uses to reach its servers before changing the production setting.";
    const result = await askTool(host, { impact: "New customers can start their agents again.", question: "How should we repair access?", kind: "question", options: [{ label }] });
    assert.equal(isError(result), false);
    const sent = rpcCalls(host).find((call) => call.method === "ask")!;
    assert.deepEqual(sent.input.options, [{ label, value: "A" }]);
    assert.equal(sent.input.text, `❓ How should we repair access?\nNew customers can start their agents again.\nA. ${label}`, "a label too long for its button is listed in full");
  } finally { await host.harness.lifecycle.dispose(); }
});

const jobState = (host: Host, id: string) => createDispatchJobs(host.bb.storage.database()).get(id)?.state;
const captainSends = (host: Host) => host.harness.sdk.callsTo("threads.send")
  .filter((c) => (c[0] as { threadId?: string }).threadId === "thr_cap").map((c) => JSON.stringify(c[0]));

test("a background dispatch that fails tells the captain", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    stubSpawn(host);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }));
    host.harness.sdk.stub("threads.spawn", async () => { throw new Error("Host is not connected"); });
    const reserved = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1", taskId: "job-fail" }, capCtx);
    assert.match(text(reserved), /Reserved crew job-fail/);
    await until(() => jobState(host, "job-fail") === "failed");
    await until(() => captainSends(host).some((sent) => /job-fail/.test(sent)));
    const [note] = captainSends(host).filter((sent) => /job-fail/.test(sent));
    assert.match(note!, /Dispatch failed/);
    assert.match(note!, /Host is not connected/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("two background dispatches for the last free slot start one crew now and the other when a slot opens", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    await host.bb.storage.kv.set("crews", Array.from({ length: 9 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
    let busy = true;
    stubSpawn(host, (threadId) => (threadId === "thr_cap" || (!busy && threadId === "thr_c1") ? "idle" : "active"));
    const dispatch = tool(host, "firstmate_dispatch");
    const results = await Promise.all([
      dispatch.execute({ task: "fix flaky login", projectId: "proj_1", taskId: "job-a" }, capCtx),
      dispatch.execute({ task: "fix slow search", projectId: "proj_1", taskId: "job-b" }, capCtx),
    ]);
    for (const result of results) assert.ok(!isError(result), text(result));
    await until(() => host.harness.sdk.callsTo("threads.spawn").length === 1);
    await until(() => ["job-a", "job-b"].some((id) => jobState(host, id) === "queued"));
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1, "the cap holds");
    const waiting = ["job-a", "job-b"].find((id) => jobState(host, id) === "queued")!;
    assert.deepEqual(captainSends(host).filter((sent) => /Dispatch failed/.test(sent)), []);
    busy = false;
    await host.harness.behavior.runSchedule("pr-delivery-follow-up");
    await until(() => jobState(host, waiting) === "started");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 2);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a held crew doorbell that fails to send on release is kept for the next release", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }));
    const store = createDoorbellHold(host.bb.storage.database());
    for (const crewId of ["c1", "c2"]) {
      store.enqueue({ captainThreadId: "thr_cap", text: `🔔 crew ${crewId} idle [ship] :: fix login`, crewId, urgent: false, createdAt: 1 });
    }
    const doorbells = () => captainSends(host).filter((sent) => /crew c[12] idle/.test(sent));

    host.harness.sdk.stub("threads.send", async () => { throw new Error("Server session is not open"); });
    await captainIdle(host);
    assert.equal(store.pending("thr_cap"), 2, "a failed send must not drop the held doorbells");

    const refused = doorbells().length;
    host.harness.sdk.stub("threads.send", async () => ({}));
    await captainIdle(host);
    assert.equal(store.pending("thr_cap"), 0);
    const delivered = doorbells().slice(refused);
    assert.equal(delivered.filter((sent) => /crew c1 idle/.test(sent)).length, 1);
    assert.equal(delivered.filter((sent) => /crew c2 idle/.test(sent)).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an over-cap dispatch starts within a minute when a slot opens without a crew turn ending", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    await host.bb.storage.kv.set("crews", Array.from({ length: 10 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
    let failed = false;
    stubSpawn(host, (threadId) => (threadId === "thr_cap" ? "idle" : failed && threadId === "thr_c1" ? "error" : "active"));
    const queued = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1" }, capCtx);
    assert.match(text(queued), /Queued as/);
    failed = true;
    await host.harness.behavior.runSchedule("pr-delivery-follow-up");
    await until(() => host.harness.sdk.callsTo("threads.spawn").length === 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("turning asyncDispatch off still starts the over-cap work and sends the doorbells it already holds", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    await host.bb.storage.kv.set("crews", Array.from({ length: 10 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
    let busy = true;
    stubSpawn(host, (threadId) => (threadId === "thr_cap" || !busy ? "idle" : "active"));
    const queued = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1" }, capCtx);
    assert.match(text(queued), /Queued as/);
    const store = createDoorbellHold(host.bb.storage.database());
    store.enqueue({ captainThreadId: "thr_cap", text: "🔔 crew c1 idle [ship] :: fix login", crewId: "c1", urgent: false, createdAt: 1 });

    await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ asyncDispatch: "off" }) });
    busy = false;
    await captainIdle(host);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1, "the queued dispatch started");
    assert.equal(store.pending("thr_cap"), 0);
    assert.equal(captainSends(host).filter((sent) => /crew c1 idle/.test(sent)).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

const queuedWarns = (host: Host, id: string) => host.harness.logEntries
  .filter((e) => e.level === "warn" && e.message.startsWith(`queued dispatch ${id}:`)).map((e) => e.message);
const queueList = async (host: Host) => text(await tool(host, "firstmate_queue").execute({ action: "list" }, capCtx));

test("an over-cap dispatch of the longest allowed task starts by itself when a slot opens", async () => {
  for (const title of [undefined, "Fix the flaky login on the sign-in page"]) {
    const host = await fullCaptainHost();
    try {
      let busy = true;
      stubSpawn(host, (threadId) => (threadId === "thr_cap" || !busy ? "idle" : "active"));
      const task = "x".repeat(4000);
      const queued = await tool(host, "firstmate_dispatch").execute({ task, title, taskId: "job-long", projectId: "proj_1" }, capCtx);
      assert.match(text(queued), /Queued as job-long/);
      busy = false;
      await captainIdle(host);
      assert.deepEqual(queuedWarns(host, "job-long"), []);
      assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1, "the queued dispatch started");
      assert.ok(JSON.stringify(host.harness.sdk.callsTo("threads.spawn")[0]).includes(task), "the crew gets the whole task");
      assert.match(await queueList(host), /^job-long \[dispatched\]/m);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  }
});

test("an over-cap dispatch whose start is refused shows as refused, tells the captain once and logs once per reason", async () => {
  const host = await fullCaptainHost();
  try {
    let busy = true;
    let providers: Array<{ id: string; available?: boolean }> = [{ id: "codex" }];
    stubSpawn(host, (threadId) => (threadId === "thr_cap" || !busy ? "idle" : "active"));
    host.harness.sdk.stub("providers.list", async () => providers);
    const queued = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", taskId: "job-stuck", projectId: "proj_1", providerId: "codex" }, capCtx);
    assert.match(text(queued), /Queued as job-stuck/);
    assert.match(await queueList(host), /^job-stuck \[queued\] ship :: fix flaky login — waiting for a crew slot; starts by itself/m);
    busy = false;
    const notices = () => captainSends(host).filter((sent) => /job-stuck/.test(sent));

    providers = [{ id: "codex", available: false }];
    for (let pass = 0; pass < 3; pass++) await captainIdle(host);
    const list = await queueList(host);
    assert.match(list, /^job-stuck \[queued\] ship :: fix flaky login — \[refused\] .*Provider "codex" is installed but not available on this host/m);
    assert.doesNotMatch(list, /starts by itself/);
    assert.equal(notices().length, 1, notices().join("\n"));
    assert.match(notices()[0]!, /did not start by itself: .*Provider \\"codex\\" is installed but not available/);
    assert.equal(queuedWarns(host, "job-stuck").length, 1, queuedWarns(host, "job-stuck").join("\n"));

    providers = [{ id: "claude-code" }];
    for (let pass = 0; pass < 3; pass++) await captainIdle(host);
    assert.match(await queueList(host), /^job-stuck \[queued\] .* — \[refused\] .*Unknown providerId "codex"/m);
    assert.equal(queuedWarns(host, "job-stuck").length, 2, "a new reason is logged once");
    assert.equal(notices().length, 1, "one notice per job");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);

    providers = [{ id: "codex" }];
    await captainIdle(host);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1, "it starts once the cause is fixed");
    const after = await queueList(host);
    assert.match(after, /^job-stuck \[dispatched\]/m);
    assert.doesNotMatch(after, /\[refused\]/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an over-cap dispatch whose project is gone when a slot opens shows as refused and tells the captain", async () => {
  const host = await fullCaptainHost();
  try {
    let busy = true;
    stubSpawn(host, (threadId) => (threadId === "thr_cap" || !busy ? "idle" : "active"));
    await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", taskId: "job-gone", projectId: "proj_1" }, capCtx);
    busy = false;
    host.harness.sdk.stub("environments.list", async () => { throw new Error("Project proj_1 not found"); });
    for (let pass = 0; pass < 2; pass++) await captainIdle(host);
    assert.match(await queueList(host), /^job-gone \[queued\] .* — \[refused\] .*Project proj_1 not found/m);
    assert.equal(captainSends(host).filter((sent) => /job-gone/.test(sent)).length, 1);
    assert.equal(queuedWarns(host, "job-gone").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a refused over-cap dispatch stays marked refused while it waits for a slot again", async () => {
  const host = await fullCaptainHost();
  try {
    let busy = true;
    stubSpawn(host, (threadId) => (threadId === "thr_cap" || !busy ? "idle" : "active"));
    host.harness.sdk.stub("threads.spawn", async () => { throw new Error("Host is not connected"); });
    await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", taskId: "job-stuck", projectId: "proj_1" }, capCtx);
    busy = false;
    await captainIdle(host);
    busy = true;
    await captainIdle(host);
    assert.match(await queueList(host), /^job-stuck \[queued\] .* — \[refused\] .*Host is not connected/m);
    assert.equal(queuedWarns(host, "job-stuck").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a queue row added by hand is still refused at add time when title and detail together are too long", async () => {
  const host = await knownCaptainHost();
  try {
    const added = await tool(host, "firstmate_queue").execute({ action: "add", title: "tidy the docs", detail: "x".repeat(3995) }, capCtx);
    assert.ok(isError(added), text(added));
    assert.match(text(added), /Queue text exceeds limits/);
    assert.match(await queueList(host), /Queue empty/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

function recordOwnerText(host: Host, messageId: string, words: string) {
  const body = envelope("live-owner").replace("telegram_message_id: 1669", `telegram_message_id: ${messageId}`).replace(/Status\?$/, words);
  return createInboundLedger(host.bb.storage.database()).record({
    captainThreadId: "thr_cap", text: body, receivedAt: 1_000, bbThreadId: "thr_cap", initiator: "user", telegram: parseInboundTelegram(body),
  })!;
}

// 15 Oct: the owner wants no text matching on agent-written text. A reply is sent as written, whatever it says.
const RELEASE_QUESTION = "Question: release the change that shows a plain icon first and the animated agent face after (#2284)?\n\nA. No, do not release it. I recommend this.\nB. Yes, release it.\n\nUntil you answer, #2284 is not released.";

test("firstmate_reply sends a reply as written: options, a decision phrase or a card restatement is not refused", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordOwnerText(host, "1669", "Status?");
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    const card = await tool(host, "firstmate_ask").execute({
      kind: "approval", irreversible: true, recommended: 0,
      question: "Safi savings: some users already had money in their goals before this change. Should that old money also come out of \"money on hand\"?",
      options: [{ label: "B: Yes. Take existing goal money out of money on hand too." }, { label: "A: No. Old goal money stays in money on hand." }],
    }, ctx);
    assert.ok(!isError(card), text(card));
    const sentBefore = host.harness.sdk.callsTo("plugins.callRpc").length;
    const words = [
      RELEASE_QUESTION,
      "Recap: all finished Cyndra work is live. 12 decisions wait for you.",
      "I sent you one question card: should money already in savings goals also come out of \"money on hand\"? I recommend yes.",
    ];
    for (const reply of words) {
      const sent = await tool(host, "firstmate_reply").execute({ ref: "tg:200:1669", text: reply, more: true }, ctx);
      assert.ok(!isError(sent), text(sent));
    }
    const replies = host.harness.sdk.callsTo("plugins.callRpc").slice(sentBefore).map((call) => (call[0] as { input: { text: string } }).input.text);
    assert.deepEqual(replies, words);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a decision in the captain's closing text brings no note", async () => {
  const host = await captainHost();
  try {
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.events.list", async () => []);
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ captain: "true" }));
    host.harness.sdk.stub("plugins.callRpc", async () => ({ replied: ["1669"], queued: 1, duplicate: false, mode: "on" }));
    recordTelegram(host, "thr_cap", "1669", Date.now());
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: RELEASE_QUESTION });
    const notes = host.harness.sdk.callsTo("threads.send")
      .map((c) => c[0] as { input: Array<{ text: string }> })
      .filter((a) => /plain text/.test(a.input[0]?.text ?? ""));
    assert.equal(notes.length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("captain report: after a reply sent with more=true, a different text to the same message is sent; the same text is sent once", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669");
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    const send = (words: string, more?: boolean) => tool(host, "firstmate_reply").execute({ ref: "tg:200:1669", text: words, ...(more === undefined ? {} : { more }) }, ctx);
    const sentTexts = () => host.harness.sdk.callsTo("plugins.callRpc").map((call) => (call[0] as { input: { text: string } }).input.text);
    assert.ok(!isError(await send("The deploy is running.", true)));
    assert.match(text(await send("The deploy is running.", true)), /Already replied to tg:200:1669/, "the same text is not sent twice");
    const second = await send("The deploy is done.", true);
    assert.ok(!isError(second), text(second));
    assert.match(text(second), /Replied to tg:200:1669/);
    assert.match(text(await send("The deploy is done.")), /Already replied to tg:200:1669/);
    assert.equal(ledgerRow(host, "1669")?.state, "received", "more=true keeps the message open");
    assert.ok(!isError(await send("All checks pass.")));
    assert.equal(ledgerRow(host, "1669")?.state, "answered");
    assert.match(text(await send("One more thing.")), /Already replied to tg:200:1669/, "a message that got its final reply takes no more");
    assert.deepEqual(sentTexts(), ["The deploy is running.", "The deploy is done.", "All checks pass."]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("captain report: firstmate_skill reads the captain's own reference files by name", async () => {
  const host = await load();
  try {
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    const read = (input: Record<string, unknown>) => tool(host, "firstmate_skill").execute(input, ctx);
    const telegram = await read({ name: "captain", reference: "references/telegram.md" });
    assert.ok(!isError(telegram), text(telegram));
    assert.ok(text(telegram).includes(readFileSync(new URL("./entry-skills/captain/references/telegram.md", import.meta.url), "utf8")));
    assert.ok(text(await read({ name: "captain" })).includes(readFileSync(new URL("./entry-skills/captain/SKILL.md", import.meta.url), "utf8")));
    // A link inside a reference resolves from that reference, as for native skills.
    const nested = await read({ name: "captain", reference: "supervision.md", source: "entry-skills/captain/references/telegram.md" });
    assert.ok(text(nested).includes(readFileSync(new URL("./entry-skills/captain/references/supervision.md", import.meta.url), "utf8")));
    for (const reference of ["../../package.json", "../../../server.ts", "references/missing.md"]) {
      const refused = await read({ name: "captain", reference });
      assert.ok(isError(refused), reference);
    }
    assert.match(text(await read({ name: "captain", reference: "references/missing.md" })), /references\/telegram\.md/, "the error lists the files that exist");
    assert.match(OWNER_DECISION_RULE, /firstmate_skill name=captain reference=references\/telegram\.md/, "the always-loaded block names the exact call");
    assert.match(CAPTAIN_RULES, /firstmate_skill name=captain reference=references\/supervision\.md/, "the captain rules name the exact call");
    assert.ok(text(await read({ name: "captain", reference: "references/supervision.md" })).includes("## Captain rules"));
    for (const act of ["deploy", "publish", "merge", "commit", "push", "firstmate_merge", "firstmate_task", "firstmate_deliveries"]) assert.ok(CAPTAIN_RULES.includes(act), act);
    assert.ok(CAPTAIN_RULES.split(/(?<=\.) /).length <= 5, "at most five short sentences");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
