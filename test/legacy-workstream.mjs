// The record an adopt made before adopt with fold (20 Oct): it grouped open tasks without a workstream branch,
// recording each task's existing worktree as an `existing` repository. Records like this still run their old
// one-editor, Ship, dev link and End behaviour, so tests of that behaviour start from one.
import { workstreamSchema } from '../lib/workstream-schema.ts';

export function seedLegacyWorkstream(db, input) {
  db.exec('CREATE TABLE IF NOT EXISTS firstmate_workstream (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
  const rows = db.prepare('SELECT record FROM firstmate_workstream').all().map((row) => JSON.parse(row.record));
  const threadId = input.threadId ?? 'cap';
  const existing = rows.find((w) => w.threadId === threadId && w.requestId === input.requestId);
  if (existing) return workstreamSchema.parse(existing);
  let port = 5200; while (rows.some((w) => w.devLink.port === port)) port++;
  const record = workstreamSchema.parse({
    id: `ws-legacy${rows.length + 1}`, name: input.name, projectId: input.projectId, threadId, requestId: input.requestId,
    state: 'open', supportsDevLink: input.supportsDevLink ?? true, provisioned: true, repos: input.repos ?? [],
    requestTaskIds: input.taskIds, taskIds: input.taskIds, jobs: [],
    devLink: { state: 'stopped', port, realLogin: false }, closeTopicRequested: false, ship: { state: 'idle' },
    createdAt: input.now ?? Date.now(), updatedAt: input.now ?? Date.now(),
  });
  db.prepare('INSERT INTO firstmate_workstream (id,record) VALUES (?,?)').run(record.id, JSON.stringify(record));
  return record;
}
