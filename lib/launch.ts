import type { BbPluginApi } from '@get-bb/plugin-sdk';

export type LaunchState = 'reserved' | 'creating' | 'provisioning' | 'running' | 'failed' | 'uncertain' | 'deleted';
export interface LaunchRecord {
  key: string; taskId: string; projectId: string; owner: string; home: string;
  generation: number; shape: string; state: LaunchState; threadId: string | null;
  nativeInvoked?: boolean; deliveryMode?: string; deliveryRequirement?: 'pr' | 'merged' | 'merged-and-verified';
  hostId?: string; path?: string; error?: string; updatedAt: number;
  execution?: { providerId: string | null; model: string | null; reasoningLevel: string | null };
}
type Database = ReturnType<BbPluginApi['storage']['database']>;
export const launchTaskKey=(project:string,task:string)=>JSON.stringify([project,task]);
export const launchKey = (project: string, owner: string, home: string, task: string, generation = 1) => JSON.stringify([project, owner, home, task, generation]);

/** A durable reservation outlives the RPC which starts creation. Absence from a
 * bounded inventory is never proof that a timed-out create did not succeed. */
export function createLaunches(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS launches (key TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS launches_owner ON launches(owner, state);
    CREATE INDEX IF NOT EXISTS launches_thread ON launches(json_extract(record,'$.threadId'));
    CREATE TABLE IF NOT EXISTS launch_deleted_workers (thread TEXT PRIMARY KEY)`);
  let tail: Promise<unknown> = Promise.resolve();
  const inFlight = new Map<string, Promise<unknown>>();
  function get(key: string): LaunchRecord | undefined {
    const row = db.prepare('SELECT record FROM launches WHERE key=?').get(key) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : undefined;
  }
  function save(record: LaunchRecord) {
    db.prepare('INSERT INTO launches VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,record=excluded.record,owner=excluded.owner,project=excluded.project')
      .run(record.key, record.owner, record.projectId, record.state, JSON.stringify(record));
    return record;
  }
  function update(key: string, patch: Partial<LaunchRecord>) {
    const current = get(key);
    if (!current) throw new Error('Launch reservation missing');
    // Authoritative deletion is terminal for this attempt. A concurrent slow
    // provisioning read or late spawn response cannot restore its held slot.
    if (current.state === 'deleted') return current;
    if (patch.threadId && db.prepare('SELECT 1 FROM launch_deleted_workers WHERE thread=?').get(patch.threadId)) {
      patch={...patch,state:'deleted',error:'Worker was deleted by BB core; this attempt cannot be resumed'};
    }
    return save({ ...current, ...patch, key, updatedAt: Date.now() });
  }
  function workerDeleted(threadId:string) {
    return db.transaction(()=>{
      // Keep the exact identity if deletion arrives before the spawn response.
      // An unknown creation still holds capacity until that response reconciles.
      db.prepare('INSERT OR IGNORE INTO launch_deleted_workers VALUES (?)').run(threadId);
      return db.prepare(`UPDATE launches SET state='deleted',record=json_set(record,'$.state','deleted','$.error','Worker was deleted by BB core; this attempt cannot be resumed','$.updatedAt',?) WHERE json_extract(record,'$.threadId')=? AND state!='deleted'`)
        .run(Date.now(),threadId).changes;
    })();
  }
  function isDeletedWorker(threadId:string):boolean {
    return !!db.prepare('SELECT 1 FROM launch_deleted_workers WHERE thread=?').get(threadId);
  }
  function list(owner?: string, limit = 100, offset = 0): LaunchRecord[] {
    const rows = owner === undefined
      ? db.prepare('SELECT record FROM launches ORDER BY key LIMIT ? OFFSET ?').all(Math.max(1,Math.min(limit, 100)), Math.max(0,offset))
      : db.prepare('SELECT record FROM launches WHERE owner=? ORDER BY key LIMIT ? OFFSET ?').all(owner, Math.max(1,Math.min(limit, 100)), Math.max(0,offset));
    return (rows as { record: string }[]).map(r => JSON.parse(r.record));
  }
  function heldTaskIds(owner:string) {
    const rows=db.prepare("SELECT record FROM launches WHERE owner=? AND state IN ('reserved','creating','provisioning','uncertain')").all(owner) as {record:string}[];
    return rows.map(row=>{const r=JSON.parse(row.record) as LaunchRecord;return launchTaskKey(r.projectId,r.taskId);});
  }
  function forTask(project:string,owner:string,task:string):LaunchRecord|undefined {
    const row=db.prepare("SELECT record FROM launches WHERE project=? AND owner=? AND json_extract(record,'$.taskId')=? ORDER BY json_extract(record,'$.generation') DESC LIMIT 1").get(project,owner,task) as {record:string}|undefined;
    return row ? JSON.parse(row.record) : undefined;
  }
  function reassignWorker(threadId:string,from:string,to:string,projectId:string) {
    return db.prepare(`UPDATE launches SET owner=?,record=json_set(record,'$.owner',?) WHERE owner=? AND project=? AND json_extract(record,'$.threadId')=?`)
      .run(to,to,from,projectId,threadId).changes;
  }
  async function reserve(record: LaunchRecord, capacity: () => Promise<{ cap: number; activeTaskIds: string[] }>, overCap = false) {
    const run = tail.then(async () => {
      const prior = get(record.key);
      if (prior && prior.state !== 'failed') return prior;
      const { cap, activeTaskIds } = await capacity();
      return db.transaction(() => {
        const current=get(record.key);
        if (current && current.state !== "failed") return current;
        const active = new Set(activeTaskIds);
        for (const held of heldTaskIds(record.owner)) active.add(held);
        if (!overCap && cap > 0 && !active.has(launchTaskKey(record.projectId,record.taskId)) && active.size >= cap) throw new Error(`Crew cap reached: ${active.size} crews running or reserved (cap ${cap}). Queue this task until capacity is available.`);
        return save(record);
      })();
    });
    tail = run.catch(() => {});
    return run;
  }
  function once<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = inFlight.get(key);
    if (prior) return prior as Promise<T>;
    const work = action().finally(() => inFlight.delete(key));
    inFlight.set(key, work);
    return work;
  }
  async function create(key: string, spawn: () => Promise<{ id: string }>, signal?: AbortSignal, timeoutMs=30_000) {
    return once(key, async () => {
      const record = get(key);
      if (!record) throw new Error('Launch reservation missing');
      if (record.state === 'deleted') throw new Error(`Worker for launch ${record.taskId} was deleted by BB core. This attempt cannot be resumed.`);
      if (record.threadId) return record;
      if (record.state === 'creating' || record.state === 'uncertain') throw new Error(`Launch ${record.taskId} has an uncertain creation outcome. Reconcile it before a new attempt.`);
      signal?.throwIfAborted();
      // Claim the external call transactionally, including overlapping instances.
      db.transaction(() => {
        const current=get(key)!;
        if (current.state !== 'reserved') throw new Error(`Launch ${current.taskId} requires reconciliation before creation.`);
        update(key, { state: 'creating' });
      })();
      try {
        const pending = spawn().then(thread => {
          // Capture a late returned identity while the database handle is valid.
          // If disposal invalidates the handle, seeded metadata remains recovery proof.
          try {
            const latest=get(key);
            if (latest?.threadId && latest.threadId !== thread.id) update(key,{state:'uncertain',error:'Multiple returned worker identities require manual reconciliation'});
            else if (!latest?.threadId) update(key, { state: 'provisioning', threadId: thread.id });
          } catch { /* reconcile after restart */ }
          return thread;
        });
        let removeAbort=() => {};
        const cancelled = new Promise<never>((_,reject) => {
          const abort=() => reject(Object.assign(new Error('Creation cancelled; external outcome is uncertain'),{name:'AbortError'}));
          const timeout=setTimeout(()=>reject(new Error('Creation response deadline exceeded; external outcome is uncertain')),timeoutMs);
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort',abort,{once:true});
          removeAbort=() => { signal?.removeEventListener('abort',abort);clearTimeout(timeout); };
        });
        let thread: { id:string };
        try { thread=await Promise.race([pending,cancelled]); }
        finally { removeAbort(); }
        // Late responses after cancellation are recoverable by seeded metadata.
        // Core has no cancel/hold API for creation, so never stop that worker.

        // Write the identity even when disposal/cancellation happened during spawn.
        const resolved=update(key, { state: 'provisioning', threadId: thread.id });
        if (resolved.state === 'deleted') throw new Error(`Worker for launch ${resolved.taskId} was deleted by BB core. This attempt cannot be resumed.`);
        return resolved;
      } catch (error) {
        update(key, { state: 'uncertain', error: String(error) });
        throw error;
      }
    });
  }
  return { get, save, update, list, heldTaskIds, forTask,reassignWorker,workerDeleted,isDeletedWorker,reserve, once, create };
}

async function recoveryRead<T>(operation:Promise<T>,signal?:AbortSignal):Promise<T> {
  signal?.throwIfAborted();
  let cancel=()=>{};
  const deadline=new Promise<never>((_,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Launch inventory response deadline exceeded')),5_000);
    const abort=()=>reject(signal?.reason ?? new Error('Launch recovery cancelled'));
    signal?.addEventListener('abort',abort,{once:true});
    cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
  });
  try { return await Promise.race([operation,deadline]); } finally {cancel();}
}
export async function discoverLaunch(bb: BbPluginApi, record: LaunchRecord, signal?: AbortSignal): Promise<string | null> {
  const matches: string[] = [];
  for (let offset = 0; offset < 500; offset += 50) {
    signal?.throwIfAborted();
    const rows = await recoveryRead(bb.sdk.threads.list({ projectId: record.projectId, parentThreadId: record.owner || undefined,
      includeHidden: true, limit: 50, offset,signal }),signal);
    for (const row of rows) {
      const meta = await recoveryRead(bb.sdk.threads.getPluginMetadata({ threadId: row.id,signal }),signal);
      if (meta.launchKey === record.key && meta.generation === record.generation && (meta.nativeHome === record.home || meta.nativeParentHome === record.home)) matches.push(row.id);
    }
    if (matches.length > 1) throw new Error(`Multiple workers match launch ${record.taskId}; manual reconciliation required.`);
    if (rows.length < 50) break;
  }
  return matches[0] ?? null;
}
