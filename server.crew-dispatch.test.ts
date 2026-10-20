import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { PROVIDER_CATALOG, stubProviderCatalog } from "./test/provider-catalog.mjs";

type Host = ReturnType<typeof createFakePluginHost>;

const tool = (host: Host, name: string) => host.harness.inspection.registrations.agentTools.find((t) => t.name === name)!;
const text = (out: unknown) => (typeof out === "string" ? out : (out as { content?: Array<{ text?: string }> })?.content?.map((c) => c.text ?? "").join("\n") ?? "").replace(/[\s⁡-⁤]+$/u, "");
const capCtx = { threadId: "thr_cap", projectId: "proj_1" };

// The live acp-grok catalog on 20 Oct also lists grok-4.5; the shared test catalog does not.
const WITH_GROK_45 = { ...PROVIDER_CATALOG, "acp-grok": [...PROVIDER_CATALOG["acp-grok"], "grok-4.5"] };

async function dispatchHost(opts: { fmHome?: string; catalog?: Record<string, string[]> } = {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["firstmate", "captain"], settings: opts.fmHome ? { fmHome: opts.fmHome } : {} });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  stubProviderCatalog(host);
  if (opts.catalog) {
    const catalog = opts.catalog;
    host.harness.sdk.stub("providers.models", async ({ providerId }: { providerId?: string } = {}) => ({
      modelLoadError: null,
      models: (catalog[providerId ?? "claude-code"] ?? []).map((id) => ({ id, model: id })),
    }));
  }
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Areliaa", kind: "repo" }));
  let n = 0;
  host.harness.sdk.stub("threads.spawn", async () => ({ id: `thr_new${++n}` }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "starting" }));
  return host;
}

const spawned = (host: Host) =>
  host.harness.sdk.callsTo("threads.spawn").map(([args]) => {
    const a = args as { providerId?: string; model?: string; reasoningLevel?: string };
    return { providerId: a.providerId, model: a.model, reasoningLevel: a.reasoningLevel };
  });

const dispatch = async (host: Host, input: Record<string, unknown>, ctx: Record<string, unknown> = { projectId: "proj_1" }) =>
  text(await tool(host, "firstmate_dispatch").execute({ projectId: "proj_1", ...input }, ctx));

test("dispatch with a rule picks that rule and names it in one line, from the tool and the CLI", async () => {
  const host = await dispatchHost({ catalog: WITH_GROK_45 });
  try {
    const out = await dispatch(host, { task: "restyle the login form", rule: "ui" });
    assert.doesNotMatch(out, /Refus|FAILED/);
    assert.match(out, /\nPicked acp-grok grok-4\.5 high \(rule ui\)\.\nQuota could not be read; kept the first model in rule ui that the catalog accepts\./);
    assert.deepEqual(spawned(host).at(-1), { providerId: "acp-grok", model: "grok-4.5", reasoningLevel: "high" });
    const cli = await host.harness.behavior.runCli(["dispatch", "--project", "proj_1", "--rule", "research", "--", "what shipped this week"], { projectId: "proj_1" });
    assert.equal(cli.exitCode, 0, cli.stderr);
    assert.match(cli.stdout, /Picked acp-grok grok-4\.7 \(rule research\)\./);
    assert.deepEqual(spawned(host).at(-1), { providerId: "acp-grok", model: "grok-4.7", reasoningLevel: undefined });
    const plain = await dispatch(host, { task: "add a settings page" });
    assert.match(plain, /\nPicked claude-code claude-opus-5-5 \(default\)\./);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("every pick goes through the catalog: a missing model is skipped, antigravity is skipped for ship work only", async () => {
  const host = await dispatchHost();
  try {
    const ship = await dispatch(host, { task: "restyle the login form", rule: "ui" });
    assert.match(ship, /Picked claude-code claude-opus-5-5 \(rule ui; skipped acp-grok grok-4\.5 high: not in the catalog; acp-antigravity gemini-3\.8-flash: not used for ship work\)\./);
    assert.deepEqual(spawned(host).at(-1), { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: undefined });
    const scout = await dispatch(host, { task: "survey the login form styles", rule: "ui", shape: "scout" });
    assert.match(scout, /Picked acp-antigravity gemini-3\.8-flash \(rule ui; skipped acp-grok grok-4\.5 high: not in the catalog\)\./);
    assert.deepEqual(spawned(host).at(-1), { providerId: "acp-antigravity", model: "gemini-3.8-flash", reasoningLevel: undefined });
    const before = spawned(host).length;
    host.harness.sdk.stub("providers.list", async () => Object.keys(PROVIDER_CATALOG).map((id) => ({ id, available: id !== "acp-grok", reasoningLevels: [{ id: "high" }] })));
    const refused = await dispatch(host, { task: "what changed in the API this week", rule: "research" });
    assert.match(refused, /no model in rule research can run \(acp-grok grok-4\.7: provider not available\)\. Name a model or pick another rule\. Nothing was spawned\./);
    assert.equal(spawned(host).length, before, "nothing was spawned");
  } finally { await host.harness.lifecycle.dispose(); }
});

test("rule order: an owner-named model beats the rule; an owner-named effort beats the rule's effort", async () => {
  const host = await dispatchHost({ catalog: WITH_GROK_45 });
  try {
    const named = await dispatch(host, { task: "restyle the login form", rule: "ui", providerId: "codex", model: "gpt-6.1-sol" });
    assert.match(named, /\nPicked codex gpt-6\.1-sol \(owner-named\)\./);
    assert.deepEqual(spawned(host).at(-1), { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: undefined });
    const effort = await dispatch(host, { task: "rework billing retries", rule: "big-risky", reasoningLevel: "high" });
    assert.match(effort, /Picked acp-grok grok-4\.6 high \(rule big-risky\)\./);
    assert.deepEqual(spawned(host).at(-1), { providerId: "acp-grok", model: "grok-4.6", reasoningLevel: "high" });
    const astra = await dispatch(host, { task: "deep audit", providerId: "codex", model: "gpt-6-astra" });
    assert.match(astra, /gpt-6-astra needs the owner's permission/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("checker differs: a checker for a task runs another model than that task's builder", async () => {
  const host = await dispatchHost();
  try {
    const built = await dispatch(host, { task: "fix the invoice total rounding", taskId: "builder-1", providerId: "codex", model: "gpt-6.1-sol" }, capCtx);
    assert.match(built, /Owner task T1 /);
    const checked = await dispatch(host, { task: "check the invoice rounding PR", taskId: "checker-1", role: "checker", shape: "scout", taskRef: "T1" }, capCtx);
    assert.match(checked, /\nPicked claude-code claude-opus-5-5 \(rule checker\)\./);
    assert.deepEqual(spawned(host).at(-1), { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: undefined });
  } finally { await host.harness.lifecycle.dispose(); }
});

test("firstmate_models edits the home file and the next dispatch uses it; a broken file tells the owner once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fm-models-"));
  try {
    // No worktree: with a home set, a worktree dispatch waits up to 45 s for a path the fake host never gives.
    const host = await dispatchHost({ fmHome: dir });
    try {
      const listed = text(await tool(host, "firstmate_models").execute({ action: "list" }, { projectId: "proj_1" }));
      assert.match(listed, /small-edit: .* → codex gpt-6-luna, then claude-code claude-sonnet-5-5 low/);
      const saved = text(await tool(host, "firstmate_models").execute({
        action: "set", id: "ui", when: "UI changes", use: [{ harness: "claude-code", model: "claude-opus-5-5", effort: "medium" }],
      }, { projectId: "proj_1" }));
      assert.match(saved, /Saved rule ui\./);
      assert.match(await dispatch(host, { task: "restyle the login form", rule: "ui", sharedEnv: true }), /\nPicked claude-code claude-opus-5-5 medium \(rule ui\)\./);
      const cli = await host.harness.behavior.runCli(["models"], { projectId: "proj_1" });
      assert.equal(cli.exitCode, 0, cli.stderr);
      assert.match(cli.stdout, /ui: UI changes → claude-code claude-opus-5-5 medium/);
      const bad = await host.harness.behavior.runCli(["models", "set", "--when", "docs", "--use", '[{"harness":"grok"}]'], { projectId: "proj_1" });
      assert.notEqual(bad.exitCode, 0);
      assert.match(bad.stderr + bad.stdout, /use is invalid/);
      mkdirSync(join(dir, "config"), { recursive: true });
      writeFileSync(join(dir, "config", "crew-dispatch.json"), "{oops");
      const first = await dispatch(host, { task: "restyle the login form", rule: "ui", sharedEnv: true });
      assert.match(first, /\nPicked acp-grok grok-4\.5 high|\nPicked claude-code claude-opus-5-5 \(rule ui; skipped/);
      assert.match(first, /\nTell the owner: config\/crew-dispatch\.json is broken \(not valid JSON\); crews use the starter rules until it is fixed\./);
      assert.doesNotMatch(await dispatch(host, { task: "restyle the signup form", rule: "ui", sharedEnv: true }), /is broken/, "reported once");
    } finally { await host.harness.lifecycle.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
