import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  chooseProfile,
  latestBuilderModel,
  loadCrewDispatch,
  readBbSubsQuota,
  runModelsCommand,
  weeklyPercent,
  type QuotaSnapshot,
} from "./crew-dispatch.ts";

function home() {
  const dir = mkdtempSync(join(tmpdir(), "fm-dispatch-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function quota(rows: Array<{ provider: string; weekly?: number; extra?: QuotaSnapshot["accounts"][number]["limits"]; active?: boolean }>): QuotaSnapshot {
  return {
    now: "2026-10-19T00:00:00Z",
    accounts: rows.map((row) => ({
      provider: row.provider,
      account: "a",
      active: row.active !== false,
      limits: row.extra ?? [{ label: "weekly", remaining: row.weekly ?? 100, limit: 100, unit: "percent" }],
    })),
  };
}

test("first use writes the DESIGN.md starter rules; empty home stays in memory", () => {
  const f = home();
  try {
    const missing = loadCrewDispatch("");
    assert.equal(missing.written, false);
    assert.equal(existsSync(join("", "config", "crew-dispatch.json")), false);
    const loaded = loadCrewDispatch(f.dir);
    assert.equal(loaded.written, true);
    assert.equal(loaded.broken, false);
    const written = JSON.parse(readFileSync(join(f.dir, "config", "crew-dispatch.json"), "utf8")) as {
      rules: Array<{ id: string; use: Array<{ harness: string; model: string; effort?: string }> }>;
      default: Array<{ model: string }>;
    };
    assert.equal(written.rules.find((r) => r.id === "small-edit")?.use[0]?.model, "gpt-6-luna");
    assert.equal(written.rules.find((r) => r.id === "ui")?.use[0]?.model, "grok-4.5");
    assert.equal(written.rules.find((r) => r.id === "ui")?.use[0]?.effort, "high");
    assert.equal(written.rules.find((r) => r.id === "big-ui")?.use[0]?.model, "claude-opus-5-5");
    assert.equal(written.rules.find((r) => r.id === "big-risky")?.use[0]?.model, "grok-4.6");
    assert.equal(written.rules.find((r) => r.id === "research")?.use[0]?.model, "grok-4.7");
    assert.equal(written.rules.find((r) => r.id === "checker")?.use[0]?.model, "gpt-6.1-sol");
    assert.equal(written.default[0]?.model, "claude-opus-5-5");
    assert.equal(loadCrewDispatch(f.dir).written, false, "a second load does not rewrite");
  } finally { f.done(); }
});

test("owner-named model beats a rule, and a rule beats the file default", () => {
  const f = home();
  try {
    const { config } = loadCrewDispatch(f.dir);
    const named = chooseProfile({
      config,
      rule: "ui",
      named: { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "medium" },
    });
    assert.equal(named.providerId, "codex");
    assert.equal(named.model, "gpt-6.1-sol");
    assert.equal(named.reasoningLevel, "medium");
    assert.equal(named.source, "named");
    assert.equal(named.line, "Picked codex gpt-6.1-sol medium (owner-named).");
    const rule = chooseProfile({ config, rule: "ui" });
    assert.equal(rule.providerId, "acp-grok");
    assert.equal(rule.model, "grok-4.5");
    assert.equal(rule.reasoningLevel, "high");
    assert.equal(rule.source, "rule");
    assert.equal(rule.line, "Picked acp-grok grok-4.5 high (rule ui).");
    const byWhen = chooseProfile({ config, rule: " UI changes " });
    assert.equal(byWhen.model, "grok-4.5");
    const fallback = chooseProfile({ config });
    assert.equal(fallback.providerId, "claude-code");
    assert.equal(fallback.model, "claude-opus-5-5");
    assert.equal(fallback.source, "default");
    assert.equal(fallback.line, "Picked claude-code claude-opus-5-5 (default).");
    const unknown = chooseProfile({ config, rule: "not-a-rule" });
    assert.equal(unknown.model, "claude-opus-5-5");
    assert.equal(unknown.source, "default");
    assert.match(unknown.notice ?? "", /Unknown rule "not-a-rule"; using default/);
    const lookup = chooseProfile({ config, role: "lookup" });
    assert.equal(lookup.providerId, "claude-code");
    assert.equal(lookup.model, "claude-haiku-5-5");
    assert.equal(lookup.source, "lookup");
  } finally { f.done(); }
});

test("chooseProfile never receives task text and does not match a substring of a when-line", () => {
  const f = home();
  try {
    const { config } = loadCrewDispatch(f.dir);
    const pick = chooseProfile({ config, rule: "fix the login UI changes please" });
    assert.equal(pick.source, "default");
    assert.equal(pick.model, "claude-opus-5-5");
  } finally { f.done(); }
});

test("quota skips a profile under 15% weekly or at 0%, and keeps 15%", () => {
  const f = home();
  try {
    const { config } = loadCrewDispatch(f.dir);
    const skipped = chooseProfile({
      config,
      rule: "ui",
      quota: quota([
        { provider: "grok", weekly: 10 },
        { provider: "antigravity", weekly: 80 },
        { provider: "claude", weekly: 90 },
      ]),
    });
    assert.equal(skipped.providerId, "acp-antigravity");
    assert.equal(skipped.model, "gemini-3.8-flash");
    assert.equal(skipped.notice, undefined);
    const exhausted = chooseProfile({
      config,
      rule: "ui",
      quota: quota([
        { provider: "grok", weekly: 0 },
        { provider: "antigravity", weekly: 40 },
      ]),
    });
    assert.equal(exhausted.model, "gemini-3.8-flash");
    const kept = chooseProfile({
      config,
      rule: "ui",
      quota: quota([{ provider: "grok", weekly: 15 }]),
    });
    assert.equal(kept.model, "grok-4.5");
    const weeklyWins = weeklyPercent(
      quota([{
        provider: "grok",
        extra: [
          { label: "5h", remaining: 90, limit: 100, unit: "percent" },
          { label: "weekly", remaining: 8, limit: 100, unit: "percent" },
        ],
      }]),
      "acp-grok",
    );
    assert.equal(weeklyWins, 8);
  } finally { f.done(); }
});

test("when every listed model is low, keep the strongest and say so", () => {
  const f = home();
  try {
    const { config } = loadCrewDispatch(f.dir);
    const pick = chooseProfile({
      config,
      rule: "ui",
      quota: quota([
        { provider: "grok", weekly: 5 },
        { provider: "antigravity", weekly: 3 },
        { provider: "claude", weekly: 10 },
      ]),
    });
    assert.equal(pick.model, "grok-4.5");
    assert.equal(pick.providerId, "acp-grok");
    assert.equal(pick.notice, "All listed models are low on weekly quota; keeping the strongest.");
  } finally { f.done(); }
});

test("unreadable quota keeps the first profile and says so when the list has more than one", () => {
  const f = home();
  try {
    const { config } = loadCrewDispatch(f.dir);
    const multi = chooseProfile({ config, rule: "ui", quota: null });
    assert.equal(multi.model, "grok-4.5");
    assert.equal(multi.notice, "Quota could not be read; keeping the first listed model.");
    const single = chooseProfile({ config, quota: null });
    assert.equal(single.model, "claude-opus-5-5");
    assert.equal(single.notice, undefined);
  } finally { f.done(); }
});

test("gpt-6-astra is skipped without the owner permission ref and allowed with it", () => {
  const f = home();
  try {
    const { config } = loadCrewDispatch(f.dir);
    const withAstra = {
      ...config,
      rules: [{
        id: "astra-first",
        when: "needs astra",
        use: [
          { harness: "codex" as const, model: "gpt-6-astra" },
          { harness: "codex" as const, model: "gpt-6.1-sol" },
        ],
      }],
    };
    const skipped = chooseProfile({ config: withAstra, rule: "astra-first" });
    assert.equal(skipped.model, "gpt-6.1-sol");
    const allowed = chooseProfile({
      config: withAstra,
      rule: "astra-first",
      modelPermission: "tg:985604794:5617",
    });
    assert.equal(allowed.model, "gpt-6-astra");
    assert.throws(
      () => chooseProfile({ config, named: { providerId: "codex", model: "gpt-6-astra" } }),
      /gpt-6-astra needs the owner's permission/,
    );
    const onlyAstra = {
      ...config,
      rules: [{ id: "only-astra", when: "only astra", use: [{ harness: "codex" as const, model: "gpt-6-astra" }] }],
    };
    assert.throws(
      () => chooseProfile({ config: onlyAstra, rule: "only-astra" }),
      /gpt-6-astra needs the owner's permission/,
    );
  } finally { f.done(); }
});

test("a checker skips the builder model", () => {
  const f = home();
  try {
    const { config } = loadCrewDispatch(f.dir);
    const pick = chooseProfile({ config, role: "checker", avoidModel: "gpt-6.1-sol" });
    assert.equal(pick.providerId, "claude-code");
    assert.equal(pick.model, "claude-opus-5-5");
    assert.equal(pick.source, "rule");
    const same = chooseProfile({ config, role: "checker" });
    assert.equal(same.model, "gpt-6.1-sol");
    assert.equal(
      latestBuilderModel([
        { role: "builder", model: "grok-4.6", parentThreadId: "cap", createdAt: "2026-10-19T00:00:00.000Z" },
        { role: "builder", model: "claude-opus-5-5", parentThreadId: "cap", createdAt: "2026-10-19T01:00:00.000Z" },
        { role: "builder", model: "other", parentThreadId: "other", createdAt: "2026-10-19T02:00:00.000Z" },
      ], "cap"),
      "claude-opus-5-5",
    );
    assert.throws(
      () => chooseProfile({
        config: { ...config, rules: [{ id: "checker", when: "checker", use: [{ harness: "codex", model: "gpt-6.1-sol" }] }] },
        role: "checker",
        avoidModel: "gpt-6.1-sol",
      }),
      /checker model must differ from the builder model/,
    );
  } finally { f.done(); }
});

test("a broken file falls back to starter rules and reports once", () => {
  const f = home();
  try {
    mkdirSync(join(f.dir, "config"), { recursive: true });
    writeFileSync(join(f.dir, "config", "crew-dispatch.json"), "{not json");
    const first = loadCrewDispatch(f.dir);
    assert.equal(first.broken, true);
    assert.equal(first.config.default[0]?.model, "claude-opus-5-5");
    assert.match(first.brokenNotice ?? "", /crew-dispatch.json is broken; using starter rules/);
    assert.equal(existsSync(join(f.dir, "state", "crew-dispatch.broken")), true);
    const second = loadCrewDispatch(f.dir);
    assert.equal(second.broken, true);
    assert.equal(second.brokenNotice, undefined);
    writeFileSync(join(f.dir, "config", "crew-dispatch.json"), '{"rules":[],"default":{"harness":"nope"}}');
    const third = loadCrewDispatch(f.dir);
    assert.equal(third.broken, true);
    assert.match(third.brokenNotice ?? "", /broken/);
  } finally { f.done(); }
});

test("the models command lists, sets, removes and replaces the default", () => {
  const f = home();
  try {
    const listed = runModelsCommand(f.dir, { action: "list" });
    assert.match(listed.text, /small-edit/);
    assert.match(listed.text, /gpt-6-luna/);
    runModelsCommand(f.dir, {
      action: "set",
      id: "docs",
      when: "docs only",
      why: "cheap docs pass",
      use: [{ harness: "claude-code", model: "claude-haiku-5-5" }],
    });
    const afterSet = runModelsCommand(f.dir, { action: "list" });
    assert.match(afterSet.text, /docs only/);
    assert.match(afterSet.text, /claude-haiku-5-5/);
    runModelsCommand(f.dir, { action: "remove", id: "docs" });
    assert.doesNotMatch(runModelsCommand(f.dir, { action: "list" }).text, /docs only/);
    runModelsCommand(f.dir, { action: "default", use: [{ harness: "acp-grok", model: "grok-4.7" }] });
    const next = chooseProfile({ config: loadCrewDispatch(f.dir).config });
    assert.equal(next.model, "grok-4.7");
    assert.throws(() => runModelsCommand("", { action: "list" }), /No firstmate home/);
  } finally { f.done(); }
});

test("readBbSubsQuota does not call bb when FM_NO_LIVE_NETWORK is set", async () => {
  const cache = { current: null as { at: number; value: QuotaSnapshot | null } | null };
  let called = false;
  const snapshot = await readBbSubsQuota({
    execFile: async () => {
      called = true;
      return { stdout: "{}" };
    },
    env: { FM_NO_LIVE_NETWORK: "1" },
    now: 1,
    cache,
  });
  assert.equal(snapshot, null);
  assert.equal(called, false);
  const ok = await readBbSubsQuota({
    execFile: async () => ({ stdout: JSON.stringify(quota([{ provider: "grok", weekly: 40 }])) }),
    env: {},
    now: 1,
    cache,
  });
  assert.equal(weeklyPercent(ok, "acp-grok"), 40);
  const cached = await readBbSubsQuota({
    execFile: async () => {
      called = true;
      return { stdout: "{}" };
    },
    env: {},
    now: 1 + 60_000,
    cache,
  });
  assert.equal(weeklyPercent(cached, "acp-grok"), 40);
  assert.equal(called, false);
});
