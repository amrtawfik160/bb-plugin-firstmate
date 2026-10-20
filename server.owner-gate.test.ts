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
  parentThreadId: "thr_cap", nativeHome: "/native", providerId: null, model: null, reasoningLevel: null,
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
  if (command.includes("gh pr view")) {
    const n = prNumber(command);
    return { payload: JSON.stringify({ number: n, url: url(n), title: `Change ${n}`, headRefName: `fm/${CREW}-change-${n}`, headRefOid: head(n), state: "OPEN", mergeable: "MERGEABLE", isDraft: false }) };
  }
  return { code: 0 };
}

function seen(n: number) {
  return { headSha: head(n), state: "open" as const, draft: false, checks: "passing" as const, review: "approved" as const, reviewHeadSha: head(n), mergeCommitSha: null, mergeable: "mergeable" as const };
}

async function deck() {
  heads.clear();
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["firstmate", "captain"], settings: { fmHome: "/native", fmHostId: "host_1" } });
  await plugin(host.bb);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "idle", environmentId: "env_wt" }));
  host.harness.sdk.stub("environments.list", async () => [{ id: "env_source", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_wt", hostId: "host_1", status: "ready", isWorktree: true, path: "/wt", branchName: `fm/${CREW}-change-2391` }));
  host.harness.sdk.stub("environments.diffFiles", async () => ({ files: [] }));
  host.harness.sdk.stub("environments.pullRequest", async () => ({ outcome: "available", pullRequest: { url: url(2391), state: "open" } }));
  host.harness.sdk.stub("threads.output", async () => ({ output: "" }));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.send", async () => ({ delivery: "queued" }));
  host.harness.sdk.stub("plugins.callRpc", async () => ({ ok: true, queued: 1, duplicate: false, mode: "on" }));
  await host.bb.storage.kv.set("crews", [crew]);
  const store = createDeliveries(host.bb.storage.database());
  store.register({ url: url(2391), taskId: CREW, projectId: "proj_1", owner: "thr_cap", home: "/native", worker: "thr_crew", requirement: "merged", title: "Change 2391" });
  store.observe(PR, seen(2391), true);
  store.verify(PR, "thr_cap", head(2391), { driven: "staging app", seen: "it works" });
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
let taps = 0;
const ownerTap = async (host: Host, id: string, answer = "Approve") => {
  await new Promise((resolve) => setTimeout(resolve, 3));
  const stamp = { answeredAt: Date.now(), tapId: `board:${id}:${++taps}` };
  host.harness.sdk.stub("plugins.callRpc", async (call: RpcCall) => {
    if (call.method === "ownerAnswer") return { answer, ok: true, ...stamp };
    return { ok: true, queued: 1, duplicate: false, mode: "on" };
  });
  return host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id, resolution: answer, ...stamp });
};

test("owner Approve posts success Owner approval status at the PR head", async () => {
  const { host, commands } = await deck();
  try {
    const asked = text(await askApproval(host));
    const ask = createOwnerAsks(host.bb.storage.database()).listOpen("thr_cap")[0];
    assert.ok(ask, asked);
    assert.equal(postedKind(commands), "pending");
    assert.match(lastStatus(commands), /Owner approval/);
    assert.equal(mergeAllowedByRequiredStatus({
      requiredContexts: [OWNER_APPROVAL_CONTEXT],
      statuses: { [OWNER_APPROVAL_CONTEXT]: "pending" },
    }), false);
    assert.equal((await ownerTap(host, ask.id)).ok, true);
    assert.equal(postedKind(commands), "success");
    assert.equal(mergeAllowedByRequiredStatus({
      requiredContexts: [OWNER_APPROVAL_CONTEXT],
      statuses: { [OWNER_APPROVAL_CONTEXT]: "success" },
    }), true);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a new author commit after owner Approve posts pending", async () => {
  const { host, commands, setAnswer } = await deck();
  try {
    await askApproval(host);
    const ask = createOwnerAsks(host.bb.storage.database()).listOpen("thr_cap")[0]!;
    assert.equal((await ownerTap(host, ask.id)).ok, true);
    assert.equal(postedKind(commands), "success");
    const approved = head(2391);
    const next = "f".repeat(40);
    const base = "b".repeat(40);
    heads.set(2391, next);
    setAnswer((command) => {
      if (command.includes("/statuses/")) return { code: 0 };
      if (command.includes("gh api")) {
        if (command.includes("/pulls/")) return { payload: JSON.stringify({ head: { sha: next }, base: { sha: base } }) };
        if (command.includes("/compare/")) {
          return { payload: JSON.stringify({
            status: "ahead", total_commits: 1, merge_base_commit: { sha: approved },
            commits: [{ sha: next, parents: [{ sha: approved }] }],
          }) };
        }
      }
      return forge(command);
    });
    const out = text(await tool(host, "firstmate_deliveries").execute({ action: "reconcile", id: PR }, ctx));
    assert.match(out, /2391|#2391|cyndra/i);
    assert.equal(postedKind(commands), "new-author");
  } finally { await host.harness.lifecycle.dispose(); }
});

test("captain firstmate_resolve_ask on an approval card cancels it (a7ro6jg)", async () => {
  const { host, commands } = await deck();
  try {
    await askApproval(host);
    const asks = createOwnerAsks(host.bb.storage.database());
    const ask = asks.listOpen("thr_cap")[0]!;
    const resolved = text(await tool(host, "firstmate_resolve_ask").execute({ id: ask.id, resolution: "Approve" }, ctx));
    assert.match(resolved, /cancelled/i);
    assert.equal(asks.get(ask.id)?.state, "cancelled");
    assert.equal(postedKind(commands), "pending");
    const cli = await host.harness.behavior.runCli(["prod-check", "Cyndra", "merge", "--pr", PR], ctx);
    assert.equal(cli.exitCode, 1);
    assert.match(cli.stderr ?? "", /approval/i);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("prod-check refuses without approval and succeeds after an owner Approve naming the PR", async () => {
  const { host } = await deck();
  try {
    const refused = await host.harness.behavior.runCli(["prod-check", "Cyndra", "merge", "--pr", PR], { threadId: "thr_crew", projectId: "proj_1" });
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr ?? "", /approval/i);
    const viaTool = text(await tool(host, "firstmate_prod_check").execute({ project: "Cyndra", what: "merge", pr: PR }, ctx));
    assert.match(viaTool, /approval/i);
    await askApproval(host);
    const ask = createOwnerAsks(host.bb.storage.database()).listOpen("thr_cap")[0]!;
    assert.equal((await ownerTap(host, ask.id)).ok, true);
    const ok = await host.harness.behavior.runCli(["prod-check", "Cyndra", "merge", "--pr", PR], { threadId: "thr_crew", projectId: "proj_1" });
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.match(ok.stdout ?? "", /Owner Approve/i);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a seeded pre-approval covers only that task and expires when the task closes", async () => {
  const { host } = await deck();
  try {
    const tasks = createOwnerTasks(host.bb.storage.database());
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", projectId: "proj_1", title: "Ship the gate", sourceRefs: ["tg:200:8801"], prs: [PR], at: Date.now() });
    createOwnerGate(host.bb.storage.database()).recordPreApproval({
      ownerMessageRef: "tg:200:8801", quote: "merge after you finish", task: task.id, project: "Cyndra", allows: "merge", createdAt: Date.now(),
    });
    const covered = await host.harness.behavior.runCli(["prod-check", "Cyndra", "merge", "--task", task.id, "--pr", PR], ctx);
    assert.equal(covered.exitCode, 0, covered.stderr);
    const other = await host.harness.behavior.runCli(["prod-check", "Cyndra", "merge", "--task", "T99", "--pr", PR], ctx);
    assert.equal(other.exitCode, 1);
    const closed = text(await tool(host, "firstmate_task").execute({ action: "close", id: task.id, state: "dropped", reason: "drop it", ref: "tg:200:8801" }, ctx));
    assert.match(closed, /dropped/i);
    const expired = await host.harness.behavior.runCli(["prod-check", "Cyndra", "merge", "--task", task.id, "--pr", PR], ctx);
    assert.equal(expired.exitCode, 1);
    assert.match(expired.stderr ?? "", /approval/i);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("an owner message judged as merge-after-finish is recorded, quoted, and expires on close", async () => {
  const keyDir = mkdtempSync(join(tmpdir(), "fm-pre-"));
  writeFileSync(join(keyDir, "decisions.env"), "OPENAI_API_KEY=test-key\n");
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"], settings: { fmHome: "/native", fmHostId: "host_1" } });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  await host.harness.behavior.setSettings({
    fmHostId: "host_1",
    decisionsKeyFile: join(keyDir, "decisions.env"),
    fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on", asyncDispatch: "on" }),
  });
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "idle" }));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Cyndra", kind: "repo" }));
  const rpc: RpcCall[] = [];
  host.harness.sdk.stub("plugins.callRpc", async (call: RpcCall) => { rpc.push(call); return { ok: true, queued: 1, duplicate: false, mode: "on" }; });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    answers: [
      { name: "merge_after_finish", choice: "yes", confidence: 0.9 },
      { name: "deploy_to_production", choice: "no", confidence: 0.9 },
    ],
  }), { status: 200 })) as typeof fetch;
  try {
    const tasks = createOwnerTasks(host.bb.storage.database());
    const task = tasks.open({
      captain: "thr_cap", project: "Cyndra", projectId: "proj_1", title: "Ship the gate",
      sourceRefs: ["tg:200:9901"], prs: [PR], at: Date.now(),
    });
    await host.harness.inspection.registrations.hooks["message.dispatch"]!({
      thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
      attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
      input: { blocks: [], text: envelope.replace("telegram_message_id: 1669", "telegram_message_id: 9901").replace("Status?", "merge after you finish") },
    } as never);
    const stored = createOwnerGate(host.bb.storage.database()).listPreApprovals(task.id);
    assert.equal(stored[0]?.allows, "merge");
    assert.match(stored[0]?.quote ?? "", /merge after you finish/);
    const progress = rpc.find((call) => call.method === "reply" && call.input?.kind === "progress");
    assert.ok(progress, JSON.stringify(rpc.map((call) => call.method)));
    assert.match(String(progress.input?.text ?? ""), /merge after you finish/);
    const ok = await host.harness.behavior.runCli(["prod-check", "Cyndra", "merge", "--task", task.id], ctx);
    assert.equal(ok.exitCode, 0, ok.stderr);
    await tool(host, "firstmate_task").execute({ action: "close", id: task.id, state: "dropped", reason: "drop it", ref: "tg:200:9901" }, ctx);
    const expired = await host.harness.behavior.runCli(["prod-check", "Cyndra", "merge", "--task", task.id], ctx);
    assert.equal(expired.exitCode, 1);
  } finally {
    globalThis.fetch = realFetch;
    await host.harness.lifecycle.dispose();
  }
});
