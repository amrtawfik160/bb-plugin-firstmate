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
