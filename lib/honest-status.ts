import type { Verdict } from "./policy.ts";

export type VerdictPresentation = {
  head: string;
  next: string;
};

export function honestIdleVerdictPresentation(crewId: string, verdict: Verdict | null): VerdictPresentation {
  switch (verdict) {
    case "BLOCKED":
      return { head: `🚧 crew ${crewId} blocked`, next: `next: bb firstmate tell|retry|forget ${crewId}` };
    case "FAILED":
      return { head: `❌ crew ${crewId} failed`, next: `next: bb firstmate retry|tell|forget ${crewId}` };
    case "DONE":
      return { head: `✅ crew ${crewId} done`, next: `next: bb firstmate deliver ${crewId}` };
    default:
      return { head: `❓ crew ${crewId} unknown`, next: `next: bb firstmate tell|retry|forget ${crewId}` };
  }
}

export function crewStatusPageHead(crewId: string, kind: string, timedOut: boolean): string {
  if (kind === "unknown" && timedOut) return `❓ crew ${crewId} unreachable`;
  if (kind === "unknown") return `❓ crew ${crewId} unreachable`;
  if (kind === "gone") return `❓ crew ${crewId} unreachable`;
  return `⏳ crew ${crewId} ${kind}`;
}

export function interruptIsStopped(reason: unknown): boolean {
  return typeof reason === "string" && reason !== "";
}

const EVIDENCE_RE = /```[\s\S]+```|\bevidence\s*:|\b(PASS|FAIL|ok \d+|tests? \d+ passed)\b|\bHTTP\/?\s*200\b|\bcore signal\b/i;

export function readyHasEvidence(text: string | null | undefined): boolean {
  if (text == null || text.trim() === "") return false;
  return EVIDENCE_RE.test(text);
}

export function readyClaim(crewId: string, text: string | null | undefined): { allowed: boolean; head: string; next: string } {
  if (readyHasEvidence(text)) {
    return { allowed: true, head: `🔎 crew ${crewId} ready for review`, next: `next: bb firstmate deliver ${crewId}` };
  }
  return {
    allowed: false,
    head: `⚖️ crew ${crewId} NEEDS DECISION`,
    next: `next: bb firstmate tell|stop|forget ${crewId} — READY claimed without evidence that the core signal fired`,
  };
}

export function statusReadLabel(timedOut: boolean, status: string): string {
  if (timedOut) return "unreachable";
  if (status === "unknown" || status === "gone") return "unreachable";
  return status;
}

export function countsTowardActiveCap(status: string): boolean {
  return status === "active" || status === "pending" || status === "starting";
}
