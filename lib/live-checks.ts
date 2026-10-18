// Owner decisions Q2 and Q9 (18 Oct): merged work becomes live only when a read-only check of what
// production runs contains it. Each project names its checks in owner/projects.json. No model calls;
// credentials are read from the host's secrets files at run time and never leave this module.
import { readFileSync } from "node:fs";
import { repoMatches, type LiveCheck, type LiveRule } from "../owner/projects.ts";
import type { DeliveryRecord } from "./pr-delivery.ts";

/** One thing production runs: an OTA update, a deploy, a loaded plugin. */
export type ProductionRun = { label: string; sha: string; at?: number };
/** What one check read: every run it names must contain a merge for it to be live. */
export type ProductionRead = { ok: true; runs: ProductionRun[] } | { ok: false; missing: string };

export type LiveVerdict =
  | { live: true; evidence: string }
  /** missing: why no check could read production (shown as "live check missing"); null when production was read and does not hold it yet. */
  | { live: false; missing: string | null; unknown: boolean };

export type LiveDeps = {
  /** What a check reads now; the caller reads each check once per pass. */
  production: (check: LiveCheck) => Promise<ProductionRead>;
  /** True when `ancestor` is in the history of `descendant`; null when it cannot be told now (budget, network). */
  contains: (check: LiveCheck, repo: string, ancestor: string, descendant: string) => Promise<boolean | null>;
  /** The release read-back that ships this task, in words, or null. */
  readback: () => string | null;
};

const short = (sha: string) => sha.slice(0, 8);
const mergedPr = (r: DeliveryRecord) => r.mergeCommitSha !== null && (r.forgeState === "merged" || r.status === "complete" || r.status === "merged-needs-verification" || r.status === "merged-unverified");

function applies(check: LiveCheck, repo: string): boolean {
  return check.repos === undefined || check.repos.some((pattern) => repoMatches(pattern, repo));
}

/**
 * Whether production runs every merged PR of a task. A release read-back check proves the whole task;
 * any other check proves one PR when every run it read contains the PR's merge commit.
 */
export async function taskLiveVerdict(rule: LiveRule | undefined, records: readonly DeliveryRecord[], deps: LiveDeps): Promise<LiveVerdict> {
  if (rule === undefined) return { live: false, missing: "this project has no live rule in owner/projects.json", unknown: false };
  const unread = rule.unread ? ` Not read: ${rule.unread}.` : "";
  if (rule.checks.some((check) => check.kind === "release-readback")) {
    const readback = deps.readback();
    if (readback !== null) return { live: true, evidence: `${readback}.${unread}` };
  }
  const merged = records.filter(mergedPr);
  if (merged.length === 0) return { live: false, missing: rule.checks.length === 0 ? rule.missing ?? "no live check" : null, unknown: false };
  const proofs: string[] = [];
  for (const record of merged) {
    const checks = rule.checks.filter((check) => check.kind !== "release-readback" && applies(check, record.repository));
    if (checks.length === 0) return { live: false, missing: rule.missing ?? `no live check for ${record.repository}`, unknown: false };
    let proof: string | null = null, missing: string | null = null, read = false, unknown = false;
    for (const check of checks) {
      const production = await deps.production(check);
      if (!production.ok) { missing ??= production.missing; continue; }
      if (production.runs.length === 0) { missing ??= "the check read no production run"; continue; }
      read = true;
      const held: boolean[] = [];
      for (const run of production.runs) {
        const has = await deps.contains(check, record.repository, record.mergeCommitSha!, run.sha);
        if (has === null) unknown = true;
        held.push(has === true);
      }
      if (held.every(Boolean)) { proof = `${production.runs.map((run) => `${run.label} (${short(run.sha)})`).join(" and ")} holds ${record.id} (${short(record.mergeCommitSha!)})`; break; }
    }
    // Production that was read and does not hold the merge is "not live yet", not a missing check.
    if (proof === null) return { live: false, missing: read ? null : missing, unknown };
    proofs.push(proof);
  }
  return { live: true, evidence: `Live check: ${proofs.join("; ")}.${unread}` };
}

/** KEY=value lines of a dotenv file, or null when it cannot be read. Values never leave this module except to the request they authorize. */
export function readEnvFile(path: string): Record<string, string> | null {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
    }
    return out;
  } catch {
    return null;
  }
}

type Fetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type ReaderDeps = {
  fetch: Fetch;
  env: (path: string) => Record<string, string> | null;
  /** The commit a plugin loaded on this host and when, or why that cannot be told. */
  loadedCommit: (plugin: string) => Promise<ProductionRun | string>;
  signal?: AbortSignal;
};

const EAS_QUERY = `query($id:String!,$ch:String!){ app { byId(appId:$id) { updateChannelByName(name:$ch) { updateBranches(offset:0,limit:10){ name updates(offset:0,limit:1){ group gitCommitHash createdAt } } } } } }`;

/** Read what one check says production runs. */
export async function readProduction(check: LiveCheck, deps: ReaderDeps): Promise<ProductionRead> {
  try {
    if (check.kind === "plugin-reload") {
      const loaded = await deps.loadedCommit(check.plugin);
      return typeof loaded === "string" ? { ok: false, missing: loaded } : { ok: true, runs: [loaded] };
    }
    if (check.kind === "release-readback") return { ok: false, missing: "a release read-back is read per task" };
    const env = deps.env(check.envFile);
    if (env === null) return { ok: false, missing: `the secrets file ${check.envFile} cannot be read` };
    if (check.kind === "eas-update") {
      const token = env["EXPO_TOKEN"];
      if (!token) return { ok: false, missing: `no EXPO_TOKEN in ${check.envFile}` };
      const runs: ProductionRun[] = [];
      for (const channel of check.channels) {
        const res = await deps.fetch("https://api.expo.dev/graphql", {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ query: EAS_QUERY, variables: { id: check.appId, ch: channel } }), ...(deps.signal ? { signal: deps.signal } : {}),
        });
        const body = await res.json() as { data?: { app?: { byId?: { updateChannelByName?: { updateBranches?: { updates?: { group?: string; gitCommitHash?: string | null; createdAt?: string }[] }[] } | null } } }; errors?: { extensions?: { errorCode?: string } }[] };
        const code = body.errors?.[0]?.extensions?.errorCode;
        if (code === "UNAUTHORIZED_ERROR") return { ok: false, missing: `the Expo token in ${check.envFile} has no access to app ${check.appId}` };
        if (!res.ok || body.errors?.length) return { ok: false, missing: `Expo did not answer for the ${channel} channel (${code ?? `HTTP ${res.status}`})` };
        const channelRow = body.data?.app?.byId?.updateChannelByName;
        if (!channelRow) return { ok: false, missing: `app ${check.appId} has no ${channel} channel` };
        const latest = (channelRow.updateBranches ?? []).flatMap((branch) => branch.updates ?? [])
          .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))[0];
        if (!latest) return { ok: false, missing: `no OTA update on the ${channel} channel` };
        if (!latest.gitCommitHash) return { ok: false, missing: `the newest ${channel} OTA update names no commit` };
        runs.push({ label: `${channel} OTA ${short(latest.group ?? "")}`.trim(), sha: latest.gitCommitHash, ...(latest.createdAt ? { at: Date.parse(latest.createdAt) } : {}) });
      }
      return { ok: true, runs };
    }
    const base = env[check.baseUrlVar], app = env[check.appVar], token = env[check.tokenVar];
    const absent = [[check.baseUrlVar, base], [check.appVar, app], [check.tokenVar, token]].filter(([, value]) => !value).map(([name]) => name);
    if (absent.length > 0) return { ok: false, missing: `no ${absent.join(", ")} in ${check.envFile}` };
    const res = await deps.fetch(`${base!.replace(/\/+$/, "")}/api/v1/deployments/applications/${encodeURIComponent(app!)}?skip=0&take=10`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" }, ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (!res.ok) return { ok: false, missing: `Coolify did not answer (HTTP ${res.status})` };
    const body = await res.json() as unknown;
    const rows = (Array.isArray(body) ? body : (body as { deployments?: unknown[] })?.deployments ?? []) as { commit?: string; status?: string; deployment_uuid?: string; finished_at?: string; created_at?: string }[];
    const done = rows.find((row) => row.status === "finished" && typeof row.commit === "string" && /^[0-9a-f]{7,40}$/i.test(row.commit));
    if (!done) return { ok: false, missing: "Coolify lists no finished deploy with a commit" };
    const at = Date.parse(done.finished_at ?? done.created_at ?? "");
    return { ok: true, runs: [{ label: `Coolify deploy ${done.deployment_uuid ?? ""}`.trim(), sha: done.commit!, ...(Number.isFinite(at) ? { at } : {}) }] };
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    return { ok: false, missing: `the ${check.kind} check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
