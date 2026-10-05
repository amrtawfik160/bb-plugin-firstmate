// Installed BB fixture paths, resolved without invoking a server or CLI command.
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,join} from 'node:path';

export function resolveInstalledBbRuntime(entrypoint) {
 const binary=realpathSync(entrypoint);
 let candidate=dirname(binary);
 // Both official entrypoints live within three levels of bb-app/package.json.
 // Bound the walk; do not search unrelated directories or fall back to source.
 for(let depth=0;depth<6;depth++){
  const manifestPath=join(candidate,'package.json');
  if(existsSync(manifestPath)){
   const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
   if(manifest.name==='bb-app'){
    const packageRoot=candidate;
    if(manifest.bin?.bb!=='dist/bb.js')throw new Error('Unsupported installed bb-app CLI manifest: '+manifestPath);
    const javascriptCli=join(packageRoot,manifest.bin.bb),nativeCli=join(packageRoot,'host-daemon/dist/bb');
    const serverPath=join(packageRoot,'server/dist/index.js'),daemonPath=join(packageRoot,'host-daemon/dist/daemon-bundle.mjs');
    if(![javascriptCli,nativeCli].includes(binary))throw new Error('Unsupported official BB entrypoint: '+binary);
    for(const path of [javascriptCli,nativeCli,serverPath,daemonPath]){
     if(!existsSync(path) || !lstatSync(path).isFile())throw new Error('Missing installed BB runtime artifact: '+path);
    }
    return {packageRoot,javascriptCli,nativeCli,serverPath,daemonPath};
   }
  }
  const parent=dirname(candidate);if(parent===candidate)break;candidate=parent;
 }
 throw new Error('No supported installed bb-app package for entrypoint: '+binary);
}
