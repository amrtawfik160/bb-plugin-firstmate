import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { workstreamSchema, type BindRefusalReason, type Workstream, type WorkstreamRepo, type WorkstreamJob, type FoldStep, type ShipSnapshot, type topicSchema } from './workstream-schema.ts';
import {
  compactTaskLine,
  crewOwnTestsPassed,
  currentJobs,
  FAILED_KEEP_MS,
  FOLD_CONFLICT_TELL,
  foldTouchesDevFiles,
  formatWorkstreamLookup,
  isAdoptedWorkstream,
  jobStartNote,
  jobToCardState,
  memoryIsLow,
} from './workstream-fold.ts';
import { resolverBrief, RESOLVE_UNSAFE, type AdoptSource } from './workstream-adopt.ts';

export class WorkstreamWaiting extends Error {}
/** A job's start found no free crew slot: it waits in line and starts on a later pass. */
export class WorkstreamJobWaiting extends Error {}
/** A job's start was refused before anything was spawned: it ends failed, and a retry is a new dispatch. */
export class WorkstreamJobRefused extends Error {}
/** What the captain hears about a job's start. */
export type JobNotice = { kind: 'waiting' | 'unresolved' | 'failed' | 'started'; reason: string };
/** A bindTopic refusal: `reason` is the stable code; the message text is unchanged for callers that read it. */
export class WorkstreamRefusal extends Error {
  readonly reason: BindRefusalReason;
  constructor(reason: BindRefusalReason, message: string) { super(message); this.reason = reason; }
}

export const DEV_IDLE_MS = 2 * 60 * 60_000;
export const UNSHIPPED_MS = 2 * 24 * 60 * 60_000;
export { workstreamSchema, topicSchema } from './workstream-schema.ts';
export type { Workstream, WorkstreamRepo, WorkstreamJob, FoldStep, ShipSnapshot } from './workstream-schema.ts';
export { isAdoptedWorkstream } from './workstream-fold.ts';
type Database = { exec(sql: string): unknown; prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };
/** A fold done in one step, without a saved per-repository transaction. */
export type FoldResult = { ok: boolean; conflict: boolean; files: string[]; wait?: string };
/** Per-repository Git steps of a fold. The service saves each step, so a restart can finish or undo it. */
export type FoldOps = {
  /** Read-only: one step per repository of the task, or why the fold must wait. */
  plan: (w: Workstream, job: WorkstreamJob) => Promise<{ steps: FoldStep[] } | { wait: string }>;
  merge: (w: Workstream, step: FoldStep) => Promise<{ kind: 'merged'; after: string; files: string[] } | { kind: 'conflict' } | { kind: 'wait'; reason: string }>;
  /** The workstream head, whether it holds the task commit, and the files changed since the step's `before`. */
  inspect: (w: Workstream, step: FoldStep) => Promise<{ head: string; hasTarget: boolean; files: string[] }>;
  /** False when the undo must wait, for example for a local change in a file the fold changed. */
  rollback: (w: Workstream, step: FoldStep) => Promise<boolean>;
};
/** Nothing when the crew was archived; `kept` when it must stay for now. */
export type ArchiveOutcome = void | { kept: string; findings?: string[] };

/** The folded work a Ship request takes: folded task crews not shipped before, and their tasks. */
export function shipSnapshotOf(w: Pick<Workstream, 'jobs'> & { ship?: { snapshot?: ShipSnapshot } }): ShipSnapshot {
  if (w.ship?.snapshot) return w.ship.snapshot;
  // Crews from before task worktrees edited the workstream worktree itself, so a finished one is in it.
  const jobs = w.jobs.filter((j) => j.editing && !j.shipped && (j.state === 'folded' || (!j.isolated && j.state === 'finished')));
  return { jobs: jobs.map((j) => j.id), taskIds: [...new Set(jobs.flatMap((j) => (j.taskId ? [j.taskId] : [])))], heads: {} };
}
export type WorkstreamDeps = {
  now: () => number;
  supportsDevLink?: (projectId: string) => Promise<boolean>;
  provision: (w: Workstream) => Promise<WorkstreamRepo[]>;
  start: (w: Workstream, job: WorkstreamJob) => Promise<string>;
  /** The task crew's own BB-managed checkout, once BB has created it; null until then. */
  checkout?: (w: Workstream, job: WorkstreamJob) => Promise<Partial<WorkstreamJob> | null>;
  status: (threadId: string) => Promise<string>;
  startDev: (w: Workstream) => Promise<string>;
  devRunning?: (w: Workstream) => Promise<boolean>;
  devActivity?: (w: Workstream) => Promise<number>;
  stopDev: (w: Workstream) => Promise<void>;
  unsaved: (repo: WorkstreamRepo) => Promise<string[]>;
  /** Why End must keep this workstream worktree (another thread still uses it); null when it may go. */
  keepWorktree?: (w: Workstream, repo: WorkstreamRepo) => Promise<string | null>;
  remove: (repo: WorkstreamRepo, w: Workstream) => Promise<void>;
  ship: (w: Workstream) => Promise<void>;
  taskState: (id: string) => string | undefined;
  busy?: (w: Workstream) => Promise<boolean>;
  editorBusy?: (w: Workstream) => Promise<boolean>;
  waiting?: (w: Workstream) => Promise<void>;
  stall?: (w: Workstream) => Promise<boolean>;
  error?: (w: Workstream, error: unknown) => void;
  memAvailable?: () => Promise<number>;
  report?: (w: Workstream, job: WorkstreamJob) => Promise<string>;
  fold?: (w: Workstream, job: WorkstreamJob) => Promise<FoldResult>;
  foldOps?: FoldOps;
  tell?: (w: Workstream, job: WorkstreamJob, message: string) => Promise<void>;
  archive?: (w: Workstream, job: WorkstreamJob) => Promise<ArchiveOutcome>;
  /** Deletes a folded task's branch; returns why a branch was kept (its open PR holds work the fold did not take). */
  deleteBranch?: (w: Workstream, job: WorkstreamJob) => Promise<string | void>;
  unsavedJob?: (w: Workstream, job: WorkstreamJob) => Promise<string[]>;
  restartDev?: (w: Workstream) => Promise<void>;
  card?: (w: Workstream) => Promise<void>;
  /** Tell the captain that a job waits for a crew slot, has an unresolved start, failed to start, or started after either. */
  jobNotice?: (w: Workstream, job: WorkstreamJob, notice: JobNotice) => Promise<void>;
  /**
   * Before an adopted crew's work folds: save its uncommitted work as a backup commit and push it. `wait`
   * holds the fold; `sourceBranch` folds that pushed branch because the crew's worktree is gone; `running`
   * names the crew's thread when it works again, so its job runs and nothing is saved or folded yet.
   */
  saveWork?: (w: Workstream, job: WorkstreamJob) => Promise<void | { wait: string } | { sourceBranch: string } | { running: string }>;
  /** A conflict the new crew could not merge safely: the task stays separate and the owner gets one question. */
  separate?: (w: Workstream, job: WorkstreamJob, reason: string) => Promise<void>;
  signal?: AbortSignal;
};

/** One adopted crew's work as a workstream job: it folds when the crew is idle. */
function adoptedJob(source: AdoptSource & { title?: string }, projectId: string): WorkstreamJob {
  return {
    id: source.crewId, editing: true, state: source.running ? 'running' : 'finished', threadId: source.threadId,
    payload: JSON.stringify({ task: source.title ?? `Adopted work of ${source.taskId}`, projectId }),
    taskId: source.taskId, isolated: true, adopted: true, repository: source.repository, branch: source.branch,
    ...(source.title ? { title: source.title } : {}),
    ...(source.repointedFrom ? { repointedFrom: source.repointedFrom } : {}),
    ...(source.from === 'branch' || !source.path
      ? { sourceBranch: source.branch }
      : {
        path: source.path, environmentId: source.environmentId ?? null,
        repos: [{ repository: source.repository, path: source.path, branch: source.branch, environmentId: source.environmentId ?? null, ...(source.hostId ? { hostId: source.hostId } : {}) }],
      }),
  };
}

type JobSubmit = Pick<WorkstreamJob, 'id' | 'editing' | 'payload'> & Partial<Pick<WorkstreamJob, 'taskId' | 'followUpOf' | 'title' | 'model' | 'environmentId' | 'path' | 'branch' | 'repos' | 'repository' | 'baseBranch'>>;

/** A crew that edits in the workstream worktree itself (a conflict crew, or an editor from before task
 * worktrees) is working there: folds, fold undos and Ship leave that worktree alone until it finishes. */
function sharedEditorActive(w: Pick<Workstream, 'jobs'>): boolean {
  return w.jobs.some((j) => j.editing && !j.isolated && (j.state === 'running' || j.state === 'starting'));
}

function keptUnsaved(job: WorkstreamJob): boolean {
  return job.state === 'kept-unsaved' || job.cleanup === 'kept-unsaved';
}

function jobClosed(job: WorkstreamJob): boolean {
  if (keptUnsaved(job) || job.cleanup === 'pending') return false;
  // A job refused before any spawn has no crew, work or worktree.
  if (job.state === 'failed' && job.threadId === null) return true;
  // Scouts, adopted editors, and editors saved before task worktrees close as before: when finished.
  if (!job.isolated) return job.state === 'finished' || job.state === 'dropped' || job.state === 'folded';
  return job.state === 'folded' || job.state === 'dropped' || job.state === 'failed';
}

function briefOf(job: WorkstreamJob): string {
  try {
    const task = JSON.parse(job.payload) as { task?: unknown };
    return typeof task.task === 'string' ? task.task : '';
  } catch {
    return '';
  }
}

export function createWorkstreams(db: Database, deps: WorkstreamDeps) {
  db.exec('CREATE TABLE IF NOT EXISTS firstmate_workstream (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
  let pending: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  };
  const all = () => db.prepare('SELECT record FROM firstmate_workstream ORDER BY rowid').all().map((row) => {
    const { record } = z.object({ record: z.string() }).parse(row);
    return workstreamSchema.parse(JSON.parse(record));
  });
  const save = (w: Workstream) => {
    const previous = all().find((r) => r.id === w.id);
    if (previous) {
      // Attachments are only added, except for a task that left the workstream.
      const left = new Set(w.leftTaskIds ?? []);
      w.taskIds = [...new Set([...previous.taskIds, ...w.taskIds])].filter((id) => !left.has(id));
      for (const repo of w.repos) repo.environmentId ??= previous.repos.find((r) => r.path === repo.path)?.environmentId ?? null;
    }
    db.prepare('INSERT OR REPLACE INTO firstmate_workstream (id,record) VALUES (?,?)').run(w.id, JSON.stringify(w)); return w; };
  const get = (id: string, threadId: string): Workstream => {
    const w = all().find((w) => w.id === id);
    if (!w || w.threadId !== threadId) throw new Error('No workstream for this captain.');
    return w;
  };
  const open = (id: string, threadId: string) => {
    const w = get(id, threadId);
    if (w.state !== 'open') throw new Error('Workstream has ended.');
    if (!w.provisioned) throw new Error('Workstream provisioning is incomplete; retry creation with its requestId.');
    return w;
  };
  async function bumpCard(w: Workstream) {
    w.cardRevision = (w.cardRevision ?? 0) + 1;
    w.updatedAt = deps.now();
    save(w);
    try { await deps.card?.(w); } catch (error) { deps.error?.(w, error); }
  }
  async function rejectFold(w: Workstream, job: WorkstreamJob) {
    if (job.adopted && job.conflict) return startResolver(w, job, job.conflict);
    job.state = 'running';
    job.error = FOLD_CONFLICT_TELL;
    await bumpCard(w);
    await deps.tell?.(w, job, FOLD_CONFLICT_TELL);
  }
  // An adopted crew's conflict goes to a new crew in the workstream worktree (owner decision Q4, 20 Oct):
  // the adopted crew was briefed before its workstream existed and keeps its own branch and PR.
  async function startResolver(w: Workstream, job: WorkstreamJob, step: FoldStep) {
    const repo = w.repos.find((r) => r.repository === step.repository) ?? w.repos[0];
    let id = `${job.id}-merge`;
    for (let n = 2; w.jobs.some((j) => j.id === id); n++) id = `${job.id}-merge${n}`;
    const label = job.sourceBranch ?? job.branch ?? job.id;
    w.jobs.push({
      id, editing: true, state: 'queued', threadId: null, resolves: job.id,
      payload: JSON.stringify({
        task: resolverBrief({ taskId: job.taskId, repository: step.repository, workstreamBranch: repo?.branch ?? '', target: step.target, label }),
        projectId: w.projectId, title: `Merge ${job.taskId ?? job.id} into the workstream`, shape: 'ship', mode: 'direct-PR', workstreamRepo: step.repository,
      }),
      title: `Merge ${job.title ?? job.taskId ?? job.id} into the workstream`,
      ...(job.taskId ? { taskId: job.taskId } : {}),
    });
    job.state = 'finished';
    job.resolver = id;
    job.note = `waiting: crew ${id} resolves the fold conflict`;
    delete job.error;
    await bumpCard(w);
  }
  // A conflict crew is idle: the task folded when the workstream branch holds its commit; otherwise the task
  // stays separate with its own worktree and PR, and the owner is asked once.
  async function checkResolved(w: Workstream, resolver: WorkstreamJob) {
    const job = w.jobs.find((j) => j.id === resolver.resolves);
    const step = job?.conflict;
    if (!job || !step || !deps.foldOps) { resolver.state = 'dropped'; await bumpCard(w); return; }
    let seen: Awaited<ReturnType<FoldOps['inspect']>>;
    try { seen = await deps.foldOps.inspect(w, step); }
    catch (error) { deps.error?.(w, error); return; }
    if (seen.hasTarget) {
      job.state = 'folded';
      job.files = seen.files;
      job.foldedAt = deps.now();
      delete job.conflict; delete job.resolver; delete job.note; delete job.error;
      resolver.state = 'folded';
      resolver.files = seen.files;
      await bumpCard(w);
      if (foldTouchesDevFiles(seen.files) && w.devLink.state === 'running' && deps.restartDev) {
        try { await deps.restartDev(w); } catch (error) { deps.error?.(w, error); }
      }
      return;
    }
    let report = '';
    try { report = deps.report ? await deps.report(w, resolver) : resolver.report ?? ''; } catch (error) { deps.error?.(w, error); }
    const unsafe = report.split('\n').find((line) => line.includes(RESOLVE_UNSAFE));
    const reason = unsafe?.slice(unsafe.indexOf(RESOLVE_UNSAFE) + RESOLVE_UNSAFE.length).replace(/^[\s:.-]+/, '').trim() || 'the conflict crew did not merge it';
    resolver.state = 'dropped';
    resolver.note = `stays separate: ${reason}`;
    job.state = 'dropped';
    job.note = `stays separate: ${reason}`;
    delete job.resolver;
    // The task leaves the workstream unless other work of it is already in or still on its way.
    const kept = w.jobs.some((j) => j.id !== job.id && j.id !== resolver.id && j.taskId === job.taskId && j.state !== 'dropped' && j.state !== 'failed');
    if (job.taskId && !kept) {
      w.leftTaskIds = [...new Set([...(w.leftTaskIds ?? []), job.taskId])];
      w.taskIds = w.taskIds.filter((id) => id !== job.taskId);
    }
    await bumpCard(w);
    try { await deps.separate?.(w, job, reason); } catch (error) { deps.error?.(w, error); }
  }
  async function waitToFold(w: Workstream, job: WorkstreamJob, reason: string) {
    job.state = 'finished';
    job.note = `waiting: ${reason}`;
    await bumpCard(w);
  }
  // The fold has landed in every repository (job.fold committed). The dev link restart follows the
  // landed fold, whatever later happens to the task's worktree cleanup.
  async function finishFold(w: Workstream, job: WorkstreamJob) {
    const files = job.fold?.files ?? job.files ?? [];
    if (job.state !== 'folded') {
      job.state = 'folded';
      job.files = files;
      job.foldedAt = deps.now();
      // An adopted crew's old worktree goes through the task-worktree cleanup, and its branch is kept.
      if (job.adopted) delete job.cleanup; else job.cleanup = 'pending';
      delete job.error;
      delete job.note;
      await bumpCard(w);
    }
    if (!job.fold) return;
    if (foldTouchesDevFiles(files) && w.devLink.state === 'running' && deps.restartDev) {
      try { await deps.restartDev(w); } catch (error) { deps.error?.(w, error); }
    }
    delete job.fold;
    save(w);
  }
  async function foldOnce(w: Workstream, job: WorkstreamJob, fold: NonNullable<WorkstreamDeps['fold']>) {
    job.state = 'folding';
    await bumpCard(w);
    try {
      const result = await fold(w, job);
      if (result.ok) {
        job.fold = { state: 'committed', steps: [], files: result.files };
        await finishFold(w, job);
      } else if (result.wait) await waitToFold(w, job, result.wait);
      else await rejectFold(w, job);
    } catch (error) {
      job.state = 'finished';
      job.error = String(error);
      save(w);
      deps.error?.(w, error);
    }
  }
  async function startFold(w: Workstream, job: WorkstreamJob, ops: FoldOps) {
    let plan: Awaited<ReturnType<FoldOps['plan']>>;
    try { plan = await ops.plan(w, job); }
    catch (error) { deps.error?.(w, error); return; }
    if ('wait' in plan) {
      if (job.note !== `waiting: ${plan.wait}`) await waitToFold(w, job, plan.wait);
      return;
    }
    // Saved before any Git change, so a restart finds every repository and its original head.
    job.fold = { state: 'merging', steps: plan.steps.map((step) => ({ ...step, state: 'pending' as const })) };
    job.state = 'folding';
    delete job.note;
    await bumpCard(w);
    await advanceFold(w, job, ops);
  }
  async function advanceFold(w: Workstream, job: WorkstreamJob, ops: FoldOps) {
    const fold = job.fold!;
    try {
      if (fold.state === 'merging') {
        for (const step of fold.steps) {
          if (step.state !== 'pending') continue;
          const result = await ops.merge(w, step);
          if (result.kind === 'merged') {
            step.state = 'merged';
            step.after = result.after;
            fold.files = [...(fold.files ?? []), ...result.files];
            save(w);
            continue;
          }
          fold.state = 'rolling-back';
          fold.reason = result.kind;
          if (result.kind === 'wait') job.note = `waiting: ${result.reason}`;
          save(w);
          break;
        }
        if (fold.state === 'merging') {
          fold.state = 'committed';
          save(w);
          await finishFold(w, job);
          return;
        }
      }
      if (fold.state !== 'rolling-back') return;
      for (const step of [...fold.steps].reverse()) {
        if (step.state !== 'merged') continue;
        if (!(await ops.rollback(w, step))) {
          job.note = 'fold undo waits: the workstream worktree changed';
          save(w);
          return;
        }
        step.state = 'rolled-back';
        save(w);
      }
      const reason = fold.reason;
      const conflicted = fold.steps.find((step) => step.state === 'pending');
      delete job.fold;
      if (reason === 'conflict' && job.adopted && conflicted) job.conflict = { ...conflicted, state: 'pending' };
      if (reason === 'conflict') await rejectFold(w, job);
      else if (reason === 'wait') await waitToFold(w, job, job.note?.replace(/^waiting: /, '') ?? 'the workstream worktree is busy');
      else { job.state = 'finished'; await bumpCard(w); }
    } catch (error) {
      // A host command's outcome is unknown: the saved transaction is checked again on the next pass.
      save(w);
      deps.error?.(w, error);
    }
  }
  // A job saved as folding was interrupted (restart or a host error) or its undo had to wait. Finish a
  // fold that verifiably landed in every repository; otherwise undo every repository it changed.
  async function recoverFold(w: Workstream, job: WorkstreamJob) {
    const fold = job.fold;
    if (!fold) { job.state = 'finished'; await bumpCard(w); return; }
    const ops = deps.foldOps;
    if (!ops) return;
    if (fold.state === 'merging') {
      // The changed files are read again from each saved original head, so a landed fold whose result
      // was lost still restarts the dev link and shows its files.
      const files = new Set<string>();
      try {
        for (const step of fold.steps) {
          const seen = await ops.inspect(w, step);
          if (seen.hasTarget) { step.state = 'merged'; step.after ??= seen.head; for (const file of seen.files) files.add(file); }
          else step.state = 'pending';
        }
      } catch (error) { deps.error?.(w, error); return; }
      if (fold.steps.every((step) => step.state === 'merged')) {
        fold.files = [...files];
        fold.state = 'committed';
        save(w);
        await finishFold(w, job);
        return;
      }
      fold.state = 'rolling-back';
      fold.reason = 'restart';
      save(w);
    }
    await advanceFold(w, job, ops);
  }
  async function holdCleanup(w: Workstream, job: WorkstreamJob, cleanup: 'pending' | 'kept-unsaved', note: string) {
    if (job.cleanup === cleanup && job.note === note) return;
    job.cleanup = cleanup;
    job.note = note;
    await bumpCard(w);
  }
  // Retire a task crew after its fold, drop or 7 failed days. Nothing is archived while it holds unsaved
  // work or the archive callback finds it still needed; both are retried on the next pass.
  async function cleanUp(w: Workstream, job: WorkstreamJob, foldedWork: boolean, doneNote?: string) {
    let findings: string[];
    try { findings = deps.unsavedJob ? await deps.unsavedJob(w, job) : []; }
    catch (error) { deps.error?.(w, error); findings = ['worktree check failed']; }
    if (findings.length) return holdCleanup(w, job, 'kept-unsaved', `kept: unsaved work (${findings.join(', ')})`);
    let outcome: ArchiveOutcome;
    try { outcome = await deps.archive?.(w, job); }
    catch (error) { deps.error?.(w, error); return holdCleanup(w, job, 'pending', `cleanup pending: ${error instanceof Error ? error.message : String(error)}`); }
    if (outcome) {
      return outcome.findings?.length
        ? holdCleanup(w, job, 'kept-unsaved', `kept: unsaved work (${outcome.findings.join(', ')})`)
        : holdCleanup(w, job, 'pending', `cleanup waits: ${outcome.kept}`);
    }
    let kept: string | void = undefined;
    if (foldedWork) {
      try { kept = await deps.deleteBranch?.(w, job); } catch (error) { deps.error?.(w, error); }
    }
    job.cleanup = 'done';
    const note = kept || doneNote;
    if (note) job.note = note; else delete job.note;
    await bumpCard(w);
  }
  async function drain(w: Workstream) {
    if (deps.signal?.aborted) return;
    const created = !isAdoptedWorkstream(w);
    for (const job of w.jobs) {
      if (!job.isolated || !job.taskId || deps.taskState(job.taskId) !== 'dropped') continue;
      if (job.state === 'dropped' || job.state === 'folded' || job.state === 'folding') continue;
      job.state = 'dropped';
      if (job.adopted) delete job.cleanup; else job.cleanup = job.threadId ? 'pending' : 'done';
      await bumpCard(w);
    }
    for (const job of w.jobs.filter((j) => j.state === 'running')) {
      if (job.isolated && !job.adopted && !job.path && deps.checkout) {
        try {
          const checkout = await deps.checkout(w, job);
          if (checkout) { Object.assign(job, checkout); save(w); }
        } catch (error) { deps.error?.(w, error); }
      }
      const status = job.threadId ? await deps.status(job.threadId) : 'unknown';
      // An adopted source crew stays pending through a recoverable error: its work is saved and folded only
      // once it is idle, so what it commits while recovering is in the fold.
      if (job.adopted && (status === 'error' || status === 'failed')) continue;
      if (status === 'idle' || status === 'archived' || status === 'error' || status === 'failed') {
        // An adopted crew's saved work is never stranded: the save reads the crew again first, so one that works
        // again keeps running.
        if (job.isolated && !job.adopted && (status === 'error' || status === 'failed' || status === 'archived')) {
          job.state = 'failed';
          job.failedAt = deps.now();
        } else {
          job.state = 'finished';
        }
        await bumpCard(w);
      }
    }
    // A fold saved before a restart, or an undo that had to wait, finishes before any new fold. After the
    // status poll, so a crew told about a conflict here is not seen idle and folded again in this pass.
    for (const job of w.jobs) {
      if (deps.signal?.aborted) return;
      if (job.fold?.state === 'committed') await finishFold(w, job);
      else if (job.state === 'folding' && !sharedEditorActive(w)) await recoverFold(w, job);
    }
    for (const resolver of w.jobs.filter((j) => j.resolves && j.state === 'finished')) {
      if (deps.signal?.aborted) return;
      await checkResolved(w, resolver);
    }
    // One fold at a time: an undo that has to wait holds later folds, whose merges would move the branch.
    if (created && w.ship.state !== 'running' && !w.jobs.some((j) => j.state === 'folding') && !sharedEditorActive(w)) {
      for (const job of w.jobs.filter((j) => j.isolated && j.state === 'finished' && !j.resolver)) {
        if (deps.signal?.aborted) return;
        if (job.adopted) {
          // An adopted crew was briefed before its workstream: it folds once idle, after its work is saved.
          if (!deps.foldOps) continue;
          let saved: Awaited<ReturnType<NonNullable<WorkstreamDeps['saveWork']>>>;
          try { saved = await deps.saveWork?.(w, job); }
          catch (error) { deps.error?.(w, error); saved = { wait: 'its unsaved work could not be saved yet' }; }
          if (saved && 'running' in saved) {
            job.state = 'running';
            job.threadId = saved.running;
            delete job.note;
            await bumpCard(w);
            continue;
          }
          if (saved && 'wait' in saved) {
            if (job.note !== `waiting: ${saved.wait}`) await waitToFold(w, job, saved.wait);
            continue;
          }
          if (saved && 'sourceBranch' in saved && job.sourceBranch !== saved.sourceBranch) { job.sourceBranch = saved.sourceBranch; save(w); }
        } else {
          const report = deps.report ? await deps.report(w, job) : job.report ?? '';
          if (report) job.report = report;
          if (!crewOwnTestsPassed(report) || (!deps.foldOps && !deps.fold)) { save(w); continue; }
        }
        if (deps.foldOps) await startFold(w, job, deps.foldOps);
        else await foldOnce(w, job, deps.fold!);
        if (job.state === 'folding') break;
      }
    }
    for (const job of w.jobs) {
      if (deps.signal?.aborted) return;
      if (!job.isolated || job.adopted || job.cleanup === 'done') continue;
      if ((job.state === 'folded' || job.state === 'dropped') && job.cleanup) await cleanUp(w, job, job.state === 'folded');
      else if (job.state === 'failed' && job.failedAt != null && !job.supersededBy && deps.now() - job.failedAt >= FAILED_KEEP_MS) await cleanUp(w, job, false, 'archived after 7 days');
    }
    for (const job of w.jobs) {
      if (deps.signal?.aborted) return;
      if (job.state !== 'queued' && job.state !== 'starting' && job.state !== 'waiting-memory') continue;
      // Adopted editors, and editors saved before task worktrees, share the workstream worktree: one at a time.
      if (!created || (job.editing && !job.isolated)) {
        // A conflict crew shares the workstream worktree only with the other crews working in it.
        const shares = (j: WorkstreamJob) => !job.resolves || !j.isolated;
        if (job.editing && w.jobs.some((j) => j.id !== job.id && j.editing && (j.state === 'running' || j.state === 'starting') && shares(j))) continue;
        if (job.editing && (w.ship.state === 'running' || w.ship.state === 'queued')) continue;
        if (job.editing && !job.resolves && await (deps.editorBusy ?? deps.busy)?.(w)) continue;
      } else if (job.state === 'queued' || job.state === 'waiting-memory') {
        if (deps.memAvailable) {
          try {
            if (memoryIsLow(await deps.memAvailable())) {
              if (job.state !== 'waiting-memory') {
                job.state = 'waiting-memory';
                await bumpCard(w);
              }
              continue;
            }
          } catch (error) {
            deps.error?.(w, error);
            continue;
          }
        }
      }
      // A job that waits for a crew slot tries again as queued, so its card does not flip on every pass.
      const waiting = job.state === 'queued' && job.told === 'waiting';
      if (!waiting && (job.state === 'queued' || job.state === 'waiting-memory')) {
        job.state = 'starting';
        await bumpCard(w);
      }
      try {
        job.threadId = await deps.start(w, job);
        const told = job.told;
        job.state = 'running';
        delete job.error; delete job.told;
        await bumpCard(w);
        if (told) await notice(w, job, { kind: 'started', reason: job.threadId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof WorkstreamJobWaiting) {
          // In line, not a start in flight: it holds no editor, and the next pass tries again.
          const first = job.told !== 'waiting';
          Object.assign(job, { state: 'queued', error: reason, told: 'waiting' });
          save(w);
          if (first) await notice(w, job, { kind: 'waiting', reason });
          continue;
        }
        if (error instanceof WorkstreamJobRefused) {
          Object.assign(job, { state: 'failed', failedAt: deps.now(), error: reason, cleanup: 'done' });
          delete job.told;
          await bumpCard(w);
          await notice(w, job, { kind: 'failed', reason });
          continue;
        }
        // A start that may have made a worker stays in flight, so it keeps an adopted workstream's one editor.
        const flipped = job.state !== 'starting';
        const first = job.told !== 'unresolved';
        Object.assign(job, { state: 'starting', error: String(error), told: 'unresolved' });
        if (flipped) await bumpCard(w); else save(w);
        if (first) await notice(w, job, { kind: 'unresolved', reason });
        if (!created) throw error;
      }
    }
  }
  async function notice(w: Workstream, job: WorkstreamJob, told: JobNotice) {
    try { await deps.jobNotice?.(w, job, told); } catch (error) { deps.error?.(w, error); }
  }
  // A created workstream's Ship takes the folded work present when it starts; a retry of the same
  // request keeps that snapshot, and later folds wait for the next Ship.
  function beginShip(w: Workstream, requestId: string) {
    const snapshot = isAdoptedWorkstream(w) ? undefined
      : w.ship.requestId === requestId && w.ship.snapshot ? w.ship.snapshot : shipSnapshotOf({ jobs: w.jobs });
    w.ship = { state: 'running', requestId, ...(snapshot ? { snapshot } : {}) };
    save(w);
  }
  function completeShip(w: Workstream) {
    for (const id of w.ship.snapshot?.jobs ?? []) {
      const job = w.jobs.find((j) => j.id === id);
      if (job) job.shipped = w.ship.requestId ?? '';
    }
    w.ship.state = 'complete';
    delete w.ship.error;
  }
  async function stop(w: Workstream) {
    if (w.devLink.state === 'stopped') return;
    await deps.stopDev(w);
    w.devLink.state = 'stopped'; save(w);
  }
  async function endRecord(w: Workstream) {
      if (w.state === 'ended') return w;
      if (await deps.busy?.(w)) throw new Error('Workstream still has active crews.');
      if (w.ship.state === 'running' || w.ship.state === 'queued') throw new Error('Ship is still running.');
      if (w.jobs.some((j) => !jobClosed(j) && !keptUnsaved(j))) throw new Error('Workstream still has crews, queued tasks or task cleanup.');
      if (w.jobs.some(keptUnsaved)) throw new Error(`Unsaved work: ${w.jobs.filter(keptUnsaved).map((j) => j.note ?? j.id).join(', ')}`);
      if (w.taskIds.some((id) => !['live', 'dropped'].includes(deps.taskState(id) ?? 'unknown'))) throw new Error('Every task must be Live or Dropped before End.');
      for (const repo of w.repos) {
        if (repo.existing) continue;
        const findings = await deps.unsaved(repo);
        if (findings.length) throw new Error(`Unsaved work: ${findings.join(', ')}`);
        const kept = await deps.keepWorktree?.(w, repo);
        if (kept) throw new Error(`Workstream worktree kept: ${kept}`);
      }
      w.cleanupApproved = true; save(w);
      await stop(w);
      for (const repo of w.repos) {
        if (repo.existing) continue;
        await deps.remove(repo, w);
      }
      // Private chat cannot close or reopen a topic (conversation-topics rule 7).
      w.state = 'ended'; w.closeTopicRequested = false; w.updatedAt = deps.now(); return save(w);
  }
  const service = {
    get,
    listAll: all,
    list: (threadId: string, includeEnded = false) => all().filter((w) => w.threadId === threadId && (includeEnded || w.state === 'open')),
    create: (input: { threadId: string; projectId: string; name: string; requestId: string; topic?: z.infer<typeof topicSchema> }) => serial(async () => {
      let w = all().find((w) => (input.topic && w.topic?.chatId === input.topic.chatId && w.topic.topicId === input.topic.topicId)
        || (w.threadId === input.threadId && w.requestId === input.requestId));
      if (w && (w.threadId !== input.threadId || w.projectId !== input.projectId)) throw new Error('Topic or request belongs to another captain or project.');
      if (!w) {
        const ports = new Set(all().map((w) => w.devLink.port));
        let port = 5200; while (ports.has(port)) port++;
        // A create without a topic records none: an undefined field fails the RPC result's JSON check.
        const { topic, ...named } = input;
        w = save({ ...named, ...(topic ? { topic } : {}), id: `ws-${randomUUID().slice(0, 12)}`, state: 'open', supportsDevLink: await deps.supportsDevLink?.(input.projectId) ?? true, provisioned: false, repos: [], taskIds: [], jobs: [],
          devLink: { state: 'stopped', port, realLogin: false }, closeTopicRequested: false, ship: { state: 'idle' }, createdAt: deps.now(), updatedAt: deps.now() });
      }
      if (!w.provisioned) { w.repos = await deps.provision(w); w.provisioned = true; save(w); }
      return w;
    }),
    /**
     * Adopt with fold: group open tasks into a new workstream with its own branch and worktree. Each idle
     * crew's saved work folds at once; a running crew folds when it finishes. A retry of the same requestId
     * continues the same workstream.
     */
    adoptFold: (input: {
      threadId: string; projectId: string; name: string; requestId: string; taskIds: string[];
      repositories: string[]; sources: Array<AdoptSource & { title?: string }>; replaces?: Array<{ url: string; repository: string }>;
      bases?: Record<string, string>;
    }) => serial(async () => {
      const taskIds = [...new Set(input.taskIds)];
      if (taskIds.length === 0) throw new Error('Adopt needs taskIds.');
      let w = all().find((row) => row.threadId === input.threadId && row.requestId === input.requestId);
      if (w && w.projectId !== input.projectId) throw new Error('Topic or request belongs to another captain or project.');
      if (w) {
        const original = [...(w.adoption?.taskIds ?? w.requestTaskIds ?? w.taskIds)].sort();
        if (!w.adoption || w.name !== input.name || JSON.stringify(original) !== JSON.stringify([...taskIds].sort())) {
          throw new Error('Adopt retry changed its original name, project or task list.');
        }
      }
      for (const taskId of taskIds) {
        const holder = all().find((other) => other.taskIds.includes(taskId) && other.id !== w?.id);
        if (holder) throw new Error(`Task ${taskId} already belongs to a workstream.`);
      }
      if (!w) {
        const ports = new Set(all().map((row) => row.devLink.port));
        let port = 5200; while (ports.has(port)) port++;
        w = save({
          threadId: input.threadId, projectId: input.projectId, name: input.name, requestId: input.requestId,
          id: `ws-${randomUUID().slice(0, 12)}`, state: 'open',
          supportsDevLink: await deps.supportsDevLink?.(input.projectId) ?? true,
          provisioned: false, repos: [], taskIds: [], jobs: [],
          adoption: { taskIds, repositories: [...new Set(input.repositories)], ...(input.bases ? { bases: input.bases } : {}) },
          ...(input.replaces?.length ? { replaces: input.replaces.map((pr) => ({ ...pr, state: 'open' as const })) } : {}),
          devLink: { state: 'stopped', port, realLogin: false }, closeTopicRequested: false, ship: { state: 'idle' },
          createdAt: deps.now(), updatedAt: deps.now(),
        });
      }
      if (!w.provisioned) { w.repos = await deps.provision(w); w.provisioned = true; save(w); }
      for (const source of input.sources) {
        if (!w.jobs.some((j) => j.id === source.crewId)) w.jobs.push(adoptedJob(source, w.projectId));
      }
      for (const taskId of taskIds) if (!w.taskIds.includes(taskId)) w.taskIds.push(taskId);
      w.updatedAt = deps.now();
      save(w);
      await bumpCard(w);
      await drain(w);
      return w;
    }),
    /**
     * Bind the workstream's Telegram topic. A recorded topic is kept, except when the caller names it as gone
     * (`goneTopicId`): then the new topic replaces it and the old id is cleared.
     */
    bindTopic: (id: string, threadId: string, topic: z.infer<typeof topicSchema>, goneTopicId?: number) => serial(async () => {
      const w = open(id, threadId);
      const used = all().find((other) => other.id !== id && other.topic?.chatId === topic.chatId && other.topic.topicId === topic.topicId);
      if (used) throw new WorkstreamRefusal('topic_in_use', 'Topic already belongs to a workstream.');
      if (w.topic && JSON.stringify(w.topic) !== JSON.stringify(topic) && (goneTopicId === undefined || w.topic.topicId !== goneTopicId)) {
        throw new WorkstreamRefusal('workstream_has_topic', 'Workstream already has a topic.');
      }
      w.topic = topic; w.updatedAt = deps.now(); return save(w);
    }),
    attachTask: (id: string, threadId: string, taskId: string) => serial(async () => {
      const w = open(id, threadId);
      if (w.leftTaskIds?.includes(taskId)) w.leftTaskIds = w.leftTaskIds.filter((left) => left !== taskId);
      if (!w.taskIds.includes(taskId)) { w.taskIds.push(taskId); w.updatedAt = deps.now(); save(w); }
    }),
    /**
     * A task attached to the wrong workstream leaves it. Its jobs that never folded are dropped and the
     * workstream never cleans their worktrees; folded work and every other task's jobs stay as they are.
     */
    removeTask: (id: string, threadId: string, taskId: string) => serial(async () => {
      const w = open(id, threadId);
      if (!w.taskIds.includes(taskId)) throw new Error(`Task ${taskId} is not in this workstream.`);
      const jobs = w.jobs.filter((j) => j.taskId === taskId);
      if (jobs.some((j) => j.state === 'folded' || j.state === 'folding' || j.fold)) throw new Error(`Task ${taskId} has folded work in this workstream; it stays. Drop the task instead if that work must go.`);
      const busy = jobs.find((j) => j.threadId !== null && (j.state === 'running' || j.state === 'starting'));
      if (busy) throw new Error(`Task ${taskId} cannot leave yet: crew ${busy.id} still works on it in this workstream. Wait for it to finish or fail.`);
      const unsaved = jobs.find(keptUnsaved);
      if (unsaved) throw new Error(`Task ${taskId} cannot leave yet: crew ${unsaved.id} holds unsaved work (${unsaved.note ?? 'kept'}).`);
      for (const job of jobs) {
        if (job.state === 'dropped') continue;
        Object.assign(job, { state: 'dropped', cleanup: 'done', note: `left the workstream: ${taskId} does not belong to it` });
        delete job.told;
      }
      w.taskIds = w.taskIds.filter((t) => t !== taskId);
      w.leftTaskIds = [...new Set([...(w.leftTaskIds ?? []), taskId])];
      await bumpCard(w);
      return w;
    }),
    /** The captain drops a job that has not started: no crew thread exists, so nothing else changes. */
    cancel: (id: string, threadId: string, jobId: string) => serial(async () => {
      const w = open(id, threadId);
      const job = w.jobs.find((j) => j.id === jobId);
      if (!job) throw new Error('No workstream crew with that id.');
      if (job.threadId !== null || !['queued', 'waiting-memory', 'starting'].includes(job.state)) {
        throw new Error(`Crew ${jobId} has started (${job.state}); it is no longer a waiting job.`);
      }
      Object.assign(job, { state: 'dropped', cleanup: 'done', note: 'cancelled by the captain before it started' });
      delete job.told;
      await bumpCard(w);
      return job;
    }),
    environment(id: string, threadId: string, path: string, environmentId: string) {
      const w = open(id, threadId);
      const repo = w.repos.find((r) => r.path === path);
      if (repo) { repo.environmentId = environmentId; save(w); return; }
      const job = w.jobs.find((j) => j.path === path || j.repos?.some((r) => r.path === path));
      if (!job) return;
      if (job.path === path) job.environmentId = environmentId;
      for (const checkout of job.repos ?? []) if (checkout.path === path) checkout.environmentId = environmentId;
      save(w);
    },
    noteJob: (id: string, threadId: string, jobId: string, patch: Partial<WorkstreamJob>) => {
      const w = open(id, threadId);
      const job = w.jobs.find((j) => j.id === jobId);
      if (!job) throw new Error('No workstream crew with that id.');
      const attached = patch.taskId !== undefined && patch.taskId !== job.taskId;
      Object.assign(job, patch);
      save(w);
      // The card lists only crews with an owner task, so show this one as soon as its task attaches.
      if (attached) void serial(async () => bumpCard(open(id, threadId))).catch((error) => deps.error?.(w, error));
      return job;
    },
    view: (id: string, threadId: string) => {
      const w = get(id, threadId);
      return currentJobs(w.jobs.filter((job) => !job.taskId || !w.leftTaskIds?.includes(job.taskId))).map((job) => compactTaskLine({
        id: job.taskId ?? job.id,
        title: job.title ?? briefOf(job).split('\n')[0] ?? job.id,
        model: job.model ?? 'default',
        state: jobToCardState(job.state, job.editing, job.cleanup),
      }) + jobStartNote(job)).join('\n');
    },
    lookup: (id: string, threadId: string, taskId: string) => {
      const w = get(id, threadId);
      const job = [...w.jobs].reverse().find((j) => j.taskId === taskId || j.id === taskId);
      if (!job) throw new Error('No task in this workstream.');
      return formatWorkstreamLookup({
        task: job.taskId ?? job.id,
        title: job.title ?? '',
        brief: briefOf(job),
        report: job.report ?? '',
        files: job.files ?? [],
      });
    },
    submit: (id: string, threadId: string, input: JobSubmit) => serial(async () => {
      const w = open(id, threadId);
      const known = w.jobs.find((j) => j.id === input.id);
      if (known && (known.payload !== input.payload || known.editing !== input.editing)) throw new Error('Workstream retry changed its original task.');
      if (!known) {
        const isolated = input.editing && !isAdoptedWorkstream(w);
        w.jobs.push({
          id: input.id, editing: input.editing, payload: input.payload, state: 'queued', threadId: null,
          ...(isolated ? { isolated: true } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.followUpOf ? { followUpOf: input.followUpOf } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
          ...(input.path ? { path: input.path } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.repos ? { repos: input.repos } : {}),
          ...(input.repository ? { repository: input.repository } : {}),
          ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        });
        // A retry that takes a failed crew's worktree owns it now: the old crew no longer expires on its own.
        if (isolated && input.environmentId) {
          for (const old of w.jobs) if (old.id !== input.id && old.state === 'failed' && old.environmentId === input.environmentId) old.supersededBy ??= input.id;
        }
        w.updatedAt = deps.now();
        save(w);
      }
      await drain(w);
      return w.jobs.find((j) => j.id === input.id)!;
    }),
    devLink: (id: string, threadId: string, realLogin = false) => serial(async () => {
      const w = open(id, threadId);
      if (!w.supportsDevLink) throw new Error('This project has no web app and does not support a dev link.');
      if (w.devLink.state === 'running' && deps.devRunning && !(await deps.devRunning(w))) { w.devLink.state = 'stopped'; save(w); }
      w.devLink.lastRequestedAt = deps.now();
      if (w.devLink.state === 'running' && w.devLink.realLogin !== realLogin) await stop(w);
      w.devLink.realLogin = realLogin;
      if (w.devLink.state !== 'running') {
        const running = all().filter((other) => other.id !== id && other.devLink.state !== 'stopped');
        for (const other of running) {
          const at = await deps.devActivity?.(other) ?? 0;
          if (at > (other.devLink.lastRequestedAt ?? 0)) { other.devLink.lastRequestedAt = at; save(other); }
        }
        running.sort((a, b) => (a.devLink.lastRequestedAt ?? 0) - (b.devLink.lastRequestedAt ?? 0));
        while (running.length >= 3) await stop(running.shift()!);
        w.devLink.state = 'starting'; save(w);
        w.devLink.url = await deps.startDev(w); w.devLink.state = 'running';
      }
      save(w);
      return { workstream: w, url: w.devLink.url! };
    }),
    ship: (id: string, threadId: string, requestId: string) => serial(async () => {
      const w = open(id, threadId);
      if (w.ship.requestId === requestId && w.ship.state === 'complete') return w;
      if ((w.ship.state === 'running' || w.ship.state === 'queued') && w.ship.requestId !== requestId) return w;
      await drain(w);
      if (isAdoptedWorkstream(w)) {
        if (w.jobs.some((j) => j.editing && (j.state === 'starting' || j.state === 'running' || (j.state === 'queued' && !['running', 'blocked', 'queued'].includes(w.ship.state))))) throw new Error('Ship waits until every editing task finishes.');
        if (await (deps.editorBusy ?? deps.busy)?.(w)) {
          const told = w.ship.state === 'queued' && w.ship.requestId === requestId;
          w.ship = { state: 'queued', requestId, error: 'Ship waits until every editing task finishes.' };
          save(w);
          if (!told) await deps.waiting?.(w);
          return w;
        }
      } else if (w.jobs.some((j) => j.state === 'folding') || sharedEditorActive(w)) {
        const told = w.ship.state === 'queued' && w.ship.requestId === requestId;
        w.ship = { state: 'queued', requestId, error: sharedEditorActive(w) ? 'Ship waits until the crew working in the workstream worktree finishes.' : 'Ship waits until the current fold finishes.' };
        save(w);
        if (!told) await deps.waiting?.(w);
        return w;
      }
      beginShip(w, requestId);
      try { await deps.ship(w); completeShip(w); }
      catch (error) { w.ship = { ...w.ship, state: error instanceof WorkstreamWaiting ? 'running' : 'blocked', error: String(error) }; save(w); if (error instanceof WorkstreamWaiting) return w; throw error; }
      w.updatedAt = deps.now(); return save(w);
    }),
    end: (id: string, threadId: string) => serial(async () => endRecord(get(id, threadId))),
    reconcile: () => serial(async () => {
      for (const w of all().filter((w) => w.state === 'open' && w.provisioned)) {
        try {
        if (w.devLink.state !== 'stopped' && deps.devActivity) {
          const at = await deps.devActivity(w);
          if (at > (w.devLink.lastRequestedAt ?? 0)) { w.devLink.lastRequestedAt = at; save(w); }
        }
        if (w.devLink.state !== 'stopped' && deps.now() - (w.devLink.lastRequestedAt ?? 0) >= DEV_IDLE_MS) await stop(w);
        await drain(w);
        if (w.ship.state === 'queued') {
          if (isAdoptedWorkstream(w)) {
            if (await (deps.editorBusy ?? deps.busy)?.(w)) continue;
          } else if (w.jobs.some((j) => j.state === 'folding') || sharedEditorActive(w)) continue;
          beginShip(w, w.ship.requestId ?? '');
        }
        if (w.ship.state === 'running') {
          try { await deps.ship(w); completeShip(w); }
          catch (error) { w.ship.state = error instanceof WorkstreamWaiting ? 'running' : 'blocked'; w.ship.error = String(error); }
          save(w);
        }
        if (deps.now() - (w.lastStallAt ?? 0) >= 24 * 60 * 60_000 && await deps.stall?.(w)) { w.lastStallAt = deps.now(); save(w); }
        if (w.taskIds.length > 0 && w.taskIds.every((id) => ['live','dropped'].includes(deps.taskState(id) ?? '')) && w.jobs.every((j) => jobClosed(j)) && w.ship.state !== 'running' && w.ship.state !== 'queued') {
          try { await endRecord(w); } catch (error) { deps.error?.(w,error); }
        }
        } catch (error) { deps.error?.(w,error); }
      }
    }),
  };
  return service;
}
