import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { PLAYBOOK_CHOICES } from './crew-contract.ts';
import { CREW_ROLES } from '../owner/crew-roles.ts';

export const queueItemSchema = z.object({
  nativeHome:z.string().optional(), id:z.string().min(1), title:z.string(), detail:z.string().default(''),
  projectId:z.string().min(1), shape:z.enum(['ship','scout']).default('ship'), mode:z.string().default(''),
  blockedBy:z.array(z.string()).default([]), providerId:z.string().optional(), model:z.string().optional(),
  reasoningLevel:z.string().optional(), deliveryRequirement:z.enum(['pr','merged','merged-and-verified']).optional(),
  waitUntil:z.string().nullable().default(null), status:z.enum(['queued','dispatched','done','dropped']).default('queued'),
  crewId:z.string().nullable().default(null), parentThreadId:z.string().nullish(), backlogId:z.string().optional(),
  sourceRefs:z.array(z.string()).optional(), overCap:z.boolean().optional(),
  playbook:z.enum(PLAYBOOK_CHOICES).optional(), role:z.enum(CREW_ROLES).optional(),
  // Set only on an over-cap dispatch that named them; absent means the default at start.
  permissionMode:z.enum(['accept-edits','auto','full']).optional(), worktree:z.boolean().optional(), visible:z.boolean().optional(),
  ownerRequestedProvider:z.boolean().optional(),
  backlogUnparsed:z.boolean().optional(), createdAt:z.string(), nativePending:z.boolean().optional(),
}).strict();
export type QueueItem = z.infer<typeof queueItemSchema>;
type Database = ReturnType<BbPluginApi['storage']['database']>;
/** Start order when a slot opens: jobs that carry an owner message first, the oldest first in each group. */
export function startOrder<T extends Pick<QueueItem,'createdAt'|'sourceRefs'>>(rows:T[]):T[] {
  const owner=(row:T)=>(row.sourceRefs?.length??0)>0?0:1;
  const age=(row:T)=>{const at=Date.parse(row.createdAt);return Number.isFinite(at)?at:Number.MAX_SAFE_INTEGER;};
  // list() returns the newest row first, so equal times fall back to the reverse of that.
  return rows.map((row,i)=>({row,i})).sort((a,b)=>owner(a.row)-owner(b.row)||age(a.row)-age(b.row)||b.i-a.i).map(({row})=>row);
}
export const queueKey=(row:Pick<QueueItem,'id'|'parentThreadId'|'projectId'>)=>JSON.stringify([row.parentThreadId||null,row.projectId,row.id]);

/** Only queue records move out of KV. The original KV value and an immutable
 * SQLite copy remain evidence, never a read-through source after migration. */
export function createQueueStore(db:Database, legacy:()=>Promise<unknown>) {
  db.exec(`CREATE TABLE IF NOT EXISTS queue_records (key TEXT PRIMARY KEY, owner TEXT, project TEXT NOT NULL, ordinal INTEGER NOT NULL UNIQUE, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS queue_owner ON queue_records(owner,ordinal);
    CREATE TABLE IF NOT EXISTS queue_start_refusals (key TEXT PRIMARY KEY, reason TEXT NOT NULL, noticed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS queue_wait_notices (key TEXT PRIMARY KEY, noticed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS queue_migration (id INTEGER PRIMARY KEY CHECK(id=1), original TEXT NOT NULL, sha256 TEXT NOT NULL, count INTEGER NOT NULL);`);
  const migrated=()=>!!db.prepare('SELECT 1 FROM queue_migration WHERE id=1').get();
  let pending:Promise<void>|undefined;
  async function ready() {
    if (migrated()) return;
    if (pending) return pending;
    pending=(async()=>{
      const raw=await legacy();
      const input=raw===undefined?[]:raw;
      if (!Array.isArray(input)) throw new Error('Queue migration refused: legacy queue is not an array; original KV retained.');
      const records:QueueItem[]=[];const keys=new Set<string>();
      for (let i=0;i<input.length;i++) {
        const parsed=queueItemSchema.safeParse(input[i]);
        if (!parsed.success) throw new Error(`Queue migration refused: invalid legacy row ${i}: ${parsed.error.message}. Original KV retained.`);
        const key=queueKey(parsed.data);
        if (keys.has(key)) throw new Error(`Queue migration refused: duplicate scoped identity ${key}. Original KV retained.`);
        keys.add(key);records.push(parsed.data);
      }
      const original=JSON.stringify(input),hash=createHash('sha256').update(original).digest('hex');
      db.transaction(()=>{
        if (migrated()) return; // another plugin instance committed while KV was read
        if (db.prepare('SELECT 1 FROM queue_records LIMIT 1').get()) throw new Error('Queue migration refused: rows exist without a completed migration.');
        records.forEach((row,i)=>insert(row,i));
        db.prepare('INSERT INTO queue_migration VALUES (1,?,?,?)').run(original,hash,records.length);
      })();
    })().finally(()=>{pending=undefined;});
    return pending;
  }
  function insert(row:QueueItem,ordinal:number) {
    db.prepare('INSERT INTO queue_records VALUES (?,?,?,?,?)').run(queueKey(row),row.parentThreadId||null,row.projectId,ordinal,JSON.stringify(queueItemSchema.parse(row)));
  }
  function get(row:Pick<QueueItem,'id'|'parentThreadId'|'projectId'>):QueueItem|undefined {
    const found=db.prepare('SELECT record FROM queue_records WHERE key=?').get(queueKey(row)) as {record:string}|undefined;
    return found?queueItemSchema.parse(JSON.parse(found.record)):undefined;
  }
  function list(owner?:string|null):QueueItem[] {
    // Page the SQL read without placing an inventory cutoff on dependency/history semantics.
    const out:QueueItem[]=[];let cursor=Number.MIN_SAFE_INTEGER;
    for (;;) {
      const rows=(owner===undefined
        ?db.prepare('SELECT ordinal,record FROM queue_records WHERE ordinal>? ORDER BY ordinal LIMIT 100').all(cursor)
        :db.prepare('SELECT ordinal,record FROM queue_records WHERE owner IS ? AND ordinal>? ORDER BY ordinal LIMIT 100').all(owner,cursor)) as {ordinal:number;record:string}[];
      for (const row of rows) out.push(queueItemSchema.parse(JSON.parse(row.record)));
      if (rows.length<100) return out;
      cursor=rows.at(-1)!.ordinal;
    }
  }
  function add(row:QueueItem) {
    return db.transaction(()=>{
      const first=db.prepare('SELECT min(ordinal) AS ordinal FROM queue_records').get() as {ordinal:number|null};
      insert(row,(first.ordinal??0)-1);return row;
    })();
  }
  function patch(row:QueueItem,changes:Partial<QueueItem>) {
    return db.transaction(()=>{
      const current=get(row);if (!current) throw new Error(`Queue record ${row.id} no longer exists.`);
      const next=queueItemSchema.parse({...current,...changes});
      if (queueKey(next)!==queueKey(current)) throw new Error('Queue identity changes require explicit handoff.');
      // A worker event can finish while dispatch publication is pending.
      if (['done','dropped'].includes(current.status) && changes.status==='dispatched') next.status=current.status;
      db.prepare('UPDATE queue_records SET record=? WHERE key=?').run(JSON.stringify(next),queueKey(row));return next;
    })();
  }
  function transform(select:(row:QueueItem)=>boolean,change:(row:QueueItem)=>QueueItem|null) {
    return db.transaction(()=>{
      let count=0;
      for (const row of list()) {
        if (!select(row)) continue;
        const next=change(row);
        if (next===null) db.prepare('DELETE FROM queue_records WHERE key=?').run(queueKey(row));
        else {
          queueItemSchema.parse(next);
          db.prepare('UPDATE queue_records SET key=?,owner=?,project=?,record=? WHERE key=?')
            .run(queueKey(next),next.parentThreadId||null,next.projectId,JSON.stringify(next),queueKey(row));
        }
        count++;
      }
      return count;
    })();
  }
  // Why the last automatic start of an over-cap dispatch was refused. Kept beside the
  // record, not in it: the record schema is strict, so an older plugin could not read it.
  type Identity=Pick<QueueItem,'id'|'parentThreadId'|'projectId'>;
  function startRefusal(row:Identity):{reason:string;noticed:boolean}|undefined {
    const found=db.prepare('SELECT reason,noticed FROM queue_start_refusals WHERE key=?').get(queueKey(row)) as {reason:string;noticed:number}|undefined;
    return found?{reason:found.reason,noticed:found.noticed===1}:undefined;
  }
  function refuseStart(row:Identity,reason:string) {
    db.prepare('INSERT INTO queue_start_refusals (key,reason) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET reason=excluded.reason').run(queueKey(row),reason);
  }
  function noticeStartRefusal(row:Identity) { db.prepare('UPDATE queue_start_refusals SET noticed=1 WHERE key=?').run(queueKey(row)); }
  function clearStartRefusal(row:Identity) { db.prepare('DELETE FROM queue_start_refusals WHERE key=?').run(queueKey(row)); }
  // The captain is told once that an owner job is still waiting for a slot.
  function waitNoticed(row:Identity):boolean { return !!db.prepare('SELECT 1 FROM queue_wait_notices WHERE key=?').get(queueKey(row)); }
  function noticeWait(row:Identity,at:number) { db.prepare('INSERT OR IGNORE INTO queue_wait_notices VALUES (?,?)').run(queueKey(row),at); }
  return {ready,get,list,add,patch,transform,startRefusal,refuseStart,noticeStartRefusal,clearStartRefusal,waitNoticed,noticeWait};
}
