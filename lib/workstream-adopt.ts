// Adopt with fold (owner decisions, 20 Oct, REHOME-DECISIONS.md): open tasks of one project join a new
// workstream with its own branch, worktree and topic. Each idle crew's saved work folds into the
// workstream branch at once; a running crew folds when it finishes. These are the pure parts: the
// owner card, the proposal, the conflict crew's brief and the reads of host script output.

/** Where one task's saved work comes from. */
export type AdoptSource = {
  taskId: string;
  /** The job id: the crew whose work this is, or `<task>-<branch>` for a branch the card names. */
  crewId: string;
  threadId: string | null;
  /** The repository the work belongs to (owner/repo). */
  repository: string;
  /** The repository the task was recorded under, when the card moved it. */
  repointedFrom?: string;
  /** `worktree`: the crew's checkout still exists; `branch`: fold the pushed branch. */
  from: 'worktree' | 'branch';
  branch: string;
  path?: string;
  environmentId?: string | null;
  hostId?: string;
  /** The crew is still working: it folds when it finishes. */
  running: boolean;
};

const MAX_CARD = 1500;

function prLabel(url: string): string {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number ? `#${number}` : url;
}

function clipLine(text: string, max: number): string {
  const line = text.trim().split(/\s+/).join(' ');
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1))}…`;
}

/** The workstream branch's starting point for the card: one base, or each repository's base when they differ. */
export function basePhrase(bases: ReadonlyArray<{ repository: string; base: string }>): string {
  const distinct = [...new Set(bases.map((b) => b.base))];
  return distinct.length <= 1 ? distinct[0] ?? 'main' : bases.map((b) => `${b.base} in ${b.repository}`).join(' and ');
}

/**
 * The one owner card for one workstream: every task it groups, where its work comes from, and the PRs it
 * replaces. `base` is basePhrase of the repositories' default branches. A task's `project` is the project it
 * gets on Approve, because it has none recorded.
 */
export function adoptCardText(input: {
  name: string;
  base: string;
  sources: readonly AdoptSource[];
  tasks: ReadonlyArray<{ id: string; title: string; project?: string }>;
  replaces: readonly string[];
}): string {
  const lines = [`Group these tasks into workstream "${clipLine(input.name, 60)}", with a new topic, a new branch from ${input.base} and one dev link:`];
  for (const task of input.tasks) {
    const own = input.sources.filter((s) => s.taskId === task.id);
    const moved = own.find((s) => s.repointedFrom);
    const when = own.length === 0 ? 'no saved work; new work starts in the workstream'
      : own.some((s) => s.running) ? 'its crew is still working; folds when its crew finishes'
      : `folds now (${own.map((s) => s.branch).join(', ')})`;
    const joins = task.project ? `; no project recorded, joins project ${clipLine(task.project, 40)}` : '';
    lines.push(`- ${task.id} ${clipLine(task.title, 60)}: ${when}${moved ? `; moves from ${moved.repointedFrom} to ${moved.repository}` : ''}${joins}`);
  }
  if (input.replaces.length > 0) {
    lines.push(`Closes ${input.replaces.map(prLabel).join(', ')} with a link once the workstream PR holds all their commits.`);
  }
  lines.push('Unsaved work is saved first. A conflict goes to a new crew; if it cannot merge safely, that task stays separate.');
  const text = lines.join('\n');
  return text.length <= MAX_CARD ? text : `${text.slice(0, MAX_CARD - 1)}…`;
}

/** `git ls-remote --symref origin HEAD` names the remote's default branch, the PR base. */
export function prBaseFromLsRemote(output: string): string | null {
  return /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(output)?.[1] ?? null;
}

/** Close a replaced PR only when it is still open and every one of its commits is in the workstream PR. */
export function replacedPrVerdict(pr: { state: string; commits: readonly string[] }, contained: ReadonlySet<string>):
  { action: 'close' } | { action: 'skip'; reason: string } | { action: 'wait'; reason: string } {
  const state = pr.state.toUpperCase();
  if (state === 'MERGED') return { action: 'skip', reason: 'already merged' };
  if (state !== 'OPEN') return { action: 'skip', reason: 'already closed' };
  if (pr.commits.length === 0) return { action: 'wait', reason: 'its commits could not be read' };
  const missing = pr.commits.filter((sha) => !contained.has(sha)).length;
  if (missing > 0) return { action: 'wait', reason: `${missing} of ${pr.commits.length} commits are not in the workstream PR yet` };
  return { action: 'close' };
}

/** prContainsScript output: the commits the workstream head holds. */
export function parseContained(output: string): Set<string> {
  return new Set(output.split('\n').map((line) => /^FM_IN (\S+)$/.exec(line.trim())?.[1]).filter((sha): sha is string => sha !== undefined));
}

/** saveWorkScript output. `busy`: a merge or rebase is in progress, so nothing was committed. */
export function parseSavedWork(output: string): { committed: boolean; head?: string; missing?: true; busy?: string } {
  const line = output.split('\n').map((l) => l.trim()).find((l) => l.startsWith('FM_SAVE '));
  if (line === 'FM_SAVE missing') return { committed: false, missing: true };
  if (line?.startsWith('FM_SAVE busy ')) return { committed: false, busy: line.slice('FM_SAVE busy '.length) };
  const head = /^FM_SAVE commit (\S+)$/.exec(line ?? '')?.[1];
  if (head) return { committed: true, head };
  if (line === 'FM_SAVE none') return { committed: false };
  throw new Error('The backup commit returned no result.');
}

export type ProposableTask = { id: string; title: string; projectId?: string | null; project?: string | null; state: string; crews: number; prs: readonly string[] };
const OPEN = new Set(['working', 'needs_you', 'ready', 'check', 'merged']);

/** One proposed workstream per project: its open tasks that no workstream holds yet. */
export function proposeWorkstreams(input: { tasks: readonly ProposableTask[]; held: ReadonlySet<string> }): Array<{ projectId: string; project: string; taskIds: string[]; lines: string[] }> {
  const groups = new Map<string, { projectId: string; project: string; taskIds: string[]; lines: string[] }>();
  for (const task of input.tasks) {
    if (!OPEN.has(task.state) || input.held.has(task.id) || !task.projectId) continue;
    const group = groups.get(task.projectId) ?? { projectId: task.projectId, project: task.project ?? task.projectId, taskIds: [], lines: [] };
    group.taskIds.push(task.id);
    const prs = task.prs.map(prLabel).join(' ');
    group.lines.push(`${task.id} ${clipLine(task.title, 60)} (${task.state}, ${task.crews} crew${task.crews === 1 ? '' : 's'}${prs ? `, ${prs}` : ''})`);
    groups.set(task.projectId, group);
  }
  return [...groups.values()];
}

/** The report mark of a conflict crew that could not merge safely. */
export const RESOLVE_UNSAFE = 'RESOLVE_UNSAFE';

/** The brief of the new crew that merges one conflicting task into the workstream branch, in the workstream worktree. */
export function resolverBrief(input: { taskId?: string; repository: string; workstreamBranch: string; target: string; label: string }): string {
  return [
    `Merge the saved work of ${input.taskId ? `task ${input.taskId}` : 'an adopted task'} (${input.label}, commit ${input.target}) into the workstream branch ${input.workstreamBranch} of ${input.repository}, in this worktree.`,
    `Run: git merge --no-ff ${input.target}. Resolve each conflict so both sides keep working, run the project's tests, and commit the merge on ${input.workstreamBranch}.`,
    'Do not switch branches, rebase, reset, push, or create another worktree. Change only what the merge needs.',
    `If you cannot merge it safely, run git merge --abort, leave the worktree clean, and write ${RESOLVE_UNSAFE} with the reason in your report. That task then stays separate and the owner is asked once.`,
  ].join('\n');
}

/** The one question for the owner when a task's conflict could not be merged safely. */
export function separateQuestion(input: { taskId: string; title: string; workstream: string; reason: string }): string {
  return `${input.taskId} ${clipLine(input.title, 60)} could not be merged into workstream "${clipLine(input.workstream, 60)}" safely (${clipLine(input.reason, 200)}). It stays separate with its own worktree and PR. How should it go on?`;
}
