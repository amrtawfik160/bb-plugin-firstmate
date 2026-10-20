import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { toReasoningLevel } from "./policy.ts";
import { modelPermissionRefusal, PERMISSION_MODELS, ROLE_DEFAULTS, type CrewRole } from "../owner/crew-roles.ts";

const execFile = promisify(execFileCb);
const QUOTA_FRESH_MS = 5 * 60 * 1000;
const REL_PATH = "config/crew-dispatch.json";
const BROKEN_PATH = "state/crew-dispatch.broken";

export const BB_PROVIDERS = ["claude-code", "codex", "acp-grok", "acp-antigravity", "acp-cursor", "pi"] as const;
export type BbProvider = (typeof BB_PROVIDERS)[number];

const HARNESS_TO_QUOTA: Record<BbProvider, string> = {
  "claude-code": "claude",
  "codex": "codex",
  "acp-grok": "grok",
  "acp-antigravity": "antigravity",
  "acp-cursor": "cursor",
  pi: "pi",
};

export type DispatchProfile = { harness: BbProvider; model?: string; effort?: string };
export type DispatchRule = { id?: string; when: string; use: DispatchProfile[]; why?: string };
export type CrewDispatchFile = { rules: DispatchRule[]; default: DispatchProfile[] };

const profileSchema = z.object({
  harness: z.enum(BB_PROVIDERS),
  model: z.string().min(1).optional(),
  effort: z.string().optional(),
  provider: z.string().optional(),
  floor: z.object({ scope: z.string(), min_percent: z.number() }).optional(),
});
const useSchema = z.union([profileSchema, z.array(profileSchema).min(1)]);
const ruleSchema = z.object({
  id: z.string().min(1).optional(),
  when: z.string().min(1),
  use: useSchema,
  why: z.string().optional(),
  approval: z.string().optional(),
  min_confidence: z.number().optional(),
  floor: z.object({ scope: z.string(), min_percent: z.number(), provider: z.string().optional() }).optional(),
});
const fileSchema = z.object({
  rules: z.array(ruleSchema).default([]),
  default: useSchema,
});

function asList(use: z.infer<typeof useSchema>): DispatchProfile[] {
  const rows = Array.isArray(use) ? use : [use];
  return rows.map((row) => ({ harness: row.harness, ...(row.model ? { model: row.model } : {}), ...(row.effort ? { effort: row.effort } : {}) }));
}

export const STARTER_DISPATCH: CrewDispatchFile = {
  rules: [
    {
      id: "small-edit",
      when: "small edit: typo, rename, or one-file fix",
      use: [
        { harness: "codex", model: "gpt-6-luna" },
        { harness: "claude-code", model: "claude-sonnet-5-5", effort: "low" },
      ],
      why: "Cheap fast models for a narrow mechanical edit.",
    },
    {
      id: "ui",
      when: "UI changes",
      use: [
        { harness: "acp-grok", model: "grok-4.5", effort: "high" },
        { harness: "acp-antigravity", model: "gemini-3.8-flash" },
        { harness: "claude-code", model: "claude-opus-5-5" },
      ],
      why: "Grok 4.5 for UI, then Gemini flash, then Opus.",
    },
    {
      id: "big-ui",
      when: "big UI redesign",
      use: [{ harness: "claude-code", model: "claude-opus-5-5" }],
      why: "Opus first for a large UI redesign.",
    },
    {
      id: "big-risky",
      when: "big or risky feature",
      use: [
        { harness: "acp-grok", model: "grok-4.6", effort: "xhigh" },
        { harness: "claude-code", model: "claude-opus-5-5" },
        { harness: "codex", model: "gpt-6.1-sol" },
      ],
      why: "Strongest coding models for big or risky work.",
    },
    {
      id: "research",
      when: "research or fresh web facts",
      use: [{ harness: "acp-grok", model: "grok-4.7" }],
      why: "Grok for live web facts.",
    },
    {
      id: "checker",
      when: "checker for another crew's PR",
      use: [
        { harness: "codex", model: "gpt-6.1-sol" },
        { harness: "claude-code", model: "claude-opus-5-5" },
      ],
      why: "Checker must differ from the builder model.",
    },
  ],
  default: [{ harness: "claude-code", model: "claude-opus-5-5" }],
};

export type QuotaLimit = { label?: string; used?: number; limit?: number; remaining?: number; unit?: string; resetAt?: string; scope?: string };
export type QuotaAccount = { provider: string; account?: string; active?: boolean; limits: QuotaLimit[] };
export type QuotaSnapshot = { now?: string; accounts: QuotaAccount[] };
export type QuotaCache = { at: number; value: QuotaSnapshot | null };
export type QuotaIo = {
  execFile?: (cmd: string, args: string[], opts: { timeout: number; maxBuffer: number; encoding: string }) => Promise<{ stdout: string }>;
  env?: NodeJS.Dict<string | undefined>;
  now?: number;
  cache?: { current: QuotaCache | null };
};

const defaultQuotaCache: { current: QuotaCache | null } = { current: null };

export type LoadResult = {
  config: CrewDispatchFile;
  written: boolean;
  broken: boolean;
  brokenNotice?: string;
};

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function normalize(parsed: z.infer<typeof fileSchema>): CrewDispatchFile {
  return {
    rules: parsed.rules.map((rule) => ({
      ...(rule.id ? { id: rule.id } : {}),
      when: rule.when,
      use: asList(rule.use),
      ...(rule.why ? { why: rule.why } : {}),
    })),
    default: asList(parsed.default),
  };
}

function writeConfig(home: string, config: CrewDispatchFile): void {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, REL_PATH), `${JSON.stringify(config, null, 2)}\n`);
}

function reportBroken(home: string, raw: string): string | undefined {
  const hash = createHash("sha256").update(raw).digest("hex");
  const marker = join(home, BROKEN_PATH);
  try {
    if (existsSync(marker) && readFileSync(marker, "utf8").trim() === hash) return undefined;
  } catch { /* report */ }
  try {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(marker, `${hash}\n`);
  } catch { /* still tell the caller once this load */ }
  return "crew-dispatch.json is broken; using starter rules.";
}

export function loadCrewDispatch(home: string): LoadResult {
  const root = home.trim();
  if (root === "" || !isDir(root)) return { config: structuredClone(STARTER_DISPATCH), written: false, broken: false };
  const path = join(root, REL_PATH);
  if (!existsSync(path)) {
    const config = structuredClone(STARTER_DISPATCH);
    writeConfig(root, config);
    return { config, written: true, broken: false };
  }
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch { return { config: structuredClone(STARTER_DISPATCH), written: false, broken: true, brokenNotice: reportBroken(root, "") }; }
  try {
    const parsed = fileSchema.parse(JSON.parse(raw));
    return { config: normalize(parsed), written: false, broken: false };
  } catch {
    return { config: structuredClone(STARTER_DISPATCH), written: false, broken: true, brokenNotice: reportBroken(root, raw) };
  }
}

function requireHome(home: string): string {
  const root = home.trim();
  if (root === "" || !isDir(root)) throw new Error("No firstmate home. Run: bb firstmate init --real");
  return root;
}

function keyOf(rule: { id?: string; when: string }): string {
  return (rule.id ?? rule.when).trim().toLowerCase();
}

function findRule(config: CrewDispatchFile, rule: string | undefined): DispatchRule | undefined {
  if (rule === undefined) return undefined;
  const key = rule.trim().toLowerCase();
  if (key === "") return undefined;
  return config.rules.find((row) => row.id?.toLowerCase() === key || row.when.trim().toLowerCase() === key);
}

export type NamedChoice = { providerId?: string; model?: string; reasoningLevel?: string };
export type PickSource = "named" | "rule" | "default" | "lookup";
export type PickResult = {
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  source: PickSource;
  ruleId?: string;
  line: string;
  notice?: string;
};

export function formatPickLine(pick: { providerId?: string; model?: string; reasoningLevel?: string; source: PickSource; ruleId?: string }): string {
  const bits = [pick.providerId, pick.model, pick.reasoningLevel].filter((part) => part !== undefined && part !== "").join(" ");
  const why = pick.source === "named" ? "owner-named"
    : pick.source === "lookup" ? "lookup default"
    : pick.source === "rule" ? `rule ${pick.ruleId}`
    : "default";
  return `Picked ${bits} (${why}).`;
}

function percentOf(limit: QuotaLimit): number | undefined {
  const unit = (limit.unit ?? "").toLowerCase();
  if (unit === "percent" || unit === "%") return typeof limit.remaining === "number" ? limit.remaining : undefined;
  if (typeof limit.remaining === "number" && typeof limit.limit === "number" && limit.limit > 0) return (limit.remaining / limit.limit) * 100;
  if (limit.remaining === 0) return 0;
  return undefined;
}

function accountWeeklyPercent(account: QuotaAccount): number | undefined {
  const weekly = account.limits.filter((row) => /weekly/i.test(row.label ?? ""));
  const pool = weekly.length > 0 ? weekly : account.limits;
  const percents = pool.map(percentOf).filter((n): n is number => n !== undefined);
  if (percents.length === 0) return undefined;
  return Math.min(...percents);
}

export function weeklyPercent(snapshot: QuotaSnapshot | null | undefined, harness: string): number | undefined {
  if (snapshot === null || snapshot === undefined) return undefined;
  const provider = HARNESS_TO_QUOTA[harness as BbProvider];
  if (provider === undefined) return undefined;
  const accounts = snapshot.accounts.filter((row) => row.provider === provider);
  if (accounts.length === 0) return undefined;
  const active = accounts.filter((row) => row.active !== false);
  const pool = active.length > 0 ? active : accounts;
  let best: number | undefined;
  for (const account of pool) {
    const pct = accountWeeklyPercent(account);
    if (pct === undefined) continue;
    if (best === undefined || pct > best) best = pct;
  }
  return best;
}

function isLow(pct: number | undefined): boolean {
  return pct !== undefined && pct < 15;
}

function allowedAstra(model: string | undefined, permission: string | undefined): boolean {
  return model === undefined || !PERMISSION_MODELS.has(model) || modelPermissionRefusal(model, permission) === null;
}

function resultOf(profile: DispatchProfile, source: PickSource, ruleId: string | undefined, notice?: string): PickResult {
  const pick = {
    providerId: profile.harness,
    model: profile.model,
    reasoningLevel: toReasoningLevel(profile.effort),
    source,
    ruleId,
  };
  return { ...pick, line: formatPickLine(pick), ...(notice ? { notice } : {}) };
}

function pickFromProfiles(
  profiles: DispatchProfile[],
  input: { quota?: QuotaSnapshot | null; modelPermission?: string; avoidModel?: string; source: PickSource; ruleId?: string; unreadableNotice: boolean },
): PickResult {
  const remaining = profiles.filter((profile) => profile.model === undefined || profile.model !== input.avoidModel);
  if (remaining.length === 0) throw new Error("Refusing: checker model must differ from the builder model. Nothing was spawned.");
  const permitted = remaining.filter((profile) => allowedAstra(profile.model, input.modelPermission));
  if (permitted.length === 0) {
    const refusal = modelPermissionRefusal(remaining[0]?.model, input.modelPermission);
    throw new Error(refusal ?? "Refusing: gpt-6-astra needs the owner's permission. Pass modelPermission with his message ref (tg:<chat>:<message>). Nothing was spawned.");
  }
  const unreadable = input.quota === null && input.unreadableNotice && permitted.length > 1
    ? "Quota could not be read; keeping the first listed model."
    : undefined;
  const healthy = permitted.filter((profile) => !isLow(weeklyPercent(input.quota, profile.harness)));
  if (healthy.length > 0) return resultOf(healthy[0]!, input.source, input.ruleId, unreadable);
  return resultOf(permitted[0]!, input.source, input.ruleId, "All listed models are low on weekly quota; keeping the strongest.");
}

export function chooseProfile(input: {
  config: CrewDispatchFile;
  rule?: string;
  role?: CrewRole;
  named?: NamedChoice | null;
  modelPermission?: string;
  avoidModel?: string;
  quota?: QuotaSnapshot | null;
}): PickResult {
  const named = input.named;
  if (named !== undefined && named !== null && (named.providerId !== undefined || named.model !== undefined)) {
    const refusal = modelPermissionRefusal(named.model, input.modelPermission);
    if (refusal !== null) throw new Error(refusal);
    const pick = { providerId: named.providerId, model: named.model, reasoningLevel: named.reasoningLevel, source: "named" as const };
    return { ...pick, line: formatPickLine(pick) };
  }
  const matched = findRule(input.config, input.rule);
  if (input.rule !== undefined && input.rule.trim() !== "" && matched === undefined) {
    const pick = pickFromProfiles(input.config.default, {
      quota: input.quota, modelPermission: input.modelPermission, source: "default", unreadableNotice: input.config.default.length > 1,
    });
    return { ...pick, notice: `Unknown rule "${input.rule.trim()}"; using default.` };
  }
  if (matched !== undefined) {
    return pickFromProfiles(matched.use, {
      quota: input.quota,
      modelPermission: input.modelPermission,
      avoidModel: input.avoidModel,
      source: "rule",
      ruleId: matched.id ?? matched.when,
      unreadableNotice: true,
    });
  }
  if (input.role === "checker") {
    const checker = findRule(input.config, "checker") ?? { id: "checker", when: "checker", use: STARTER_DISPATCH.rules.find((r) => r.id === "checker")!.use };
    return pickFromProfiles(checker.use, {
      quota: input.quota,
      modelPermission: input.modelPermission,
      avoidModel: input.avoidModel,
      source: "rule",
      ruleId: checker.id ?? "checker",
      unreadableNotice: true,
    });
  }
  if (input.role === "lookup") {
    const fallback = ROLE_DEFAULTS.lookup;
    const pick = { providerId: fallback.providerId, model: fallback.model, source: "lookup" as const };
    return { ...pick, line: formatPickLine(pick) };
  }
  return pickFromProfiles(input.config.default, {
    quota: input.quota, modelPermission: input.modelPermission, source: "default", unreadableNotice: input.config.default.length > 1,
  });
}

export function latestBuilderModel(
  crews: Array<{ role?: string; model?: string | null; parentThreadId?: string | null; createdAt?: string }>,
  parentThreadId?: string | null,
): string | undefined {
  const builders = crews.filter((crew) =>
    (parentThreadId == null || crew.parentThreadId === parentThreadId)
    && (crew.role === "builder" || crew.role === undefined)
    && typeof crew.model === "string"
    && crew.model !== "",
  );
  builders.sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
  return builders[0]?.model ?? undefined;
}

function parseUse(use: unknown): DispatchProfile[] {
  if (use === undefined) throw new Error("Need use: an array of {harness, model?, effort?}.");
  const parsed = typeof use === "string" ? JSON.parse(use) : use;
  const list = asList(useSchema.parse(parsed));
  if (list.length === 0) throw new Error("Need use: an array of {harness, model?, effort?}.");
  return list;
}

export function putRule(home: string, rule: DispatchRule): CrewDispatchFile {
  const root = requireHome(home);
  const loaded = loadCrewDispatch(root);
  const next: CrewDispatchFile = structuredClone(loaded.config);
  const incoming: DispatchRule = { ...rule, use: rule.use };
  const idx = next.rules.findIndex((row) => keyOf(row) === keyOf(incoming) || row.when.trim().toLowerCase() === incoming.when.trim().toLowerCase());
  if (idx >= 0) next.rules[idx] = incoming;
  else next.rules.push(incoming);
  writeConfig(root, next);
  return next;
}

export function removeRule(home: string, idOrWhen: string): CrewDispatchFile {
  const root = requireHome(home);
  const loaded = loadCrewDispatch(root);
  const key = idOrWhen.trim().toLowerCase();
  const next: CrewDispatchFile = { ...loaded.config, rules: loaded.config.rules.filter((row) => keyOf(row) !== key && row.when.trim().toLowerCase() !== key) };
  if (next.rules.length === loaded.config.rules.length) throw new Error(`No rule "${idOrWhen}".`);
  writeConfig(root, next);
  return next;
}

export function setDefault(home: string, profiles: DispatchProfile[]): CrewDispatchFile {
  const root = requireHome(home);
  const loaded = loadCrewDispatch(root);
  const next: CrewDispatchFile = { ...loaded.config, default: profiles };
  writeConfig(root, next);
  return next;
}

function profileLine(profile: DispatchProfile): string {
  return [profile.harness, profile.model, profile.effort].filter(Boolean).join(" ");
}

export function formatRules(config: CrewDispatchFile): string {
  const lines = [`default: ${config.default.map(profileLine).join(", then ")}`];
  for (const rule of config.rules) {
    const id = rule.id ?? rule.when;
    lines.push(`${id}: ${rule.when} → ${rule.use.map(profileLine).join(", then ")}`);
  }
  return lines.join("\n");
}

export function runModelsCommand(home: string, input: {
  action: "list" | "show" | "set" | "remove" | "default";
  id?: string;
  when?: string;
  why?: string;
  use?: unknown;
}): { text: string; config: CrewDispatchFile } {
  const root = requireHome(home);
  if (input.action === "list" || input.action === "show") {
    const loaded = loadCrewDispatch(root);
    return { text: formatRules(loaded.config), config: loaded.config };
  }
  if (input.action === "remove") {
    const id = (input.id ?? input.when ?? "").trim();
    if (id === "") throw new Error("Need id or when to remove a rule.");
    const config = removeRule(root, id);
    return { text: `Removed rule ${id}.\n${formatRules(config)}`, config };
  }
  if (input.action === "default") {
    const config = setDefault(root, parseUse(input.use));
    return { text: `Default updated.\n${formatRules(config)}`, config };
  }
  const when = (input.when ?? "").trim();
  if (when === "") throw new Error("Need when.");
  const config = putRule(root, { id: input.id?.trim() || undefined, when, use: parseUse(input.use), why: input.why });
  return { text: `Saved rule ${input.id ?? when}.\n${formatRules(config)}`, config };
}

function parseQuota(stdout: string): QuotaSnapshot | null {
  try {
    const parsed = JSON.parse(stdout) as { accounts?: unknown };
    if (!Array.isArray(parsed.accounts)) return null;
    const accounts: QuotaAccount[] = [];
    for (const row of parsed.accounts) {
      if (typeof row !== "object" || row === null) continue;
      const rec = row as Record<string, unknown>;
      if (typeof rec.provider !== "string") continue;
      const limits = Array.isArray(rec.limits) ? rec.limits.filter((item): item is QuotaLimit => typeof item === "object" && item !== null) : [];
      accounts.push({
        provider: rec.provider,
        ...(typeof rec.account === "string" ? { account: rec.account } : {}),
        ...(typeof rec.active === "boolean" ? { active: rec.active } : {}),
        limits,
      });
    }
    return { ...(typeof (parsed as { now?: unknown }).now === "string" ? { now: (parsed as { now: string }).now } : {}), accounts };
  } catch {
    return null;
  }
}

export async function readBbSubsQuota(io: QuotaIo = {}): Promise<QuotaSnapshot | null> {
  const env = io.env ?? process.env;
  if (env.FM_NO_LIVE_NETWORK === "1") return null;
  const now = io.now ?? Date.now();
  const cache = io.cache ?? defaultQuotaCache;
  if (cache.current !== null && now - cache.current.at < QUOTA_FRESH_MS) return cache.current.value;
  const run = io.execFile ?? ((cmd, args, opts) => execFile(cmd, args, opts) as Promise<{ stdout: string }>);
  try {
    const { stdout } = await run("bb", ["subs", "quota", "--json"], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" });
    const value = parseQuota(stdout);
    cache.current = { at: now, value };
    return value;
  } catch {
    cache.current = { at: now, value: null };
    return null;
  }
}
