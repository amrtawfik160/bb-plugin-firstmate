import { z } from "zod";
import type { createOwnerAsks, OwnerAsk } from "./owner-asks.ts";

type Database = Parameters<typeof createOwnerAsks>[0];

export const PRODUCTION_RULE = 'Production approval: do not merge, publish, deploy, submit or write to production. Report "ready to go live" with what changes, where and how to undo. Go live only after the captain passes on the owner’s approval card naming that change.';
export const PRODUCTION_APPROVAL_POINTER = "Every production change needs firstmate_ask kind=approval naming what changes, where, how to undo, and screenshots for visible changes. Name PRs as owner/repo#N and wait for the owner’s Yes/Approve. Standing approvals never replace this card.";
export const PRODUCTION_CARD_RULE = "Before any production change, send firstmate_ask kind=approval. Name what changes, where it goes live, how to undo, and screenshots for visible changes. Name each PR as owner/repo#N. Wait for the owner's Yes or Approve answer. Production includes a merge to a branch that deploys, website publish, OTA update, App Store or external TestFlight submit, customer server or fleet update, production database or config write, and live plugin or bot change. Read-only checks need no approval. Standing approvals and --yes do not replace this card.";

/** Parse PR identifiers, never infer permission from agent-written prose. */
export function approvalPrs(text: string): string[] {
  return [...new Set([...text.matchAll(/\b([\w.-]+\/[\w.-]+)#([1-9]\d*)\b/g)].map((m) => `${m[1]!.toLowerCase()}#${m[2]}`))];
}

export function affirmative(ask: OwnerAsk): boolean {
  const answer = ask.resolution?.trim().toLowerCase();
  if (answer === "yes" || answer === "approve") return true;
  const option = ask.options.find((o) => o.label.trim().toLowerCase() === answer);
  const value = (option?.value ?? answer)?.toLowerCase();
  return value === "yes" || value === "approve";
}

export function createProductionApprovals(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS production_approval_pr (ask TEXT NOT NULL, pr TEXT NOT NULL, head TEXT NOT NULL, PRIMARY KEY(ask,pr))");
  return {
    bind(ask: string, pr: string, head: string) {
      db.prepare("INSERT INTO production_approval_pr VALUES (?,?,?)").run(ask, pr.toLowerCase(), head);
    },
    has(ask: string): boolean {
      return db.prepare("SELECT ask FROM production_approval_pr WHERE ask=? LIMIT 1").get(ask) !== undefined;
    },
    candidates(pr: string) {
      return z.array(z.object({ ask: z.string(), head: z.string() })).parse(db.prepare("SELECT ask,head FROM production_approval_pr WHERE pr=? ORDER BY rowid DESC").all(pr.toLowerCase()));
    },
  };
}

const commitSchema = z.object({ sha: z.string(), parents: z.array(z.object({ sha: z.string() })) });
export const compareSchema = z.object({ status: z.string(), total_commits: z.number(), merge_base_commit: z.object({ sha: z.string() }), commits: z.array(commitSchema) });

/** Only first-parent merges whose other parents are already in the base preserve approval. */
export async function onlyBaseMerges(approved: string, head: string, comparison: z.infer<typeof compareSchema>, inBase: (sha: string) => Promise<boolean>): Promise<boolean> {
  if (comparison.status !== "ahead" || comparison.merge_base_commit.sha !== approved || comparison.total_commits !== comparison.commits.length) return false;
  const commits = new Map(comparison.commits.map((commit) => [commit.sha, commit]));
  const visited = new Set<string>();
  let current = head;
  while (current !== approved) {
    if (visited.has(current)) return false;
    visited.add(current);
    const commit = commits.get(current);
    if (!commit || commit.parents.length < 2) return false;
    for (const parent of commit.parents.slice(1)) if (!await inBase(parent.sha)) return false;
    current = commit.parents[0]!.sha;
  }
  return true;
}

/** Native checks can reread the head; reject a changed head at the forge command too. */
export function productionMergeGuard(head: string): string {
  if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new Error('Invalid approved PR head');
  return `
export FM_OWNER_APPROVED_HEAD='${head}'
gh() {
  if [ "\${1:-} \${2:-}" = 'pr merge' ]; then
    local previous='' matched='' argument
    for argument in "$@"; do
      if [ "$previous" = '--match-head-commit' ]; then matched=$argument; fi
      previous=$argument
    done
    if [ "$matched" != "$FM_OWNER_APPROVED_HEAD" ]; then
      echo 'Refusing: PR head changed after owner approval checks; send a new approval card.' >&2
      return 1
    fi
  fi
  command gh "$@"
}
export -f gh
`;
}
