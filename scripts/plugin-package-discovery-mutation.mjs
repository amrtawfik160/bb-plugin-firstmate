// Restore the confirmed directory-root error in a private install candidate.
import assert from 'node:assert/strict';import {cpSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
const root=resolve('.'),candidate=mkdtempSync(join(tmpdir(),'fm-package-mutation-'));
try{
 cpSync(root,candidate,{recursive:true,filter:p=>!['.git','node_modules','dist','__pycache__'].includes(basename(p))});
 symlinkSync(join(root,'node_modules'),join(candidate,'node_modules'),'dir');
 const path=join(candidate,'package.json'),manifest=JSON.parse(readFileSync(path));
 manifest.bb.skills=['entry-skills/captain','entry-skills/firstmate'];writeFileSync(path,JSON.stringify(manifest,null,2)+'\n');
 const result=spawnSync(process.execPath,['--test','--experimental-strip-types','scripts/plugin-package-discovery.test.mjs'],{cwd:candidate,env:{...process.env,FIRSTMATE_KEEP_PACKAGE_EVIDENCE:'0'},encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024});
 assert.equal(result.status,1,result.stdout+result.stderr);assert.doesNotMatch(result.stdout+result.stderr,/SyntaxError|ERR_MODULE_NOT_FOUND/);
 assert.match(result.stdout+result.stderr,/actual BB root discovery must supply|unknown skill id/,'mutation must fail through actual BB package discovery');
 console.log('KILLED individual-skill paths used as package roots: actual installed BB fails the causal discovery assertion. Source and production untouched.');
}finally{rmSync(candidate,{recursive:true,force:true});}
