// A turn that failed because its provider is out of capacity (an Account Pooler 429
// "no eligible account", "Selected model is at capacity", a plain 429) cannot succeed
// by resubmitting to the same provider at once.
export type FailedTurnInfo = { category?: string | null; httpStatusCode?: number | null } | null;

export function providerExhausted(info: FailedTurnInfo, detail = ""): boolean {
  if (info?.category === "rate-limit" || info?.category === "overloaded") return true;
  if (info?.httpStatusCode === 429 || info?.httpStatusCode === 529) return true;
  return /\b429\b|no account pooler account|at capacity|rate.?limit/i.test(detail);
}

export const FAILOVER_WINDOW_MS = 60 * 60_000;
// Antigravity crews skip the outcome line and the PR contract (fleet audit 2026-10-07).
export const SHIP_EXCLUDED_PROVIDERS: ReadonlySet<string> = new Set(["acp-antigravity"]);

export type ExecutionChoice = { providerId: string | null; model: string | null };

// Preferred choices (the captain's own execution, then the project default) come first,
// then the rest of the host catalog. A null model means "that provider's default".
export function failoverTarget(input: {
  failedProviderId: string | null;
  shape: string;
  preferred: readonly ExecutionChoice[];
  catalog: ReadonlyArray<{ id: string; available?: boolean }>;
}): { providerId: string; model: string | null } | null {
  const usable = new Set(input.catalog.filter((p) => p.available !== false).map((p) => p.id));
  const candidates = [...input.preferred, ...input.catalog.map((p) => ({ providerId: p.id, model: null }))];
  for (const choice of candidates) {
    const id = choice.providerId;
    if (!id || id === input.failedProviderId || !usable.has(id)) continue;
    if (input.shape === "ship" && SHIP_EXCLUDED_PROVIDERS.has(id)) continue;
    return { providerId: id, model: choice.model };
  }
  return null;
}

export const CAPTAIN_RESUME_DELAYS_MS: readonly number[] = [2, 5, 10].map((m) => m * 60_000);

/** Delay before resume number `scheduled + 1`, or null once the budget is spent. */
export function captainResumeDelay(scheduled: number): number | null {
  return CAPTAIN_RESUME_DELAYS_MS[scheduled] ?? null;
}

// Cursor at its plan limit ends the turn as completed with "Upgrade your plan to
// continue" as the only assistant text (crews af4986b1 and d883a2a4, 2026-10-10), so
// no turn failure fires. Only a whole short message counts: a crew report that quotes
// the wording is a report.
const PLAN_LIMIT = /upgrade your plan|plan limit|quota (?:exceeded|exhausted)|exceeded your (?:current )?quota|out of (?:credits|quota)/i;

export function planLimitNotice(text: string | null): boolean {
  const body = (text ?? "").trim();
  return body.length <= 120 && !/^(?:DONE|BLOCKED|FAILED|NEEDS[ _-]DECISION|WAITING)\b/i.test(body) && PLAN_LIMIT.test(body);
}

export function planLimitError(detail: string): boolean {
  return PLAN_LIMIT.test(detail);
}

export const PROVIDER_UNAVAILABLE_MS = 60 * 60_000;
export const PROVIDER_UNAVAILABLE_KEY = "provider-unavailable";
export type UnavailableProviders = Record<string, { until: number; reason: string }>;

/** The reset the error names ("try again in 25 minutes"), else 60 minutes; at most a day. */
export function unavailableUntil(text: string, now: number): number {
  const named = /\bin\s+(\d+)\s*(min|hour|hr)/i.exec(text);
  if (named === null) return now + PROVIDER_UNAVAILABLE_MS;
  const ms = Number(named[1]) * (named[2]!.toLowerCase() === "min" ? 60_000 : 60 * 60_000);
  return now + Math.min(Math.max(ms, 60_000), 24 * 60 * 60_000);
}

export function utcMinute(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function unavailableProviderLines(marks: UnavailableProviders | undefined, now: number): string[] {
  return Object.entries(marks ?? {}).filter(([, mark]) => mark.until > now)
    .map(([id, mark]) => `PROVIDER_UNAVAILABLE: ${id} is ${mark.reason}; dispatches with no provider named skip it until ${utcMinute(mark.until)}.`);
}
