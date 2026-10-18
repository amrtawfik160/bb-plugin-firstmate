// Owner decision Q5 (18 Oct): every task that is not finished has a next step and someone who takes it.
// A task with no step taken for more than 24 hours is a stall (GLOSSARY.md): one alert names who must act,
// repeated only while it stays stalled for another 24 hours. Merged tasks are listed as "not live yet".
import { clip, formatAge } from "./owner-asks.ts";
import { isOpenTask, type OwnerTask } from "./owner-tasks.ts";

export const STALL_MS = 24 * 60 * 60_000;
export const STALL_ALERT_MAX_LINES = 15;

/** How a project goes live, as the stall and not-live lists need it. missing: why no live check proves its work. */
export type LivePlan = { next: string; actor: string; missing: string | null };

export type NextStep = { next: string; who: string };

/** The step a task waits for and who takes it. `plan` is its project's live plan, if any. */
export function nextStep(task: OwnerTask, plan: LivePlan | undefined, runningCrews: number): NextStep {
  switch (task.state) {
    case "needs_you": return { next: "answer the open question", who: "the owner" };
    case "ready": return { next: "merge the ready PR", who: "the owner" };
    case "check": return { next: "check the work, then make it live with evidence or drop it with the owner's words", who: "the captain" };
    case "merged": return plan
      ? { next: plan.missing ? `${plan.next} (live check missing: ${plan.missing})` : plan.next, who: plan.actor }
      : { next: "name how this project goes live in owner/projects.json", who: "the captain" };
    case "working": return runningCrews > 0
      ? { next: `wait for ${runningCrews} crew${runningCrews === 1 ? "" : "s"}`, who: "the crew" }
      : { next: "start a crew or say what blocks it", who: "the captain" };
    default: return { next: "none: it is finished", who: "nobody" };
  }
}

/** One merged task that production does not run yet, for the board's "Not live yet" section. */
export type NotLiveItem = { id: string; project: string | null; title: string; state: "merged"; ageMs: number; next: string; who: string; missing: string | null };

export function notLiveItems(tasks: readonly OwnerTask[], planFor: (task: OwnerTask) => LivePlan | undefined, now: number): NotLiveItem[] {
  return tasks.filter((task) => task.state === "merged").map((task) => {
    const plan = planFor(task);
    const step = nextStep(task, plan, 0);
    return { id: task.id, project: task.project, title: task.title, state: "merged" as const, ageMs: Math.max(0, now - task.updatedAt), next: step.next, who: step.who, missing: plan?.missing ?? null };
  }).sort((a, b) => b.ageMs - a.ageMs || a.id.localeCompare(b.id));
}

export function notLiveLine(item: NotLiveItem): string {
  return `${item.id} ${item.project ? `${item.project} · ` : ""}${clip(item.title, 60)} · merged ${formatAge(item.ageMs)} ago · next: ${clip(item.next, 120)} · ${item.who}`;
}

export type Stall = { task: OwnerTask; idleMs: number } & NextStep;

/** Open tasks with no crew running and no step for more than 24 hours. */
export function findStalls(tasks: readonly OwnerTask[], running: ReadonlySet<string>, planFor: (task: OwnerTask) => LivePlan | undefined, now: number): Stall[] {
  return tasks.filter((task) => isOpenTask(task) && now - task.updatedAt > STALL_MS && !task.crewIds.some((id) => running.has(id)))
    .map((task) => ({ task, idleMs: now - task.updatedAt, ...nextStep(task, planFor(task), 0) }));
}

/** Per task: when its stall was last alerted, and the update time it was stalled on. Per project: when it was last warned. */
export type StallMemory = { tasks: Record<string, { at: number; updatedAt: number }>; projects: Record<string, number> };
export const EMPTY_STALL_MEMORY: StallMemory = { tasks: {}, projects: {} };

const projectKeyOf = (task: OwnerTask) => task.project?.trim().toLowerCase() ?? "";

/** A memory from before project windows held only the per-task map. */
export function stallMemoryOf(value: unknown): StallMemory {
  const raw = (value ?? {}) as Partial<StallMemory> & Record<string, unknown>;
  if (typeof raw.tasks === "object" && raw.tasks !== null) return { tasks: { ...raw.tasks }, projects: { ...(raw.projects ?? {}) } };
  return { tasks: { ...(raw as StallMemory["tasks"]) }, projects: {} };
}

/**
 * The stalls to alert now: a new stall once, and the same stall again only after another 24 hours. A task
 * that moved since its alert is a new stall when it stalls again. Each project is warned at most once in
 * 24 hours: stalls of a project warned more recently wait, still due, for its window. Tasks no longer
 * stalled leave the memory.
 */
export function dueStalls(stalls: readonly Stall[], memory: StallMemory | Record<string, never>, now: number): { due: Stall[]; memory: StallMemory } {
  const before = stallMemoryOf(memory);
  const tasks: StallMemory["tasks"] = {};
  const projects = Object.fromEntries(Object.entries(before.projects).filter(([, at]) => now - at < STALL_MS));
  const candidates = new Map<string, Stall[]>();
  for (const stall of stalls) {
    const seen = before.tasks[stall.task.id];
    if (seen !== undefined && seen.updatedAt === stall.task.updatedAt && now - seen.at < STALL_MS) {
      tasks[stall.task.id] = seen;
      continue;
    }
    const key = projectKeyOf(stall.task);
    candidates.set(key, [...(candidates.get(key) ?? []), stall]);
  }
  const due: Stall[] = [];
  for (const [key, group] of candidates) {
    if (projects[key] !== undefined) {
      for (const stall of group) if (before.tasks[stall.task.id] !== undefined) tasks[stall.task.id] = before.tasks[stall.task.id]!;
      continue;
    }
    projects[key] = now;
    for (const stall of group) {
      due.push(stall);
      tasks[stall.task.id] = { at: now, updatedAt: stall.task.updatedAt };
    }
  }
  return { due, memory: { tasks, projects } };
}

/** Undo what `dueStalls` recorded for the given tasks and project when their alert was not sent. */
export function unsentStalls(memory: StallMemory, earlier: StallMemory, ids: readonly string[], project: string | null): StallMemory {
  const tasks = { ...memory.tasks };
  for (const id of ids) if (earlier.tasks[id] !== undefined) tasks[id] = earlier.tasks[id]!; else delete tasks[id];
  const projects = { ...memory.projects };
  const key = project?.trim().toLowerCase() ?? "";
  if (earlier.projects[key] !== undefined) projects[key] = earlier.projects[key]!; else delete projects[key];
  return { tasks, projects };
}

/** One alert per project, naming who must act on each stalled task. */
export function stallAlerts(due: readonly Stall[]): Array<{ project: string | null; text: string; ids: string[] }> {
  const byProject = new Map<string, Stall[]>();
  for (const stall of due) {
    const key = stall.task.project ?? "";
    byProject.set(key, [...(byProject.get(key) ?? []), stall]);
  }
  return [...byProject].map(([project, stalls]) => {
    const sorted = [...stalls].sort((a, b) => b.idleMs - a.idleMs || a.task.id.localeCompare(b.task.id));
    const lines = sorted.slice(0, STALL_ALERT_MAX_LINES).map((s) => `- ${s.task.id} ${clip(s.task.title, 60)} (${s.task.state === "merged" ? "merged, not live" : s.task.state.replace("_", " ")}, no step for ${formatAge(s.idleMs)}): ${s.who} must ${clip(s.next, 140)}`);
    const more = sorted.length - lines.length;
    const head = `${sorted.length} task${sorted.length === 1 ? " has" : "s have"} had no next step for more than 24 hours${project ? ` in ${project}` : ""}:`;
    return { project: project || null, text: [head, ...lines, ...(more > 0 ? [`…and ${more} more on the board.`] : [])].join("\n"), ids: sorted.map((s) => s.task.id) };
  });
}
