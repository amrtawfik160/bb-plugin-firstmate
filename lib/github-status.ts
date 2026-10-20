import { clip } from "./owner-asks.ts";
import { OWNER_APPROVAL_CONTEXT, type OwnerApprovalStatus } from "./owner-gate.ts";

const DESCRIPTION_MAX = 140;

function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function postStatusArgs(repo: string, sha: string, status: OwnerApprovalStatus): {
  path: string;
  body: { state: "success" | "pending"; description: string; context: string };
} {
  return {
    path: `repos/${repo}/statuses/${sha}`,
    body: {
      state: status.state,
      description: clip(status.description, DESCRIPTION_MAX),
      context: OWNER_APPROVAL_CONTEXT,
    },
  };
}

/** Shell for a host `gh api` POST. Tests never run this against a live remote. */
export function postStatusCommand(repo: string, sha: string, status: OwnerApprovalStatus): string {
  const posted = postStatusArgs(repo, sha, status);
  return [
    "gh api -X POST",
    shQuote(posted.path),
    `-f state=${shQuote(posted.body.state)}`,
    `-f description=${shQuote(posted.body.description)}`,
    `-f context=${shQuote(posted.body.context)}`,
  ].join(" ");
}
