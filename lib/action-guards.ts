// Owner decisions Q9 and Q10 (17 Oct). Native scripts print "WARNING: queued wakes pending" ahead of
// their own refusal, so 9 merges, spawns and retires read as refused by wakes when another line was
// the cause. And a crew on a provider whose sign-in expired failed 12 times with 401 Unauthorized.

const WAKE_WARNING = /^WARNING: queued wakes pending\b.*$/;

/** Native output without the queued-wakes warning, so the line that refused leads. */
export function withoutWakeWarning(output: string): string {
  return output.split(/\r?\n/).filter((line) => !WAKE_WARNING.test(line.trim())).join("\n").trim();
}

/** The command that reads a provider's sign-in on its host, or null when it has none to check. */
export function signInCommand(providerId: string | null | undefined): { command: string; fix: string; label: string } | null {
  if (providerId === "codex" || providerId === "provider-codex") return { command: "codex login status", fix: "run `codex login` on that host", label: "Codex" };
  if (providerId === "claude-code" || providerId === "provider-claude-code") return { command: "claude auth status", fix: "run `claude auth login` on that host", label: "Claude Code" };
  return null;
}

/** Whether the sign-in read says the provider can serve a crew. */
export function signedIn(providerId: string, exitCode: number | null, output: string): boolean {
  if (exitCode !== 0) return false;
  if (providerId.includes("claude")) {
    try { return (JSON.parse(output) as { loggedIn?: unknown }).loggedIn === true; } catch { return !/not logged in|loggedIn"?\s*:\s*false/i.test(output); }
  }
  return /\blogged in\b/i.test(output) && !/\bnot logged in\b/i.test(output);
}

/** A provider error that says the crew's sign-in is missing or expired: restarting cannot help. */
export function authFailure(detail: string): boolean {
  return /\b401\b|unauthori[sz]ed|missing bearer|not logged in|authentication (?:failed|required)|invalid api key|login required/i.test(detail);
}

/** Delays before each retry of a wake acknowledgement that failed after its action succeeded. */
export const WAKE_COMPLETION_RETRY_MS: readonly number[] = [5_000, 30_000, 120_000];
