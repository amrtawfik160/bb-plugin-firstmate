import type { BbPluginApi } from '@get-bb/plugin-sdk';
export interface ExecutionSelection { projectId:string; hostId:string; checkout:string; environmentId:string | null }
export async function selectExecution(bb:BbPluginApi, projectId:string, preferredHost?:string):Promise<ExecutionSelection> {
  const environments=await bb.sdk.environments.list({ projectId });
  const source=environments.find(e=>!e.isWorktree && e.status==='ready' && e.path && (!preferredHost || e.hostId===preferredHost));
  if (source) return { projectId,hostId:source.hostId,checkout:source.path!,environmentId:source.id };
  const project=await bb.sdk.projects.get({ projectId });
  const sources=project.sources.filter(s=>s.path && (!preferredHost || s.hostId===preferredHost));
  const selected=sources.find(s=>s.isDefault) ?? sources[0];
  if (!selected) throw new Error(`No matching project checkout on ${preferredHost ?? 'an execution host'}. Refusing to use a path from another host.`);
  return { projectId,hostId:selected.hostId,checkout:selected.path,environmentId:null };
}
export function validateLaunchCapabilities(input:{ transport:string; shape:string; worktree:boolean; sendAt?:number }) {
  if (input.sendAt !== undefined) throw new Error('sendAt is unsupported for Firstmate launch. A backlog waitUntil gate only makes work eligible; dispatch it after the gate opens.');
  if (input.transport==='real' && input.shape==='ship' && !input.worktree) throw new Error('Native ship isolation is mandatory; shared-worktree requests are unsupported.');
}
