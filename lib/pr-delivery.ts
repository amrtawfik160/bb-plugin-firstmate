import { createHash } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
type Database = ReturnType<BbPluginApi['storage']['database']>;
export type DeliveryRequirement = 'pr' | 'merged' | 'merged-and-verified';
export type DeliveryStatus = 'draft' | 'waiting-checks' | 'failing-checks' | 'waiting-review' | 'changes-requested' | 'waiting-approval' | 'ready-to-merge' | 'merged-needs-verification' | 'closed-needs-disposition' | 'complete' | 'explicitly-abandoned';
export interface DeliveryRecord {
  id: string; repository: string; number: number; url: string; headSha: string; mergeCommitSha:string|null;
  taskId: string; projectId: string; owner: string | null; home: string;
  workers: string[]; requirement: DeliveryRequirement; status: DeliveryStatus;
  blocker: string; nextAction: string; nextCheckAt: number; observedAt: number | null;
  freshness: 'fresh' | 'stale'; error: string | null; errors: number;
  ownerNeeded: boolean; verifiedCommitSha: string | null; disposition: { reason: string; actor: string; at: number } | null;
  notification: { desired: string | null; delivered: string | null; queued: string | null; retryAt: number; attempted?: string | null; attemptedAt?: number };
  actionDueAt: number;
  updatedAt: number;
}
export interface ForgeObservation {
  headSha: string; state: 'open' | 'closed' | 'merged'; draft: boolean;
  checks: 'pending' | 'passing' | 'failing' | 'unknown'; review: 'approved' | 'changes-requested' | 'required' | 'unknown';
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  reviewHeadSha:string|null; mergeCommitSha:string|null;
}
export function canonicalPr(url: string) {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url.trim());
  if (!m || Number(m[2]) < 1) throw new Error('Expected a canonical GitHub PR URL');
  const repository = m[1]!.toLowerCase(), number = Number(m[2]);
  return { id: `${repository}#${number}`, repository, number, url: `https://github.com/${repository}/pull/${number}` };
}
export function deliveryLine(r: DeliveryRecord) {
  return `${r.id} [${r.status}${r.freshness === 'stale' ? ', stale' : ''}${r.ownerNeeded ? ', owner needed' : ''}] owner=${r.owner ?? 'unassigned'} ${r.url}\n  ${r.blocker || 'No known blocker'}. Next: ${r.nextAction}`;
}
const terminal = (r: DeliveryRecord) => r.status === 'complete' || r.status === 'explicitly-abandoned';
function notificationKey(r: DeliveryRecord) {
  return createHash('sha256').update(JSON.stringify([r.headSha, r.status, r.owner, r.ownerNeeded, r.blocker])).digest('hex');
}
function actionable(r: DeliveryRecord) {
  return r.ownerNeeded || ['failing-checks','changes-requested','waiting-review','waiting-approval','ready-to-merge','merged-needs-verification','closed-needs-disposition'].includes(r.status);
}
export function createDeliveries(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, owner TEXT, project TEXT NOT NULL, status TEXT NOT NULL, due INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status,due);
    CREATE INDEX IF NOT EXISTS deliveries_owner ON deliveries(owner,project);
    CREATE INDEX IF NOT EXISTS deliveries_project_number ON deliveries(project,json_extract(record,'$.number'))`);
  function get(id: string): DeliveryRecord | undefined {
    const row = db.prepare('SELECT record FROM deliveries WHERE id=?').get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : undefined;
  }
  function save(r: DeliveryRecord) {
    db.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,project=excluded.project,status=excluded.status,due=excluded.due,record=excluded.record')
      .run(r.id,r.owner,r.projectId,r.status,r.nextCheckAt,JSON.stringify(r));
    return r;
  }
  function list(scope: { owner?: string; projectId?: string; due?: number; includeComplete?: boolean; includeLost?:boolean; limit?: number; offset?: number } = {}) {
    const filters: string[] = [], params: (string | number)[] = [];
    if (scope.owner !== undefined) { filters.push(scope.includeLost ? "(owner=? OR json_extract(record,'$.ownerNeeded')=1)" : 'owner=?'); params.push(scope.owner); }
    if (scope.projectId !== undefined) { filters.push('project=?'); params.push(scope.projectId); }
    if (scope.due !== undefined) { filters.push('due<=?'); params.push(scope.due); }
    if (!scope.includeComplete) filters.push("status NOT IN ('complete','explicitly-abandoned')");
    params.push(Math.max(1, Math.min(scope.limit ?? 50,100)), Math.max(0,scope.offset ?? 0));
    const rows = db.prepare(`SELECT record FROM deliveries ${filters.length ? 'WHERE '+filters.join(' AND ') : ''} ORDER BY due,id LIMIT ? OFFSET ?`).all(...params) as { record: string }[];
    return rows.map(r => JSON.parse(r.record) as DeliveryRecord);
  }
  function conflict(projectId:string,owner:string,ids:string[],numbers:number[]) {
    const matching:string[]=[];const params:(string|number)[]=[projectId,owner];
    if (ids.length) { matching.push(`id IN (${ids.map(()=>'?').join(',')})`);params.push(...ids); }
    if (numbers.length) { matching.push(`json_extract(record,'$.number') IN (${numbers.map(()=>'?').join(',')})`);params.push(...numbers); }
    if (!matching.length) return undefined;
    const row=db.prepare(`SELECT record FROM deliveries WHERE project=? AND owner IS NOT ? AND status NOT IN ('complete','explicitly-abandoned') AND (${matching.join(' OR ')}) LIMIT 1`).get(...params) as {record:string}|undefined;
    return row ? JSON.parse(row.record) as DeliveryRecord : undefined;
  }
  function hasOwned(owner:string,projectId:string,taskId?:string) {
    const filter=taskId === undefined ? '' : " AND json_extract(record,'$.taskId')=?";
    return !!db.prepare(`SELECT 1 FROM deliveries WHERE owner=? AND project=? AND status NOT IN ('complete','explicitly-abandoned')${filter} LIMIT 1`)
      .get(owner,projectId,...(taskId === undefined ? [] : [taskId]));
  }
  function register(input: { url: string; taskId: string; projectId: string; owner: string | null; home: string; worker: string; requirement?: DeliveryRequirement }) {
    const identity = canonicalPr(input.url);
    const prior = get(identity.id);
    if (prior) {
      if (prior.projectId !== input.projectId || prior.owner !== input.owner || prior.taskId !== input.taskId) throw new Error(`PR ${identity.id} already belongs to another task or manager. Explicit assignment is required.`);
      if (input.requirement && prior.requirement !== input.requirement) throw new Error("Delivery contract is already agreed; registration cannot silently replace it.");
      return save({ ...prior, workers: [...new Set([...prior.workers,input.worker])].slice(-100) });
    }
    return save({ ...identity, headSha:'', mergeCommitSha:null,taskId:input.taskId, projectId:input.projectId, owner:input.owner,
      home:input.home, workers:[input.worker], requirement:input.requirement ?? 'merged', status:'waiting-checks',
      blocker:'Forge observation pending', nextAction:'Observe PR checks and review', nextCheckAt:Date.now(), observedAt:null,
      freshness:'stale', error:null, errors:0, ownerNeeded:input.owner === null, verifiedCommitSha:null, disposition:null,
      notification:{ desired:null, delivered:null, queued:null, retryAt:0 }, actionDueAt:Date.now()+86_400_000, updatedAt:Date.now() });
  }
  function observe(id: string, o: ForgeObservation, mergeAuthorized: boolean, now = Date.now()) {
    const prior = get(id); if (!prior) throw new Error('Unknown deliverable');
    if (terminal(prior)) return prior;
    const changedHead = prior.headSha !== o.headSha;
    let r: DeliveryRecord = { ...prior, headSha:o.headSha, mergeCommitSha:o.mergeCommitSha,verifiedCommitSha:changedHead ? null : prior.verifiedCommitSha,
      observedAt:now, freshness:'fresh', error:null, errors:0, updatedAt:now, nextCheckAt:now+60_000 };
    if (o.state === 'merged') {
      r.status = r.requirement === 'merged-and-verified' && (r.verifiedCommitSha !== o.mergeCommitSha || r.mergeCommitSha === null) ? 'merged-needs-verification' : 'complete';
      r.blocker = r.status === 'complete' ? '' : r.mergeCommitSha ? 'Required verification has not been recorded' : 'Merged commit is not yet readable';
      r.nextAction = r.status === 'complete' ? 'Delivery contract satisfied' : r.mergeCommitSha ? `Run agreed verification on merged commit ${r.mergeCommitSha} and record its evidence` : 'Observe the merged commit before recording verification';
    } else if (o.state === 'closed') {
      r.status = 'closed-needs-disposition'; r.blocker = 'PR closed without merge'; r.nextAction = 'Reopen, replace, or explicitly abandon with a reason';
    } else if (o.draft) {
      r.status='draft'; r.blocker='PR is a draft'; r.nextAction='Finish work and mark ready';
    } else if (o.review === 'changes-requested') {
      r.status='changes-requested'; r.blocker='Reviewer requested changes'; r.nextAction='Reuse the author for fixes, then obtain independent review';
    } else if (o.checks === 'failing') {
      r.status='failing-checks'; r.blocker='A check failed'; r.nextAction='Reuse the author to investigate and fix the failing check';
    } else if (changedHead || o.checks !== 'passing' || o.mergeable !== 'mergeable') {
      r.status='waiting-checks'; r.blocker=changedHead ? 'New head invalidated prior readiness; confirm checks and review again' : 'Checks or mergeability are pending or unknown'; r.nextAction='Wait for current-head checks and mergeability';
    } else if (o.review !== 'approved' || o.reviewHeadSha !== o.headSha) {
      r.status='waiting-review'; r.blocker='Independent review is required or unknown'; r.nextAction='Obtain independent review for the current head';
    } else {
      r.status=mergeAuthorized ? 'ready-to-merge' : 'waiting-approval';
      r.blocker=mergeAuthorized ? '' : 'Merge approval is required'; r.nextAction=mergeAuthorized ? 'Use native guarded merge; preserve independent review' : 'Request merge approval through the existing decision mechanism';
    }
    if (r.requirement === 'pr' && o.state === 'open' && !o.draft) {
      r.status='complete'; r.blocker=''; r.nextAction='Agreed PR-only delivery satisfied';
    }
    if (r.status !== prior.status || changedHead) r.actionDueAt=now+86_400_000;
    r.notification={...prior.notification};
    if (actionable(r) || (r.status === 'complete' && prior.status !== 'complete')) r.notification.desired=notificationKey(r);
    if (!terminal(r)) {
      if (now >= r.actionDueAt) r.notification.desired=`overdue:${notificationKey(r)}:${r.actionDueAt}`;
      else if (!actionable(r)) r.notification.desired=null;
    }
    if (r.notification.desired !== prior.notification.desired) r.notification.attempted=null;
    return save(r);
  }
  function stale(id: string, error: string, now=Date.now()) {
    const prior=get(id); if (!prior) throw new Error('Unknown deliverable');
    return save({ ...prior, freshness:'stale', error:error.slice(0,1000), errors:prior.errors+1,
      nextCheckAt:now+Math.min(3_600_000,60_000*2**Math.min(prior.errors,6)), updatedAt:now });
  }
  function assign(id:string, from:string | null, to:string, projectId:string) {
    const r=get(id); if (!r || r.projectId !== projectId || r.owner !== from) throw new Error('Deliverable ownership/project mismatch');
    const next: DeliveryRecord={ ...r, owner:to, ownerNeeded:false, updatedAt:Date.now(), nextCheckAt:Date.now(), notification:{ ...r.notification, queued:null, desired:null, delivered:null,attempted:null } };
    next.notification.desired=notificationKey(next); return save(next);
  }
  function ownerLost(owner:string) {
    const now=Date.now();
    db.prepare(`UPDATE deliveries SET due=?,record=json_set(record,'$.ownerNeeded',json('true'),'$.nextAction','Explicitly assign a new manager','$.nextCheckAt',?,'$.notification.desired','owner-needed:'||id||':'||owner)
      WHERE owner=? AND status NOT IN ('complete','explicitly-abandoned')`).run(now+3_600_000,now+3_600_000,owner);
  }
  function transferOwner(from:string,to:string,projectId:string,taskId?:string) {
    const now=Date.now();
    const filter=taskId === undefined ? '' : " AND json_extract(record,'$.taskId')=?";
    return db.prepare(`UPDATE deliveries SET owner=?,due=?,record=json_set(record,'$.owner',?,'$.ownerNeeded',json('false'),'$.nextCheckAt',?,'$.notification.queued',NULL,'$.notification.attempted',NULL,'$.notification.delivered',NULL,'$.notification.desired','handoff:'||id||':'||?) WHERE owner=? AND project=? AND status NOT IN ('complete','explicitly-abandoned')${filter}`)
      .run(to,now,to,now,to,from,projectId,...(taskId === undefined ? [] : [taskId])).changes;
  }

  function abandon(id:string, actor:string, reason:string) {
    const r=get(id); if (!r || r.owner !== actor) throw new Error('Only the owning manager can record authorized abandonment');
    if (!reason.trim()) throw new Error('Abandonment requires a reason and explicit authority');
    return save({ ...r, status:'explicitly-abandoned', notification:{...r.notification,desired:null,attempted:null}, disposition:{ reason:reason.trim(), actor, at:Date.now() }, blocker:'',nextAction:'Explicitly abandoned',updatedAt:Date.now() });
  }
  function verify(id:string, actor:string, commitSha:string, evidence:string) {
    const r=get(id); if (!r || r.owner !== actor || r.status !== 'merged-needs-verification' || r.mergeCommitSha !== commitSha || !r.mergeCommitSha || r.freshness !== 'fresh' || !evidence.trim()) throw new Error('Verification requires the owning manager, freshly observed merged commit, and evidence');
    return save({ ...r, status:'complete', verifiedCommitSha:commitSha, notification:{...r.notification,desired:null,attempted:null},disposition:{ reason:evidence,actor,at:Date.now() },blocker:'',nextAction:'Delivery contract satisfied',updatedAt:Date.now() });
  }
  function pendingNotifications(now=Date.now(),limit=20) {
    const rows=db.prepare("SELECT record FROM deliveries WHERE json_extract(record,'$.notification.desired') IS NOT NULL AND json_extract(record,'$.notification.desired') IS NOT json_extract(record,'$.notification.delivered') AND json_extract(record,'$.notification.retryAt')<=? ORDER BY due,id LIMIT ?").all(now,limit) as { record:string }[];
    return rows.map(row=>JSON.parse(row.record) as DeliveryRecord);
  }
  function markQueued(id:string,owner:string,signature:string) {
    const r=get(id);
    if (!r || r.owner !== owner || r.ownerNeeded || r.notification.desired !== signature || r.status === 'explicitly-abandoned') return false;
    r.notification.queued=signature;save(r);return true;
  }
  async function notify(id:string, deliver:(r:DeliveryRecord)=>Promise<boolean>, now=Date.now(), reconcile?:(r:DeliveryRecord)=>Promise<'accepted'|'absent'|'unknown'>) {
    let r=get(id); if (!r || r.ownerNeeded || !r.owner || !r.notification.desired || r.notification.desired === r.notification.delivered || r.notification.retryAt>now) return false;
    const signature=r.notification.desired;
    if (r.notification.attempted === signature) {
      const outcome=await reconcile?.(r) ?? 'unknown';
      const latest=get(id)!;
      if (latest.owner !== r.owner || latest.notification.desired !== signature || latest.ownerNeeded) return false;
      if (outcome === 'accepted') { latest.notification.delivered=signature; latest.notification.attempted=null; save(latest); return true; }
      if (outcome === 'unknown') { latest.notification.retryAt=now+60_000; save(latest); return false; }
      r=latest;
    }
    r.notification.attempted=signature; r.notification.attemptedAt=now; save(r);
    try {
      const accepted=await deliver(r);
      const latest=get(id)!;
      if (latest.owner !== r.owner || latest.notification.desired !== signature || latest.ownerNeeded) return false;
      if (accepted) { latest.notification.delivered=signature; latest.notification.retryAt=0; }
      else latest.notification.retryAt=now+60_000;
      latest.notification.attempted=null; save(latest); return accepted;
    } catch {
      // Ambiguous delivery or a write failure AFTER acceptance must be reconciled
      // by notification identity, never blindly repeated after reload.
      const latest=get(id)!; if (latest.owner !== r.owner || latest.notification.desired !== signature || latest.ownerNeeded) return false; latest.notification.retryAt=now+60_000; save(latest); return false;
    }
  }
  return { get,save,list,conflict,hasOwned,register,observe,stale,assign,ownerLost,transferOwner,abandon,verify,markQueued,notify,pendingNotifications };
}

/** Parse forge data conservatively. A successful lookup with unknown fields
 * cannot turn checks green or waive independent review. */
export function parseForge(value: unknown): ForgeObservation {
  if (!value || typeof value !== 'object') throw new Error('Invalid forge observation');
  const r=value as Record<string,unknown>;
  if (typeof r.headRefOid !== 'string' || !r.headRefOid || !['OPEN','CLOSED','MERGED'].includes(String(r.state))) throw new Error('Missing forge head/state');
  const checks=Array.isArray(r.statusCheckRollup) ? r.statusCheckRollup as Record<string,unknown>[] : null;
  const failing=['FAILURE','ERROR','CANCELLED','TIMED_OUT','ACTION_REQUIRED'];
  const passing=['SUCCESS','NEUTRAL','SKIPPED'];
  const checkState=checks === null ? 'unknown' : checks.some(c=>failing.includes(String(c.conclusion ?? c.state))) ? 'failing' : checks.some(c=>!passing.includes(String(c.conclusion ?? c.state))) ? 'pending' : 'passing';
  const approvals=Array.isArray(r.reviews) ? (r.reviews as Record<string,unknown>[]).filter(review=>review.state === 'APPROVED' && (review.commit as Record<string,unknown>|undefined)?.oid === r.headRefOid) : [];
  const approved=r.reviewDecision === 'APPROVED' && approvals.length>0;
  return { mergeCommitSha:typeof (r.mergeCommit as Record<string,unknown>|undefined)?.oid === 'string' ? (r.mergeCommit as {oid:string}).oid : null,reviewHeadSha:approved ? r.headRefOid : null,headSha:r.headRefOid,state:String(r.state).toLowerCase() as ForgeObservation['state'], draft:r.isDraft === true,
    checks:checkState, review:approved ? 'approved' : r.reviewDecision === 'CHANGES_REQUESTED' ? 'changes-requested' : r.reviewDecision === 'REVIEW_REQUIRED' ? 'required' : 'unknown',
    mergeable:r.mergeable === 'MERGEABLE' ? 'mergeable' : r.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown' };
}
