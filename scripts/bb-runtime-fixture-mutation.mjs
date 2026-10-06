// Restore the fixed-depth runtime lookup in a private fixture candidate only.
import assert from 'node:assert/strict';import {cpSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
const root=resolve('.'),candidate=mkdtempSync(join(tmpdir(),'fm-runtime-lookup-mutation-'));
try{
 cpSync(root,candidate,{recursive:true,filter:p=>!['.git','node_modules','dist','__pycache__'].includes(basename(p))});
 symlinkSync(join(root,'node_modules'),join(candidate,'node_modules'),'dir');
 const path=join(candidate,'scripts/bb-runtime-fixture.mjs'),source=readFileSync(path,'utf8');
 assert.ok(source.includes('const packageRoot=candidate;'));
 writeFileSync(path,source.replace('const packageRoot=candidate;',"const packageRoot=dirname(dirname(dirname(binary)));"));
 const result=spawnSync(process.execPath,['--test','--test-reporter=tap','--experimental-strip-types','scripts/plugin-package-discovery.test.mjs'],{cwd:candidate,encoding:'utf8',env:{...process.env,FIRSTMATE_KEEP_PACKAGE_EVIDENCE:'0'},timeout:90000,maxBuffer:4*1024*1024});
 const output=result.stdout+result.stderr;
 assert.equal(result.status,1,output);assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND/);
 assert.match(output,/Unsupported official BB entrypoint/,'old fixed-depth lookup must refuse the JavaScript launcher at the causal assertion');
 assert.match(output,/not ok .*runtime lookup accepts both official entrypoints/);
 assert.match(output,/not ok .*role configuration via javascriptCli/);
 assert.match(output,/\nok .*role configuration via nativeCli/);
 console.log('KILLED fixed two-parent runtime lookup: official JavaScript entrypoint fails package identity validation. Source and production untouched.');
}finally{rmSync(candidate,{recursive:true,force:true});}
