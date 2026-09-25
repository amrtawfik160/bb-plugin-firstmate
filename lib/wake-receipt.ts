import { z } from "zod";

const receiptSchema = z.object({
  id: z.string().nullable(),
  phase: z.string(),
  report: z.string(),
  path: z.string(),
  replayed: z.boolean(),
  truncated: z.boolean(),
});
export type WakeReceipt = z.infer<typeof receiptSchema>;

export function parseWakeReceipt(output: string): WakeReceipt {
  const frames = output.split(/\r?\n/).filter((line) => line.startsWith("FM_BB_RECEIPT="));
  if (frames.length !== 1) throw new Error("Wake receipt frame missing or ambiguous; no acknowledgement confirmed.");
  return receiptSchema.parse(JSON.parse(frames[0]!.slice("FM_BB_RECEIPT=".length)));
}

export function renderWakeReceipt(receipt: WakeReceipt): string {
  const lines = [receipt.report.trim() || "No unread reports."];
  if (receipt.truncated) lines.push(`REPORT TRUNCATED: read the full report at ${receipt.path} before completing this receipt.`);
  if (receipt.id) {
    lines.push(`WAKE_RECEIPT: ${receipt.id}${receipt.replayed ? " (replayed)" : ""}`);
    lines.push(receipt.phase === "acting"
      ? "Action outcome is uncertain. Reconcile external state before acting again; do not blindly repeat the action. After reconciliation, complete with firstmate_wake handledWake."
      : receipt.phase === "ready"
      ? "Handle the whole batch, then pass handledWake on your final successful Firstmate action. If no action remains, call firstmate_wake with handledWake."
      : "Handling was recorded. Retry firstmate_wake with handledWake only; do not repeat the successful action.");
  }
  return lines.join("\n");
}
