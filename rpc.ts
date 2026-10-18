import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { workstreamSchema, topicSchema } from './lib/workstream-schema.ts';
export const workstreamListSchema = z.object({workstreams:z.array(workstreamSchema),trialProjectIds:z.array(z.string())});
export const workstreamResultSchema = z.object({workstream:workstreamSchema});
export const workstreamDevLinkSchema = workstreamResultSchema.extend({url:z.string()});
const workstreamOwner = z.object({threadId:z.string().min(1)});
const workstreamTarget = workstreamOwner.extend({workstreamId:z.string().min(1)});
const crewRow = z.object({
  id: z.string(),
  status: z.string(),
  shape: z.string(),
  posture: z.string(),
  task: z.string(),
  threadId: z.string(),
  prUrl: z.string(),
  worktree: z.boolean(),
});

export const rpcContract = defineRpcContract({
  "workstreams.list": {input:workstreamOwner.extend({includeEnded:z.boolean().optional()}),output:workstreamListSchema},
  "workstreams.create": {input:workstreamOwner.extend({projectId:z.string().min(1),name:z.string().min(1),requestId:z.string().min(1),topic:topicSchema.optional()}),output:workstreamResultSchema},
  "workstreams.bindTopic": {input:workstreamTarget.extend({chatId:z.string().min(1),topicId:z.number().int().positive()}),output:workstreamResultSchema},
  "workstreams.ship": {input:workstreamTarget.extend({requestId:z.string().min(1)}),output:workstreamResultSchema},
  "workstreams.devLink": {input:workstreamTarget.extend({realLogin:z.boolean().optional()}),output:workstreamDevLinkSchema},
  "workstreams.end": {input:workstreamTarget,output:workstreamResultSchema},
  listAsks: {
    experimental_description: "Read open asks and asks answered in the last 24 hours for one captain. Does not create or resolve asks.",
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ asks: z.array(z.object({
      id: z.string(), text: z.string(),
      options: z.array(z.object({ label: z.string(), value: z.string() })),
      state: z.enum(["open", "answered"]), resolvedAt: z.number().nullable(),
    })) }),
  },
  linkAsk: {
    input: z.object({ threadId: z.string().min(1), id: z.string().min(1).max(64), messageUrl: z.string().url() }),
    output: z.object({ ok: z.boolean() }),
  },
  resolveAsk: {
    input: z.object({ threadId: z.string().min(1), id: z.string().min(1).max(64), resolution: z.string().min(1).max(2000) }),
    output: z.object({ ok: z.boolean() }),
  },
  closeAsk: {
    experimental_description: "The owner closes these cards with no answer and no action. All or nothing: foreign, missing or resolved cards refuse the request, except a previous owner close returns already. Closed cards never proceed on their deadline or return to Needs you. The task stays as it is. The captain is told once; a failed notice is retried later.",
    input: z.object({ threadId: z.string().min(1), ids: z.array(z.string().min(1).max(64)).min(1).max(20) }),
    output: z.object({ ok: z.boolean(), closed: z.array(z.string()), already: z.array(z.string()), refused: z.array(z.string()) }),
  },
  deferAsk: {
    experimental_description: "The owner skipped these open cards on the Board (decide later) until `until` (ms). All or nothing: if any card is not this captain's open card, nothing is skipped, ok is false and `refused` names those cards. Each card stays open and comes back to the owner on its own at that time; a skipped card never proceeds on its deadline. `already`: cards still skipped from before, which keep their time; `until` is the time in effect. The captain is told once, and a notice whose send failed is sent again later.",
    input: z.object({ threadId: z.string().min(1), ids: z.array(z.string().min(1).max(64)).min(1).max(20), until: z.number().int().positive() }),
    output: z.object({ ok: z.boolean(), deferred: z.array(z.string()), already: z.array(z.string()), refused: z.array(z.string()), until: z.number().nullable() }),
  },
  telegramCommand: {
    experimental_description: "Answer a Telegram owner command (/inbox, /workers, the board, the digest, or the tasks) for one captain thread as plain text. tasks returns, in `tasks`, every open owner task and each one that changed since `since` (default now), with the BB project id of its crews (projectId: the connector's topic for the task comes from it), its starting and running crews, what it waits on and the owner's Telegram refs, for the connector's task status lines and /tasks. The board has four sections: Needs you, Finished since you last looked (live or dropped only), Not live yet (merged work production does not run yet), In progress. board and digest also return notLive: each merged task that is not live yet, with its age since it merged (ms), its next step, who takes it, and why its project's live check is missing (null when the check reads production), for the connector's Not live yet section. since (ms) is when the owner last looked: board defaults to 24 h ago, digest to 12 h ago. The digest text is empty when there is nothing to report. For board, away is the captain's /afk posture, projects counts the crews working on each project, for the pinned board of each Telegram project topic, and promises (absent when there is none) lists each dated promise to the owner still open (due: the captain was woken), also shown in the board text under Promised.",
    input: z.object({
      command: z.enum(["inbox", "workers", "board", "digest", "tasks"]),
      threadId: z.string().min(1),
      since: z.number().int().nonnegative().optional(),
    }),
    output: z.object({
      workstreams: z.array(workstreamSchema).optional(),
      text: z.string(), away: z.boolean().optional(), projects: z.array(z.object({ name: z.string(), working: z.number().int().nonnegative() })).optional(),
      notLive: z.array(z.object({
        id: z.string(), project: z.string().nullable(), title: z.string(), state: z.literal("merged"),
        ageMs: z.number().nonnegative(), next: z.string(), who: z.string(), missing: z.string().nullable(),
      })).optional(),
      tasks: z.array(z.object({
        id: z.string(), project: z.string().nullable(), title: z.string(),
        state: z.enum(["working", "needs_you", "ready", "check", "merged", "live", "done", "dropped"]),
        crews: z.number().int().nonnegative(), waitsOn: z.string().nullable(), refs: z.array(z.string()),
        workstreamId: z.string().optional(),
        projectId: z.string().nullable(),
        createdAt: z.number(), updatedAt: z.number(),
      })).optional(),
      promises: z.array(z.object({
        id: z.string(), by: z.number(), what: z.string(), task: z.string().nullable(), ref: z.string().nullable(), state: z.enum(["open", "due"]),
      })).optional(),
    }),
  },
  fleet: {
    // null is the pre-0.4.0 app contract. Keep it during live reloads because
    // already-open BB tabs can run the previous bundle until they refresh.
    input: z.union([
      z.null(),
      z.object({
        threadId: z.string().nullable().optional(),
      }),
    ]),
    output: z.object({
      deliveries:z.array(z.object({ id:z.string(),url:z.string(),owner:z.string().nullable(),status:z.string(),blocker:z.string(),nextAction:z.string(),freshness:z.string(),ownerNeeded:z.boolean(),deliverySatisfiedAt:z.number().nullable().optional(),workers:z.array(z.string()).default([]),failures:z.array(z.object({id:z.string(),name:z.string(),url:z.string(),headSha:z.string(),resolvedAt:z.number().nullable(),accounting:z.object({scope:z.enum(["author","baseline"]),taskId:z.string(),worker:z.string(),evidence:z.string(),actor:z.string(),at:z.number()}).optional()})).default([]) })).default([]),
      head: z.string(),
      calls: z.array(z.string()),
      landed: z.array(z.string()),
      ready: z.array(crewRow),
      running: z.array(crewRow),
      next: z.array(z.string()),
      afk: z.boolean(),
      quiet: z.boolean(),
      supervision: z.boolean(),
      captain: z.boolean(),
    }),
  },
});
