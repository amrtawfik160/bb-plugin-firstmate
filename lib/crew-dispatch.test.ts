import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  chooseProfile,
  latestBuilderModel,
  loadCrewDispatch,
  quotaLeft,
  readBbSubsQuota,
  runModelsCommand,
  weeklyPercent,
  type QuotaCache,
  type QuotaSnapshot,
} from "./crew-dispatch.ts";

function home() {
  const dir = mkdtempSync(join(tmpdir(), "fm-dispatch-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function quota(rows: Array<{ provider: string; weekly?: number; extra?: QuotaSnapshot["accounts"][number]["limits"]; active?: boolean; stale?: boolean }>): QuotaSnapshot {
  return {
    accounts: rows.map((row) => ({
      provider: row.provider,
      account: "a",
      active: row.active !== false,
      ...(row.stale ? { stale: true } : {}),
      limits: row.extra ?? [{ label: "Weekly window", remaining: row.weekly ?? 100, limit: 100, unit: "percent", scope: null }],
    })),
  };
}

// The shape `bb subs quota --json` printed on 20 Oct, with account names removed.
const LIVE_SHAPE = {
  now: 1792500000000,
  accounts: [
    { provider: "claude", account: "x", active: false, stale: false, error: null, limits: [
      { label: "5-hour window", used: 0, limit: 100, remaining: 100, unit: "percent", resetAt: 1, scope: null },
      { label: "Weekly window", used: 93, limit: 100, remaining: 7, unit: "percent", resetAt: 1, scope: null },
    ] },
    { provider: "claude", account: "y", active: true, stale: false, error: null, limits: [
      { label: "5-hour window", used: 45, limit: 100, remaining: 55, unit: "percent", resetAt: 1, scope: null },
      { label: "Fable · weekly", used: 95, limit: 100, remaining: 5, unit: "percent", resetAt: 1, scope: { kind: "group", group: "Fable" } },
    ] },
    { provider: "grok", account: "z", active: true, stale: false, error: null, limits: [
      { label: "Weekly pool", used: 100, limit: 100, remaining: 0, unit: "percent", resetAt: 1, scope: null },
    ] },
    { provider: "antigravity", account: "w", active: true, stale: false, error: null, limits: [
      { label: "Claude · weekly", used: 100, limit: 100, remaining: 0, unit: "percent", resetAt: 1, scope: { kind: "group", group: "Claude" } },
    ] },
    { provider: "codex", account: "v", active: true, stale: false, error: null, limits: [
      { label: "Weekly window", used: 63, limit: 100, remaining: 37, unit: "percent", resetAt: 1, scope: null },
      { label: "Credit balance", used: null, limit: null, remaining: 5000, unit: "credits", resetAt: null, scope: null },
    ] },
    { provider: "cursor", account: "u", active: true, stale: false, error: null, limits: [
      { label: "Plan usage", used: 390, limit: 400, remaining: 10, unit: "usd", resetAt: 1, scope: null },
    ] },
  ],
};

test("first use writes the DESIGN.md starter rules; empty home stays in memory", () => {
  const f = home();
  try {
    assert.equal(loadCrewDispatch("").written, false);
    const loaded = loadCrewDispatch(f.dir);
    assert.equal(loaded.written, true);
    assert.equal(loaded.broken, false);
    const written = JSON.parse(readFileSync(join(f.dir, "config", "fm-model-rules.json"), "utf8")) as {
      rules: Array<{ id: string; use: Array<{ harness: string; model: string; effort?: string }> }>;
      default: Array<{ model: string }>;
    };
    const first = (id: string) => written.rules.find((r) => r.id === id)?.use[0];
    assert.deepEqual(first("small-edit"), { harness: "codex", model: "gpt-6-luna" });
    assert.deepEqual(written.rules.find((r) => r.id === "small-edit")?.use[1], { harness: "claude-code", model: "claude-sonnet-5-5", effort: "low" });
    assert.deepEqual(first("ui"), { harness: "acp-grok", model: "grok-4.5", effort: "high" });
    assert.deepEqual(first("big-ui"), { harness: "claude-code", model: "claude-opus-5-5" });
    assert.deepEqual(first("big-risky"), { harness: "acp-grok", model: "grok-4.6", effort: "xhigh" });
    assert.deepEqual(first("research"), { harness: "acp-grok", model: "grok-4.7" });
    assert.deepEqual(first("checker"), { harness: "codex", model: "gpt-6.1-sol" });
    assert.equal(written.default[0]?.model, "claude-opus-5-5");
    assert.equal(JSON.stringify(written).includes("gpt-6-astra"), false, "no starter rule uses gpt-6-astra");
    assert.equal(loadCrewDispatch(f.dir).written, false, "a second load does not rewrite");
  } finally { f.done(); }
});

test("the plugin never reads or writes config/crew-dispatch.json, the file the native home check scans", () => {
  const f = home();
  try {
    mkdirSync(join(f.dir, "config"), { recursive: true });
    const native = join(f.dir, "config", "crew-dispatch.json");
    writeFileSync(native, '{"rules":[],"default":{"harness":"grok"}}');
    const loaded = loadCrewDispatch(f.dir);
    assert.equal(loaded.broken, false, "the native file is not read");
    assert.equal(loaded.config.default[0]?.model, "claude-opus-5-5");
    runModelsCommand(f.dir, { action: "set", id: "docs", when: "docs only", use: [{ harness: "claude-code", model: "claude-haiku-5-5" }] });
    runModelsCommand(f.dir, { action: "reset" });
    assert.equal(readFileSync(native, "utf8"), '{"rules":[],"default":{"harness":"grok"}}', "the native file is not written");
    assert.deepEqual(readdirSync(join(f.dir, "config")).filter((name) => !name.endsWith(".bak")).sort(), ["crew-dispatch.json", "fm-model-rules.json"]);
  } finally { f.done(); }
});

test("rule order: owner-named model beats a rule, and a rule beats the file default", async () => {
  const f = home();
  try {
    const { config } = loadCrewDispatch(f.dir);
    const named = await chooseProfile({ config, rule: "ui", named: { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "medium" } });
    assert.deepEqual([named.providerId, named.model, named.reasoningLevel, named.source], ["codex", "gpt-6.1-sol", "medium", "named"]);
    assert.equal(named.line, "Picked codex gpt-6.1-sol medium (owner-named).");
    const rule = await chooseProfile({ config, rule: "ui" });
    assert.deepEqual([rule.providerId, rule.model, rule.reasoningLevel, rule.source], ["acp-grok", "grok-4.5", "high", "rule"]);
    assert.equal(rule.line, "Picked acp-grok grok-4.5 high (rule ui).");
    assert.equal((await chooseProfile({ config, rule: " UI changes " })).model, "grok-4.5", "the when-text names the rule too");
    const fallback = await chooseProfile({ config });
    assert.deepEqual([fallback.providerId, fallback.model, fallback.source], ["claude-code", "claude-opus-5-5", "default"]);
    assert.equal(fallback.line, "Picked claude-code claude-opus-5-5 (default).");
    const unknown = await chooseProfile({ config, rule: "not-a-rule" });
    assert.deepEqual([unknown.model, unknown.source], ["claude-opus-5-5", "default"]);
    assert.match(unknown.notice ?? "", /Unknown rule "not-a-rule"; used the builder default\. Rules: small-edit, ui,/);
    const unknownChecker = await chooseProfile({ config, rule: "nope", role: "checker" });
    assert.equal(unknownChecker.model, "gpt-6.1-sol", "an unknown rule keeps the role default");
    const lookup = await chooseProfile({ config, role: "lookup" });
    assert.deepEqual([lookup.providerId, lookup.model, lookup.source], ["claude-code", "claude-haiku-5-5", "lookup"]);
  } finally { f.done(); }
});

test("a rule is named by id or whole when-text only, never by matching task text", async () => {
  const { config } = loadCrewDispatch("");
  const pick = await chooseProfile({ config, rule: "fix the login UI changes please" });
  assert.equal(pick.source, "default");
  assert.equal(pick.model, "claude-opus-5-5");
});

test("quota skip: under 15% weekly or 0% is skipped, 15% is kept, and the line says why", async () => {
  const { config } = loadCrewDispatch("");
  const skipped = await chooseProfile({ config, rule: "ui", quota: quota([{ provider: "grok", weekly: 10 }, { provider: "antigravity", weekly: 80 }, { provider: "claude", weekly: 90 }]) });
  assert.deepEqual([skipped.providerId, skipped.model], ["acp-antigravity", "gemini-3.8-flash"]);
  assert.equal(skipped.notice, undefined);
  assert.equal(skipped.line, "Picked acp-antigravity gemini-3.8-flash (rule ui; skipped acp-grok grok-4.5 high: 10% left in weekly window).");
  const exhausted = await chooseProfile({ config, rule: "ui", quota: quota([{ provider: "grok", weekly: 0 }, { provider: "antigravity", weekly: 40 }]) });
  assert.equal(exhausted.model, "gemini-3.8-flash");
  assert.match(exhausted.line, /acp-grok grok-4\.5 high: none left in weekly window/);
  assert.equal((await chooseProfile({ config, rule: "ui", quota: quota([{ provider: "grok", weekly: 15 }]) })).model, "grok-4.5");
  const fiveHourHigh = quota([{ provider: "grok", extra: [
    { label: "5h", remaining: 90, limit: 100, unit: "percent" },
    { label: "weekly", remaining: 8, limit: 100, unit: "percent" },
  ] }]);
  assert.equal(weeklyPercent(fiveHourHigh, "acp-grok"), 8, "the weekly row decides, not the 5-hour row");
});

test("quota reads the live bb subs shape: active account, model-group rows, usd plans, stale accounts", async () => {
  const live = LIVE_SHAPE as unknown as QuotaSnapshot;
  assert.equal(weeklyPercent(live, "claude-code", "claude-opus-5-5"), undefined, "the active account has no weekly row for Opus; a Fable row does not apply");
  assert.deepEqual(quotaLeft(live, "claude-code", "claude-opus-5-5"), { percent: 55, window: "5-hour window" }, "the window that stands in keeps its own label");
  assert.equal(weeklyPercent(live, "claude-code", "claude-fable-5-1"), 5, "a Fable row applies to Fable");
  assert.equal(weeklyPercent(live, "acp-grok", "grok-4.5"), 0);
  assert.equal(weeklyPercent(live, "acp-antigravity", "gemini-3.8-flash"), undefined, "a Claude group row says nothing about Gemini");
  assert.equal(weeklyPercent(live, "acp-antigravity", "claude-opus-5-5"), 0);
  assert.equal(weeklyPercent(live, "codex", "gpt-6.1-sol"), 37, "credits without a limit are not a percent");
  assert.equal(weeklyPercent(live, "acp-cursor", "composer-2.5"), undefined);
  assert.deepEqual(quotaLeft(live, "acp-cursor", "composer-2.5"), { percent: 2.5, window: "Plan usage" });
  assert.equal(weeklyPercent(live, "pi", "anything"), undefined, "pi spans many providers");
  assert.equal(weeklyPercent(quota([{ provider: "grok", weekly: 1, stale: true }]), "acp-grok"), undefined, "a stale account is unknown");
  const { config } = loadCrewDispatch("");
  const fiveHour = await chooseProfile({ config, rule: "big-risky", quota: quota([{ provider: "grok", weekly: 90 }, { provider: "claude", extra: [{ label: "5-hour window", remaining: 6, limit: 100, unit: "percent", scope: null }] }]), check: async (p) => p.harness === "acp-grok" ? "not in the catalog" : null });
  assert.match(fiveHour.line, /claude-code claude-opus-5-5: 6% left in 5-hour window/, "a 5-hour reading is never called weekly");
});

test("a spent short window blocks a model whose weekly quota remains, and names that window", async () => {
  const spent = quota([{ provider: "claude", extra: [
    { label: "5-hour window", remaining: 0, limit: 100, unit: "percent", scope: null },
    { label: "Weekly window", remaining: 80, limit: 100, unit: "percent", scope: null },
  ] }, { provider: "codex", weekly: 80 }]);
  assert.deepEqual(quotaLeft(spent, "claude-code", "claude-opus-5-5"), { percent: 0, window: "5-hour window" });
  assert.equal(weeklyPercent(spent, "claude-code", "claude-opus-5-5"), undefined, "a spent 5-hour window is not reported as weekly");
  const { config } = loadCrewDispatch("");
  const pick = await chooseProfile({ config, quota: spent, fallback: async () => [{ harness: "codex", model: "gpt-6.1-sol" }] });
  assert.equal(pick.line, "Picked codex gpt-6.1-sol (fallback to a usable provider; the default cannot run: claude-code claude-opus-5-5: none left in 5-hour window).");
});

test("an unknown provider default is a blocked candidate, and a checker never runs on one", async () => {
  const { config } = loadCrewDispatch("");
  const rules = { ...config, rules: [{ id: "checker", when: "checker", use: [{ harness: "claude-code" as const }, { harness: "codex" as const, model: "gpt-6.1-sol" }] }] };
  const pick = await chooseProfile({ config: rules, role: "checker", avoidModel: "claude-opus-5-5", resolveModel: async () => undefined });
  assert.deepEqual([pick.providerId, pick.model], ["codex", "gpt-6.1-sol"]);
  assert.equal(pick.line, "Picked codex gpt-6.1-sol (rule checker; skipped claude-code: default model unknown (model list unreadable)).");
  const noResolver = await chooseProfile({ config: rules, role: "checker", avoidModel: "claude-opus-5-5" });
  assert.equal(noResolver.model, "gpt-6.1-sol", "without a resolver a checker still skips an unknown default");
  const resolved = await chooseProfile({ config: rules, role: "checker", avoidModel: "gpt-6.1-sol", resolveModel: async () => "claude-opus-5-5" });
  assert.equal(resolved.line, "Picked claude-code claude-opus-5-5 (rule checker).", "the line names the resolved model");
});

test("all-low notice: every model low keeps the strongest that can run and tells the owner", async () => {
  const { config } = loadCrewDispatch("");
  const pick = await chooseProfile({ config, rule: "ui", quota: quota([{ provider: "grok", weekly: 5 }, { provider: "antigravity", weekly: 3 }, { provider: "claude", weekly: 10 }]) });
  assert.deepEqual([pick.providerId, pick.model], ["acp-grok", "grok-4.5"]);
  assert.equal(pick.notice, "Tell the owner: every model in rule ui that can run is under 15% quota; kept acp-grok grok-4.5 high (5% left in weekly window).");
  assert.doesNotMatch(pick.line, /grok-4\.5 high: 5% left/, "the kept model is not listed as skipped");
  const firstOut = await chooseProfile({ config, rule: "ui", quota: quota([{ provider: "grok", weekly: 0 }, { provider: "antigravity", weekly: 3 }, { provider: "claude", weekly: 10 }]) });
  assert.equal(firstOut.model, "gemini-3.8-flash", "an exhausted model is skipped even when all are low");
  const lowBlocked = await chooseProfile({
    config, rule: "ui", quota: quota([{ provider: "grok", weekly: 5 }, { provider: "antigravity", weekly: 3 }, { provider: "claude", weekly: 10 }]),
    check: async (profile) => profile.harness === "acp-grok" ? "not in the catalog" : null,
  });
  assert.equal(lowBlocked.model, "gemini-3.8-flash");
  assert.match(lowBlocked.line, /skipped acp-grok grok-4\.5 high: 5% left in weekly window, not in the catalog; claude-code claude-opus-5-5: 10% left in weekly window\)/);
  await assert.rejects(
    chooseProfile({ config, rule: "ui", quota: quota([{ provider: "grok", weekly: 0 }, { provider: "antigravity", weekly: 0 }, { provider: "claude", weekly: 0 }]) }),
    /no model in rule ui can run .*none left in weekly window.*Nothing was spawned/,
  );
});

test("unreadable quota keeps the first profile and says so when the list has more than one", async () => {
  const { config } = loadCrewDispatch("");
  const multi = await chooseProfile({ config, rule: "ui", quota: null });
  assert.equal(multi.model, "grok-4.5");
  assert.equal(multi.notice, "Quota could not be read; kept the first model in rule ui that the catalog accepts.");
  const single = await chooseProfile({ config, quota: null });
  assert.equal(single.model, "claude-opus-5-5");
  assert.equal(single.notice, undefined);
});

test("a candidate the catalog or a guard refuses is skipped and named; all refused refuses the dispatch", async () => {
  const { config } = loadCrewDispatch("");
  const seen: string[] = [];
  const pick = await chooseProfile({
    config, rule: "ui", quota: null,
    check: async (profile) => { seen.push(profile.model ?? ""); return profile.model === "grok-4.5" ? "not in the catalog" : profile.harness === "acp-antigravity" ? "not used for ship work" : null; },
  });
  assert.deepEqual([pick.providerId, pick.model], ["claude-code", "claude-opus-5-5"]);
  assert.equal(pick.line, "Picked claude-code claude-opus-5-5 (rule ui; skipped acp-grok grok-4.5 high: not in the catalog; acp-antigravity gemini-3.8-flash: not used for ship work).");
  assert.deepEqual(seen, ["grok-4.5", "gemini-3.8-flash", "claude-opus-5-5"], "each candidate is checked once, in order");
  await assert.rejects(chooseProfile({ config, rule: "research", check: async () => "provider not available" }), /no model in rule research can run \(acp-grok grok-4\.7: provider not available\)/);
});

test("fallback: a rule that cannot run tries the role default, then usable providers, each checked again", async () => {
  const { config } = loadCrewDispatch("");
  const stale = await chooseProfile({ config, rule: "research", check: async (p) => p.model === "grok-4.7" ? "not in the catalog" : null });
  assert.deepEqual([stale.providerId, stale.model, stale.source], ["claude-code", "claude-opus-5-5", "default"]);
  assert.equal(stale.line, "Picked claude-code claude-opus-5-5 (default; rule research cannot run: acp-grok grok-4.7: not in the catalog).");
  assert.equal(stale.notice, "Tell the owner: rule research cannot run (acp-grok grok-4.7: not in the catalog); this crew runs claude-code claude-opus-5-5 instead. Update the rule with firstmate_models.");
  const resolveModel = async (p: { harness: string }) => p.harness === "codex" ? "gpt-6.1-sol" : p.harness === "acp-grok" ? "grok-4.7" : "claude-opus-5-5";
  const fallback = async () => [{ harness: "claude-code" as const }, { harness: "codex" as const }, { harness: "acp-grok" as const }];
  const moved = await chooseProfile({
    config, role: "builder", avoidModel: "gpt-6.1-sol", resolveModel, fallback,
    quota: quota([{ provider: "claude", weekly: 0 }, { provider: "codex", weekly: 80 }, { provider: "grok", weekly: 80 }]),
  });
  assert.deepEqual([moved.providerId, moved.model, moved.source], ["acp-grok", "grok-4.7", "fallback"], "quota, then the excluded model, are checked again on the fallback");
  assert.match(moved.line, /^Picked acp-grok grok-4\.7 \(fallback to a usable provider; the default cannot run: claude-code claude-opus-5-5: none left in weekly window; skipped codex gpt-6\.1-sol: the builder's model\)\.$/);
  assert.doesNotMatch(moved.line, /claude-code claude-opus-5-5: none left in weekly window;.*claude-code claude-opus-5-5/, "a model already tried is not tried again");
  const onlyAstra = { ...config, rules: [{ id: "only-astra", when: "only astra", use: [{ harness: "codex" as const, model: "gpt-6-astra" }] }] };
  await assert.rejects(chooseProfile({ config: onlyAstra, rule: "only-astra", fallback }), /gpt-6-astra needs the owner's permission/, "the permission guard is never chosen around");
  await assert.rejects(chooseProfile({ config, rule: "research", fallback: async () => [], check: async () => "provider not available" }), /^Error: Refusing: no model in rule research can run \(acp-grok grok-4\.7: provider not available\); no model in the default can run/);
});

test("astra guard: gpt-6-astra is skipped without the owner permission ref and allowed with it", async () => {
  const { config } = loadCrewDispatch("");
  const withAstra = { ...config, rules: [{ id: "astra-first", when: "needs astra", use: [{ harness: "codex" as const, model: "gpt-6-astra" }, { harness: "codex" as const, model: "gpt-6.1-sol" }] }] };
  assert.equal((await chooseProfile({ config: withAstra, rule: "astra-first" })).model, "gpt-6.1-sol");
  assert.equal((await chooseProfile({ config: withAstra, rule: "astra-first", modelPermission: "tg:985604794:5617" })).model, "gpt-6-astra");
  await assert.rejects(chooseProfile({ config, named: { providerId: "codex", model: "gpt-6-astra" } }), /gpt-6-astra needs the owner's permission/);
  const onlyAstra = { ...config, rules: [{ id: "only-astra", when: "only astra", use: [{ harness: "codex" as const, model: "gpt-6-astra" }] }] };
  await assert.rejects(chooseProfile({ config: onlyAstra, rule: "only-astra" }), /gpt-6-astra needs the owner's permission/);
});

test("checker differs: a checker skips the builder model of the task it checks", async () => {
  const { config } = loadCrewDispatch("");
  const pick = await chooseProfile({ config, role: "checker", avoidModel: "gpt-6.1-sol" });
  assert.deepEqual([pick.providerId, pick.model, pick.source], ["claude-code", "claude-opus-5-5", "rule"]);
  assert.equal((await chooseProfile({ config, role: "checker", avoidModel: "claude-opus-5-5" })).model, "gpt-6.1-sol");
  const crews = [
    { id: "b1", role: "builder", model: "grok-4.6", parentThreadId: "cap", createdAt: "2026-10-19T00:00:00.000Z" },
    { id: "b2", model: "claude-opus-5-5", parentThreadId: "cap", createdAt: "2026-10-19T01:00:00.000Z" },
    { id: "s1", shape: "scout", model: "grok-4.7", parentThreadId: "cap", createdAt: "2026-10-19T03:00:00.000Z" },
    { id: "o1", role: "builder", model: "other", parentThreadId: "other", createdAt: "2026-10-19T02:00:00.000Z" },
  ];
  assert.equal(latestBuilderModel(crews, { parentThreadId: "cap" }), "claude-opus-5-5", "the newest builder under the captain; a scout is not a builder");
  assert.equal(latestBuilderModel(crews, { parentThreadId: "cap", crewIds: ["b1"] }), "grok-4.6", "the checked task's crews win");
  await assert.rejects(
    chooseProfile({ config: { ...config, rules: [{ id: "checker", when: "checker", use: [{ harness: "codex", model: "gpt-6.1-sol" }] }] }, role: "checker", avoidModel: "gpt-6.1-sol" }),
    /no model in rule checker can run \(codex gpt-6\.1-sol: the builder's model\)\. Name a model or pick another rule\. Nothing was spawned\./,
  );
});

test("broken file: falls back to starter rules, reports once, and edits never overwrite it", () => {
  const f = home();
  try {
    const file = join(f.dir, "config", "fm-model-rules.json");
    mkdirSync(join(f.dir, "config"), { recursive: true });
    writeFileSync(file, "{not json");
    const first = loadCrewDispatch(f.dir);
    assert.equal(first.broken, true);
    assert.equal(first.config.default[0]?.model, "claude-opus-5-5");
    assert.equal(first.brokenNotice, "Tell the owner: config/fm-model-rules.json is broken (not valid JSON); crews use the starter rules until it is fixed.");
    const second = loadCrewDispatch(f.dir);
    assert.equal(second.broken, true);
    assert.equal(second.brokenNotice, undefined, "reported once per broken content");
    writeFileSync(file, '{"rules":[],"default":{"harness":"grok"}}');
    const third = loadCrewDispatch(f.dir);
    assert.match(third.brokenNotice ?? "", /broken \(default\..*harness/, "new broken content reports again, with the field");
    writeFileSync(file, '{"rules":[{"when":"x","use":{"harness":"codex","modle":"gpt-6-luna"}}],"default":{"harness":"codex"}}');
    assert.equal(loadCrewDispatch(f.dir).broken, true, "an unknown key is a typo, not ignored");
    assert.match(runModelsCommand(f.dir, { action: "list" }).text, /^config\/fm-model-rules\.json is broken \(.+\); crews use these starter rules/);
    assert.throws(() => runModelsCommand(f.dir, { action: "set", when: "docs", use: [{ harness: "codex" }] }), /is broken .*run reset/);
    assert.match(readFileSync(file, "utf8"), /modle/, "the owner's broken text is untouched");
    const reset = runModelsCommand(f.dir, { action: "reset" });
    assert.match(reset.text, /Wrote the starter rules; the old file is config\/fm-model-rules\.json\..+\.bak/);
    assert.equal(readdirSync(join(f.dir, "config")).filter((name) => name.endsWith(".bak")).length, 1);
    assert.equal(loadCrewDispatch(f.dir).broken, false);
    assert.equal(existsSync(join(f.dir, "state", "fm-model-rules.broken")), false);
  } finally { f.done(); }
});

test("the models command lists, sets, replaces, removes and changes the default", async () => {
  const f = home();
  try {
    const listed = runModelsCommand(f.dir, { action: "list" });
    assert.match(listed.text, /small-edit: small edit: typo, rename, or one-file fix → codex gpt-6-luna, then claude-code claude-sonnet-5-5 low/);
    runModelsCommand(f.dir, { action: "set", id: "docs", when: "docs only", why: "cheap docs pass", use: [{ harness: "claude-code", model: "claude-haiku-5-5" }] });
    assert.match(runModelsCommand(f.dir, { action: "list" }).text, /docs: docs only → claude-code claude-haiku-5-5 \(cheap docs pass\)/);
    runModelsCommand(f.dir, { action: "set", id: "ui", when: "UI changes", use: '[{"harness":"claude-code","model":"claude-opus-5-5","effort":"medium"}]' });
    const ui = await chooseProfile({ config: loadCrewDispatch(f.dir).config, rule: "ui" });
    assert.equal(ui.line, "Picked claude-code claude-opus-5-5 medium (rule ui).", "use Opus for UI replaces the ui rule");
    assert.match(runModelsCommand(f.dir, { action: "list" }).text, /ui: UI changes → claude-code claude-opus-5-5 medium \(Grok 4\.5 for UI/, "a replaced rule keeps its why");
    runModelsCommand(f.dir, { action: "remove", id: "docs" });
    assert.doesNotMatch(runModelsCommand(f.dir, { action: "list" }).text, /docs only/);
    assert.throws(() => runModelsCommand(f.dir, { action: "remove", id: "docs" }), /No rule "docs"/);
    runModelsCommand(f.dir, { action: "default", use: [{ harness: "acp-grok", model: "grok-4.7" }] });
    assert.equal((await chooseProfile({ config: loadCrewDispatch(f.dir).config })).model, "grok-4.7");
    assert.throws(() => runModelsCommand(f.dir, { action: "set", when: "x", use: [{ harness: "grok" }] }), /use is invalid .*harness is one of claude-code/);
    assert.throws(() => runModelsCommand(f.dir, { action: "set", when: "x", use: "[not json" }), /use is not valid JSON/);
    assert.throws(() => runModelsCommand("", { action: "list" }), /No firstmate home/);
  } finally { f.done(); }
});

test("readBbSubsQuota: no live call under FM_NO_LIVE_NETWORK, 5-minute cache, 1-minute retry, BB_CLI", async () => {
  const cache: { current: QuotaCache | null; pending: Promise<QuotaSnapshot | null> | null } = { current: null, pending: null };
  const calls: string[] = [];
  const io = (now: number, stdout: string | Error) => ({
    execFile: async (cmd: string, args: string[]) => { calls.push(`${cmd} ${args.join(" ")}`); if (stdout instanceof Error) throw stdout; return { stdout }; },
    env: { BB_CLI: "/opt/bb" }, now, cache,
  });
  assert.equal(await readBbSubsQuota({ ...io(0, "{}"), env: { FM_NO_LIVE_NETWORK: "1" } }), null);
  assert.deepEqual(calls, []);
  const ok = await readBbSubsQuota(io(1, JSON.stringify(LIVE_SHAPE)));
  assert.equal(weeklyPercent(ok, "codex"), 37);
  assert.deepEqual(calls, ["/opt/bb subs quota --json"]);
  assert.equal(weeklyPercent(await readBbSubsQuota(io(1 + 4 * 60_000, "{}")), "codex"), 37, "fresh for 5 minutes");
  assert.equal(calls.length, 1);
  assert.equal(await readBbSubsQuota(io(1 + 5 * 60_000, new Error("down"))), null, "stale after 5 minutes; a failed read is unreadable");
  assert.equal(await readBbSubsQuota(io(2 + 5 * 60_000 + 30_000, JSON.stringify(LIVE_SHAPE))), null, "a failure is kept for a minute");
  assert.equal(weeklyPercent(await readBbSubsQuota(io(2 + 6 * 60_000, JSON.stringify(LIVE_SHAPE))), "codex"), 37, "then read again");
  assert.equal(calls.length, 3);
  assert.equal(await readBbSubsQuota({ ...io(2 + 6 * 60_000 + 1, '{"accounts":[]}'), env: { BB_CLI: "/opt/other-bb" } }).then((v) => v?.accounts.length), 0, "another command does not reuse this reading");
  assert.equal(calls.length, 4);
  cache.current = null;
  const [a, b] = await Promise.all([readBbSubsQuota(io(10_000_000, JSON.stringify(LIVE_SHAPE))), readBbSubsQuota(io(10_000_000, JSON.stringify(LIVE_SHAPE)))]);
  assert.equal(a, b, "two dispatches at once share one read");
  assert.equal(calls.length, 5);
});
