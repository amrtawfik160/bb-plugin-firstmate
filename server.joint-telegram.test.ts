import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createInboundLedger } from "./lib/inbound-ledger.ts";
import { manifestSkillIds } from "./scripts/plugin-skill-fixture.mjs";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";

/**
 * Firstmate and the Telegram connector together: the connector's real Engine, with its fake Telegram,
 * behind Firstmate's RPC calls. It needs a connector checkout: TELEGRAM_CHECKOUT, or ../bb-plugin-telegram
 * next to this checkout. Without one it is skipped.
 */
const telegram = path.resolve(process.env.TELEGRAM_CHECKOUT ?? new URL("../bb-plugin-telegram", import.meta.url).pathname);
const present = existsSync(path.join(telegram, "test", "support.ts"));
const load = (file: string) => import(pathToFileURL(path.join(telegram, file)).href);
const firstmate = new URL(".", import.meta.url).pathname;
type Rpc = { pluginId: string; method: string; input: Record<string, unknown> };

test("joint: an answer.md that fails twice reopens the owner message each time and tells the captain each time; the third send delivers the file alone", { skip: present ? false : `no Telegram connector checkout at ${telegram}` }, async () => {
  // The connector's own module resolution (its imports name .js files that are .ts on disk).
  await load("test/register.mjs");
  const { baseConfig, cycle, makeHarness, openStore, textUpdate } = await load("test/support.ts");
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: manifestSkillIds(firstmate) });
  try {
    await host.bb.storage.kv.set("captain-project:thr_cap", "proj_cyndra");
    await plugin(host.bb); stubProviderCatalog(host);
    await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on", asyncDispatch: "on" }) });
    host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_cyndra", status: "starting" }));
    host.harness.sdk.stub("threadSections.list", async () => []);
    host.harness.sdk.stub("environments.list", async () => []);
    host.harness.sdk.stub("projects.get", async ({ projectId }: { projectId: string }) => ({ id: projectId, name: projectId, kind: "repo" }));
    const notices: string[] = [];
    host.harness.sdk.stub("threads.send", async (args: { input?: Array<{ text?: string }> }) => {
      const text = args.input?.[0]?.text ?? "";
      if (text.includes("Not delivered to the owner")) notices.push(text);
      return {};
    });
    const { store } = openStore();
    const tg = makeHarness({ store, now: () => Date.now(), config: baseConfig({ pinnedBoard: false, threadedReplies: "on", topics: false, richMessages: false }) });
    await cycle(tg.engine);
    const engine = tg.engine as unknown as Record<string, (input?: unknown) => unknown>;
    host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
      switch (args.method) {
        case "reply": return tg.engine.enqueueThreadReply(args.input as never);
        case "replied": return { replied: tg.engine.repliedMessages(String(args.input.chatId), args.input.messageIds as string[]) };
        case "undelivered": return { undelivered: tg.engine.undeliveredReplies() };
        case "ackUndelivered": return tg.engine.ackUndelivered(args.input as never);
        case "freeText": return { obligations: tg.engine.freeTextObligations() };
        case "ackFreeText": return tg.engine.ackFreeText(args.input as never);
        default: return engine[args.method] ? engine[args.method]!(args.input) : { ok: true };
      }
    });
    const envelope = readFileSync(new URL("./test/fixtures/envelopes/live-owner.txt", import.meta.url), "utf8").replace("telegram_chat_id: 200", "telegram_chat_id: 42");
    tg.telegram.updates.push(textUpdate(9300, "Send the whole audit"));
    await cycle(tg.engine);
    await host.harness.inspection.registrations.hooks["message.dispatch"]!({
      thread: makeThreadResponse({ id: "thr_cap", status: "active" }), attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
      input: { blocks: [], text: envelope.replace("telegram_message_id: 1669", "telegram_message_id: 9300").replace("Status?", "Send the whole audit") },
    } as never);
    const reply = host.harness.inspection.registrations.agentTools.find((tool: { name: string }) => tool.name === "firstmate_reply")!;
    const capCtx = { threadId: "thr_cap", projectId: "proj_cyndra" } as never;
    const state = () => createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: "42", messageId: "9300" })?.state;
    const idle = () => host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    const text = "X".repeat(4_000);
    for (const round of [1, 2]) {
      tg.telegram.failNextUpload("Bad Request: failed document");
      await reply.execute({ ref: "tg:42:9300", text }, capCtx);
      await cycle(tg.engine);
      await pause();
      await idle();
      await idle();
      assert.notEqual(state(), "answered", `round ${round}: open again`);
      assert.equal(notices.length, round, `round ${round}: the captain is told`);
      await pause();
    }
    await reply.execute({ ref: "tg:42:9300", text }, capCtx);
    await cycle(tg.engine);
    await idle();
    assert.equal(state(), "answered");
    assert.equal(tg.telegram.sent.filter((row: { text: string }) => row.text.startsWith("X".repeat(100))).length, 1, "the text was sent once");
    assert.equal(tg.telegram.uploadedFiles.filter((file: { filename: string }) => file.filename === "answer.md").length, 1, "the file, at the third send");
    assert.deepEqual(tg.engine.repliedMessages("42", ["9300"]), ["9300"]);
    assert.deepEqual(tg.engine.undeliveredReplies(), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
