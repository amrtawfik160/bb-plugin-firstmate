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
    input: z.null(),
    output: z.object({
      head: z.string(),
      calls: z.array(z.string()),
      landed: z.array(z.string()),
      ready: z.array(crewRow),
      running: z.array(crewRow),
      next: z.array(z.string()),
      afk: z.boolean(),
      quiet: z.boolean(),
      supervision: z.boolean(),
    }),
  },
});
