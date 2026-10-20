// Archive one crew thread and undo the archive inside BB's undo grace when it should not stand.
// BB's archive has no idle check, takes the thread's whole tree, and keeps a running turn alive for a
// 30-second grace before its teardown stops it. So the deadline starts before the archive request,
// time for the undo is reserved, every read-back is bounded by what is left, and the undo starts at
// once when a read already shows work.

export const ARCHIVE_UNDO_GRACE_MS = 30_000;
/** Time kept back from the grace for the unarchive calls themselves. */
export const UNARCHIVE_RESERVE_MS = 10_000;

export type ArchiveUndoOps = {
  now: () => number;
  /** Runs one call; rejects when it outlives `ms`. */
  within: <T>(call: () => Promise<T>, ms: number) => Promise<T>;
  /** Archives the thread; returns every thread BB archived with it. */
  archive: (threadId: string) => Promise<string[]>;
  /** The thread runs a turn or background work. */
  threadBusy: (threadId: string) => Promise<boolean>;
  /** A live thread in the environment runs a turn or background work. */
  environmentBusy: (environmentId: string) => Promise<boolean>;
  unarchive: (threadId: string) => Promise<void>;
};

export type ArchiveUndoResult =
  | { undone: false; taken: string[] }
  | { undone: true; taken: string[]; reason: string; failed: string[] };

export async function archiveWithUndo(ops: ArchiveUndoOps, threadId: string, environmentIds: readonly string[]): Promise<ArchiveUndoResult> {
  const deadline = ops.now() + ARCHIVE_UNDO_GRACE_MS - UNARCHIVE_RESERVE_MS;
  const left = () => deadline - ops.now();
  const undo = async (taken: string[], reason: string): Promise<ArchiveUndoResult> => {
    const failed: string[] = [];
    // The crew thread first: BB refuses to unarchive a lifecycle dependent before its owner.
    for (const id of [threadId, ...taken.filter((id) => id !== threadId)]) {
      try { await ops.within(() => ops.unarchive(id), UNARCHIVE_RESERVE_MS); }
      catch (error) { failed.push(`${id} (${message(error)})`); }
    }
    return { undone: true, taken, reason, failed };
  };
  let taken: string[];
  try { taken = await ops.within(() => ops.archive(threadId), Math.max(0, left())); }
  // The request may still have reached BB; nothing verified it, so undo it.
  catch (error) { return undo([threadId], `archive failed (${message(error)})`); }
  if (!taken.includes(threadId)) taken = [threadId, ...taken];
  const others = taken.filter((id) => id !== threadId);
  if (others.length > 0) return undo(taken, `BB also archived ${others.join(", ")}`);
  try {
    if (await ops.within(() => ops.threadBusy(threadId), budget(left()))) return undo(taken, "work started while archiving");
    for (const environmentId of environmentIds) {
      if (await ops.within(() => ops.environmentBusy(environmentId), budget(left()))) return undo(taken, "work started while archiving");
    }
  } catch (error) {
    return undo(taken, `not verified after archiving (${message(error)})`);
  }
  return { undone: false, taken };
}

function budget(ms: number): number {
  if (ms <= 0) throw new Error("no time left inside the undo grace");
  return ms;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
