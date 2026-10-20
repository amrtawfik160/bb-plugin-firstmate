// Model choice for crews the owner named no model for (workstream redesign, 19 Oct). Each Firstmate home
// keeps config/fm-model-rules.json in the upstream crew-dispatch shape, with BB provider ids as `harness`.
// Owner decision (20 Oct): only the plugin reads this file. The native home check validates
// config/crew-dispatch.json against upstream harness names, so the plugin never reads or writes that name.
// Firstmate picks a rule by judgement and passes its id or when-text; code never matches task text.
import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { toReasoningLevel } from "./policy.ts";
import { modelPermissionRefusal, PERMISSION_MODELS, ROLE_DEFAULTS, type CrewRole } from "../owner/crew-roles.ts";

const execFile = promisify(execFileCb);
const QUOTA_FRESH_MS = 5 * 60 * 1000;
const QUOTA_RETRY_MS = 60 * 1000;
export const LOW_QUOTA_PERCENT = 15;
const REL_PATH = "config/fm-model-rules.json";
const BROKEN_PATH = "state/fm-model-rules.broken";

export const BB_PROVIDERS = ["claude-code", "codex", "acp-grok", "acp-antigravity", "acp-cursor", "pi"] as const;
export type BbProvider = (typeof BB_PROVIDERS)[number];

// `bb subs quota --json` provider names. Pi routes to many providers, so its quota is unknown.
const QUOTA_PROVIDER: Partial<Record<BbProvider, string>> = {
  "claude-code": "claude",
  codex: "codex",
  "acp-grok": "grok",
  "acp-antigravity": "antigravity",
  "acp-cursor": "cursor",
};

export type DispatchProfile = { harness: BbProvider; model?: string; effort?: string };
export type DispatchRule = { id?: string; when: string; use: DispatchProfile[]; why?: string };
export type CrewDispatchFile = { rules: DispatchRule[]; default: DispatchProfile[] };

const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra", "none", "ultracode"] as const;
const floorSchema = z.object({ scope: z.string(), min_percent: z.number(), provider: z.string().optional() }).strict();
// Upstream fields this plugin does not apply (provider, floor, approval, min_confidence, select) are
// accepted and kept, so an upstream file still loads. Any other key is a typo and breaks the file.
const profileSchema = z.object({
  harness: z.enum(BB_PROVIDERS),
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).optional(),
  provider: z.string().optional(),
  floor: floorSchema.optional(),
}).strict();
const useSchema = z.union([profileSchema, z.array(profileSchema).min(1)]);
const ruleSchema = z.object({
  id: z.string().min(1).optional(),
  when: z.string().min(1),
  use: useSchema,
  why: z.string().optional(),
  approval: z.string().optional(),
  min_confidence: z.number().optional(),
  floor: floorSchema.optional(),
  select: z.string().optional(),
}).strict();
const fileSchema = z.object({
  rules: z.array(ruleSchema).default([]),
  default: useSchema,
}).strict();

type ParsedProfile = z.infer<typeof profileSchema>;

function asList(use: ParsedProfile | ParsedProfile[]): DispatchProfile[] {
  return (Array.isArray(use) ? use : [use]).map((row) => ({ ...row }));
}

// Owner design (19 Oct), "Model choice". Each list is strongest first.
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

export type QuotaLimit = {
  label?: string; used?: number; limit?: number | null; remaining?: number | null; unit?: string;
  resetAt?: number | string; scope?: { kind?: string; group?: string } | null;
};
export type QuotaAccount = { provider: string; account?: string; active?: boolean; stale?: boolean; error?: unknown; limits: QuotaLimit[] };
export type QuotaSnapshot = { accounts: QuotaAccount[] };
export type QuotaCache = { at: number; value: QuotaSnapshot | null; ttl: number; bin?: string };
export type QuotaIo = {
  execFile?: (cmd: string, args: string[], opts: { timeout: number; maxBuffer: number; encoding: "utf8" }) => Promise<{ stdout: string }>;
  env?: NodeJS.Dict<string | undefined>;
  now?: number;
  cache?: { current: QuotaCache | null; pending?: Promise<QuotaSnapshot | null> | null };
};

const defaultQuotaCache: NonNullable<QuotaIo["cache"]> = { current: null, pending: null };

export type LoadResult = {
  config: CrewDispatchFile;
  written: boolean;
  broken: boolean;
  /** Why the file did not load; set on every load of a broken file. */
  brokenReason?: string;
  /** Set once per broken file content, for the next dispatch result. */
  brokenNotice?: string;
};

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function normalize(parsed: z.infer<typeof fileSchema>): CrewDispatchFile {
  return {
    rules: parsed.rules.map((rule) => ({ ...rule, use: asList(rule.use) })),
    default: asList(parsed.default),
  };
}

function writeConfig(home: string, config: CrewDispatchFile): void {
  mkdirSync(join(home, "config"), { recursive: true });
  const path = join(home, REL_PATH);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
}

type Issue = { code?: string; path: PropertyKey[]; message: string; errors?: Issue[][] };

// For "one profile or a list" the useful issue is the deepest one inside the union.
function deepestIssue(issue: Issue, prefix: PropertyKey[] = []): { path: PropertyKey[]; message: string } {
  const path = [...prefix, ...issue.path];
  let best: { path: PropertyKey[]; message: string } | undefined;
  for (const sub of (issue.code === "invalid_union" ? issue.errors ?? [] : []).flat()) {
    const found = deepestIssue(sub, path);
    if (best === undefined || found.path.length > best.path.length) best = found;
  }
  return best ?? { path, message: issue.message };
}

function brokenReason(error: unknown): string {
  if (error instanceof SyntaxError) return "not valid JSON";
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    if (first === undefined) return "invalid";
    const issue = deepestIssue(first as unknown as Issue);
    const where = issue.path.map(String).join(".");
    return `${where !== "" ? `${where}: ` : ""}${issue.message}`.slice(0, 160);
  }
  return error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
}

// One notice per broken file content; the marker under state/ remembers the content hash.
function reportBroken(home: string, raw: string, reason: string): string | undefined {
  const hash = createHash("sha256").update(raw).digest("hex");
  const marker = join(home, BROKEN_PATH);
  try {
    if (existsSync(marker) && readFileSync(marker, "utf8").trim() === hash) return undefined;
  } catch { /* report */ }
  try {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(marker, `${hash}\n`);
  } catch { /* still tell the caller once this load */ }
  return `Tell the owner: ${REL_PATH} is broken (${reason}); crews use the starter rules until it is fixed.`;
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
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
    return { config: normalize(fileSchema.parse(JSON.parse(raw))), written: false, broken: false };
  } catch (error) {
    const reason = brokenReason(error);
    const notice = reportBroken(root, raw, reason);
    return { config: structuredClone(STARTER_DISPATCH), written: false, broken: true, brokenReason: reason, ...(notice !== undefined ? { brokenNotice: notice } : {}) };
  }
}

function requireHome(home: string): string {
  const root = home.trim();
  if (root === "" || !isDir(root)) throw new Error("No firstmate home. Run: bb firstmate init --real");
  return root;
}

const keyOf = (text: string) => text.trim().toLowerCase();

/** The rule whose id or whole when-text equals `rule` (case and outer spaces ignored). */
export function findRule(config: CrewDispatchFile, rule: string | undefined): DispatchRule | undefined {
  if (rule === undefined || keyOf(rule) === "") return undefined;
  const key = keyOf(rule);
  return config.rules.find((row) => (row.id !== undefined && keyOf(row.id) === key) || keyOf(row.when) === key);
}

export type PickSource = "named" | "rule" | "default" | "lookup" | "fallback";
export type PickResult = {
  providerId: string;
  model?: string;
  reasoningLevel?: string;
  source: PickSource;
  ruleId?: string;
  /** One short line for the dispatch result: what was picked and why. */
  line: string;
  /** A plain notice; a line starting "Tell the owner:" must reach the owner. */
  notice?: string;
  /** The lists that could not run before this pick, with each model's reason. */
  failed?: Array<{ label: string; reasons: string[] }>;
  /** Models of the picked list skipped before the pick, with each reason. */
  skipped?: string[];
};

/** Concrete evidence that blocks one candidate (catalog refusal, plan limit, ship guard), or null. */
export type CandidateCheck = (profile: DispatchProfile) => Promise<string | null>;
/** The model a profile without one runs (the provider's catalog default), or undefined when unknown. */
export type ModelResolver = (profile: DispatchProfile) => Promise<string | undefined>;

/** No model in a list can run; a caller may try the next list. Permission refusals are plain errors. */
export class NoUsableModel extends Error {
  readonly label: string;
  readonly reasons: string[];
  constructor(label: string, reasons: string[]) {
    super(`no model in ${label} can run (${reasons.join("; ")})`);
    this.label = label;
    this.reasons = reasons;
  }
}

export function profileLine(profile: { harness?: string; providerId?: string; model?: string; effort?: string; reasoningLevel?: string }): string {
  return [profile.harness ?? profile.providerId, profile.model, profile.effort ?? profile.reasoningLevel].filter((part) => part !== undefined && part !== "").join(" ");
}

const sourceText = (source: PickSource, ruleId?: string) => source === "named" ? "owner-named"
  : source === "lookup" ? "lookup default"
  : source === "rule" ? `rule ${ruleId}`
  : source === "fallback" ? "fallback to a usable provider"
  : "default";

export function formatPickLine(pick: { providerId?: string; model?: string; reasoningLevel?: string; source: PickSource; ruleId?: string; failed?: Array<{ label: string; reasons: string[] }> }, skipped: string[] = []): string {
  const parts = [
    sourceText(pick.source, pick.ruleId),
    ...(pick.failed ?? []).map((row) => `${row.label} cannot run: ${row.reasons.join(", ")}`),
    ...(skipped.length > 0 ? [`skipped ${skipped.join("; ")}`] : []),
  ];
  return `Picked ${profileLine(pick)} (${parts.join("; ")}).`;
}

function percentOf(limit: QuotaLimit): number | undefined {
  const unit = (limit.unit ?? "").toLowerCase();
  if (typeof limit.remaining !== "number") return undefined;
  if (unit === "percent" || unit === "%") return limit.remaining;
  if (typeof limit.limit === "number" && limit.limit > 0) return (limit.remaining / limit.limit) * 100;
  return undefined;
}

// A row scoped to a model group ("Fable · weekly") counts only for models of that group.
function rowApplies(limit: QuotaLimit, model: string | undefined): boolean {
  if (limit.scope?.kind !== "group") return true;
  const group = keyOf(limit.scope.group ?? "").split(/\s+/)[0] ?? "";
  return group !== "" && model !== undefined && keyOf(model).includes(group);
}

export type QuotaLeft = { percent: number; window: string };

// Any applicable window at zero (a spent 5-hour window too) blocks the account. Otherwise the weekly rows
// decide; with no weekly row, the tightest other window stands in under its own label.
function accountLeft(account: QuotaAccount, model: string | undefined): QuotaLeft | undefined {
  const rows = account.limits.filter((row) => rowApplies(row, model));
  const spent = rows.find((row) => { const percent = percentOf(row); return percent !== undefined && percent <= 0; });
  if (spent !== undefined) return { percent: 0, window: spent.label?.trim() || "quota" };
  const weekly = rows.filter((row) => /week/i.test(row.label ?? ""));
  let tightest: QuotaLeft | undefined;
  for (const row of weekly.length > 0 ? weekly : rows) {
    const percent = percentOf(row);
    if (percent !== undefined && (tightest === undefined || percent < tightest.percent)) tightest = { percent, window: row.label?.trim() || "quota" };
  }
  return tightest;
}

/** Quota left for a profile on its best active account, with the window it was read from; undefined when unknown. */
export function quotaLeft(snapshot: QuotaSnapshot | null | undefined, harness: string, model?: string): QuotaLeft | undefined {
  const provider = QUOTA_PROVIDER[harness as BbProvider];
  if (snapshot == null || provider === undefined) return undefined;
  const accounts = snapshot.accounts.filter((row) => row.provider === provider && row.stale !== true && row.error == null);
  const active = accounts.filter((row) => row.active === true);
  let best: QuotaLeft | undefined;
  for (const account of active.length > 0 ? active : accounts) {
    const left = accountLeft(account, model);
    if (left !== undefined && (best === undefined || left.percent > best.percent)) best = left;
  }
  return best;
}

/** Weekly quota left (percent), or undefined when no weekly row applies. */
export function weeklyPercent(snapshot: QuotaSnapshot | null | undefined, harness: string, model?: string): number | undefined {
  const left = quotaLeft(snapshot, harness, model);
  return left !== undefined && /week/i.test(left.window) ? left.percent : undefined;
}

const leftText = (left: QuotaLeft) => `${Math.floor(left.percent)}% left in ${left.window.toLowerCase()}`;

type ListInput = {
  label: string; source: PickSource; ruleId?: string;
  quota?: QuotaSnapshot | null; modelPermission?: string; avoidModel?: string; check?: CandidateCheck; resolveModel?: ModelResolver; effort?: string;
  /** Concrete models an earlier list already tried; they are not tried again. */
  seen: Set<string>;
};

async function pickFromProfiles(listed: DispatchProfile[], input: ListInput): Promise<PickResult> {
  const skipped: string[] = [];
  const reasons: string[] = [];
  const permissionRefusals: string[] = [];
  const low: Array<{ profile: DispatchProfile; left: QuotaLeft; at: number }> = [];
  const blocks = new Map<DispatchProfile, string | null>();
  const blocked = async (profile: DispatchProfile): Promise<string | null> => {
    if (!blocks.has(profile)) blocks.set(profile, input.check === undefined ? null : await input.check(profile));
    return blocks.get(profile)!;
  };
  const skip = (profile: DispatchProfile, why: string) => { skipped.push(`${profileLine(profile)}: ${why}`); reasons.push(`${profileLine(profile)}: ${why}`); };
  const done = (profile: DispatchProfile, notice?: string): PickResult => {
    const pick = { providerId: profile.harness, model: profile.model, reasoningLevel: toReasoningLevel(profile.effort), source: input.source, ruleId: input.ruleId };
    return { ...pick, line: formatPickLine(pick, skipped), ...(skipped.length > 0 ? { skipped: [...skipped] } : {}), ...(notice !== undefined ? { notice } : {}) };
  };
  let candidates = 0;
  for (const raw of listed) {
    // A profile without a model runs its provider's default, so the exclusions below see that model.
    const model = raw.model ?? await input.resolveModel?.(raw);
    const profile: DispatchProfile = { ...raw, ...(model !== undefined ? { model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}) };
    const key = `${profile.harness} ${profile.model ?? ""}`;
    if (input.seen.has(key)) continue;
    input.seen.add(key);
    candidates += 1;
    // An unreadable or empty model list leaves the default unknown: never spawn on it, and never a checker.
    if (model === undefined && (input.resolveModel !== undefined || input.avoidModel !== undefined)) { skip(profile, "default model unknown (model list unreadable)"); continue; }
    if (input.avoidModel !== undefined && profile.model === input.avoidModel) { skip(profile, "the builder's model"); continue; }
    const refusal = modelPermissionRefusal(profile.model, input.modelPermission);
    if (profile.model !== undefined && PERMISSION_MODELS.has(profile.model) && refusal !== null) { permissionRefusals.push(refusal); skip(profile, "needs the owner's permission"); continue; }
    const left = quotaLeft(input.quota, profile.harness, profile.model);
    if (left !== undefined && left.percent <= 0) { skip(profile, `none left in ${left.window.toLowerCase()}`); continue; }
    if (left !== undefined && left.percent < LOW_QUOTA_PERCENT) { low.push({ profile, left, at: skipped.length }); skip(profile, leftText(left)); continue; }
    const why = await blocked(profile);
    if (why !== null) { skip(profile, why); continue; }
    const unread = input.quota === null && listed.length > 1 ? `Quota could not be read; kept the first model in ${input.label} that the catalog accepts.` : undefined;
    return done(profile, unread);
  }
  // Every candidate is low: keep the strongest one that can run, never a silent downgrade.
  for (const { profile, left, at } of low) {
    const why = await blocked(profile);
    if (why !== null) { skipped[at] = `${profileLine(profile)}: ${leftText(left)}, ${why}`; reasons[at] = skipped[at]!; continue; }
    skipped.splice(at, 1);
    return done(profile, `Tell the owner: every model in ${input.label} that can run is under ${LOW_QUOTA_PERCENT}% quota; kept ${profileLine(profile)} (${leftText(left)}).`);
  }
  // Only the permission guard stopped this list: say so plainly instead of choosing around it.
  if (candidates > 0 && permissionRefusals.length === candidates) throw new Error(permissionRefusals[0]!);
  throw new NoUsableModel(input.label, reasons);
}

/**
 * Order: owner-named model > the rule Firstmate picked > the role default in the file (checker rule for a
 * checker) > a usable provider from `fallback`. Each list skips a model under 15% quota, one `check`
 * refuses, a checker's builder model, and gpt-6-astra without the owner's permission.
 */
export async function chooseProfile(input: {
  config: CrewDispatchFile;
  rule?: string;
  role?: CrewRole;
  named?: { providerId?: string; model?: string; reasoningLevel?: string } | null;
  /** An effort the owner named; it replaces each profile's effort. */
  reasoningLevel?: string;
  modelPermission?: string;
  avoidModel?: string;
  quota?: QuotaSnapshot | null;
  check?: CandidateCheck;
  resolveModel?: ModelResolver;
  /** Usable providers, best first, tried when the rule and the role default cannot run. */
  fallback?: () => Promise<DispatchProfile[]>;
}): Promise<PickResult> {
  const named = input.named;
  if (named != null && (named.providerId !== undefined || named.model !== undefined)) {
    const refusal = modelPermissionRefusal(named.model, input.modelPermission);
    if (refusal !== null) throw new Error(refusal);
    const role = ROLE_DEFAULTS[input.role ?? "builder"];
    const pick = { providerId: named.providerId ?? role.providerId, model: named.model, reasoningLevel: named.reasoningLevel, source: "named" as const };
    return { ...pick, line: formatPickLine(pick) };
  }
  const seen = new Set<string>();
  const shared = { quota: input.quota, modelPermission: input.modelPermission, avoidModel: input.avoidModel, check: input.check, resolveModel: input.resolveModel, effort: input.reasoningLevel, seen };
  const matched = findRule(input.config, input.rule);
  const notices: string[] = [];
  if (input.rule !== undefined && keyOf(input.rule) !== "" && matched === undefined) {
    notices.push(`Unknown rule "${input.rule.trim()}"; used the ${input.role ?? "builder"} default. Rules: ${input.config.rules.map((row) => row.id ?? row.when).join(", ")}.`);
  }
  const checker = input.role === "checker" ? findRule(input.config, "checker") ?? findRule(STARTER_DISPATCH, "checker")! : undefined;
  const lists: Array<{ use: () => Promise<DispatchProfile[]>; label: string; source: PickSource; ruleId?: string }> = [];
  if (matched !== undefined) lists.push({ use: async () => matched.use, label: `rule ${matched.id ?? matched.when}`, source: "rule", ruleId: matched.id ?? matched.when });
  if (checker !== undefined && checker !== matched) lists.push({ use: async () => checker.use, label: `rule ${checker.id ?? checker.when}`, source: "rule", ruleId: checker.id ?? checker.when });
  else if (input.role === "lookup") {
    const lookup = ROLE_DEFAULTS.lookup;
    lists.push({ use: async () => [{ harness: lookup.providerId as BbProvider, model: lookup.model }], label: "the lookup default", source: "lookup" });
  } else if (checker === undefined) lists.push({ use: async () => input.config.default, label: "the default", source: "default" });
  if (input.fallback !== undefined) lists.push({ use: input.fallback, label: "the usable providers", source: "fallback" });
  const failed: Array<{ label: string; reasons: string[] }> = [];
  for (const list of lists) {
    let pick: PickResult;
    try {
      pick = await pickFromProfiles(await list.use(), { ...shared, label: list.label, source: list.source, ...(list.ruleId !== undefined ? { ruleId: list.ruleId } : {}) });
    } catch (error) {
      if (!(error instanceof NoUsableModel)) throw error;
      failed.push({ label: error.label, reasons: error.reasons });
      continue;
    }
    if (failed.some((row) => row.reasons.length > 0)) {
      const stale = failed.some((row) => row.reasons.some((why) => /not in the catalog|unknown provider/.test(why)));
      pick.failed = failed.filter((row) => row.reasons.length > 0);
      pick.line = formatPickLine(pick, pick.skipped);
      notices.push(`Tell the owner: ${pick.failed.map((row) => `${row.label} cannot run (${row.reasons.join("; ")})`).join("; ")}; this crew runs ${profileLine(pick)} instead.${stale ? " Update the rule with firstmate_models." : ""}`);
    }
    const all = [...notices, ...(pick.notice !== undefined ? [pick.notice] : [])];
    if (all.length > 0) pick.notice = all.join("\n");
    else delete pick.notice;
    return pick;
  }
  // A list with nothing left to try (each model already tried above) adds no reason of its own.
  const parts = failed.map((row) => row.reasons.length > 0 ? `no model in ${row.label} can run (${row.reasons.join("; ")})` : `nothing else to try in ${row.label}`);
  throw new Error(`Refusing: ${parts.join("; ")}. Name a model or pick another rule. Nothing was spawned.`);
}

/** The model of the newest builder crew among `crewIds` (the checked task's crews), else under the captain. */
export function latestBuilderModel(
  crews: ReadonlyArray<{ id?: string; role?: string; shape?: string; model?: string | null; parentThreadId?: string | null; createdAt?: string }>,
  scope: { parentThreadId?: string | null; crewIds?: readonly string[] },
): string | undefined {
  const ids = scope.crewIds !== undefined && scope.crewIds.length > 0 ? new Set(scope.crewIds) : undefined;
  const builders = crews.filter((crew) =>
    (ids !== undefined ? crew.id !== undefined && ids.has(crew.id) : scope.parentThreadId == null || crew.parentThreadId === scope.parentThreadId)
    && (crew.role === "builder" || crew.role === undefined)
    && crew.shape !== "scout"
    && typeof crew.model === "string"
    && crew.model !== "",
  );
  builders.sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
  return builders[0]?.model ?? undefined;
}

function parseUse(use: unknown): DispatchProfile[] {
  if (use === undefined) throw new Error("Need use: a JSON array of {harness, model?, effort?}.");
  let parsed: unknown = use;
  if (typeof use === "string") {
    try { parsed = JSON.parse(use); } catch { throw new Error("use is not valid JSON: pass an array of {harness, model?, effort?}."); }
  }
  const result = useSchema.safeParse(parsed);
  if (!result.success) throw new Error(`use is invalid (${brokenReason(result.error)}). harness is one of ${BB_PROVIDERS.join(", ")}.`);
  return asList(result.data);
}

// Edits never overwrite a broken file: the owner's text stays until reset backs it up.
function loadForEdit(root: string): CrewDispatchFile {
  const loaded = loadCrewDispatch(root);
  if (loaded.broken) throw new Error(`${REL_PATH} is broken (${loaded.brokenReason}). Fix the file, or run reset to back it up and write the starter rules.`);
  return loaded.config;
}

export function putRule(home: string, rule: DispatchRule): CrewDispatchFile {
  const root = requireHome(home);
  const next = structuredClone(loadForEdit(root));
  const idx = next.rules.findIndex((row) => (rule.id !== undefined && row.id !== undefined && keyOf(row.id) === keyOf(rule.id)) || keyOf(row.when) === keyOf(rule.when));
  if (idx >= 0) next.rules[idx] = { ...next.rules[idx], ...rule, ...(rule.why === undefined && next.rules[idx]!.why !== undefined ? { why: next.rules[idx]!.why } : {}) };
  else next.rules.push(rule);
  writeConfig(root, next);
  return next;
}

export function removeRule(home: string, idOrWhen: string): CrewDispatchFile {
  const root = requireHome(home);
  const current = loadForEdit(root);
  const target = findRule(current, idOrWhen);
  if (target === undefined) throw new Error(`No rule "${idOrWhen}". Rules: ${current.rules.map((row) => row.id ?? row.when).join(", ")}.`);
  const next: CrewDispatchFile = { ...current, rules: current.rules.filter((row) => row !== target) };
  writeConfig(root, next);
  return next;
}

export function setDefault(home: string, profiles: DispatchProfile[]): CrewDispatchFile {
  const root = requireHome(home);
  const next: CrewDispatchFile = { ...loadForEdit(root), default: profiles };
  writeConfig(root, next);
  return next;
}

/** Back up the current file (broken or not) and write the starter rules. */
export function resetRules(home: string, at = Date.now()): { config: CrewDispatchFile; backup?: string } {
  const root = requireHome(home);
  const path = join(root, REL_PATH);
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${REL_PATH}.${new Date(at).toISOString().replace(/[:.]/g, "-")}.bak`;
    copyFileSync(path, join(root, backup));
  }
  const config = structuredClone(STARTER_DISPATCH);
  writeConfig(root, config);
  rmSync(join(root, BROKEN_PATH), { force: true });
  return { config, ...(backup !== undefined ? { backup } : {}) };
}

export function formatRules(config: CrewDispatchFile): string {
  const lines = [`default: ${config.default.map(profileLine).join(", then ")}`];
  for (const rule of config.rules) {
    lines.push(`${rule.id ?? rule.when}: ${rule.when} → ${rule.use.map(profileLine).join(", then ")}${rule.why !== undefined ? ` (${rule.why})` : ""}`);
  }
  return lines.join("\n");
}

export const MODELS_ACTIONS = ["list", "show", "set", "remove", "default", "reset"] as const;
export type ModelsAction = (typeof MODELS_ACTIONS)[number];

export function runModelsCommand(home: string, input: {
  action: ModelsAction;
  id?: string;
  when?: string;
  why?: string;
  use?: unknown;
}): { text: string; config: CrewDispatchFile } {
  const root = requireHome(home);
  if (input.action === "list" || input.action === "show") {
    const loaded = loadCrewDispatch(root);
    const head = loaded.broken ? `${REL_PATH} is broken (${loaded.brokenReason}); crews use these starter rules. Fix the file, or run reset.\n` : "";
    return { text: `${head}${formatRules(loaded.config)}`, config: loaded.config };
  }
  if (input.action === "reset") {
    const { config, backup } = resetRules(root);
    return { text: `Wrote the starter rules${backup !== undefined ? `; the old file is ${backup}` : ""}.\n${formatRules(config)}`, config };
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
  if (when === "") throw new Error("Need when: the plain kind of task this rule is for.");
  const id = input.id?.trim();
  const why = input.why?.trim();
  const config = putRule(root, { ...(id ? { id } : {}), when, use: parseUse(input.use), ...(why ? { why } : {}) });
  return { text: `Saved rule ${id || when}.\n${formatRules(config)}`, config };
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
      accounts.push({
        provider: rec.provider,
        ...(typeof rec.account === "string" ? { account: rec.account } : {}),
        ...(typeof rec.active === "boolean" ? { active: rec.active } : {}),
        ...(rec.stale === true ? { stale: true } : {}),
        ...(rec.error != null ? { error: rec.error } : {}),
        limits: Array.isArray(rec.limits) ? rec.limits.filter((item): item is QuotaLimit => typeof item === "object" && item !== null) : [],
      });
    }
    return { accounts };
  } catch {
    return null;
  }
}

/** `bb subs quota --json`, cached 5 minutes (a failed read retries after 1 minute); null when unreadable. */
export async function readBbSubsQuota(io: QuotaIo = {}): Promise<QuotaSnapshot | null> {
  const env = io.env ?? process.env;
  if (env.FM_NO_LIVE_NETWORK === "1") return null;
  const now = io.now ?? Date.now();
  const cache = io.cache ?? defaultQuotaCache;
  const bin = env.BB_CLI?.trim() || "bb";
  // A reading counts only for the command that produced it.
  if (cache.current !== null && (cache.current.bin ?? bin) === bin && now - cache.current.at < cache.current.ttl) return cache.current.value;
  if (cache.pending) return cache.pending;
  const run = io.execFile ?? ((cmd, args, opts) => execFile(cmd, args, opts));
  const read = (async () => {
    let value: QuotaSnapshot | null = null;
    try { value = parseQuota((await run(bin, ["subs", "quota", "--json"], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" })).stdout); }
    catch { value = null; }
    cache.current = { at: now, value, ttl: value === null ? QUOTA_RETRY_MS : QUOTA_FRESH_MS, bin };
    return value;
  })();
  cache.pending = read;
  try { return await read; } finally { cache.pending = null; }
}
