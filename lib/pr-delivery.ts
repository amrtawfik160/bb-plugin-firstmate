import { createHash } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
type Database = ReturnType<BbPluginApi['storage']['database']>;
export type DeliveryRequirement = 'pr' | 'merged' | 'merged-and-verified';
export type DeliveryStatus = 'draft' | 'waiting-checks' | 'failing-checks' | 'waiting-review' | 'waiting-native-gates' | 'changes-requested' | 'on-hold' | 'changed-since-hold' | 'waiting-approval' | 'ready-to-merge' | 'merged-needs-verification' | 'closed-needs-disposition' | 'pr-delivered' | 'complete' | 'explicitly-abandoned';
export interface CheckFailure {
  id:string; name:string; url:string; headSha:string; resolvedAt:number|null;
  accounting?:{scope:'author'|'baseline'; taskId:string; worker:string; evidence:string; actor:string; at:number};
}
export interface DeliveryRecord {
  id: string; repository: string; number: number; url: string; headSha: string; mergeCommitSha:string|null;
  title?:string; openedAt?:number;
  taskId: string; projectId: string; owner: string | null; home: string;
  continuation?:Record<string,unknown>;
  deliverySatisfiedAt?:number|null; forgeState?:ForgeObservation['state']; failures?:CheckFailure[];
  workers: string[]; requirement: DeliveryRequirement; status: DeliveryStatus;
  blocker: string; nextAction: string; nextCheckAt: number; observedAt: number | null;
  freshness: 'fresh' | 'stale'; error: string | null; errors: number;
  ownerNeeded: boolean; verifiedCommitSha: string | null; disposition: { reason: string; actor: string; at: number } | null;
  notification: { desired: string | null; delivered: string | null; queued: string | null; retryAt: number; attempted?: string | null; attemptedAt?: number };
  actionDueAt: number;
  /** Head commit that carried a do-not-merge verdict. Set until the PR merges or the captain clears it. */
  heldHead?: string | null;
  updatedAt: number;
}
export interface ForgeObservation {
  headSha: string; state: 'open' | 'closed' | 'merged'; draft: boolean;
  checks: 'pending' | 'passing' | 'failing' | 'unknown'; review: 'approved' | 'changes-requested' | 'required' | 'unknown';
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  reviewHeadSha:string|null; mergeCommitSha:string|null; failedChecks?:{id:string;name:string;url:string}[];
  title?:string; openedAt?:number;
  /** A do-not-merge verdict that applies to the current head, quoted; null when none. */
  hold?:string|null;
}
export function canonicalPr(url: string) {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url.trim());
  if (!m || Number(m[2]) < 1) throw new Error('Expected a canonical GitHub PR URL');
  const repository = m[1]!.toLowerCase(), number = Number(m[2]);
  return { id: `${repository}#${number}`, repository, number, url: `https://github.com/${repository}/pull/${number}` };
}
export function deliveryLine(r: DeliveryRecord) {
  return `${r.id} [${r.status}${r.freshness === 'stale' ? ', stale' : ''}${r.ownerNeeded ? ', owner needed' : ''}] owner=${r.owner ?? 'unassigned'} ${r.url}\n  ${r.deliverySatisfiedAt ? 'Agreed delivery satisfied; ' : ''}${r.blocker || 'No known blocker'}. Next: ${r.nextAction}${(r.failures ?? []).filter(f=>f.resolvedAt===null).map(f=>`\n  ${f.id}: ${f.name} ${f.url} — ${f.accounting ? `${f.accounting.scope} follow-up task=${f.accounting.taskId} worker=${f.accounting.worker}` : `unaccounted; author=${r.workers.at(-1) ?? 'unknown'}`}`).join('')}`;
}
/** One open pull request on the owner's board; `state` is already plain words.
 * `needsOwner` is true when the owner must act: a lost manager, or a merge only the owner approves. */
export type BoardPr = { ref: string; url: string; title?: string; state: string; needsOwner: boolean; openedAt: number };
/** One plain owner-facing state per tracked status; null leaves the PR off the board (merged or closed).
 * Nobody asks the owner to review, so passing checks without a hold read "ready to merge". */
const BOARD_PR_STATE: Record<DeliveryStatus, string | null> = {
  'draft': 'draft',
  'waiting-checks': 'checks running',
  'failing-checks': 'checks failed',
  'changes-requested': 'changes requested',
  'on-hold': 'on hold',
  'changed-since-hold': 'changed since hold, needs a check',
  'waiting-review': 'ready to merge',
  'waiting-native-gates': 'ready to merge',
  'pr-delivered': 'ready to merge',
  'waiting-approval': 'ready to merge',
  'ready-to-merge': 'ready to merge',
  'merged-needs-verification': null,
  'closed-needs-disposition': null,
  'complete': null,
  'explicitly-abandoned': null,
};
/** The open PRs to show the owner. A PR that needs a new manager is waiting on the owner. */
export function boardPullRequests(records: readonly DeliveryRecord[]): BoardPr[] {
  return records.flatMap((r) => {
    // A PR-only delivery keeps its status while checks run; its blocker says so.
    const state = r.status === 'pr-delivered' && r.blocker !== '' ? 'checks running' : BOARD_PR_STATE[r.status];
    if (state === null || state === undefined || r.forgeState === 'merged' || r.forgeState === 'closed') return [];
    const needsOwner = r.ownerNeeded || r.status === 'waiting-approval' || r.status === 'ready-to-merge';
    return [{ ref: r.id, url: r.url, ...(r.title ? { title: r.title } : {}), state: r.ownerNeeded ? 'waiting on you' : state, needsOwner, openedAt: r.openedAt ?? r.updatedAt }];
  });
}
/** How often a PR without a live manager is read on GitHub, so a merge or close
 * still leaves the open list within minutes. */
export const LOST_OWNER_RECHECK_MS = 5 * 60_000;
const terminal = (r: DeliveryRecord) => r.status === 'complete' || r.status === 'explicitly-abandoned';
function notificationKey(r: DeliveryRecord) {
  return createHash('sha256').update(JSON.stringify([r.headSha, r.status, r.owner, r.ownerNeeded, r.blocker, (r.failures??[]).filter(f=>f.resolvedAt===null).map(f=>[f.id,f.accounting??null])])).digest('hex');
}
function actionable(r: DeliveryRecord) {
  return r.ownerNeeded || ['failing-checks','changes-requested','changed-since-hold','waiting-review','waiting-native-gates','waiting-approval','ready-to-merge','merged-needs-verification','closed-needs-disposition'].includes(r.status);
}
export function createDeliveries(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, owner TEXT, project TEXT NOT NULL, status TEXT NOT NULL, due INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status,due);
    CREATE INDEX IF NOT EXISTS deliveries_owner ON deliveries(owner,project);
    CREATE INDEX IF NOT EXISTS deliveries_project_number ON deliveries(project,json_extract(record,'$.number'))`);
  // Old PR-only completion recorded artifact delivery, never forge completion.
  // Reopen observation once, preserving original contracts and author linkage.
  db.prepare("UPDATE deliveries SET status='pr-delivered',due=0,record=json_set(record,'$.status','pr-delivered','$.deliverySatisfiedAt',json_extract(record,'$.updatedAt'),'$.freshness','stale','$.nextCheckAt',0,'$.nextAction','Observe PR health; original PR-only contract stays satisfied') WHERE status='complete' AND json_extract(record,'$.requirement')='pr' AND json_extract(record,'$.forgeState') IS NULL AND json_extract(record,'$.mergeCommitSha') IS NULL").run();
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
  function taskRecord(owner:string,projectId:string,id:string) {
    const row=db.prepare("SELECT record FROM deliveries WHERE owner=? AND project=? AND status NOT IN ('complete','explicitly-abandoned') AND (json_extract(record,'$.taskId')=? OR EXISTS(SELECT 1 FROM json_each(json_extract(record,'$.workers')) WHERE value=?)) ORDER BY due,id LIMIT 1").get(owner,projectId,id,id) as {record:string}|undefined;
    return row ? JSON.parse(row.record) as DeliveryRecord : undefined;
  }
  /** taskRecord across every project of this owner; open deliveries only unless includeComplete. */
  function ownedTaskRecord(owner:string,id:string,includeComplete=false) {
    const row=db.prepare(`SELECT record FROM deliveries WHERE owner=? ${includeComplete ? "" : "AND status NOT IN ('complete','explicitly-abandoned')"} AND (json_extract(record,'$.taskId')=? OR EXISTS(SELECT 1 FROM json_each(json_extract(record,'$.workers')) WHERE value=?)) ORDER BY due,id LIMIT 1`).get(owner,id,id) as {record:string}|undefined;
    return row ? JSON.parse(row.record) as DeliveryRecord : undefined;
  }
  function register(input: { url: string; taskId: string; projectId: string; owner: string | null; home: string; worker: string; requirement?: DeliveryRequirement; continuation?:Record<string,unknown>; title?:string; openedAt?:number }) {
    const identity = canonicalPr(input.url);
    const prior = get(identity.id);
    if (prior) {
      if (prior.projectId !== input.projectId || prior.owner !== input.owner || prior.taskId !== input.taskId) throw new Error(`PR ${identity.id} already belongs to another task or manager. Explicit assignment is required.`);
      if (input.requirement && prior.requirement !== input.requirement) throw new Error("Delivery contract is already agreed; registration cannot silently replace it.");
      return save({ ...prior, title:prior.title ?? input.title, openedAt:prior.openedAt ?? input.openedAt, continuation:input.continuation ?? prior.continuation, workers: [...new Set([...prior.workers,input.worker])].slice(-100) });
    }
    return save({ ...identity, ...(input.title ? { title:input.title } : {}), ...(input.openedAt ? { openedAt:input.openedAt } : {}), headSha:'', mergeCommitSha:null,taskId:input.taskId, projectId:input.projectId, owner:input.owner,
      home:input.home, continuation:input.continuation, workers:[input.worker], requirement:input.requirement ?? 'merged', status:'waiting-checks',
      blocker:'Forge observation pending', nextAction:'Observe PR checks and review', nextCheckAt:Date.now(), observedAt:null,
      freshness:'stale', error:null, errors:0, ownerNeeded:input.owner === null, verifiedCommitSha:null, disposition:null,
      notification:{ desired:null, delivered:null, queued:null, retryAt:0 }, actionDueAt:Date.now()+86_400_000, updatedAt:Date.now() });
  }
  function observe(id: string, o: ForgeObservation, mergeAuthorized: boolean, now = Date.now(), unverifiedStanding=false) {
    const prior = get(id); if (!prior) throw new Error('Unknown deliverable');
    if (terminal(prior)) return prior;
    const changedHead = prior.headSha !== o.headSha;
    let r: DeliveryRecord = { ...prior, title:o.title ?? prior.title, openedAt:o.openedAt ?? prior.openedAt, headSha:o.headSha, mergeCommitSha:o.mergeCommitSha,verifiedCommitSha:changedHead ? null : prior.verifiedCommitSha,
      forgeState:o.state, observedAt:now, freshness:'fresh', error:null, errors:0, updatedAt:now, nextCheckAt:now+60_000 };
    const currentFailures=o.failedChecks ?? (o.checks==='failing' ? [{id:'unknown-check',name:'Unidentified failing check; inspect forge',url:r.url}] : []);
    const failures=changedHead ? [] : (prior.failures ?? []);
    r.failures=failures.map(f=>({...f,resolvedAt:o.checks==='passing' ? (f.resolvedAt ?? now) : f.resolvedAt}));
    for (const failure of currentFailures) {
      const old=r.failures.find(f=>f.id===failure.id);
      if (old) old.resolvedAt=null;
      else r.failures.push({...failure,headSha:o.headSha,resolvedAt:null});
    }
    r.heldHead=o.state!=='open' ? null : o.hold ? o.headSha : prior.heldHead === o.headSha ? null : prior.heldHead ?? null;
    if (o.state === 'merged') {
      r.status = r.requirement === 'merged-and-verified' && (r.verifiedCommitSha !== o.mergeCommitSha || r.mergeCommitSha === null) ? 'merged-needs-verification' : 'complete';
      if (r.status==='complete') r.deliverySatisfiedAt=prior.deliverySatisfiedAt ?? now;
      r.blocker = r.status === 'complete' ? '' : r.mergeCommitSha ? 'Required verification has not been recorded' : 'Merged commit is not yet readable';
      r.nextAction = r.status === 'complete' ? 'Delivery contract satisfied' : r.mergeCommitSha ? `Run agreed verification on merged commit ${r.mergeCommitSha} and record its evidence` : 'Observe the merged commit before recording verification';
    } else if (o.state === 'closed') {
      r.status = 'closed-needs-disposition'; r.blocker = 'PR closed without merge'; r.nextAction = 'Reopen, replace, or explicitly abandon with a reason';
    } else if (o.draft) {
      r.status='draft'; r.blocker='PR is a draft'; r.nextAction='Finish work and mark ready';
    } else if (o.hold) {
      r.status='on-hold'; r.blocker=`Do-not-merge verdict: ${o.hold}`; r.nextAction='Do not merge. New commits need a captain check before the hold lifts';
    } else if (r.heldHead) {
      r.status='changed-since-hold'; r.blocker='New commits since the do-not-merge verdict; nobody has checked them yet'; r.nextAction='Check the new commits, then merge or clear the hold with a reason';
    } else if (o.review === 'changes-requested') {
      r.status='changes-requested'; r.blocker='Reviewer requested changes'; r.nextAction='Reuse the author for fixes, then repeat the agreed review and validation';
    } else if (o.checks === 'failing') {
      r.status='failing-checks'; r.blocker='A check failed'; r.nextAction='Reuse the author to investigate and fix the failing check';
    } else if (changedHead || o.checks !== 'passing' || o.mergeable !== 'mergeable') {
      r.status='waiting-checks'; r.blocker=changedHead ? 'New head invalidated prior readiness; confirm checks and review again' : 'Checks or mergeability are pending or unknown'; r.nextAction='Wait for current-head checks and mergeability';
    } else if (o.review === 'required' || (o.review === 'approved' && o.reviewHeadSha !== o.headSha)) {
      r.status='waiting-review'; r.blocker='Repository review requirement is unsatisfied for this head'; r.nextAction='Satisfy the repository’s required review policy for the current head';
    } else if (o.review === 'unknown' && mergeAuthorized) {
      r.status='waiting-native-gates'; r.blocker='Repository review evidence is unknown'; r.nextAction='Continue the agreed native review and validation path, then use native guarded merge to check repository rules and task authority';
    } else {
      r.status=mergeAuthorized ? 'ready-to-merge' : 'waiting-approval';
      r.blocker=mergeAuthorized ? '' : 'Merge approval is required'; r.nextAction=mergeAuthorized ? 'Use native guarded merge; preserve the agreed review and validation path' : 'Request merge approval through the existing decision mechanism';
    }
    if (unverifiedStanding && r.status==='waiting-approval') {
      r.status='waiting-native-gates';r.blocker='Standing yolo recorded; captain approval provenance is unverified';
      r.nextAction='Resolve recorded captain approval under native precedence. Already-approved green in-scope work needs no fresh merge request; an unexplained registry flag alone proves no approval. Preserve actual user holds, then use native guarded merge.';
    }
    if (r.requirement === 'pr' && o.state === 'open' && !o.draft) {
      r.deliverySatisfiedAt=prior.deliverySatisfiedAt ?? now;
      // Artifact delivery is fulfilled independently of CI and review health.
      if (o.checks==='failing' || o.review==='changes-requested' || o.hold || r.heldHead) {
        r.nextAction='Inspect every independent failure. Reuse the author for branch-specific fixes; record baseline evidence and an existing authorized follow-up task separately. No merge authority is added.';
      } else {
        r.status='pr-delivered'; r.blocker=o.checks==='passing' ? '' : 'PR delivered; checks pending or unknown';
        r.nextAction='Observe PR health; PR-only delivery does not require merge';
      }
    }
    if (r.status !== prior.status || changedHead) r.actionDueAt=now+86_400_000;
    r.notification={...prior.notification};
    if (actionable(r) || (r.deliverySatisfiedAt && !prior.deliverySatisfiedAt) || (r.status === 'complete' && prior.status !== 'complete')) r.notification.desired=notificationKey(r);
    if (!terminal(r)) {
      if (now >= r.actionDueAt && r.status!=='pr-delivered') r.notification.desired=`overdue:${notificationKey(r)}:${r.actionDueAt}`;
      else if (!actionable(r) && !(r.deliverySatisfiedAt && !prior.deliverySatisfiedAt)) r.notification.desired=r.status==='pr-delivered' && prior.status==='pr-delivered' && !changedHead && prior.notification.desired!==prior.notification.delivered ? prior.notification.desired : null;
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
      WHERE owner=? AND status NOT IN ('complete','explicitly-abandoned')`).run(now+LOST_OWNER_RECHECK_MS,now+LOST_OWNER_RECHECK_MS,owner);
  }
  /** Mark one record as needing a new manager without delaying the owner's other records. */
  function markOwnerNeeded(id:string) {
    const r=get(id); if (!r || terminal(r) || r.ownerNeeded) return r;
    return save({ ...r, ownerNeeded:true, nextAction:'Explicitly assign a new manager', notification:{ ...r.notification, desired:`owner-needed:${r.id}:${r.owner}`, attempted:null } });
  }
  /** The recorded manager is alive again (or was marked lost by mistake). */
  function ownerRestored(id:string) {
    const r=get(id); if (!r || !r.owner || !r.ownerNeeded) return r;
    const desired=r.notification.desired?.startsWith('owner-needed:') ? null : r.notification.desired;
    return save({ ...r, ownerNeeded:false, notification:{ ...r.notification, desired, attempted:null } });
  }
  function transferOwner(from:string,to:string,projectId:string,taskId?:string,excludedTasks:string[] = []) {
    const now=Date.now();
    const filter=(taskId === undefined ? '' : " AND json_extract(record,'$.taskId')=?") + (excludedTasks.length ? ` AND json_extract(record,'$.taskId') NOT IN (${excludedTasks.map(()=>'?').join(',')})` : '');
    return db.prepare(`UPDATE deliveries SET owner=?,due=?,record=json_set(record,'$.owner',?,'$.ownerNeeded',json('false'),'$.nextCheckAt',?,'$.notification.queued',NULL,'$.notification.attempted',NULL,'$.notification.delivered',NULL,'$.notification.desired','handoff:'||id||':'||?) WHERE owner=? AND project=? AND status NOT IN ('complete','explicitly-abandoned')${filter}`)
      .run(to,now,to,now,to,from,projectId,...(taskId === undefined ? [] : [taskId]),...excludedTasks).changes;
  }

  function accountFailure(id:string, actor:string, failureId:string, scope:'author'|'baseline', taskId:string, worker:string, evidence:string) {
    const r=get(id);if (!r || r.owner!==actor || !evidence.trim() || !taskId || !worker) throw new Error('Failure accounting requires owner, exact follow-up identity and evidence');
    const failure=r.failures?.find(f=>f.id===failureId && f.resolvedAt===null);
    if (!failure) throw new Error('Unknown current failing check; reconcile first');
    if (scope==='author' && (taskId!==r.taskId || !r.workers.includes(worker))) throw new Error('Branch-specific follow-up must reuse the recorded author');
    failure.accounting={scope,taskId,worker,evidence,actor,at:Date.now()};
    return save({...r,updatedAt:Date.now()});
  }
  function abandon(id:string, actor:string, reason:string) {
    const r=get(id); if (!r || r.owner !== actor) throw new Error('Only the owning manager can record authorized abandonment');
    if (!reason.trim()) throw new Error('Abandonment requires a reason and explicit authority');
    return save({ ...r, status:'explicitly-abandoned', notification:{...r.notification,desired:null,attempted:null}, disposition:{ reason:reason.trim(), actor, at:Date.now() }, blocker:'',nextAction:'Explicitly abandoned',updatedAt:Date.now() });
  }
  /** The captain checked the commits pushed after a hold and lifts it. */
  function clearHold(id:string, actor:string, reason:string) {
    const r=get(id); if (!r || r.owner !== actor) throw new Error('Only the owning manager can clear a hold');
    if (!reason.trim()) throw new Error('Clearing a hold needs a reason: what you checked');
    if (!r.heldHead) throw new Error(`${r.id} has no hold to clear`);
    if (r.status==='on-hold') throw new Error(`${r.id} still has a do-not-merge verdict on its current head; remove the label or comment first`);
    return save({ ...r, heldHead:null, status:'waiting-checks', blocker:'Hold cleared; readiness not yet re-read', nextAction:'Observe PR checks and review', nextCheckAt:0, disposition:{ reason:reason.trim(), actor, at:Date.now() }, updatedAt:Date.now() });
  }
  /** Every record, open or closed, that belongs to one of these crew tasks or PR ids. */
  function forTasks(taskIds:readonly string[], ids:readonly string[]=[]) {
    if (!taskIds.length && !ids.length) return [];
    const matching:string[]=[];
    if (taskIds.length) matching.push(`json_extract(record,'$.taskId') IN (${taskIds.map(()=>'?').join(',')})`);
    if (ids.length) matching.push(`id IN (${ids.map(()=>'?').join(',')})`);
    return (db.prepare(`SELECT record FROM deliveries WHERE ${matching.join(' OR ')} ORDER BY id`).all(...taskIds,...ids) as {record:string}[]).map(row=>JSON.parse(row.record) as DeliveryRecord);
  }
  /** The commit may be the recorded merge commit or a hex prefix of it, 7 characters or longer. The record keeps the full SHA. */
  function verify(id:string, actor:string, commitSha:string, evidence:string) {
    const r=get(id); if (!r) throw new Error(`Unknown deliverable ${id}`);
    if (r.owner !== actor) throw new Error(`Only the owning manager can verify ${r.id}`);
    if (r.status !== 'merged-needs-verification') throw new Error(`${r.id} is ${r.status}, not merged-needs-verification`);
    const merged=r.mergeCommitSha, given=commitSha.trim().toLowerCase();
    if (!merged) throw new Error(`${r.id} has no recorded merge commit; reconcile it, then verify again`);
    if (merged !== commitSha && !(/^[0-9a-f]{7,}$/.test(given) && merged.toLowerCase().startsWith(given))) throw new Error(`Commit ${commitSha} does not match the recorded merge commit ${merged.slice(0,7)} of ${r.id}; pass at least its first 7 characters`);
    if (r.freshness !== 'fresh') throw new Error(`${r.id} was not freshly observed; reconcile it, then verify again`);
    if (!evidence.trim()) throw new Error(`Verifying ${r.id} needs evidence: say what you checked`);
    return save({ ...r, status:'complete', verifiedCommitSha:merged, notification:{...r.notification,desired:null,attempted:null},disposition:{ reason:evidence,actor,at:Date.now() },blocker:'',nextAction:'Delivery contract satisfied',updatedAt:Date.now() });
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
  /** This manager's PRs that merged at or after `since`, newest first. updatedAt stands in for the merge time. */
  function mergedSince(owner:string, since:number, limit=50) {
    const rows=db.prepare("SELECT record FROM deliveries WHERE owner=? AND json_extract(record,'$.forgeState')='merged' AND json_extract(record,'$.updatedAt')>=? ORDER BY json_extract(record,'$.updatedAt') DESC,id LIMIT ?").all(owner,since,Math.max(1,Math.min(limit,100))) as {record:string}[];
    return rows.map(row=>JSON.parse(row.record) as DeliveryRecord);
  }
  return { get,save,list,mergedSince,conflict,hasOwned,taskRecord,ownedTaskRecord,register,observe,stale,assign,ownerLost,markOwnerNeeded,ownerRestored,transferOwner,accountFailure,abandon,clearHold,forTasks,verify,markQueued,notify,pendingNotifications };
}

const DO_NOT_MERGE = /\b(?:do not|don'?t|dont)[\s-]+merge\b|\bdo-not-merge\b/i;
/** A captain or crew says "do not merge" with a PR label, or with a comment written after
 * the current head's commit. A later commit is new work, so it lifts a comment hold. */
function holdOf(r:Record<string,unknown>):string|null {
  const labels=Array.isArray(r.labels) ? r.labels as Record<string,unknown>[] : [];
  const label=labels.map(l=>String(l.name ?? '')).find(name=>DO_NOT_MERGE.test(name.replace(/[-_]/g,' ')) || /^(?:hold|on[\s-]hold)$/i.test(name));
  if (label) return `label "${label}"`;
  const commits=Array.isArray(r.commits) ? r.commits as Record<string,unknown>[] : [];
  const headAt=Date.parse(String(commits.at(-1)?.committedDate ?? ''));
  const notes=[...(Array.isArray(r.comments) ? r.comments : []),...(Array.isArray(r.reviews) ? r.reviews : [])] as Record<string,unknown>[];
  const verdict=notes.filter(n=>{
    const at=Date.parse(String(n.createdAt ?? n.submittedAt ?? ''));
    return DO_NOT_MERGE.test(String(n.body ?? '')) && (!Number.isFinite(headAt) || !Number.isFinite(at) || at>=headAt);
  }).at(-1);
  return verdict ? String(verdict.body).replace(/\s+/g,' ').trim().slice(0,200) : null;
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
  const openedAt=typeof r.createdAt === 'string' ? Date.parse(r.createdAt) : NaN;
  return { ...(typeof r.title === 'string' && r.title.trim() ? { title:r.title.trim().slice(0,300) } : {}), ...(Number.isFinite(openedAt) ? { openedAt } : {}),
    mergeCommitSha:typeof (r.mergeCommit as Record<string,unknown>|undefined)?.oid === 'string' ? (r.mergeCommit as {oid:string}).oid : null,reviewHeadSha:approved ? r.headRefOid : null,headSha:r.headRefOid,state:String(r.state).toLowerCase() as ForgeObservation['state'], draft:r.isDraft === true,
    failedChecks:(checks??[]).filter(c=>failing.includes(String(c.conclusion ?? c.state))).map(c=>{
      const name=String(c.name ?? c.context ?? 'Unidentified check'),url=String(c.detailsUrl ?? c.targetUrl ?? '');
      return {id:createHash('sha256').update(JSON.stringify([name,url])).digest('hex').slice(0,24),name,url};
    }),
    checks:checkState, review:approved ? 'approved' : r.reviewDecision === 'CHANGES_REQUESTED' ? 'changes-requested' : r.reviewDecision === 'REVIEW_REQUIRED' ? 'required' : 'unknown',
    mergeable:r.mergeable === 'MERGEABLE' ? 'mergeable' : r.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown', hold:holdOf(r) };
}
