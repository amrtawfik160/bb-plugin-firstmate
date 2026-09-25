import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Only provider work advances the native pane hash. Polls, metadata writes,
// queued messages, token-accounting events, and watchdog ticks are not progress.
export const BB_ACTIVITY_TYPES = [
  "item/started", "item/completed", "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/plan/delta",
  "item/toolCall/progress", "item/mcpToolCall/progress",
  "item/commandExecution/outputDelta", "item/fileChange/outputDelta",
  "item/backgroundTask/progress", "item/backgroundTask/completed",
  "item/delegation/progress", "item/delegation/completed", "turn/diff/updated",
] as const;

export async function readBbActivity(sdk: BbPluginApi["sdk"], threadId: string, signal?: AbortSignal) {
  const [thread, events, result, interactions] = await Promise.all([
    sdk.threads.get({ threadId, signal }),
    sdk.threads.events.list({ threadId, signal, order: "desc", limit: "1", types: BB_ACTIVITY_TYPES }),
    sdk.threads.output({ threadId, signal }),
    sdk.threads.interactions.list({ threadId, signal }),
  ]);
  if (!Array.isArray(events) || !Array.isArray(interactions)) throw new Error("Invalid BB activity response");
  const event = events[0];
  if (event && (!BB_ACTIVITY_TYPES.some(type => type === event.type)
    || !Number.isSafeInteger(event.seq) || event.seq < 1
    || !Number.isFinite(event.createdAt) || event.createdAt < 0)) {
    throw new Error("Invalid BB activity event");
  }
  return {
    version: 1,
    threadId,
    status: thread.status,
    runtimeStatus: thread.runtime.displayStatus,
    queuedMessageCount: thread.queuedMessageCount,
    interactionCount: interactions.filter(row => row.status === "pending" || row.status === "resolving").length,
    activity: event ? { seq: event.seq, type: event.type, createdAt: event.createdAt } : null,
    output: (result.output ?? "").slice(-8000),
  };
}
