// The hourly follow-through pass for one captain (owner decisions Q1, Q5, Q9, 18 Oct): read what each
// project's production runs, move merged tasks that it holds to live with that evidence, then raise one
// alert per new stall. Read-only towards production; the only writes are task moves and the alerts.
import { projectForName, projectForRepo, type LiveCheck, type ProjectRule } from "../owner/projects.ts";
import { readProduction, taskLiveVerdict, type PrDetails, type ProductionRead, type ReaderDeps, type ReleaseEvidence } from "./live-checks.ts";
import type { OwnerTask } from "./owner-tasks.ts";
import type { DeliveryRecord } from "./pr-delivery.ts";
import { dueStalls, findStalls, stallAlerts, stallMemoryOf, unsentStalls, type LivePlan, type StallMemory } from "./stalls.ts";

export const LIVE_PASS_MS = 60 * 60_000;

/** Per project: why its work cannot be proven live (null when its checks read production), as of `at`. */
export type LiveStatus = Record<string, { missing: string | null; at: number }>;

export type LivePassDeps = {
  captain: string;
  now: number;
  /** Every task of the captain, finished ones included. */
  tasks: () => readonly OwnerTask[];
  recordsFor: (task: OwnerTask) => readonly DeliveryRecord[];
  /** Crews that start or run now. */
  running: ReadonlySet<string>;
  readers: ReaderDeps;
  contains: (check: LiveCheck, repo: string, ancestor: string, descendant: string) => Promise<boolean | null>;
  /** The task's release read-backs in its project's required group. */
  readback: (task: OwnerTask) => readonly ReleaseEvidence[];
  /** A merged PR's merge time and files, from GitHub; null when not read. */
  details?: (record: DeliveryRecord) => Promise<PrDetails | null>;
  /** Move the task to live with this evidence; false when something holds it (a program). */
  markLive: (task: OwnerTask, evidence: string, check: string) => boolean;
  alert: (project: string | null, text: string, incident: string) => Promise<boolean>;
  stallMemory: StallMemory | Record<string, never>;
};

/** The project rule of a task: its project label, else the repo of a linked PR. */
export function ruleOf(task: OwnerTask, records: readonly DeliveryRecord[]): ProjectRule | undefined {
  return projectForName(task.project) ?? records.map((r) => projectForRepo(r.repository)).find((rule) => rule !== undefined);
}

export function planOf(rule: ProjectRule | undefined, status: LiveStatus): LivePlan | undefined {
  if (rule?.live === undefined) return undefined;
  const missing = status[rule.name]?.missing ?? (rule.live.checks.length === 0 ? rule.live.missing ?? "no live check" : null);
  return { next: rule.live.next, actor: rule.live.actor, missing };
}

export async function runLivePass(deps: LivePassDeps): Promise<{ live: string[]; status: LiveStatus; stallMemory: StallMemory; alerted: string[] }> {
  // Each check is read once per pass, however many tasks it covers.
  const reads = new Map<string, Promise<ProductionRead>>();
  const production = (check: LiveCheck) => {
    const key = JSON.stringify(check);
    let read = reads.get(key);
    if (!read) reads.set(key, read = readProduction(check, deps.readers));
    return read;
  };
  const status: LiveStatus = {};
  const live: string[] = [];
  for (const task of deps.tasks().filter((item) => item.state === "merged")) {
    const records = deps.recordsFor(task);
    const rule = ruleOf(task, records);
    const verdict = await taskLiveVerdict(rule?.live, records, { production, contains: deps.contains, readback: () => deps.readback(task), ...(deps.details ? { details: deps.details } : {}) });
    if (rule) {
      const before = status[rule.name];
      // A project is "live check missing" only while no task of it could be read.
      status[rule.name] = { missing: verdict.live ? null : before !== undefined && before.missing === null ? null : verdict.missing, at: deps.now };
    }
    if (verdict.live && deps.markLive(task, verdict.evidence, rule?.name ?? "live check")) live.push(task.id);
  }
  const tasks = deps.tasks();
  const recordsOf = new Map(tasks.map((task) => [task.id, deps.recordsFor(task)]));
  const stalls = findStalls(tasks, deps.running, (task) => planOf(ruleOf(task, recordsOf.get(task.id) ?? []), status), deps.now);
  const earlier = stallMemoryOf(deps.stallMemory);
  const { due, memory } = dueStalls(stalls, earlier, deps.now);
  const alerted: string[] = [];
  let stallMemory = memory;
  for (const alert of stallAlerts(due)) {
    const incident = `stall-${(alert.project ?? "none").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date(deps.now).toISOString().slice(0, 13)}`;
    if (await deps.alert(alert.project, alert.text, incident)) { alerted.push(...alert.ids); continue; }
    // Not sent: these stalls, and their project's window, stay due for the next pass.
    stallMemory = unsentStalls(stallMemory, earlier, alert.ids, alert.project);
  }
  return { live, status, stallMemory, alerted };
}
