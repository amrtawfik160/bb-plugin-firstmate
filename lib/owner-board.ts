import { ASK_KIND_EMOJI, clip, formatAge, formatUtcTime, recommendedLabel, type OwnerAsk } from "./owner-asks.ts";
import { isOpenTask, linkedPrs, STALE_TASK_MS, type OwnerTask } from "./owner-tasks.ts";
import { boardPullRequests, type BoardPr, type DeliveryRecord } from "./pr-delivery.ts";
import { isOpenProgram, programLine, programNeedsOwner, type Program } from "./programs.ts";

/** What the owner's board and digest are drawn from. `tasks` includes closed tasks;
 * `records` holds the captain's open PRs and the ones merged since `since`. */
export type BoardInput = {
  asks: readonly OwnerAsk[];
  calls: readonly string[];
  tasks: readonly OwnerTask[];
  records: readonly DeliveryRecord[];
  /** The captain's programs; closed ones are left out. */
  programs?: readonly Program[];
  since: number;
  now: number;
};

// Telegram allows 4096; the connector adds a few characters around the board.
export const BOARD_MAX_CHARS = 3900;
export const BOARD_MAX_NEEDS_YOU = 15;
export const BOARD_MAX_DONE = 8;
export const DIGEST_MAX_NEEDS_YOU = 5;
export const DIGEST_MAX_STALE = 15;
export const BOARD_ANSWER_HINT = "Tap a question's button or reply with just its letter.";

const WAITING_WORDS: Partial<Record<OwnerTask["state"], string>> = { needs_you: "needs you", ready: "ready for you", check: "finished, check" };
const DONE_STATES = new Set<OwnerTask["state"]>(["merged", "live", "done", "dropped"]);

/** A section's own facts: `count` is the true total shown in its header. */
type Items = { count: number; lines: string[] };
type Section = { title: string; empty: string; cap: number; items: Items; footer?: string };

const byNumber = (a: OwnerTask, b: OwnerTask) => taskNumber(a.id) - taskNumber(b.id);

function taskNumber(id: string): number {
  return Number(id.slice(1)) || 0;
}

/** `cyndra-ai/cyndra-saas#2115` reads as `cyndra-saas#2115`. */
function shortRef(ref: string): string {
  return ref.replace(/^[^/]*\//, "");
}

type PrRef = (pr: { ref: string; url: string }) => string;
const plainRef: PrRef = (pr) => shortRef(pr.ref);
// The Telegram connector turns exactly this `[label](https://...)` form into a link.
const linkedRef: PrRef = (pr) => `[${shortRef(pr.ref)}](${pr.url})`;
/** The board limit is on what the owner sees: a link counts as its label only. */
const visibleLength = (text: string) => text.replace(/\[([^\]]*)\]\(https:\/\/[^)\s]*\)/g, "$1").length;

function askLine(ask: OwnerAsk, now: number): string {
  const label = recommendedLabel(ask);
  return `${ASK_KIND_EMOJI[ask.kind]} ${clip(ask.text, 140)} (${formatAge(now - ask.createdAt)}, ask ${ask.id})`
    + (label !== null ? ` Recommended: ${label}.` : "")
    + (ask.defaultAt !== null && label !== null ? ` Auto at ${formatUtcTime(ask.defaultAt)}.` : "")
    + (ask.messageUrl ? ` ${ask.messageUrl}` : "");
}

function prLine(pr: BoardPr, ref: PrRef): string {
  return `PR ${ref(pr)}${pr.title ? ` ${clip(pr.title, 50)}` : ""} · ${pr.state}`;
}

function taskLine(task: OwnerTask, now: number, ref: PrRef, extra: { state?: string; prs?: readonly BoardPr[]; tail?: string }): string {
  // A finished task's age says nothing the owner needs.
  const age = extra.tail === undefined ? formatAge(now - task.createdAt) : "";
  const stale = isOpenTask(task) && now - task.updatedAt >= STALE_TASK_MS ? `stale ${formatAge(now - task.updatedAt)}` : "";
  const prs = (extra.prs ?? []).map((pr) => `${ref(pr)} ${pr.state}`).join("; ");
  return [`${task.id} ${task.project ? `${task.project} · ` : ""}${clip(task.title, 60)}`, extra.state ?? "", age, prs, stale, extra.tail ?? ""]
    .filter((part) => part !== "")
    .join(" · ");
}

function doneTail(task: OwnerTask): string {
  return task.state === "dropped" ? `dropped: ${clip(task.dropReason ?? "", 60)}` : task.state;
}

/** What earlier digests already told the owner. `done` maps a finished item to the `since` of the
 * digest that first listed it. */
export type DigestMemory = { done: Record<string, number>; stale: { ids: string[]; at: number; since: number } | null };
export const EMPTY_DIGEST_MEMORY: DigestMemory = { done: {}, stale: null };
export const DIGEST_STALE_REPEAT_MS = 24 * 60 * 60_000;

/** Sort every fact once; the board and the digest pick from the same lists. `listDone` drops
 * finished items an earlier digest listed. */
function collect(input: BoardInput, ref: PrRef, listDone: (key: string) => boolean = () => true) {
  const linkedTo = new Map(input.tasks.map((task) => [task.id, new Set(linkedPrs(task, input.records).map((r) => r.id))]));
  const linked = new Set([...linkedTo.values()].flatMap((ids) => [...ids]));
  const open = boardPullRequests(input.records).sort((a, b) => a.openedAt - b.openedAt || a.ref.localeCompare(b.ref));
  const folded = (task: OwnerTask) => open.filter((pr) => linkedTo.get(task.id)!.has(pr.ref));
  const programs = (input.programs ?? []).filter(isOpenProgram);
  // An open program speaks for the owner task it holds: one line per program, not one per task.
  const heldTasks = new Set(programs.flatMap((program) => program.taskId ? [program.taskId] : []));
  const tasks = [...input.tasks].filter((task) => !heldTasks.has(task.id)).sort(byNumber);
  const asks = input.asks.filter((ask) => ask.state === "open").sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const waiting = tasks.filter((task) => task.state === "needs_you" || task.state === "ready" || task.state === "check");
  const ownerPrs = open.filter((pr) => !linked.has(pr.ref) && pr.needsOwner);
  const needsYou = [
    ...asks.map((ask) => askLine(ask, input.now)),
    ...input.calls.map((call) => clip(call, 160)),
    ...waiting.map((task) => taskLine(task, input.now, ref, { state: WAITING_WORDS[task.state], prs: folded(task) })),
    ...programs.flatMap((program) => programNeedsOwner(program, input.now) ?? []),
    ...ownerPrs.map((pr) => prLine(pr, ref)),
  ].map((line, index) => `${index + 1}. ${line}`);
  const doneTasks = tasks.filter((task) => DONE_STATES.has(task.state) && !(task.state === "dropped" && /duplicate|merged into T\d+/i.test(task.dropReason ?? "")) && task.updatedAt >= input.since).sort((a, b) => b.updatedAt - a.updatedAt || byNumber(b, a));
  // A record's updatedAt is the last time it was observed; for a merged PR that is close to its merge.
  const mergedPrs = input.records.filter((r) => r.forgeState === "merged" && r.updatedAt >= input.since && !linked.has(r.id)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const finished = [
    ...doneTasks.map((task) => ({ key: `${task.id}:${task.state}`, line: taskLine(task, input.now, ref, { tail: doneTail(task) }) })),
    ...mergedPrs.map((r) => ({ key: r.id, line: prLine({ ref: r.id, url: r.url, ...(r.title ? { title: r.title } : {}), state: "merged", needsOwner: false, openedAt: r.openedAt ?? r.updatedAt }, ref) })),
  ];
  const listed = finished.filter((item) => listDone(item.key));
  const done = listed.map((item) => `- ${item.line}`);
  const working = tasks.filter((task) => task.state === "working");
  const otherPrs = open.filter((pr) => !linked.has(pr.ref) && !pr.needsOwner);
  const programLines = programs.map((program) => `- ${program.id} ${program.project ? `${program.project} · ` : ""}${programLine(program, input.now)}`);
  const inProgress = [
    ...programLines,
    ...working.map((task) => `- ${taskLine(task, input.now, ref, { prs: folded(task) })}`),
    ...(otherPrs.length > 0 ? [`Other PRs: ${otherPrs.map((pr) => `${ref(pr)} ${pr.state}`).join("; ")}`] : []),
  ];
  const stale = tasks.filter((task) => isOpenTask(task) && input.now - task.updatedAt >= STALE_TASK_MS).map((task) => task.id);
  return {
    asks,
    needsYou: { count: needsYou.length, lines: needsYou },
    done: { count: done.length, lines: done },
    finishedKeys: finished.map((item) => item.key),
    listedKeys: listed.map((item) => item.key),
    inProgress: { count: programs.length + working.length, lines: inProgress },
    programs: { count: programs.length, lines: programLines },
    stale,
  };
}

function render(section: Section, kept: number): string {
  const { items } = section;
  const more = items.lines.length - kept;
  return [
    items.count === 0 ? section.empty : `${section.title} (${items.count})`,
    ...items.lines.slice(0, kept),
    ...(more > 0 ? [`…and ${more} more`] : []),
    ...(section.footer ? [section.footer] : []),
  ].join("\n");
}

/** Sections come most important first. Over the limit, lines leave from the end of the
 * last section that still has any; headers and counts always stay. */
function fit(sections: readonly Section[], max: number, length: (text: string) => number = (text) => text.length): string {
  const kept = sections.map((section) => Math.min(section.items.lines.length, section.cap));
  const text = () => sections.map((section, i) => render(section, kept[i]!)).join("\n\n");
  let out = text();
  for (let i = sections.length - 1; i >= 0 && length(out) > max; i--) {
    while (kept[i]! > 0 && length(out) > max) {
      kept[i]!--;
      out = text();
    }
  }
  return out;
}

/** The pinned Telegram board: what needs the owner, what finished since `since`, what is still running. */
/**
 * The crews working on each project, for the Telegram connector's pinned board in each project topic:
 * the working tasks per project, in the order the projects first appear. A task with no project is
 * not counted.
 */
export function workingByProject(tasks: BoardInput["tasks"]): Array<{ name: string; working: number }> {
  const counts = new Map<string, number>();
  for (const task of tasks) if (task.state === "working" && task.project) counts.set(task.project, (counts.get(task.project) ?? 0) + 1);
  return [...counts].map(([name, working]) => ({ name, working }));
}

export function formatBoard(input: BoardInput): string {
  const facts = collect(input, linkedRef);
  return fit([
    { title: "📌 Needs you", empty: "📌 Needs you: nothing right now.", cap: BOARD_MAX_NEEDS_YOU, items: facts.needsYou, ...(facts.asks.length > 0 ? { footer: BOARD_ANSWER_HINT } : {}) },
    { title: "✅ Done since you last looked", empty: "✅ Done since you last looked: nothing new.", cap: BOARD_MAX_DONE, items: facts.done },
    { title: "🔧 In progress", empty: "🔧 In progress: nothing open.", cap: Infinity, items: facts.inProgress },
  ], BOARD_MAX_CHARS, visibleLength);
}

/** A short catch-up for the owner; empty when there is nothing to say. */
export function formatDigest(input: BoardInput): string {
  return digestText(collect(input, plainRef), true);
}

/** The digest without what an earlier digest already said: a finished item is listed once, and an
 * unchanged stale list once per day. The same `since` again means the earlier digest was not
 * sent, so its items are listed again. */
export function digestOnce(input: BoardInput, memory: DigestMemory): { text: string; memory: DigestMemory } {
  const facts = collect(input, plainRef, (key) => memory.done[key] === undefined || memory.done[key] === input.since);
  const last = memory.stale;
  const showStale = last === null || last.since === input.since || last.ids.join() !== facts.stale.join() || input.now - last.at >= DIGEST_STALE_REPEAT_MS;
  // Lines past the cap were not shown, so they stay new for the next digest.
  const shown = new Set(facts.listedKeys.slice(0, BOARD_MAX_DONE));
  const done = Object.fromEntries(facts.finishedKeys.flatMap((key) => {
    const since = shown.has(key) ? memory.done[key] ?? input.since : memory.done[key];
    return since === undefined ? [] : [[key, since]];
  }));
  const stale = facts.stale.length === 0 ? null : showStale ? { ids: facts.stale, at: input.now, since: input.since } : last;
  return { text: digestText(facts, showStale), memory: { done, stale } };
}

function digestText(facts: ReturnType<typeof collect>, showStale: boolean): string {
  const stale = facts.stale.length > DIGEST_MAX_STALE ? [...facts.stale.slice(0, DIGEST_MAX_STALE), "…"] : facts.stale;
  const sections: Section[] = [
    { title: "Needs you", empty: "", cap: DIGEST_MAX_NEEDS_YOU, items: facts.needsYou },
    { title: "Done", empty: "", cap: BOARD_MAX_DONE, items: facts.done },
    // An open program is listed in every digest until each ticket is done or dropped.
    { title: "Programs", empty: "", cap: Infinity, items: facts.programs },
  ].filter((section) => section.items.count > 0);
  const blocks = [
    ...(sections.length > 0 ? [fit(sections, BOARD_MAX_CHARS)] : []),
    ...(showStale && facts.stale.length > 0 ? [`Stale (${facts.stale.length}): ${stale.join(", ")}`] : []),
  ];
  return blocks.join("\n\n");
}
