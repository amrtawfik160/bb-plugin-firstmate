import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { workstreamSchema, type Workstream, type WorkstreamRepo, type WorkstreamJob, type topicSchema } from './workstream-schema.ts';

export class WorkstreamWaiting extends Error {}

export const DEV_IDLE_MS = 2 * 60 * 60_000;
export const UNSHIPPED_MS = 2 * 24 * 60 * 60_000;
export { workstreamSchema, topicSchema } from './workstream-schema.ts';
export type { Workstream, WorkstreamRepo, WorkstreamJob } from './workstream-schema.ts';
type Database = { exec(sql: string): unknown; prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };
export type WorkstreamDeps = {
  now: () => number;
  supportsDevLink?: (projectId: string) => Promise<boolean>;
  provision: (w: Workstream) => Promise<WorkstreamRepo[]>;
  start: (w: Workstream, job: WorkstreamJob) => Promise<string>;
  status: (threadId: string) => Promise<string>;
  startDev: (w: Workstream) => Promise<string>;
  devRunning?: (w: Workstream) => Promise<boolean>;
  devActivity?: (w: Workstream) => Promise<number>;
  stopDev: (w: Workstream) => Promise<void>;
  unsaved: (repo: WorkstreamRepo) => Promise<string[]>;
  remove: (repo: WorkstreamRepo) => Promise<void>;
  ship: (w: Workstream) => Promise<void>;
  taskState: (id: string) => string | undefined;
  busy?: (w: Workstream) => Promise<boolean>;
  editorBusy?: (w: Workstream) => Promise<boolean>;
  waiting?: (w: Workstream) => Promise<void>;
  stall?: (w: Workstream) => Promise<boolean>;
  error?: (w: Workstream, error: unknown) => void;
};

export function createWorkstreams(db: Database, deps: WorkstreamDeps) {
  db.exec('CREATE TABLE IF NOT EXISTS firstmate_workstream (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
  let pending: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  };
  const all = () => db.prepare('SELECT record FROM firstmate_workstream ORDER BY rowid').all().map((row) => {
    const { record } = z.object({ record: z.string() }).parse(row);
    return workstreamSchema.parse(JSON.parse(record));
  });
  const save = (w: Workstream) => {
    const previous = all().find((r) => r.id === w.id);
    if (previous) {
      w.taskIds = [...new Set([...previous.taskIds, ...w.taskIds])];
      for (const repo of w.repos) repo.environmentId ??= previous.repos.find((r) => r.path === repo.path)?.environmentId ?? null;
    }
    db.prepare('INSERT OR REPLACE INTO firstmate_workstream (id,record) VALUES (?,?)').run(w.id, JSON.stringify(w)); return w; };
  const get = (id: string, threadId: string): Workstream => {
    const w = all().find((w) => w.id === id);
    if (!w || w.threadId !== threadId) throw new Error('No workstream for this captain.');
    return w;
  };
  const open = (id: string, threadId: string) => {
    const w = get(id, threadId);
    if (w.state !== 'open') throw new Error('Workstream has ended.');
    if (!w.provisioned) throw new Error('Workstream provisioning is incomplete; retry creation with its requestId.');
    return w;
  };
  async function drain(w: Workstream) {
    for (const job of w.jobs.filter((j) => j.state === 'running')) {
      const status = job.threadId ? await deps.status(job.threadId) : 'unknown';
      if (status === 'idle' || status === 'archived' || status === 'error' || status === 'failed') { job.state = 'finished'; save(w); }
    }
    for (const job of w.jobs) {
      if (job.state !== 'queued' && job.state !== 'starting') continue;
      if (job.editing && w.jobs.some((j) => j.id !== job.id && j.editing && (j.state === 'running' || j.state === 'starting'))) continue;
      if (job.editing && (w.ship.state === 'running' || w.ship.state === 'queued')) continue;
      if (job.editing && await (deps.editorBusy ?? deps.busy)?.(w)) continue;
      job.state = 'starting'; save(w);
      try {
        job.threadId = await deps.start(w, job);
        job.state = 'running'; delete job.error; save(w);
      } catch (error) {
        job.error = String(error); save(w);
        // A failed spawn may already have created a thread. Keep its editing reservation and retry its identity.
        throw error;
      }
    }
  }
  async function stop(w: Workstream) {
    if (w.devLink.state === 'stopped') return;
    await deps.stopDev(w);
    w.devLink.state = 'stopped'; save(w);
  }
  async function endRecord(w: Workstream) {
      if (w.state === 'ended') return w;
      if (await deps.busy?.(w)) throw new Error('Workstream still has active crews.');
      if (w.ship.state === 'running' || w.ship.state === 'queued') throw new Error('Ship is still running.');
      if (w.jobs.some((j) => j.state !== 'finished')) throw new Error('Workstream still has crews or queued tasks.');
      if (w.taskIds.some((id) => !['live', 'dropped'].includes(deps.taskState(id) ?? 'unknown'))) throw new Error('Every task must be Live or Dropped before End.');
      for (const repo of w.repos) {
        if (repo.existing) continue;
        const findings = await deps.unsaved(repo);
        if (findings.length) throw new Error(`Unsaved work: ${findings.join(', ')}`);
      }
      w.cleanupApproved = true; save(w);
      await stop(w);
      for (const repo of w.repos) {
        if (repo.existing) continue;
        await deps.remove(repo);
      }
      // Private chat cannot close or reopen a topic (conversation-topics rule 7).
      w.state = 'ended'; w.closeTopicRequested = false; w.updatedAt = deps.now(); return save(w);
  }
  const service = {
    get,
    listAll: all,
    list: (threadId: string, includeEnded = false) => all().filter((w) => w.threadId === threadId && (includeEnded || w.state === 'open')),
    create: (input: { threadId: string; projectId: string; name: string; requestId: string; topic?: z.infer<typeof topicSchema> }) => serial(async () => {
      let w = all().find((w) => (input.topic && w.topic?.chatId === input.topic.chatId && w.topic.topicId === input.topic.topicId)
        || (w.threadId === input.threadId && w.requestId === input.requestId));
      if (w && (w.threadId !== input.threadId || w.projectId !== input.projectId)) throw new Error('Topic or request belongs to another captain or project.');
      if (!w) {
        const ports = new Set(all().map((w) => w.devLink.port));
        let port = 5200; while (ports.has(port)) port++;
        w = save({ ...input, id: `ws-${randomUUID().slice(0, 12)}`, state: 'open', supportsDevLink: await deps.supportsDevLink?.(input.projectId) ?? true, provisioned: false, repos: [], taskIds: [], jobs: [],
          devLink: { state: 'stopped', port, realLogin: false }, closeTopicRequested: false, ship: { state: 'idle' }, createdAt: deps.now(), updatedAt: deps.now() });
      }
      if (!w.provisioned) { w.repos = await deps.provision(w); w.provisioned = true; save(w); }
      return w;
    }),
    adopt: (input: { threadId: string; projectId: string; name: string; requestId: string; taskIds: string[]; repos?: WorkstreamRepo[] }) => serial(async () => {
      const taskIds = [...new Set(input.taskIds)];
      if (taskIds.length === 0) throw new Error('Adopt needs taskIds.');
      let w = all().find((row) => row.threadId === input.threadId && row.requestId === input.requestId);
      if (w && (w.threadId !== input.threadId || w.projectId !== input.projectId)) throw new Error('Topic or request belongs to another captain or project.');
      if (w) {
        const original = [...(w.requestTaskIds ?? w.taskIds)].sort();
        const requested = [...taskIds].sort();
        if (w.name !== input.name || JSON.stringify(original) !== JSON.stringify(requested)) {
          throw new Error('Adopt retry changed its original name, project or task list.');
        }
      }
      for (const taskId of taskIds) {
        const holder = all().find((other) => other.taskIds.includes(taskId) && other.id !== w?.id);
        if (holder) throw new Error(`Task ${taskId} already belongs to a workstream.`);
      }
      if (!w) {
        const ports = new Set(all().map((row) => row.devLink.port));
        let port = 5200; while (ports.has(port)) port++;
        w = save({
          threadId: input.threadId, projectId: input.projectId, name: input.name, requestId: input.requestId,
          id: `ws-${randomUUID().slice(0, 12)}`, state: 'open',
          supportsDevLink: await deps.supportsDevLink?.(input.projectId) ?? true,
          provisioned: true, repos: input.repos ?? [], requestTaskIds: taskIds, taskIds: [], jobs: [],
          devLink: { state: 'stopped', port, realLogin: false }, closeTopicRequested: false, ship: { state: 'idle' },
          createdAt: deps.now(), updatedAt: deps.now(),
        });
      } else if (w.repos.length === 0 && input.repos?.length) {
        w.repos = input.repos;
      }
      for (const taskId of taskIds) {
        if (!w.taskIds.includes(taskId)) w.taskIds.push(taskId);
      }
      w.updatedAt = deps.now();
      return save(w);
    }),
    bindTopic: (id: string, threadId: string, topic: z.infer<typeof topicSchema>) => serial(async () => {
      const w = open(id, threadId);
      const used = all().find((other) => other.id !== id && other.topic?.chatId === topic.chatId && other.topic.topicId === topic.topicId);
      if (used) throw new Error('Topic already belongs to a workstream.');
      if (w.topic && JSON.stringify(w.topic) !== JSON.stringify(topic)) throw new Error('Workstream already has a topic.');
      w.topic = topic; return save(w);
    }),
    attachTask: (id: string, threadId: string, taskId: string) => serial(async () => {
      const w = open(id, threadId);
      if (!w.taskIds.includes(taskId)) { w.taskIds.push(taskId); w.updatedAt = deps.now(); save(w); }
    }),
    environment(id: string, threadId: string, path: string, environmentId: string) {
      const w = open(id, threadId);
      const repo = w.repos.find((r) => r.path === path);
      if (!repo) throw new Error('Environment does not belong to workstream.');
      repo.environmentId = environmentId; save(w);
    },
    submit: (id: string, threadId: string, input: Pick<WorkstreamJob, 'id' | 'editing' | 'payload'>) => serial(async () => {
      const w = open(id, threadId);
      const known = w.jobs.find((j) => j.id === input.id);
      if (known && (known.payload !== input.payload || known.editing !== input.editing)) throw new Error('Workstream retry changed its original task.');
      if (!known) { w.jobs.push({ ...input, state: 'queued', threadId: null }); w.updatedAt = deps.now(); save(w); }
      await drain(w);
      return w.jobs.find((j) => j.id === input.id)!;
    }),
    devLink: (id: string, threadId: string, realLogin = false) => serial(async () => {
      const w = open(id, threadId);
      if (!w.supportsDevLink) throw new Error('This project has no web app and does not support a dev link.');
      if (w.devLink.state === 'running' && deps.devRunning && !(await deps.devRunning(w))) { w.devLink.state = 'stopped'; save(w); }
      w.devLink.lastRequestedAt = deps.now();
      if (w.devLink.state === 'running' && w.devLink.realLogin !== realLogin) await stop(w);
      w.devLink.realLogin = realLogin;
      if (w.devLink.state !== 'running') {
        const running = all().filter((other) => other.id !== id && other.devLink.state !== 'stopped');
        for (const other of running) {
          const at = await deps.devActivity?.(other) ?? 0;
          if (at > (other.devLink.lastRequestedAt ?? 0)) { other.devLink.lastRequestedAt = at; save(other); }
        }
        running.sort((a, b) => (a.devLink.lastRequestedAt ?? 0) - (b.devLink.lastRequestedAt ?? 0));
        while (running.length >= 3) await stop(running.shift()!);
        w.devLink.state = 'starting'; save(w);
        w.devLink.url = await deps.startDev(w); w.devLink.state = 'running';
      }
      save(w);
      return { workstream: w, url: w.devLink.url! };
    }),
    ship: (id: string, threadId: string, requestId: string) => serial(async () => {
      const w = open(id, threadId);
      if (w.ship.requestId === requestId && w.ship.state === 'complete') return w;
      if ((w.ship.state === 'running' || w.ship.state === 'queued') && w.ship.requestId !== requestId) return w;
      await drain(w);
      if (w.jobs.some((j) => j.editing && (j.state === 'starting' || j.state === 'running' || (j.state === 'queued' && !['running', 'blocked', 'queued'].includes(w.ship.state))))) throw new Error('Ship waits until every editing task finishes.');
      if (await (deps.editorBusy ?? deps.busy)?.(w)) {
        const told = w.ship.state === 'queued' && w.ship.requestId === requestId;
        w.ship = { state: 'queued', requestId, error: 'Ship waits until every editing task finishes.' };
        save(w);
        if (!told) await deps.waiting?.(w);
        return w;
      }
      w.ship = { state: 'running', requestId }; save(w);
      try { await deps.ship(w); w.ship = { state: 'complete', requestId }; }
      catch (error) { w.ship = { state: error instanceof WorkstreamWaiting ? 'running' : 'blocked', requestId, error: String(error) }; save(w); if (error instanceof WorkstreamWaiting) return w; throw error; }
      w.updatedAt = deps.now(); return save(w);
    }),
    end: (id: string, threadId: string) => serial(async () => endRecord(get(id, threadId))),
    reconcile: () => serial(async () => {
      for (const w of all().filter((w) => w.state === 'open' && w.provisioned)) {
        try {
        if (w.devLink.state !== 'stopped' && deps.devActivity) {
          const at = await deps.devActivity(w);
          if (at > (w.devLink.lastRequestedAt ?? 0)) { w.devLink.lastRequestedAt = at; save(w); }
        }
        if (w.devLink.state !== 'stopped' && deps.now() - (w.devLink.lastRequestedAt ?? 0) >= DEV_IDLE_MS) await stop(w);
        await drain(w);
        if (w.ship.state === 'queued') {
          if (await (deps.editorBusy ?? deps.busy)?.(w)) continue;
          w.ship = { state: 'running', requestId: w.ship.requestId }; save(w);
        }
        if (w.ship.state === 'running') {
          try { await deps.ship(w); w.ship.state = 'complete'; delete w.ship.error; }
          catch (error) { w.ship.state = error instanceof WorkstreamWaiting ? 'running' : 'blocked'; w.ship.error = String(error); }
          save(w);
        }
        if (deps.now() - (w.lastStallAt ?? 0) >= 24 * 60 * 60_000 && await deps.stall?.(w)) { w.lastStallAt = deps.now(); save(w); }
        if (w.taskIds.length > 0 && w.taskIds.every((id) => ['live','dropped'].includes(deps.taskState(id) ?? '')) && w.jobs.every((j) => j.state === 'finished') && w.ship.state !== 'running' && w.ship.state !== 'queued') {
          try { await endRecord(w); } catch (error) { deps.error?.(w,error); }
        }
        } catch (error) { deps.error?.(w,error); }
      }
    }),
  };
  return service;
}
