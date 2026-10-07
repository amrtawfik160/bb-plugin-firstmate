/** Plugin-owned native assets, staged only through public SDK host files/terminals.
 * Release code and selected captain state have separate durable identities. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import type {BbPluginApi} from '@get-bb/plugin-sdk';

type Distribution = {
  schema:1; release:string; archiveSha256:string; archiveBytes:number; helperSha256:string;
  auditedSources:string[]; pluginVersion:string; upstreamCommit:string; snapshotCommit:string; adapterRevision:string; stateContract:string;
};
const hash = (data:Buffer) => createHash('sha256').update(data).digest('hex');
const quote = (text:string) => `'${text.replaceAll("'", "'\\''")}'`;
export function loadRuntimeAssets(directory:string) {
  const distribution:Distribution = JSON.parse(readFileSync(join(directory,'distribution.json'),'utf8'));
  const archive=readFileSync(join(directory,'runtime.tar.gz')), helper=readFileSync(join(directory,'runtime-host.py'));
  if (distribution.schema!==1 || distribution.stateContract!=='native-flat-v1' ||
      !/^[0-9a-f]{64}$/.test(distribution.release) || hash(archive)!==distribution.archiveSha256 ||
      archive.length!==distribution.archiveBytes || hash(helper)!==distribution.helperSha256) {
    throw new Error('Bundled native assets are incomplete or mismatched; reinstall this tested plugin release. No external source fallback.');
  }
  return {distribution,archive,helper};
}
export function createNativeRuntime(input:{
  assets:string; files:()=>BbPluginApi['sdk']['files']; disposal:AbortSignal;
  run:(host:string,command:string,budgetMs:number,signal?:AbortSignal)=>Promise<{output:string;exitCode:number|null;stderr?:string}>;
}) {
  async function operation(host:string, action:'install'|'bind-seeded'|'bind'|'status'|'inspect'|'select'|'migrate'|'rollback', args:{
    home?:string;captain?:string;release?:string;check?:boolean;consumers?:boolean;projectId?:string;parentHome?:string;parentCaptain?:string;taskId?:string;
  }={}, parent?:AbortSignal):Promise<Record<string,unknown>&{distribution:Distribution;store:string}> {
    const assets=loadRuntimeAssets(input.assets);
    const files=input.files(), remove=files.remove;
    const signal=AbortSignal.any([input.disposal,...(parent?[parent]:[]),AbortSignal.timeout(120_000)]);
    signal.throwIfAborted();
    const remoteHome=await input.run(host,`printf '%s' "$HOME"`,15_000,signal);
    if (remoteHome.exitCode!==0 || !remoteHome.output.startsWith('/') || remoteHome.output.includes('\n')) throw new Error('Cannot resolve the selected host user home for bundled runtime storage.');
    const store=`${remoteHome.output}/.local/share/bb-firstmate`;
    const temporary=`/tmp/.fm-runtime-${randomUUID()}`;
    const cleanup=async()=>{
      // Capture this supported method before disposal. A late SDK write can
      // recreate the private directory after the first cleanup has completed.
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {await Promise.race([remove({hostId:host,path:temporary,rootPath:'/tmp',recursive:true}),new Promise<void>(resolve=>{timer=setTimeout(resolve,1000);})]);} catch { /* exact private staging bytes only; publication remains recoverable */ }
      finally {if(timer)clearTimeout(timer);}
    };
    async function write(name:string,bytes:Buffer) {
      let lost=false;
      const pending=files.write({hostId:host,path:`${temporary}/${name}`,rootPath:temporary,
        content:bytes.toString('base64'),contentEncoding:'base64',createParents:true,expectedSha256:null,mode:0o600});
      void pending.then(()=>{if(lost)void cleanup();},()=>{});
      let remove=()=>{};
      const aborted=new Promise<never>((_,reject)=>{
        const abort=()=>{lost=true;reject(signal.reason??new Error('Runtime staging cancelled'));};
        if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
        remove=()=>signal.removeEventListener('abort',abort);
      });
      try {
        const result=await Promise.race([pending,aborted]);
        signal.throwIfAborted();
        if(result.outcome!=='written' || result.sha256!==hash(bytes)) throw new Error(`Runtime staging failed for ${name}; no publication/selection attempted.`);
      } finally {remove();}
    }
    try {
      const prepared=await input.run(host,`mkdir -m 700 -- ${quote(temporary)}`,10_000,signal);
      if(prepared.exitCode!==0)throw new Error('Cannot prepare private runtime staging directory.');
      await write('runtime-host.py',assets.helper);
      if(action==='install')await write('runtime.tar.gz',assets.archive);
      const helper=`${temporary}/runtime-host.py`;
      const verification=`python3 -c ${quote('import hashlib,sys;sys.exit(0 if hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest()==sys.argv[2] else 2)')} ${quote(helper)} ${quote(assets.distribution.helperSha256)}`;
      const options=['--store',store,'--audited-sources',JSON.stringify(assets.distribution.auditedSources),...(action==='install'?['--archive',`${temporary}/runtime.tar.gz`,'--sha256',assets.distribution.archiveSha256]:[]),
        ...(args.parentHome?['--parent-home',args.parentHome]:[]),...(args.parentCaptain?['--parent-captain',args.parentCaptain]:[]),...(args.taskId?['--task-id',args.taskId]:[]),...(args.projectId?['--project-id',args.projectId]:[]),...(args.home?['--home',args.home]:[]),...(args.captain?['--captain',args.captain,'--host',host]:[]),
        ...(action==='bind'||action==='bind-seeded'||action==='select'||action==='migrate'||action==='rollback'||action==='status' && args.release?['--release',args.release??assets.distribution.release]:[]),...(args.check?['--check']:[]),...(args.consumers?['--consumers']:[])];
      signal.throwIfAborted();
      const result=await input.run(host,`${verification} && python3 ${quote(helper)} ${quote(action)} ${options.map(quote).join(' ')}`,90_000,signal);
      if(result.exitCode!==0)throw new Error(result.stderr||result.output||`Runtime ${action} failed (${result.exitCode}); no readiness claimed.`);
      const resultData=JSON.parse(result.output) as Record<string,unknown>;
      return {distribution:assets.distribution,store,...resultData};
    } finally {await cleanup();}
  }
  return {operation,manifest:()=>loadRuntimeAssets(input.assets).distribution};
}

/** Read one atomic home selection and verify its published helper/version before
 * selecting code. External homes keep their original root and path semantics. */
export function runtimeRootAssign(home:string) {
  const resolveCode=[
    'import hashlib,json,os,pathlib,re,subprocess,sys',
    'home=pathlib.Path(sys.argv[1]);value=json.loads((home/"config/bb-runtime-selected.json").read_text())',
    'assert value["schema"]==1 and value["stateContract"]=="native-flat-v1" and re.fullmatch("[0-9a-f]{64}",value["release"])',
    'store=pathlib.Path(value["store"]);assert store.is_absolute()',
    'helper=store/"versions"/value["release"]/"runtime-host.py"',
    'assert not helper.is_symlink() and hashlib.sha256(helper.read_bytes()).hexdigest()==value["helperSha256"]',
    'host=os.environ.get("FM_BB_MACHINE") or value["host"];assert host==value["host"]',
    'root=subprocess.check_output([sys.executable,str(helper),"resolve","--store",str(store),"--home",str(home),"--captain",value["captain"],"--host",host],text=True).strip()',
    'assert root==value["root"] and root.startswith("/") and "\\n" not in root;print(root)',
  ].join(';');
  return `unset FM_BUNDLED_VERIFIED; FM_RUNTIME_ROOT=${quote(home)}; if [ -f ${quote(`${home}/config/bb-runtime-selected.json`)} ]; then FM_RUNTIME_ROOT=$(python3 -c ${quote(resolveCode)} ${quote(home)}) || exit 1; export FM_BUNDLED_VERIFIED=1; fi; export FM_ROOT="$FM_RUNTIME_ROOT" FM_ROOT_OVERRIDE="$FM_RUNTIME_ROOT"`;
}
