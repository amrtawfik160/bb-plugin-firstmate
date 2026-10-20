import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createInboundLedger } from "./lib/inbound-ledger.ts";
import { createOwnerTasks } from "./lib/owner-tasks.ts";
import { manifestSkillIds } from "./scripts/plugin-skill-fixture.mjs";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";
import { approveAdopt, stubHostGit } from "./test/workstream-adopt-fixtures.mjs";

/**
 * Firstmate and the Telegram connector together: the connector's real Engine, with its fake Telegram,
 * behind Firstmate's RPC calls. Checkout: TELEGRAM_CHECKOUT, ../bb-plugin-telegram, or the host clone.
 */
function telegramCheckout(): string {
  if (process.env.TELEGRAM_CHECKOUT) return path.resolve(process.env.TELEGRAM_CHECKOUT);
  const sibling = path.resolve(new URL("../bb-plugin-telegram", import.meta.url).pathname);
  if (existsSync(path.join(sibling, "test", "support.ts"))) return sibling;
  return "/root/github_projects/bb-plugin-telegram";
}
const telegram = telegramCheckout();
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
        case "freeText": { const bound = store.activeBinding()?.captain_thread_id; return { obligations: tg.engine.freeTextObligations(), ...(bound ? { captainThreadId: bound } : {}) }; }
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
      await reply.execute({ ref: "tg:42:9300", noWork: true, text }, capCtx);
      await cycle(tg.engine);
      await pause();
      await idle();
      await idle();
      assert.notEqual(state(), "answered", `round ${round}: open again`);
      assert.equal(notices.length, round, `round ${round}: the captain is told`);
      await pause();
    }
    await reply.execute({ ref: "tg:42:9300", noWork: true, text }, capCtx);
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

test("joint: adopt three Cyndra-shaped workstreams of two tasks (one running crew) into topics; status lines move; a card and a result land; restart adopt is a no-op", { skip: present ? false : `no Telegram connector checkout at ${telegram}` }, async () => {
  await load("test/register.mjs");
  const { baseConfig, cycle, makeHarness, openStore, textUpdate } = await load("test/support.ts");
  const { parseFleetTasks } = await load("src/task-lines.ts");
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: manifestSkillIds(firstmate) });
  const capCtx = { threadId: "thr_cap", projectId: "proj_cyndra" } as never;
  try {
    await host.bb.storage.kv.set("captain-project:thr_cap", "proj_cyndra");
    await plugin(host.bb); stubProviderCatalog(host);
    await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on", asyncDispatch: "on" }), decisionsKeyFile: "" });
    host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
    host.harness.sdk.stub("threads.list", async () => []);
    const crewSpecs = [
      { id: "crew-chat", threadId: "thr_crew_chat", envId: "env_chat", path: "/wt/chat", branch: "fm/chat", active: true },
      { id: "crew-tokens", threadId: "thr_crew_tokens", envId: "env_tokens", path: "/wt/tokens", branch: "fm/tokens", active: false },
      { id: "crew-apple", threadId: "thr_crew_apple", envId: "env_apple", path: "/wt/apple", branch: "fm/apple", active: false },
      { id: "crew-nav", threadId: "thr_crew_nav", envId: "env_nav", path: "/wt/nav", branch: "fm/nav", active: false },
      { id: "crew-coss", threadId: "thr_crew_coss", envId: "env_coss", path: "/wt/coss", branch: "fm/coss", active: false },
      { id: "crew-sheet", threadId: "thr_crew_sheet", envId: "env_sheet", path: "/wt/sheet", branch: "fm/sheet", active: false },
    ];
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      const spec = crewSpecs.find((row) => row.threadId === threadId);
      return makeThreadResponse({
        id: threadId, projectId: "proj_cyndra", status: spec?.active ? "active" : spec ? "idle" : "starting",
        environmentId: spec?.envId,
      });
    });
    host.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => {
      const spec = crewSpecs.find((row) => row.envId === environmentId);
      return spec
        ? { id: spec.envId, hostId: "h1", path: spec.path, status: "ready", isWorktree: true, branchName: spec.branch }
        : { id: environmentId, hostId: "h1", path: "/repo/main", status: "ready", isWorktree: false };
    });
    host.harness.sdk.stub("threadSections.list", async () => []);
    host.harness.sdk.stub("environments.list", async () => [{ id: "env_main", hostId: "h1", path: "/repo/main", status: "ready", isWorktree: false }]);
    host.harness.sdk.stub("projects.list", async () => [{ id: "proj_cyndra", name: "Cyndra SaaS" }, { id: "proj_safi", name: "Safi" }]);
    host.harness.sdk.stub("projects.get", async ({ projectId }: { projectId: string }) => ({ id: projectId, name: projectId === "proj_safi" ? "Safi" : "Cyndra SaaS", kind: "repo", sources: projectId === "proj_cyndra" ? [{ hostId: "h1", path: "/repo/main", isDefault: true }] : [] }));
    stubHostGit(host);
    host.harness.sdk.stub("threads.send", async () => ({}));
    const { store } = openStore();
    const config = baseConfig({
      captainThreadId: "thr_cap", topics: true, pinnedBoard: false, routineUpdates: "off", richMessages: false,
      threadedReplies: "on", projects: "🟣 Cyndra [proj_cyndra], 🟢 Safi [proj_safi]",
    });
    const workstreams = {
      list: (input: Record<string, unknown>) => host.harness.behavior.callRpc("workstreams.list", input),
      create: (input: Record<string, unknown>) => host.harness.behavior.callRpc("workstreams.create", input),
      bindTopic: (input: Record<string, unknown>) => host.harness.behavior.callRpc("workstreams.bindTopic", input),
      ship: (input: Record<string, unknown>) => host.harness.behavior.callRpc("workstreams.ship", input),
      devLink: (input: Record<string, unknown>) => host.harness.behavior.callRpc("workstreams.devLink", input),
    };
    const fleetTasks = async (captainThreadId: string, since: number) =>
      parseFleetTasks((await host.harness.behavior.callRpc("telegramCommand", { command: "tasks", threadId: captainThreadId, since }) as { tasks?: unknown }).tasks);
    let now = Date.parse("2026-10-19T12:00:00Z");
    const harnessOptions = {
      store, now: () => now, config, workstreams, fleetTasks,
      linkAsk: async (input: { threadId: string; id: string; messageUrl: string }) => host.harness.behavior.callRpc("linkAsk", input),
    };
    const settleOwner = async () => {
      await cycle(tg.engine);
      now += 3_000;
      await cycle(tg.engine);
    };
    let tg = makeHarness(harnessOptions);
    tg.telegram.setTopicsEnabled(true);
    tg.fake.setThread({
      id: "thr_cap", projectId: "proj_cyndra", visibility: "visible", archivedAt: null, deletedAt: null,
      lifecycleOwnerThreadId: null, parentThreadId: null, originKind: null,
    });
    host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
      if (args.pluginId === "firstmate") return host.harness.behavior.callRpc(args.method, args.input);
      switch (args.method) {
        case "reply": return tg.engine.enqueueThreadReply(args.input as never);
        case "ask": return tg.engine.enqueueAskRouted(args.input as never);
        case "refreshBoard": tg.engine.refreshBoardSoon(); return { ok: true };
        case "editAsk": return { ok: true };
        case "replied": return { replied: tg.engine.repliedMessages(String(args.input.chatId), args.input.messageIds as string[]) };
        case "undelivered": return { undelivered: tg.engine.undeliveredReplies() };
        case "ackUndelivered": return tg.engine.ackUndelivered(args.input as never);
        case "freeText": { const bound = store.activeBinding()?.captain_thread_id; return { obligations: tg.engine.freeTextObligations(), ...(bound ? { captainThreadId: bound } : {}) }; }
        case "ackFreeText": return tg.engine.ackFreeText(args.input as never);
        default: return { ok: true };
      }
    });
    let fed = 0;
    const feed = async () => {
      const batch = tg.fake.sends.slice(fed);
      fed = tg.fake.sends.length;
      for (const send of batch) {
        await host.harness.inspection.registrations.hooks["message.dispatch"]!({
          thread: makeThreadResponse({ id: "thr_cap", status: "active" }), attempt: "join-turn", initiator: "user",
          senderThreadId: null, queuedMessages: [], input: { blocks: [], text: send.text },
        } as never);
      }
    };
    await cycle(tg.engine);
    const lines = [
      [1001, "Restyle the Cyndra web chat composer"],
      [1002, "Web chat composer tokens"],
      [1003, "Dr Woo Apple redesign"],
      [1004, "Apple navigation"],
      [1005, "Coss UI design system"],
      [1006, "Coss token sheet"],
    ] as const;
    for (const [id, text] of lines) tg.telegram.updates.push(textUpdate(id, text));
    await settleOwner();
    await feed();
    const tasks = createOwnerTasks(host.bb.storage.database());
    const opened = lines.map(([id, title], index) => tasks.open({
      captain: "thr_cap", project: "Cyndra SaaS", projectId: "proj_cyndra", title, sourceRefs: [`tg:42:${id}`],
      crewId: crewSpecs[index]!.id, at: now,
    }));
    await host.bb.storage.kv.set("crews", crewSpecs.map((spec, index) => ({
      id: spec.id, task: lines[index]![1], title: spec.id, projectId: "proj_cyndra", threadId: spec.threadId,
      parentThreadId: "thr_cap", nativeHome: "", worktree: true, shape: "ship", posture: "direct-PR",
      createdAt: new Date().toISOString(), providerId: null, model: null, reasoningLevel: null,
    })));
    tg.engine.refreshBoardSoon();
    await cycle(tg.engine);
    const groups = [
      { name: "Cyndra web chat restyle", requestId: "adopt-chat", ids: [opened[0]!.id, opened[1]!.id] },
      { name: "Dr Woo Apple redesign", requestId: "adopt-apple", ids: [opened[2]!.id, opened[3]!.id] },
      { name: "Coss UI design system", requestId: "adopt-coss", ids: [opened[4]!.id, opened[5]!.id] },
    ];
    // Adopt shows the owner one card per workstream; his Approve adopts it with a new workstream branch.
    const adopted = [];
    for (const group of groups) {
      adopted.push(await approveAdopt(host, {
        threadId: "thr_cap", projectId: "proj_cyndra", name: group.name, requestId: group.requestId, taskIds: group.ids,
      }) as { workstream: { id: string; repos: Array<{ path: string; existing?: boolean }>; jobs: Array<{ id: string; state: string; adopted?: boolean }> } });
    }
    assert.deepEqual(adopted[0]!.workstream.repos.map((repo) => repo.existing), [undefined]);
    assert.deepEqual(adopted[0]!.workstream.jobs.map((job) => [job.id, job.adopted]), [["crew-chat", true], ["crew-tokens", true]]);
    assert.equal(adopted[0]!.workstream.jobs[0]!.state, "running", "the running crew folds when it finishes");
    const crew = ((await host.bb.storage.kv.get("crews")) as Array<{ id: string; workstreamId?: string }>).find((row) => row.id === "crew-chat");
    assert.equal(crew?.workstreamId, undefined);
    tg.engine.refreshBoardSoon();
    await cycle(tg.engine);
    await cycle(tg.engine);
    const created = tg.telegram.requests.filter((row: { method: string }) => row.method === "createForumTopic");
    assert.deepEqual(created.map((row: { body: { name: string } }) => row.body.name), groups.map((group) => group.name));
    const topics = Object.fromEntries(created.map((row: { body: { name: string } }, index: number) => [row.body.name, 500 + index]));
    const liveLines = () => {
      const deleted = new Set(tg.telegram.requests.filter((row: { method: string; body: { message_id: number } }) => row.method === "deleteMessage").map((row: { body: { message_id: number } }) => row.body.message_id));
      return tg.telegram.sent.filter((row: { message_id: number; text: string; message_thread_id?: number }) => !deleted.has(row.message_id) && /^(?:🔨|🔍|✋|🟢) /.test(row.text));
    };
    for (const task of opened) {
      const hits = liveLines().filter((row: { text: string }) => row.text.includes(task.title));
      assert.equal(hits.length, 1, `${task.id} status lines: ${hits.map((row: { text: string }) => row.text).join(" | ")}`);
      const group = groups.find((item) => item.ids.includes(task.id))!;
      assert.equal(hits[0]!.message_thread_id, topics[group.name], `${task.id} should be in ${group.name}`);
    }
    const ask = host.harness.inspection.registrations.agentTools.find((tool: { name: string }) => tool.name === "firstmate_ask")!;
    const asked = await ask.execute({
      question: "Which composer density should the restyle keep?", kind: "question",
      options: [{ label: "Comfortable" }, { label: "Compact" }], project: "Cyndra", task: opened[0]!.id,
    }, capCtx);
    assert.match(typeof asked === "string" ? asked : JSON.stringify(asked), /Question card|Ask /);
    await cycle(tg.engine);
    const card = tg.telegram.sent.find((row: { text: string; message_thread_id?: number }) => row.text.includes("composer density") && row.message_thread_id === topics["Cyndra web chat restyle"]);
    assert.ok(card, "the card lands in the chat restyle topic");
    tg.telegram.updates.push(textUpdate(1100, "Keep going on the composer", { message_thread_id: topics["Cyndra web chat restyle"], is_topic_message: true }));
    await settleOwner();
    await feed();
    const envelope = [...tg.fake.sends].reverse().find((row: { text: string }) => row.text.includes("Keep going on the composer"));
    assert.match(envelope?.text ?? "", /^telegram_topic: Cyndra web chat restyle$/m);
    const reply = host.harness.inspection.registrations.agentTools.find((tool: { name: string }) => tool.name === "firstmate_reply")!;
    const replied = await reply.execute({
      ref: "tg:42:1100", task: opened[0]!.id, result: true,
      text: "The web chat restyle is on the page: the composer uses the new tokens.",
    }, capCtx);
    assert.match(typeof replied === "string" ? replied : JSON.stringify(replied), /delivered|Replied|result/i);
    await cycle(tg.engine);
    const result = tg.telegram.sent.find((row: { text: string; message_thread_id?: number }) => row.text.includes("composer uses the new tokens") && row.message_thread_id === topics["Cyndra web chat restyle"]);
    assert.ok(result, "the result lands in the chat restyle topic");
    const beforeRestart = created.length;
    tg = makeHarness({ ...harnessOptions, reuse: { telegram: tg.telegram, fake: tg.fake } });
    tg.telegram.setTopicsEnabled(true);
    for (const group of groups) {
      await host.harness.behavior.callRpc("workstreams.adopt", {
        threadId: "thr_cap", projectId: "proj_cyndra", name: group.name, requestId: group.requestId, taskIds: group.ids,
      });
    }
    await cycle(tg.engine);
    await cycle(tg.engine);
    assert.equal(tg.telegram.requests.filter((row: { method: string }) => row.method === "createForumTopic").length, beforeRestart);
    const listed = await host.harness.behavior.callRpc("workstreams.list", { threadId: "thr_cap" }) as { workstreams: Array<{ id: string }> };
    assert.equal(listed.workstreams.length, 3);
    const board = await tg.engine.boardState() as { workstreams?: Array<{ name: string; tasks: Array<{ id: string }> }>; projects: Array<{ tasks: Array<{ id: string }> }> };
    assert.equal(board.workstreams?.length, 3);
    const boardIds = (board.workstreams ?? []).flatMap((stream) => stream.tasks.map((task) => task.id));
    assert.deepEqual([...boardIds].sort(), opened.map((task) => task.id).sort());
    assert.equal(boardIds.length, new Set(boardIds).size);
    const generalIds = board.projects.flatMap((project) => project.tasks.map((task) => task.id));
    assert.equal(generalIds.filter((id) => opened.some((task) => task.id === id)).length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
