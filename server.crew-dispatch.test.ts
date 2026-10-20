import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

const tool = (host: { harness: { inspection: { registrations: { agentTools: Array<{ name: string; execute: Function }> } } } }, name: string) =>
  host.harness.inspection.registrations.agentTools.find((t) => t.name === name)!;
const text = (out: unknown) => typeof out === "string" ? out : (out as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? JSON.stringify(out);

async function dispatchHost(fmHome?: string) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["firstmate", "captain"], settings: fmHome ? { fmHome } : {} });
  await plugin(host.bb);
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_new" }));
  host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_new", status: "starting" }));
  host.harness.sdk.stub("providers.list", async () => [
    { id: "claude-code", available: true, reasoningLevels: [{ id: "low" }, { id: "high" }, { id: "xhigh" }] },
    { id: "codex", available: true },
    { id: "acp-grok", available: true, reasoningLevels: [{ id: "high" }, { id: "xhigh" }] },
    { id: "acp-antigravity", available: true },
  ]);
  const catalog: Record<string, string[]> = {
    "claude-code": ["claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"],
    codex: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
    "acp-grok": ["grok-4.7", "grok-4.6", "grok-4.5"],
    "acp-antigravity": ["gemini-3.8-flash"],
  };
  host.harness.sdk.stub("providers.models", async ({ providerId }: { providerId?: string }) => ({
    modelLoadError: null,
    models: (catalog[providerId ?? ""] ?? []).map((id) => ({ id, model: id })),
  }));
  return host;
}

const spawned = (host: { harness: { sdk: { callsTo: (name: string) => unknown[][] } } }) =>
  host.harness.sdk.callsTo("threads.spawn").map(([args]) => {
    const a = args as { providerId?: string; model?: string; reasoningLevel?: string };
    return { providerId: a.providerId, model: a.model, reasoningLevel: a.reasoningLevel };
  });

test("dispatch with a rule picks that rule and names it in the result", async () => {
  const host = await dispatchHost();
  try {
    const out = text(await tool(host, "firstmate_dispatch").execute({ projectId: "proj_1", task: "restyle the login form", rule: "ui" }, { projectId: "proj_1" }));
    assert.doesNotMatch(out, /Refus|FAILED/);
    assert.match(out, /Picked acp-grok grok-4\.5 high \(rule ui\)\./);
    assert.deepEqual(spawned(host).at(-1), { providerId: "acp-grok", model: "grok-4.5", reasoningLevel: "high" });
    const cli = await host.harness.behavior.runCli(["dispatch", "--project", "proj_1", "--rule", "research", "--", "what shipped this week"], { projectId: "proj_1" });
    assert.equal(cli.exitCode, 0, cli.stderr);
    assert.match(cli.stdout, /Picked acp-grok grok-4\.7 \(rule research\)\./);
    assert.deepEqual(spawned(host).at(-1), { providerId: "acp-grok", model: "grok-4.7", reasoningLevel: undefined });
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a rule that picks antigravity for ship work is not swapped by the ship guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fm-models-"));
  try {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "crew-dispatch.json"), `${JSON.stringify({
      rules: [{ id: "agy", when: "antigravity only", use: [{ harness: "acp-antigravity", model: "gemini-3.8-flash" }] }],
      default: [{ harness: "claude-code", model: "claude-opus-5-5" }],
    }, null, 2)}\n`);
    const host = await dispatchHost(dir);
    try {
      const out = text(await tool(host, "firstmate_dispatch").execute({ projectId: "proj_1", task: "ui polish", rule: "agy" }, { projectId: "proj_1" }));
      assert.doesNotMatch(out, /not used for ship work/);
      assert.match(out, /Picked acp-antigravity gemini-3\.8-flash \(rule agy\)\./);
      assert.deepEqual(spawned(host).at(-1), { providerId: "acp-antigravity", model: "gemini-3.8-flash", reasoningLevel: undefined });
    } finally { await host.harness.lifecycle.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("firstmate_models lists and edits the home file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fm-models-"));
  try {
    const host = await dispatchHost(dir);
    try {
      const listed = text(await tool(host, "firstmate_models").execute({ action: "list" }, { projectId: "proj_1" }));
      assert.match(listed, /small-edit/);
      assert.match(listed, /gpt-6-luna/);
      const saved = text(await tool(host, "firstmate_models").execute({
        action: "set", id: "docs", when: "docs only", use: [{ harness: "claude-code", model: "claude-haiku-5-5" }],
      }, { projectId: "proj_1" }));
      assert.match(saved, /Saved rule docs/);
      const cli = await host.harness.behavior.runCli(["models"], { projectId: "proj_1" });
      assert.equal(cli.exitCode, 0, cli.stderr);
      assert.match(cli.stdout, /docs only/);
    } finally { await host.harness.lifecycle.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
