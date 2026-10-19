import { OWNER_APPROVAL_CONTEXT } from "./owner-gate.ts";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : {};
}

function enabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return asRecord(value)["enabled"] === true;
}

function logins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    const row = asRecord(item);
    if (typeof row["login"] === "string") return row["login"];
    if (typeof row["slug"] === "string") return row["slug"];
    return "";
  }).filter(Boolean);
}

function actorList(value: unknown): { users: string[]; teams: string[]; apps: string[] } {
  const row = asRecord(value);
  return { users: logins(row["users"]), teams: logins(row["teams"]), apps: logins(row["apps"]) };
}

function checksOf(value: unknown): Array<{ context: string; app_id?: number | null }> {
  const row = asRecord(value);
  const fromChecks = Array.isArray(row["checks"])
    ? row["checks"].map((item) => {
      const check = asRecord(item);
      return typeof check["context"] === "string" ? { context: check["context"], ...(typeof check["app_id"] === "number" ? { app_id: check["app_id"] } : {}) } : undefined;
    }).filter((item): item is { context: string; app_id?: number } => item !== undefined)
    : [];
  const fromContexts = Array.isArray(row["contexts"])
    ? row["contexts"].filter((item): item is string => typeof item === "string").map((context) => ({ context }))
    : [];
  const seen = new Set(fromChecks.map((item) => item.context));
  return [...fromChecks, ...fromContexts.filter((item) => !seen.has(item.context))];
}

function withOwnerApproval(checks: Array<{ context: string; app_id?: number | null }>): Array<{ context: string; app_id?: number | null }> {
  if (checks.some((item) => item.context === OWNER_APPROVAL_CONTEXT)) return checks;
  return [...checks, { context: OWNER_APPROVAL_CONTEXT }];
}

function statusChecksPut(value: unknown, addOwner: boolean) {
  const row = value === null ? {} : asRecord(value);
  const checks = addOwner ? withOwnerApproval(checksOf(row)) : checksOf(row).filter((item) => item.context !== OWNER_APPROVAL_CONTEXT);
  const contexts = [...new Set(checks.map((item) => item.context))];
  return {
    strict: row["strict"] === true,
    contexts,
    checks: checks.map((item) => item.app_id === undefined ? { context: item.context } : { context: item.context, app_id: item.app_id }),
  };
}

function reviewsPut(value: unknown): Json | null {
  if (value === null || value === undefined) return null;
  const row = asRecord(value);
  const dismissal = row["dismissal_restrictions"] === undefined ? undefined : actorList(row["dismissal_restrictions"]);
  return {
    dismiss_stale_reviews: row["dismiss_stale_reviews"] === true,
    require_code_owner_reviews: row["require_code_owner_reviews"] === true,
    required_approving_review_count: typeof row["required_approving_review_count"] === "number" ? row["required_approving_review_count"] : 0,
    require_last_push_approval: row["require_last_push_approval"] === true,
    ...(dismissal ? { dismissal_restrictions: dismissal } : {}),
  };
}

function restrictionsPut(value: unknown): { users: string[]; teams: string[]; apps: string[] } | null {
  if (value === null || value === undefined) return null;
  return actorList(value);
}

const FLAG_KEYS = [
  "required_linear_history",
  "allow_force_pushes",
  "allow_deletions",
  "block_creations",
  "required_conversation_resolution",
  "lock_branch",
  "allow_fork_syncing",
] as const;

/** Convert a GET protection payload into a PUT body, preserving every existing rule. */
export function protectionPutFromGet(existing: unknown): Json {
  const row = existing === null || existing === undefined ? {} : asRecord(existing);
  const put: Json = {
    required_status_checks: row["required_status_checks"] === null ? null : statusChecksPut(row["required_status_checks"], false),
    enforce_admins: enabled(row["enforce_admins"]),
    required_pull_request_reviews: reviewsPut(row["required_pull_request_reviews"]),
    restrictions: restrictionsPut(row["restrictions"]),
  };
  for (const key of FLAG_KEYS) {
    if (row[key] !== undefined) put[key] = enabled(row[key]);
  }
  return put;
}

export type ProtectionPlan = {
  canEnforce: boolean;
  put: Json & {
    enforce_admins: boolean;
    required_status_checks: { strict: boolean; contexts: string[]; checks: Array<{ context: string; app_id?: number | null }> };
    required_pull_request_reviews: unknown;
    restrictions: unknown;
  };
  undo: Json;
  undoCommand: string;
};

function statusBlock(existing: unknown, addOwner: boolean) {
  const row = existing === null || existing === undefined ? {} : asRecord(existing);
  const source = row["required_status_checks"] === null ? {} : row["required_status_checks"];
  return statusChecksPut(source, addOwner);
}

export function desiredProtection(existing: unknown, repo = "OWNER/REPO", branch = "main"): ProtectionPlan {
  const undo = existing === null || existing === undefined
    ? null
    : protectionPutFromGet(existing);
  const putBase = existing === null || existing === undefined
    ? {
      required_status_checks: statusChecksPut({}, true),
      enforce_admins: true,
      required_pull_request_reviews: null,
      restrictions: null,
    }
    : {
      ...protectionPutFromGet(existing),
      required_status_checks: statusBlock(existing, true),
      enforce_admins: true,
    };
  const path = `repos/${repo}/branches/${branch}/protection`;
  return {
    canEnforce: true,
    put: putBase as ProtectionPlan["put"],
    undo: undo ?? {},
    undoCommand: undo === null
      ? `gh api -X DELETE ${path}`
      : `gh api -X PUT ${path} --input - <<'EOF'\n${JSON.stringify(undo, null, 2)}\nEOF`,
  };
}

export function mergeAllowedByRequiredStatus(input: {
  requiredContexts: readonly string[];
  statuses: Readonly<Record<string, string>>;
}): boolean {
  return input.requiredContexts.every((context) => input.statuses[context] === "success");
}

export function canEnforceRequiredChecks(error: { status: number; message: string } | null): { ok: boolean; reason?: string } {
  if (error === null) return { ok: true };
  if (error.status === 404) return { ok: true };
  if (error.status === 403 || error.status === 422) return { ok: false, reason: error.message };
  return { ok: true };
}

export function listedRepoPatterns(projects: { repos: readonly string[] }[]): string[] {
  return [...new Set(projects.flatMap((project) => [...project.repos]))];
}

export function isExactRepo(pattern: string): boolean {
  return !pattern.includes("*");
}
