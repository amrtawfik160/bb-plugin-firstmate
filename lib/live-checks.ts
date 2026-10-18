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

/** A crew's read-back of an app build in the project's required group. It proves a merge only when the
 * commit the build was built from holds it; builtAt is shown, never used as proof. */
export type ReleaseEvidence = { text: string; commit?: string; builtAt?: number };
/** What GitHub says of a merged PR: when it merged and the files it changed; null when not read yet. */
export type PrDetails = { mergedAt: number | null; files: readonly string[] };

export type LiveDeps = {
  /** What a check reads now; the caller reads each check once per pass. */
  production: (check: LiveCheck) => Promise<ProductionRead>;
  /** True when `ancestor` is in the history of `descendant`; null when it cannot be told now (budget, network). */
  contains: (check: LiveCheck, repo: string, ancestor: string, descendant: string) => Promise<boolean | null>;
  /** The task's release read-backs in the required group. */
  readback: () => readonly ReleaseEvidence[];
  /** A merged PR's merge time and files; without it, a rule that needs them proves nothing. */
  details?: (record: DeliveryRecord) => Promise<PrDetails | null>;
};

const short = (sha: string) => sha.slice(0, 8);
/** Only a full commit id is commit evidence; a short or missing one proves nothing. */
const FULL_SHA = /^[0-9a-f]{40}$/i;
/** A reader trusts only HTTP 200 with no error field: a failed or partial answer is never evidence. */
const clean = (res: { status: number }, body: unknown) => res.status === 200 && typeof body === "object" && body !== null && !("errors" in body) && !("error" in body);
const mergedPr = (r: DeliveryRecord) => r.mergeCommitSha !== null && (r.forgeState === "merged" || r.status === "complete" || r.status === "merged-needs-verification" || r.status === "merged-unverified");

function applies(check: { repos?: readonly string[] }, repo: string): boolean {
  return check.repos === undefined || check.repos.some((pattern) => repoMatches(pattern, repo));
}

type Proof = { proof: string | null; missing: string | null; read: boolean; unknown: boolean };

/** Whether any of `checks` reads production and every run it read holds the PR's merge. */
async function proveWith(checks: readonly LiveCheck[], record: DeliveryRecord, deps: LiveDeps): Promise<Proof> {
  const out: Proof = { proof: null, missing: null, read: false, unknown: false };
  for (const check of checks) {
    const production = await deps.production(check);
    if (!production.ok) { out.missing ??= production.missing; continue; }
    if (production.runs.length === 0) { out.missing ??= "the check read no production run"; continue; }
    out.read = true;
    const held: boolean[] = [];
    for (const run of production.runs) {
      const has = await deps.contains(check, record.repository, record.mergeCommitSha!, run.sha);
      if (has === null) out.unknown = true;
      held.push(has === true);
    }
    if (held.every(Boolean)) return { ...out, proof: `${production.runs.map((run) => `${run.label} (${short(run.sha)})`).join(" and ")} holds ${record.id} (${short(record.mergeCommitSha!)})` };
  }
  return out;
}

/** A release read-back that covers this merge: its build's commit holds the merge commit. Only the commit
 * decides: a build time never proves which merges a build holds (a new build can come from an old branch). */
async function proveWithReadback(check: LiveCheck, record: DeliveryRecord, deps: LiveDeps): Promise<Proof> {
  const out: Proof = { proof: null, missing: null, read: false, unknown: false };
  const rows = deps.readback();
  for (const row of rows) {
    if (!row.commit) continue;
    out.read = true;
    const has = await deps.contains(check, record.repository, record.mergeCommitSha!, row.commit);
    if (has === true) return { ...out, proof: `${row.text} (built from ${short(row.commit)}, which holds ${record.id})` };
    if (has === null) out.unknown = true;
  }
  if (!out.read) out.missing = rows.length === 0 ? "no release read-back in the required group" : "the release read-back names no build commit: build commit not read";
  return out;
}

/**
 * Whether production runs every merged PR of a task. A PR is live when one check proves it: a release
 * read-back of a build that covers its merge, or a production read whose every run holds its merge. A PR
 * that changes the project's backend files needs backend evidence too; unread, it stays not live.
 */
export async function taskLiveVerdict(rule: LiveRule | undefined, records: readonly DeliveryRecord[], deps: LiveDeps): Promise<LiveVerdict> {
  if (rule === undefined) return { live: false, missing: "this project has no live rule in owner/projects.json", unknown: false };
  const merged = records.filter(mergedPr);
  if (merged.length === 0) return { live: false, missing: rule.checks.length === 0 ? rule.missing ?? "no live check" : null, unknown: false };
  const proofs: string[] = [];
  let backendSeen = false;
  for (const record of merged) {
    const readbacks = rule.checks.filter((check) => check.kind === "release-readback" && applies(check, record.repository));
    const checks = rule.checks.filter((check) => check.kind !== "release-readback" && applies(check, record.repository));
    if (readbacks.length === 0 && checks.length === 0) return { live: false, missing: rule.missing ?? `no live check for ${record.repository}`, unknown: false };
    const backend = rule.backend !== undefined && applies(rule.backend, record.repository) ? rule.backend : undefined;
    const details = backend !== undefined ? await deps.details?.(record) ?? null : null;
    if (backend !== undefined) {
      // Which files the PR changed decides whether the backend must be deployed too; unread, nothing is proven.
      if (details === null) return { live: false, missing: null, unknown: true };
      if (details.files.some((file) => backend.paths.some((path) => file.startsWith(path)))) {
        backendSeen = true;
        const proved = backend.checks.length === 0 ? { proof: null, missing: backend.missing, read: false, unknown: false } : await proveWith(backend.checks, record, deps);
        if (proved.proof === null) return { live: false, missing: proved.read ? null : `${record.id} changes ${backend.what}, and the backend was not read: ${proved.missing ?? backend.missing}`, unknown: proved.unknown };
        proofs.push(proved.proof);
      }
    }
    let proof: Proof = { proof: null, missing: null, read: false, unknown: false };
    for (const check of readbacks) {
      const next = await proveWithReadback(check, record, deps);
      // Neither route read anything: name both reasons.
      const missing = [proof.missing, next.missing].filter((reason): reason is string => reason !== null).join("; ") || null;
      proof = { proof: next.proof, missing, read: proof.read || next.read, unknown: proof.unknown || next.unknown };
      if (proof.proof !== null) break;
    }
    if (proof.proof === null && checks.length > 0) {
      const next = await proveWith(checks, record, deps);
      // Neither route read anything: name both reasons.
      const missing = [proof.missing, next.missing].filter((reason): reason is string => reason !== null).join("; ") || null;
      proof = { proof: next.proof, missing, read: proof.read || next.read, unknown: proof.unknown || next.unknown };
    }
    // Production that was read and does not hold the merge is "not live yet", not a missing check.
    if (proof.proof === null) return { live: false, missing: proof.read ? null : proof.missing, unknown: proof.unknown };
    proofs.push(proof.proof);
  }
  const backendNote = rule.backend !== undefined && !backendSeen ? ` No change to ${rule.backend.what}, so no backend deploy is needed.` : "";
  return { live: true, evidence: `Live check: ${proofs.join("; ")}.${backendNote}` };
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
      if (typeof loaded === "string") return { ok: false, missing: loaded };
      return FULL_SHA.test(loaded.sha) ? { ok: true, runs: [loaded] } : { ok: false, missing: `the ${check.plugin} plugin reported "${loaded.sha}", not a full commit` };
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
        if (!clean(res, body)) return { ok: false, missing: `Expo did not answer for the ${channel} channel (${code ?? (res.status === 200 ? "errors in the answer" : `HTTP ${res.status}`)})` };
        const channelRow = body.data?.app?.byId?.updateChannelByName;
        if (!channelRow) return { ok: false, missing: `app ${check.appId} has no ${channel} channel` };
        const latest = (channelRow.updateBranches ?? []).flatMap((branch) => branch.updates ?? [])
          .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))[0];
        if (!latest) return { ok: false, missing: `no OTA update on the ${channel} channel` };
        if (!latest.gitCommitHash || !FULL_SHA.test(latest.gitCommitHash)) return { ok: false, missing: `the newest ${channel} OTA update names no full commit` };
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
    const body = res.status === 200 ? await res.json() as unknown : null;
    if (body === null || (!Array.isArray(body) && !clean(res, body))) return { ok: false, missing: `Coolify did not answer cleanly (HTTP ${res.status})` };
    const rows = (Array.isArray(body) ? body : (body as { deployments?: unknown[] })?.deployments ?? []) as { commit?: string; status?: string; deployment_uuid?: string; finished_at?: string; created_at?: string }[];
    const done = rows.find((row) => row.status === "finished" && typeof row.commit === "string" && FULL_SHA.test(row.commit));
    if (!done) return { ok: false, missing: "Coolify lists no finished deploy with a commit" };
    const at = Date.parse(done.finished_at ?? done.created_at ?? "");
    return { ok: true, runs: [{ label: `Coolify deploy ${done.deployment_uuid ?? ""}`.trim(), sha: done.commit!, ...(Number.isFinite(at) ? { at } : {}) }] };
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    return { ok: false, missing: `the ${check.kind} check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const EAS_BUILDS = `query($id:String!){ app { byId(appId:$id) { builds(offset:0,limit:50){ id platform gitCommitHash appBuildVersion } } } }`;

/** The commit an EAS build was built from, found by build id or iOS build number; or why it cannot be read. */
export async function easBuildCommit(appId: string, envFile: string, build: string, deps: Pick<ReaderDeps, "fetch" | "env" | "signal">): Promise<{ commit: string } | { missing: string }> {
  const token = deps.env(envFile)?.["EXPO_TOKEN"];
  if (!token) return { missing: `no EXPO_TOKEN in ${envFile}` };
  try {
    const res = await deps.fetch("https://api.expo.dev/graphql", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: EAS_BUILDS, variables: { id: appId } }), ...(deps.signal ? { signal: deps.signal } : {}),
    });
    const body = await res.json() as { data?: { app?: { byId?: { builds?: { id: string; platform?: string; gitCommitHash?: string | null; appBuildVersion?: string | null }[] } } }; errors?: { extensions?: { errorCode?: string } }[] };
    if (body.errors?.[0]?.extensions?.errorCode === "UNAUTHORIZED_ERROR") return { missing: `the Expo token in ${envFile} has no access to app ${appId}` };
    // HTTP 200 with no errors only: a failed or partial answer is never build evidence.
    if (!clean(res, body)) return { missing: `EAS did not answer cleanly (HTTP ${res.status}${body.errors ? ", errors in the answer" : ""}): build commit not read` };
    const wanted = build.trim();
    const row = (body.data?.app?.byId?.builds ?? []).find((b) => b.id === wanted || (b.platform === "IOS" && b.appBuildVersion === wanted));
    if (!row) return { missing: `EAS lists no build ${wanted} among the app's last 50 builds` };
    if (!row.gitCommitHash || !FULL_SHA.test(row.gitCommitHash)) return { missing: `EAS build ${wanted} names no full commit: build commit not read` };
    return { commit: row.gitCommitHash };
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    return { missing: `EAS did not answer: ${error instanceof Error ? error.message : String(error)}` };
  }
}
