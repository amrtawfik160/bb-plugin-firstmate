import {basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
/** BB source entry and `bb plugin build`'s dist/server.js share one package.
 * Only package-relative paths are permitted; never search a server checkout. */
export function pluginAssetRoot(moduleUrl:string):string {
  const directory=dirname(fileURLToPath(moduleUrl));
  return basename(directory)==='dist'?dirname(directory):directory;
}
