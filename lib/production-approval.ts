import { z } from "zod";
import type { createOwnerAsks, OwnerAsk } from "./owner-asks.ts";

type Database = Parameters<typeof createOwnerAsks>[0];

export const PRODUCTION_RULE = 'Production approval: do not merge, publish, deploy, submit or write to production. Report "ready to go live" with what changes, where and how to undo. Go live only after the captain passes on the owner’s approval card naming that change.';
export const PRODUCTION_APPROVAL_POINTER = "Every production change needs firstmate_ask kind=approval naming what changes, where, how to undo, and screenshots for visible changes. Pass PRs in prs=[owner/repo#N] and wait for the owner’s Approve on the plugin’s fixed Approve/No buttons. Standing approvals never replace this card.";
export const PRODUCTION_CARD_RULE = "Before any production change, send firstmate_ask kind=approval. Name what changes, where it goes live, how to undo, and screenshots for visible changes. Pass PRs in the structured prs=[owner/repo#N] field, not question text. The plugin displays exactly that list and supplies fixed Approve and No buttons. Omit options and recommended. Wait for the owner's Approve answer. Production includes a merge to a branch that deploys, website publish, OTA update, App Store or external TestFlight submit, customer server or fleet update, production database or config write, and live plugin or bot change. Read-only checks need no approval. Standing approvals and --yes do not replace this card.";

export const APPROVAL_CHOICES = [{label:"Approve",value:"approve"},{label:"No",value:"no"}] as const;

export function fixedApprovalChoices(options: readonly {label:string;value?:string}[]): boolean {
  return options.length === APPROVAL_CHOICES.length && options.every((option,index) => {
    const fixed = APPROVAL_CHOICES[index]!;
    return option.label === fixed.label && (option.value === undefined || option.value === fixed.value);
  });
}

/** Permission comes from the owner's visible choice, never an agent's hidden value. */
export function affirmative(ask: OwnerAsk): boolean {
  return fixedApprovalChoices(ask.options) && ask.resolution === "Approve";
}

export function approvalCardText(question: string, prs: readonly string[]): string {
  return `${question.trim()}\n\nPRs approved by this card:\n${prs.length ? prs.map(pr => `- ${pr}`).join("\n") : "None"}`;
}

export function createProductionApprovals(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS production_approval_pr (ask TEXT NOT NULL, pr TEXT NOT NULL, head TEXT NOT NULL, PRIMARY KEY(ask,pr)); CREATE TABLE IF NOT EXISTS production_approval_card (ask TEXT PRIMARY KEY, prs TEXT NOT NULL)");
  return {
    bindCard(ask: string, targets: readonly {pr:string;head:string}[]) {
      db.transaction(() => {
        db.prepare("INSERT INTO production_approval_card VALUES (?,?)").run(ask, JSON.stringify(targets.map(target => target.pr)));
        for (const {pr,head} of targets) db.prepare("INSERT INTO production_approval_pr VALUES (?,?,?)").run(ask, pr, head);
      })();
    },
    has(ask: string): boolean {
      return db.prepare("SELECT ask FROM production_approval_card WHERE ask=?").get(ask) !== undefined;
    },
    candidates(pr: string) {
      return z.array(z.object({ ask: z.string(), head: z.string() })).parse(db.prepare("SELECT p.ask,p.head FROM production_approval_pr p JOIN production_approval_card c ON c.ask=p.ask WHERE p.pr=? ORDER BY p.rowid DESC").all(pr.toLowerCase()));
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
