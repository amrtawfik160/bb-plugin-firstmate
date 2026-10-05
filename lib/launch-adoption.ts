import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { LaunchRecord } from './launch.ts';

// Explicit legacy repair reads are bounded even when an SDK transport ignores
// AbortSignal. No operation here can start or alter a worker turn.
export async function adoptionRead<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel = () => {};
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Adoption read timed out; inspect the retained launch before retry.')), 5_000);
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
  });
  try { return await Promise.race([operation, deadline]); } finally { cancel(); }
}

export function assertAdoptableReservation(record: LaunchRecord | undefined, owner: string, project: string, home: string, threadId: string): asserts record is LaunchRecord {
  if (!record || record.owner !== owner || record.projectId !== project || record.home !== home) throw new Error('No launch reservation with this exact captain/project/home identity.');
  if (!record.nativeInvoked || record.generation !== 1 || !['ship','scout'].includes(record.shape) ||
      !record.deliveryRequirement || !['direct-PR','no-mistakes','local-only'].includes(record.deliveryMode ?? '') || !record.hostId || !record.path) {
    throw new Error('Legacy adoption requires the original native launch identity and immutable delivery contract.');
  }
  if (!['uncertain','provisioning'].includes(record.state) && !record.adoption) throw new Error('Only unresolved native launches can be adopted.');
  if (record.state === 'deleted' || record.state === 'failed' || record.threadId && record.threadId !== threadId || record.adoption && record.adoption.threadId !== threadId) {
    throw new Error('Launch is retired or bound to a different worker; adoption refused.');
  }
}

export async function inspectAdoptionIdentity(bb: BbPluginApi, record: LaunchRecord, threadId: string, signal: AbortSignal) {
  const read = <T>(p: Promise<T>) => adoptionRead(p, signal);
  const thread = await read(bb.sdk.threads.get({ threadId, signal }));
  if (thread.id !== threadId || thread.projectId !== record.projectId || thread.parentThreadId !== record.owner || thread.archivedAt || thread.deletedAt || !thread.environmentId) {
    throw new Error('Worker parent/project/lifecycle identity does not match this launch.');
  }
  const environment = await read(bb.sdk.environments.get({ environmentId: thread.environmentId, signal }));
  if (environment.projectId !== record.projectId || environment.hostId !== record.hostId || environment.status !== 'ready' ||
      !environment.path || !environment.managed || !environment.isWorktree || environment.workspaceProvisionType !== 'managed-worktree' || environment.lifecycle.phase !== 'active') {
    throw new Error('Worker requires a ready managed isolated worktree on the original project and host.');
  }
  const project = await read(bb.sdk.projects.get({ projectId: record.projectId, signal }));
  if (!project.sources.some(s => s.hostId === record.hostId && s.path === record.path)) throw new Error('Original checkout is not a project source on the original host.');
  const occupants = await read(bb.sdk.threads.list({environmentId:environment.id,includeHidden:true,limit:2,signal}));
  if (occupants.length!==1 || occupants[0]?.id!==threadId) throw new Error('Managed worktree is not exclusively bound to this worker.');
  const metadata = await read(bb.sdk.threads.getPluginMetadata({ threadId, signal }));
  const expected = { crewId:record.taskId, nativeHome:record.home, launchKey:record.key, generation:record.generation, shape:record.shape, posture:record.deliveryMode, deliveryRequirement:record.deliveryRequirement };
  for (const [key,value] of Object.entries(expected)) if (metadata[key] !== undefined && metadata[key] !== value) throw new Error(`Worker metadata collision: ${key}.`);
  if (metadata.captain === true || metadata.captain === 'true' || metadata.crew === false || metadata.crew === 'false') throw new Error('Worker role conflicts with adoption.');
  if (metadata.worktree !== undefined && metadata.worktree !== true && metadata.worktree !== 'true' ||
      metadata.nativeTaskId !== undefined && metadata.nativeTaskId !== record.taskId ||
      metadata.nativeParentHome !== undefined && metadata.nativeParentHome !== record.home) throw new Error('Worker isolation/task/home metadata conflicts with adoption.');
  const events = await read(bb.sdk.threads.events.list({ threadId, types:['client/turn/requested'], order:'asc', limit:'1', signal }));
  const first = events[0];
  if (!first || first.threadId !== threadId || first.type !== 'client/turn/requested' || first.data.target.kind !== 'thread-start') throw new Error('Immutable initial worker prompt provenance is unavailable.');
  const prompt = first.data.input.filter(p => p.type === 'text').map(p => p.text).join('\n');
  if (!prompt || prompt.length > 2_000_000) throw new Error('Initial prompt is missing or exceeds the repair bound.');
  const execution=first.data.execution;
  if (!execution?.model || !execution.reasoningLevel || !execution.permissionMode ||
      record.execution?.model && record.execution.model!==execution.model ||
      record.execution?.reasoningLevel && record.execution.reasoningLevel!==execution.reasoningLevel ||
      record.execution?.providerId && record.execution.providerId!==thread.providerId) throw new Error('Original worker execution provenance is missing or conflicts with the reservation.');
  // Inventory must be exhausted, never treat a partial page as uniqueness proof.
  // Exact task namespace in metadata or the original prompt identifies a rival;
  // names/titles/error prose are not adoption evidence.
  for (let offset = 0; offset < 200; offset += 50) {
    const rows = await read(bb.sdk.threads.list({ projectId:record.projectId, parentThreadId:record.owner, includeHidden:true, limit:50, offset, signal }));
    for (const row of rows) {
      if (row.id === threadId || row.archivedAt || row.deletedAt) continue;
      const meta = await read(bb.sdk.threads.getPluginMetadata({ threadId:row.id, signal }));
      if (meta.crewId === record.taskId || meta.launchKey === record.key) throw new Error('Multiple candidate workers; adoption refused.');
      const initial = await read(bb.sdk.threads.events.list({ threadId:row.id, types:['client/turn/requested'], order:'asc', limit:'1', signal }));
      const event = initial[0];
      if (event?.type === 'client/turn/requested' && event.data.input.some(p => p.type === 'text' && p.text.includes(`${record.home}/state/${record.taskId}.status`))) throw new Error('Multiple unmarked candidate workers; adoption refused.');
    }
    if (rows.length < 50) return { thread, environment, metadata, prompt, eventId:first.id, execution };
  }
  throw new Error('Worker inventory exceeds the explicit repair bound; uniqueness cannot be established.');
}
