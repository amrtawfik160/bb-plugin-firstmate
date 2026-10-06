import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {join,posix} from 'node:path';
import {z} from 'zod';
import {METHOD_ASSET_HASHES} from './method-assets.ts';
export const METHODS_PROFILE='selected-v1';
export const METHODS_REVISION=createHash('sha256').update(JSON.stringify(METHOD_ASSET_HASHES)).digest('hex');
export const prSourceSchema=z.object({id:z.string().min(1),revision:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type PrSource=z.infer<typeof prSourceSchema>;
export function selectedPrSource(value:string):PrSource|undefined{return value?prSourceSchema.parse(JSON.parse(value)):undefined;}
/** Public source evidence describes the complete SDK body, not a page snapshot. */
export function prSourcePage(page:string,source:PrSource,activityMarker:string):string {
  const metadata=JSON.stringify(prSourceSchema.parse(source));
  if(Buffer.byteLength(metadata)>2048)throw new Error('PR source metadata exceeds 2048 UTF-8 bytes after JSON escaping; no source evidence was truncated.');
  const result=page.replace('\nBEGIN_PAGE\n',()=>`\nFIRSTMATE_PR_SOURCE ${metadata}\nSource revision identifies complete SKILL.md; snapshot identifies this transport read.\nBEGIN_PAGE\n`);
  // The existing 8KB body pages leave room within the 12KB skill-response
  // budget. Count escaped metadata, complete headers/cursor, activity marker
  // and the CLI JSON envelope rather than estimating overhead from raw text.
  if(Buffer.byteLength(JSON.stringify({text:result+activityMarker},null,2)+'\n')>=12000)throw new Error('PR paged response exceeds 12000 UTF-8 bytes including JSON escaping; no source or body was truncated. Use an unpaged operator read for this resource.');
  return result;
}
export type MethodRole='captain'|'worker';
export function methodPointer(role:MethodRole):string {
  return role==='captain'
    ? 'Installation-selected BB methods (native policy remains owner): use firstmate_methods action=read name=captain-methods. Trigger branches: assignment/handoff/completion coverage; consequential decision trail; scoped investigation/design/independent review; history/reflection/preferences only when explicitly requested. Read only the triggered reference, following every cursor. Methods grant no new reviewer, merge, reporting or execution authority.'
    : 'Installation-selected BB methods: use firstmate_methods action=read name=worker-methods for the assigned trigger. Branches: consequential behavior/shared-state/retry/migration proof; changed UI journey verification (verification-skill creation/upkeep only when assigned); consequential decision trail; assigned investigation/design/bounded review. Read only that reference and every cursor; the native brief owns scope, result channel and pipeline.';
}
export function methodResource(root:string,role:MethodRole,name:string,reference?:string,source?:string):{path:string;text:string;sha256:string} {
  const owned=`${role}-methods`;
  if(name!==owned)throw new Error(`Method ${name} does not belong to this ${role} role.`);
  const base=source??`${name}/SKILL.md`;
  if(!base.startsWith(`${owned}/`) || !(base in METHOD_ASSET_HASHES))throw new Error('Unknown method source file.');
  const path=reference===undefined?base:posix.normalize(posix.join(posix.dirname(base),reference.split('#')[0]));
  if(!path.startsWith(`${owned}/`) || !(path in METHOD_ASSET_HASHES))throw new Error('Reference is outside the selected role method inventory.');
  let file=join(root,'skills');
  for(const segment of ['.',...path.split('/')]){
    file=join(file,segment);if(lstatSync(file).isSymbolicLink())throw new Error('Selected method asset symlink refused.');
  }
  const bytes=readFileSync(file),sha256=createHash('sha256').update(bytes).digest('hex');
  if(sha256!==METHOD_ASSET_HASHES[path as keyof typeof METHOD_ASSET_HASHES])throw new Error('Selected method bytes differ from the installed version; rebuild and review the package.');
  return{path,text:bytes.toString('utf8'),sha256};
}

/** Resolve provider-native copies by actual execution identity; an ACP reader
 * may consume cross-provider copies only after proving complete byte equality. */
export async function installedPrResource(
  sdk:import('@get-bb/plugin-sdk').BbPluginApi['sdk'],
  threadId:string,expectedProject:string|undefined,signal:AbortSignal,
  read:<T>(promise:Promise<T>,signal:AbortSignal)=>Promise<T>,sourceId?:string,
):Promise<{text:string;identity:unknown;source:PrSource}> {
  if(sourceId!==undefined && !sourceId.trim())throw new Error('Select the exact nonempty requested pr resource ID.');
  const thread=await read(sdk.threads.get({threadId,signal}),signal);
  if(!thread.projectId || expectedProject && expectedProject!==thread.projectId)throw new Error("PR skill writer project identity differs from caller.");
  const workspace={projectId:thread.projectId,environmentId:thread.environmentId??null,signal};
  const inventory=await read(sdk.skills.list(workspace),signal);
  const matches=inventory.skills.filter(skill=>skill.name==='pr');
  if(!matches.length)throw new Error("Missing /pr skill in the body author's workspace; restore the requested skill before writing the PR body.");
  const applicable=matches.filter(skill=>skill.provider==null || skill.provider===thread.providerId);
  const candidates=(sourceId!==undefined?matches.filter(skill=>skill.id===sourceId):(applicable.length?applicable:matches)).sort((a,b)=>a.id.localeCompare(b.id));
  if(!candidates.length || sourceId && candidates.length!==1)throw new Error("Selected /pr source is unavailable or not the requested pr skill in this workspace.");
  if(candidates.length>8)throw new Error("Ambiguous /pr inventory exceeds eight candidate copies; resolve the workspace skill sources before body writing.");
  const loaded:Array<{id:string;content:string;revision:string}>=[];
  for(const candidate of candidates){
    const content=await read(sdk.skills.getContent({...workspace,skillId:candidate.id,path:'SKILL.md'}),signal);
    if(!content.content.trim())throw new Error("Resolved /pr skill is empty.");
    loaded.push({id:candidate.id,...content});
  }
  if(loaded.some(copy=>copy.content!==loaded[0]!.content))throw new Error("Ambiguous /pr skills contain different body policies in the author's workspace; resolve that source conflict before body writing.");
  return{text:loaded[0]!.content,source:{id:loaded[0]!.id,revision:loaded[0]!.revision,sha256:createHash('sha256').update(loaded[0]!.content).digest('hex')},identity:[thread.projectId,thread.environmentId,thread.providerId??null,loaded.map(copy=>[copy.id,copy.revision])]};
}
