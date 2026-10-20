export const MEMORY_GUARD_BYTES = 3 * 1024 * 1024 * 1024;
export const FAILED_KEEP_MS = 7 * 24 * 60 * 60_000;
export const LOOKUP_MAX_LINES = 15;
export const FOLD_OK = "FOLD_OK";
export const FOLD_CONFLICT = "FOLD_CONFLICT";
export const WORKSTREAM_CARD_METHOD = "workstreamCard";
export const FOLD_CONFLICT_TELL =
  "Fold into the workstream branch hit a conflict. Update this worktree from the workstream branch, fix the conflict, retest, and report again. Do not create another worktree.";

export const CARD_TASK_STATES = [
  "queued",
  "waiting-memory",
  "working",
  "folding",
  "folded",
  "failed",
  "kept-unsaved",
  "dropped",
] as const;
export type CardTaskState = (typeof CARD_TASK_STATES)[number];

export function isAdoptedWorkstream(w: { requestTaskIds?: string[]; repos: Array<{ existing?: boolean }> }): boolean {
  return w.requestTaskIds !== undefined || w.repos.some((repo) => repo.existing === true);
}

export function memAvailableBytes(meminfo: string): number {
  const line = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
  if (!line) throw new Error("MemAvailable missing from /proc/meminfo.");
  return Number(line[1]) * 1024;
}

export function memoryIsLow(availableBytes: number, limit = MEMORY_GUARD_BYTES): boolean {
  return availableBytes < limit;
}

export function crewOwnTestsPassed(report: string): boolean {
  const text = report.trim();
  if (text === "") return false;
  if (/\btests? failed\b/i.test(text) || /\btest(?:s)? fail(?:ed|ure)?\b/i.test(text)) return false;
  const failed = /\b(\d+)\s+fail(?:ed|ures?)?\b/i.exec(text);
  if (failed && Number(failed[1]) > 0) return false;
  return /\btests? passed\b/i.test(text) || /\b\d+\s+pass(?:ed)?\b/i.test(text);
}

export function foldTouchesDevFiles(paths: readonly string[]): boolean {
  return paths.some((path) => {
    const name = path.split("/").pop() ?? path;
    if (
      name === "package.json" ||
      name === "package-lock.json" ||
      name === "pnpm-lock.yaml" ||
      name === "yarn.lock" ||
      name === "bun.lock" ||
      name === "bun.lockb"
    ) return true;
    if (name.startsWith(".env")) return true;
    if (/^vite\.config\./.test(name) || /^next\.config\./.test(name)) return true;
    if (/^tsconfig.*\.json$/.test(name)) return true;
    return false;
  });
}

export function jobToCardState(state: string, editing = true): CardTaskState {
  if (state === "waiting-memory") return "waiting-memory";
  if (state === "starting" || state === "running") return "working";
  if (state === "folding") return "folding";
  if (state === "folded") return "folded";
  if (state === "finished") return editing ? "folding" : "folded";
  if (state === "failed") return "failed";
  if (state === "kept-unsaved") return "kept-unsaved";
  if (state === "dropped") return "dropped";
  return "queued";
}

export function compactTaskLine(task: { id: string; title: string; model: string; state: string }): string {
  const title = task.title.trim().slice(0, 60) || "untitled";
  const model = task.model.trim().slice(0, 40) || "default";
  return `${task.id} ${title} ${model} ${task.state}`;
}

function oneLine(text: string, max: number): string {
  const line = text.trim().split(/\s+/).join(" ");
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1))}…`;
}

export function formatWorkstreamLookup(input: {
  task: string;
  title: string;
  brief: string;
  report: string;
  files: readonly string[];
}): string {
  const reportLines = input.report.trim().split("\n").map((line) => line.trimEnd()).filter((line) => line !== "").slice(0, 8);
  const files = input.files.slice(0, 6);
  const lines = [
    `${input.task} ${input.title}`.trim(),
    `brief: ${oneLine(input.brief, 200) || "(none)"}`,
    "last report:",
    ...(reportLines.length > 0 ? reportLines.map((line) => oneLine(line, 200)) : ["(none)"]),
    "changed files:",
    ...(files.length > 0 ? files.map((file) => `- ${file}`) : ["(none)"]),
  ];
  return lines.slice(0, LOOKUP_MAX_LINES).join("\n");
}

export function parseFoldOutput(output: string): { ok: boolean; conflict: boolean; files: string[] } {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const conflict = lines.includes(FOLD_CONFLICT);
  const ok = lines.includes(FOLD_OK) && !conflict;
  const marker = lines.findIndex((line) => line === FOLD_OK || line === FOLD_CONFLICT);
  const files = ok ? lines.slice(marker + 1) : [];
  return { ok, conflict, files };
}

export type WorkstreamCardTask = {
  task: string;
  title: string;
  model: string;
  state: CardTaskState;
  note?: string;
};

// The connector refuses the whole card for a task ID that is not T<n> or is longer than 24
// characters, so a crew whose owner task is not attached yet stays off the card.
export function isCardTaskId(task: string): boolean {
  return task.length <= 24 && /^T\d+$/.test(task);
}

export function workstreamCardInput(input: {
  workstreamId: string;
  revision: number;
  tasks: WorkstreamCardTask[];
}): { workstreamId: string; revision: number; tasks: WorkstreamCardTask[] } {
  return {
    workstreamId: input.workstreamId,
    revision: input.revision,
    tasks: input.tasks.filter((task) => isCardTaskId(task.task)).slice(0, 50).map((task) => ({
      task: task.task,
      title: task.title.slice(0, 80),
      model: task.model.slice(0, 40),
      state: task.state,
      ...(task.note ? { note: task.note.slice(0, 120) } : {}),
    })),
  };
}
