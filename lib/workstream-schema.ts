import { z } from 'zod';

export const topicSchema = z.object({ chatId: z.string().min(1), topicId: z.number().int().positive() });
export const workstreamRepoSchema = z.object({
  repository: z.string(), projectId: z.string(), hostId: z.string(), path: z.string(), sourcePath: z.string(),
  branch: z.string(), environmentId: z.string().nullable(),
});
export const jobSchema = z.object({
  id: z.string(), editing: z.boolean(), payload: z.string(),
  state: z.enum(['queued', 'starting', 'running', 'finished']), threadId: z.string().nullable(), error: z.string().optional(),
});
export const workstreamSchema = z.object({
  id: z.string(), name: z.string(), projectId: z.string(), threadId: z.string(), requestId: z.string(),
  state: z.enum(['open', 'ended']), supportsDevLink: z.boolean(), provisioned: z.boolean(), topic: topicSchema.optional(),
  repos: z.array(workstreamRepoSchema), taskIds: z.array(z.string()), jobs: z.array(jobSchema),
  devLink: z.object({ state: z.enum(['stopped', 'starting', 'running']), port: z.number().int(), url: z.string().optional(), lastRequestedAt: z.number().optional(), realLogin: z.boolean().default(false) }),
  closeTopicRequested: z.boolean(),
  ship: z.object({ state: z.enum(['idle', 'queued', 'running', 'blocked', 'complete']), requestId: z.string().optional(), error: z.string().optional() }),
  lastStallAt: z.number().optional(),
  cleanupApproved: z.boolean().optional(),
  createdAt: z.number(), updatedAt: z.number(),
});
export type Workstream = z.infer<typeof workstreamSchema>;
export type WorkstreamRepo = z.infer<typeof workstreamRepoSchema>;
export type WorkstreamJob = z.infer<typeof jobSchema>;
