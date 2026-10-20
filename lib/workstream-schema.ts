import { z } from 'zod';

export const topicSchema = z.object({ chatId: z.string().min(1), topicId: z.number().int().positive() });
// Why bindTopic refused, stable for the Telegram connector: the workstream already has another topic, or
// another workstream holds this topic. The refusal's message text stays as before.
export const bindRefusalSchema = z.object({ reason: z.enum(['workstream_has_topic', 'topic_in_use']), message: z.string() });
export type BindRefusalReason = z.infer<typeof bindRefusalSchema>['reason'];
export const workstreamRepoSchema = z.object({
  repository: z.string(), projectId: z.string(), hostId: z.string(), path: z.string(), sourcePath: z.string(),
  branch: z.string(), environmentId: z.string().nullable(),
  existing: z.boolean().optional(),
  taskId: z.string().optional(),
  crewId: z.string().optional(),
  // The repository's PR base (its default branch), read once at create or adopt; absent on older records means main.
  base: z.string().optional(),
});
export const jobCheckoutSchema = z.object({
  repository: z.string(), path: z.string(), branch: z.string(), environmentId: z.string().nullable().optional(),
  hostId: z.string().optional(),
});
// One repository of a fold, saved before any Git change so a restart can finish or undo it.
export const foldStepSchema = z.object({
  repository: z.string(), hostId: z.string(), workstreamPath: z.string(), checkoutPath: z.string(),
  before: z.string(), target: z.string(), after: z.string().optional(),
  state: z.enum(['pending', 'merged', 'rolled-back']),
});
export const foldSchema = z.object({
  state: z.enum(['merging', 'committed', 'rolling-back']),
  steps: z.array(foldStepSchema),
  files: z.array(z.string()).optional(),
  // Why the undo is retried: the crew is told about a conflict only after it lands.
  reason: z.enum(['conflict', 'wait', 'restart']).optional(),
});
export const jobSchema = z.object({
  id: z.string(), editing: z.boolean(), payload: z.string(),
  state: z.enum(['queued', 'waiting-memory', 'starting', 'running', 'finished', 'folding', 'folded', 'failed', 'kept-unsaved', 'dropped']),
  threadId: z.string().nullable(), error: z.string().optional(),
  taskId: z.string().optional(),
  followUpOf: z.string().optional(),
  failedAt: z.number().optional(),
  environmentId: z.string().nullable().optional(),
  path: z.string().optional(),
  branch: z.string().optional(),
  repos: z.array(jobCheckoutSchema).optional(),
  note: z.string().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
  report: z.string().optional(),
  files: z.array(z.string()).optional(),
  // A created-workstream editor in its own worktree. Fold and cleanup rules apply only to these;
  // records saved before this field existed keep their old behaviour.
  isolated: z.boolean().optional(),
  // The one repository this task changes (owner/repo).
  repository: z.string().optional(),
  // A retry after its old worktree was removed starts a new worktree from this retained branch.
  baseBranch: z.string().optional(),
  // A retry took over this failed crew's worktree, so this job no longer expires on its own.
  supersededBy: z.string().optional(),
  fold: foldSchema.optional(),
  foldedAt: z.number().optional(),
  // Cleanup after fold, drop or failed expiry, separate from the task's result.
  cleanup: z.enum(['pending', 'kept-unsaved', 'done']).optional(),
  // The Ship request that took this folded work.
  shipped: z.string().optional(),
  // An adopted crew's saved work (adopt with fold): it folds when the crew is idle, a conflict goes to a
  // new crew, and its old worktree is retired by the task-worktree cleanup, never by the workstream.
  adopted: z.boolean().optional(),
  // Fold this pushed branch instead of a checkout: the crew's worktree is gone or holds another repository.
  sourceBranch: z.string().optional(),
  // The repository the task was recorded under before the owner card moved it.
  repointedFrom: z.string().optional(),
  // The fold that conflicted, kept for the conflict crew and its check.
  conflict: foldStepSchema.optional(),
  // The conflict crew merging this job's work, and on that crew, the job it merges.
  resolver: z.string().optional(),
  resolves: z.string().optional(),
  // The captain was told this job waits for a crew slot, or that its start is unresolved; he hears once
  // more when it starts or fails.
  told: z.enum(['waiting', 'unresolved']).optional(),
});
export const workstreamSchema = z.object({
  id: z.string(), name: z.string(), projectId: z.string(), threadId: z.string(), requestId: z.string(),
  state: z.enum(['open', 'ended']), supportsDevLink: z.boolean(), provisioned: z.boolean(), topic: topicSchema.optional(),
  repos: z.array(workstreamRepoSchema), taskIds: z.array(z.string()), requestTaskIds: z.array(z.string()).optional(), jobs: z.array(jobSchema),
  devLink: z.object({ state: z.enum(['stopped', 'starting', 'running']), port: z.number().int(), url: z.string().optional(), lastRequestedAt: z.number().optional(), realLogin: z.boolean().default(false) }),
  closeTopicRequested: z.boolean(),
  ship: z.object({
    state: z.enum(['idle', 'queued', 'running', 'blocked', 'complete']), requestId: z.string().optional(), error: z.string().optional(),
    // The folded work this Ship request takes, saved when it starts: later folds go out with the next Ship.
    snapshot: z.object({ jobs: z.array(z.string()), taskIds: z.array(z.string()), heads: z.record(z.string(), z.string()) }).optional(),
  }),
  // Adopt with fold: the original task list (a retry must match it) and the repositories provisioned, with
  // each repository's default branch as the owner's card named it (absent on records from before).
  adoption: z.object({ taskIds: z.array(z.string()), repositories: z.array(z.string()), bases: z.record(z.string(), z.string()).optional() }).optional(),
  // Tasks that left the workstream (a conflict that could not be merged safely); they keep their own work.
  leftTaskIds: z.array(z.string()).optional(),
  // PRs this workstream replaces: each closes with a link once the workstream PR holds all its commits.
  replaces: z.array(z.object({ url: z.string(), repository: z.string(), state: z.enum(['open', 'closed', 'skipped']), note: z.string().optional() })).optional(),
  lastStallAt: z.number().optional(),
  cleanupApproved: z.boolean().optional(),
  cardRevision: z.number().int().nonnegative().optional(),
  createdAt: z.number(), updatedAt: z.number(),
});
export type Workstream = z.infer<typeof workstreamSchema>;
export type WorkstreamRepo = z.infer<typeof workstreamRepoSchema>;
export type WorkstreamJob = z.infer<typeof jobSchema>;
export type FoldStep = z.infer<typeof foldStepSchema>;
export type ShipSnapshot = NonNullable<Workstream['ship']['snapshot']>;
