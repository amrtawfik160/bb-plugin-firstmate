import { randomInt } from "node:crypto";
import { z } from "zod";
import { clip, type AskKind, type AskState } from "./owner-asks.ts";

export const OWNER_APPROVAL_CONTEXT = "Owner approval";

export type HeadCoverage = "covers" | "new-author" | "unknown";
export type Allows = "merge" | "deploy" | "both";
export type ProdWhat = "merge" | "deploy";

export type GateCard = {
  id: string;
  prs: readonly string[];
  head: string;
  kind: AskKind;
  captain?: string;
  irreversible: boolean;
  state: AskState;
  resolution: string | null;
  answeredByOwner: boolean;
  createdAt: number;
  answeredAt?: number;
};

export type PreApproval = {
  id: string;
  ownerMessageRef: string;
  quote: string;
  task: string;
  /** Open epoch of the task this record is bound to. 0 means unbound. */
  generation: number;
  project: string;
  allows: Allows;
  createdAt: number;
};

export type OwnerApprovalStatus = { state: "success" | "pending"; description: string };

export type DeploySighting = {
  id: string;
  project: string;
  task?: string;
  source: string;
  detail: string;
  approved: boolean;
  at: number;
};

export type ProdCheckInput = {
  project: string;
  what: ProdWhat;
  task?: string;
  pr?: string;
  head?: string;
  cards: readonly GateCard[];
  coverage?: (card: GateCard) => HeadCoverage;
  preApprovals: readonly PreApproval[];
  taskOpen?: boolean;
  generation?: number;
  taskPrs?: readonly string[];
  captain?: string;
};

type Database = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

const allowsSchema = z.enum(["merge", "deploy", "both"]);

export type OwnerDispatchSource = "telegram" | "omitted" | null;

/** Classify a dispatch from BB origin fields. `omitted` means those fields were never set. */
export function ownerDispatchSource(input: {
  initiator: unknown;
  senderThreadId: unknown;
  origin: unknown;
  originPluginId: unknown;
  submissionPluginId?: unknown;
}): OwnerDispatchSource {
  if (String(input.initiator ?? "") !== "user") return null;
  const sender = input.senderThreadId;
  if (sender === "mixed") return null;
  if (typeof sender === "string" && sender !== "") return null;
  const origin = input.origin;
  const originPluginId = input.originPluginId;
  const submissionPluginId = input.submissionPluginId;
  if (origin === "mixed" || originPluginId === "mixed") return null;
  if (typeof originPluginId === "string" && originPluginId !== "telegram") return null;
  if (originPluginId === "telegram" || submissionPluginId === "telegram") return "telegram";
  if (origin === undefined && originPluginId === undefined) return "omitted";
  return null;
}

function samePr(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function ownerApprove(card: GateCard): boolean {
  return card.kind === "approval" && card.state === "answered" && card.answeredByOwner && card.resolution === "Approve";
}

function ownerNo(card: GateCard): boolean {
  return card.kind === "approval" && card.state === "answered" && card.answeredByOwner && card.resolution === "No";
}

function ownerAnswerTime(card: GateCard): number {
  return card.answeredAt ?? card.createdAt;
}

function newestForPr(cards: readonly GateCard[], pr: string, captain?: string): GateCard | undefined {
  let newest: GateCard | undefined;
  for (const card of cards) {
    if (card.kind !== "approval" || !card.answeredByOwner) continue;
    if (!card.prs.some((named) => samePr(named, pr))) continue;
    if (captain !== undefined && card.captain !== undefined && card.captain !== captain) continue;
    if (!newest) {
      newest = card;
      continue;
    }
    const time = ownerAnswerTime(card);
    const best = ownerAnswerTime(newest);
    if (time > best || (time === best && card.id > newest.id)) newest = card;
  }
  return newest;
}

function coverOf(card: GateCard, head: string, coverage?: (card: GateCard) => HeadCoverage): HeadCoverage {
  if (coverage) return coverage(card);
  return card.head === head ? "covers" : "unknown";
}

export type ApprovalDecisionInput = {
  pr: string;
  head: string;
  action: ProdWhat;
  cards: readonly GateCard[];
  coverage?: (card: GateCard) => HeadCoverage;
  preApprovals: readonly PreApproval[];
  task?: string;
  taskOpen?: boolean;
  generation?: number;
  captain?: string;
};

/**
 * The only production-approval decision. Merge prod-check, deploy prod-check, Ship/merge,
 * and the GitHub status all call this. Callers do not add a fallback.
 *
 * Order: latest owner-confirmed decision for this PR by stored owner-answer time (then
 * card id), scoped to the captain that owns the PR's task. Cards with no owner answer never
 * count. A later No blocks whatever pre-approval exists; an owner Approve covers only the
 * head it named plus proven base-only merges; else a valid pre-approval for this opening of
 * the task.
 */
export function approvalFor(input: ApprovalDecisionInput): OwnerApprovalStatus {
  const newest = newestForPr(input.cards, input.pr, input.captain);
  if (newest && ownerNo(newest)) {
    return { state: "pending", description: clip("Owner answered No", 140) };
  }
  if (newest && ownerApprove(newest) && coverOf(newest, input.head, input.coverage) === "covers") {
    return { state: "success", description: clip("Owner Approve at this head", 140) };
  }
  const pre = input.preApprovals.find((row) => preApprovalCovers(row, {
    task: input.task, what: input.action, taskOpen: input.taskOpen === true, generation: input.generation,
  }));
  if (pre) return { state: "success", description: clip(`Owner pre-approval for ${pre.task} allows ${pre.allows}`, 140) };
  if (newest && ownerApprove(newest)) {
    const covered = coverOf(newest, input.head, input.coverage);
    if (covered === "new-author") return { state: "pending", description: clip("New author commits after approval", 140) };
    return { state: "pending", description: clip("Cannot prove this head is covered", 140) };
  }
  return { state: "pending", description: clip(`Needs owner Approve for ${input.pr}`, 140) };
}

/** GitHub commit status for this PR head: `approvalFor` with action merge. */
export function ownerApprovalStatus(input: Omit<ApprovalDecisionInput, "action">): OwnerApprovalStatus {
  return approvalFor({ ...input, action: "merge" });
}

export function preApprovalCovers(pre: PreApproval, input: { task?: string; what: ProdWhat; taskOpen: boolean; generation?: number }): boolean {
  if (!input.taskOpen) return false;
  if (input.task === undefined || pre.task !== input.task) return false;
  const epoch = input.generation ?? 1;
  if ((pre.generation ?? 1) !== epoch) return false;
  return pre.allows === "both" || pre.allows === input.what;
}

export function gatedAskResolve(
  ask: { kind: AskKind; irreversible: boolean },
  input: { ownerConfirmed: boolean; cancelled?: boolean; reopen?: boolean },
): "answer" | "cancel" | "reopen" {
  if (input.reopen === true) return "reopen";
  if (input.cancelled === true) return "cancel";
  const gated = ask.kind === "approval" || ask.irreversible;
  if (gated && !input.ownerConfirmed) return "cancel";
  return "answer";
}

export function quotePreApproval(pre: PreApproval): string {
  return `Recorded your pre-approval for ${pre.task} (${pre.project}): "${clip(pre.quote, 240)}". This allows ${pre.allows} until the task closes.`;
}

export function prodCheck(input: ProdCheckInput): { ok: boolean; reason: string } {
  if (input.task && input.pr && input.taskPrs && !input.taskPrs.some((named) => samePr(named, input.pr!))) {
    return { ok: false, reason: `Refusing: ${input.pr} is not work of task ${input.task}.` };
  }
  const decision = approvalFor({
    pr: input.pr ?? "",
    head: input.head ?? "",
    action: input.what,
    cards: input.cards,
    coverage: input.coverage,
    preApprovals: input.preApprovals,
    task: input.task,
    taskOpen: input.taskOpen,
    generation: input.generation,
    captain: input.captain,
  });
  if (decision.state === "success") return { ok: true, reason: decision.description };
  return { ok: false, reason: `Refusing: ${input.project} ${input.what} needs an owner approval or pre-approval for this work.` };
}

function newId(prefix: string): string {
  return `${prefix}${randomInt(0, 36 ** 6).toString(36).padStart(6, "0")}`;
}

type CardRow = {
  ask: string;
  head: string;
  prs: string;
  kind: string;
  captain: string;
  irreversible: number;
  state: string;
  resolution: string | null;
  created_at: number;
  answered_at: number | null;
  owner: number;
};

export function createOwnerGate(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS production_pre_approval (
    id TEXT PRIMARY KEY, owner_message_ref TEXT NOT NULL, quote TEXT NOT NULL,
    task TEXT NOT NULL, project TEXT NOT NULL, allows TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS production_pre_approval_task ON production_pre_approval(task);
    CREATE TABLE IF NOT EXISTS production_deploy_sighting (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, task TEXT, source TEXT NOT NULL,
    detail TEXT NOT NULL, approved INTEGER NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS production_status_retry (
    pr TEXT NOT NULL, head TEXT NOT NULL, last_error TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (pr, head));`);
  try {
    db.exec("ALTER TABLE production_pre_approval ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
  } catch { /* already present on this database */ }
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS production_pre_approval_owner_message_ref ON production_pre_approval(owner_message_ref) WHERE owner_message_ref != ''");
  } catch { /* already present, or older rows share a ref */ }

  function asPreApproval(row: {
    id: string; owner_message_ref: string; quote: string; task: string; project: string; allows: string; created_at: number; generation?: number;
  }): PreApproval {
    return {
      id: row.id,
      ownerMessageRef: row.owner_message_ref,
      quote: row.quote,
      task: row.task,
      generation: typeof row.generation === "number" ? row.generation : 1,
      project: row.project,
      allows: allowsSchema.parse(row.allows),
      createdAt: row.created_at,
    };
  }

  function listPreApprovals(task?: string): PreApproval[] {
    const rows = (task === undefined
      ? db.prepare("SELECT * FROM production_pre_approval ORDER BY created_at DESC").all()
      : db.prepare("SELECT * FROM production_pre_approval WHERE task=? ORDER BY created_at DESC").all(task)) as Array<{
      id: string; owner_message_ref: string; quote: string; task: string; project: string; allows: string; created_at: number; generation?: number;
    }>;
    return rows.map(asPreApproval);
  }

  return {
    recordPreApproval(input: Omit<PreApproval, "id" | "generation"> & { id?: string; generation?: number }): PreApproval {
      const asRow = (row: {
        id: string; owner_message_ref: string; quote: string; task: string; project: string; allows: string; created_at: number; generation?: number;
      }) => asPreApproval(row);
      if (input.ownerMessageRef !== "") {
        const existing = db.prepare("SELECT * FROM production_pre_approval WHERE owner_message_ref=?").get(input.ownerMessageRef) as {
          id: string; owner_message_ref: string; quote: string; task: string; project: string; allows: string; created_at: number; generation?: number;
        } | undefined;
        if (existing) return asRow(existing);
      }
      const generation = input.generation ?? (input.task ? 1 : 0);
      const row: PreApproval = { ...input, id: input.id ?? newId("p"), generation };
      try {
        db.prepare("INSERT INTO production_pre_approval(id, owner_message_ref, quote, task, project, allows, created_at, generation) VALUES (?,?,?,?,?,?,?,?)").run(
          row.id, row.ownerMessageRef, row.quote, row.task, row.project, row.allows, row.createdAt, row.generation,
        );
      } catch (error) {
        if (input.ownerMessageRef !== "") {
          const existing = db.prepare("SELECT * FROM production_pre_approval WHERE owner_message_ref=?").get(input.ownerMessageRef) as {
            id: string; owner_message_ref: string; quote: string; task: string; project: string; allows: string; created_at: number; generation?: number;
          } | undefined;
          if (existing) return asRow(existing);
        }
        throw error;
      }
      return row;
    },
    listPreApprovals,
    bindPreApproval(id: string, task: string, generation: number): boolean {
      const current = db.prepare("SELECT task FROM production_pre_approval WHERE id=?").get(id) as { task: string } | undefined;
      if (!current || current.task !== "") return false;
      db.prepare("UPDATE production_pre_approval SET task=?, generation=? WHERE id=? AND task=''").run(task, generation, id);
      return true;
    },
    covering(input: { task: string; what: ProdWhat; taskOpen: boolean; generation?: number }): PreApproval | undefined {
      return listPreApprovals(input.task).find((row) => preApprovalCovers(row, { ...input, generation: input.generation ?? 1 }));
    },
    targetsForAsk(ask: string): Array<{ pr: string; head: string }> {
      try {
        return z.array(z.object({ pr: z.string(), head: z.string() })).parse(db.prepare("SELECT pr, head FROM production_approval_pr WHERE ask=?").all(ask));
      } catch {
        return [];
      }
    },
    cardsForPr(pr: string): GateCard[] {
      try {
        const rows = db.prepare(
          `SELECT p.ask, p.head, c.prs, a.kind, a.captain, a.irreversible,
            CASE WHEN ans.id IS NOT NULL THEN 'answered' ELSE a.state END AS state,
            COALESCE(ans.resolution, a.resolution) AS resolution,
            a.created_at,
            ans.at AS answered_at,
            CASE WHEN ans.id IS NOT NULL THEN 1 ELSE 0 END AS owner
           FROM production_approval_pr p
           JOIN production_approval_card c ON c.ask=p.ask
           JOIN owner_ask a ON a.id=p.ask
           LEFT JOIN owner_ask_answer ans ON ans.id=p.ask AND ans.source='owner'
             AND ans.tap_id IS NOT NULL AND ans.tap_id != '' AND ans.at IS NOT NULL
           WHERE lower(p.pr)=?
           ORDER BY p.rowid DESC`,
        ).all(pr.toLowerCase()) as CardRow[];
        return rows.map((row) => {
          let prs: string[] = [];
          try {
            const parsed: unknown = JSON.parse(row.prs);
            if (Array.isArray(parsed)) prs = parsed.map((item) => String(item));
          } catch { /* stored by production-approval */ }
          return {
            id: row.ask,
            prs,
            head: row.head,
            kind: row.kind as AskKind,
            captain: row.captain,
            irreversible: row.irreversible === 1,
            state: row.state as AskState,
            resolution: row.resolution,
            answeredByOwner: row.owner === 1,
            createdAt: row.created_at,
            ...(typeof row.answered_at === "number" ? { answeredAt: row.answered_at } : {}),
          };
        });
      } catch {
        return [];
      }
    },
    recordDeploy(input: Omit<DeploySighting, "id"> & { id?: string }): DeploySighting {
      const row: DeploySighting = { ...input, id: input.id ?? newId("d") };
      db.prepare("INSERT INTO production_deploy_sighting VALUES (?,?,?,?,?,?,?)").run(
        row.id, row.project, row.task ?? null, row.source, row.detail, row.approved ? 1 : 0, row.at,
      );
      return row;
    },
    unapprovedDeploys(): DeploySighting[] {
      return (db.prepare("SELECT * FROM production_deploy_sighting WHERE approved=0 ORDER BY at DESC").all() as Array<{
        id: string; project: string; task: string | null; source: string; detail: string; approved: number; at: number;
      }>).map((row) => ({
        id: row.id,
        project: row.project,
        ...(row.task ? { task: row.task } : {}),
        source: row.source,
        detail: row.detail,
        approved: row.approved === 1,
        at: row.at,
      }));
    },
    needStatusPost(pr: string, head: string, error: string, at: number): void {
      db.prepare("INSERT INTO production_status_retry(pr, head, last_error, at) VALUES(?,?,?,?) ON CONFLICT(pr, head) DO UPDATE SET last_error=excluded.last_error, at=excluded.at").run(pr.toLowerCase(), head, error, at);
    },
    /** Save a post held back by the background allowance; a saved post keeps its last error and place. */
    deferStatusPost(pr: string, head: string, at: number): void {
      db.prepare("INSERT INTO production_status_retry(pr, head, last_error, at) VALUES(?,?,?,?) ON CONFLICT(pr, head) DO NOTHING").run(pr.toLowerCase(), head, "deferred: background GitHub allowance used", at);
    },
    clearStatusPost(pr: string, head: string): void {
      db.prepare("DELETE FROM production_status_retry WHERE pr=? AND head=?").run(pr.toLowerCase(), head);
    },
    statusPostNeeded(pr: string, head: string): boolean {
      return db.prepare("SELECT 1 FROM production_status_retry WHERE pr=? AND head=?").get(pr.toLowerCase(), head) !== undefined;
    },
    /** Every saved status post still to retry, the longest waiting first. */
    pendingStatusPosts(): Array<{ pr: string; head: string }> {
      return z.array(z.object({ pr: z.string(), head: z.string() })).parse(db.prepare("SELECT pr, head FROM production_status_retry ORDER BY at, pr, head").all());
    },
  };
}
