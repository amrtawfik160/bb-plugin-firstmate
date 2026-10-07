import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

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
  listAsks: {
    experimental_description: "Read open asks and asks answered in the last 24 hours for one captain. Does not create or resolve asks.",
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ asks: z.array(z.object({
      id: z.string(), text: z.string(),
      options: z.array(z.object({ label: z.string(), value: z.string() })),
      state: z.enum(["open", "answered"]), resolvedAt: z.number().nullable(),
    })) }),
  },
  autoAsk: {
    input: z.object({
      threadId: z.string().min(1),
      text: z.string().min(1).max(16000),
      options: z.array(z.object({ label: z.string().min(1).max(1000), value: z.string().min(1).max(1000) })).max(26),
      sourceRef: z.string().min(1).max(512),
      messageUrl: z.string().url().optional(),
    }),
    output: z.object({ id: z.string(), created: z.boolean(), state: z.enum(["open", "answered", "defaulted", "cancelled"]) }),
  },
  linkAsk: {
    input: z.object({ threadId: z.string().min(1), id: z.string().min(1).max(64), messageUrl: z.string().url() }),
    output: z.object({ ok: z.boolean() }),
  },
  resolveAsk: {
    input: z.object({ threadId: z.string().min(1), id: z.string().min(1).max(64), resolution: z.string().min(1).max(2000) }),
    output: z.object({ ok: z.boolean() }),
  },
  telegramCommand: {
    experimental_description: "Answer a Telegram owner command (/inbox, /workers, the board, or the digest) for one captain thread as plain text. The board has three sections: Needs you, Done since you last looked, In progress. since (ms) is when the owner last looked: board defaults to 24 h ago, digest to 12 h ago. The digest text is empty when there is nothing to report. For board, away is the captain's /afk posture.",
    input: z.object({
      command: z.enum(["inbox", "workers", "board", "digest"]),
      threadId: z.string().min(1),
      since: z.number().int().nonnegative().optional(),
    }),
    output: z.object({ text: z.string(), away: z.boolean().optional() }),
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
