// Restore each reviewed defect in private copies; require a causal assertion.
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
const root=resolve('.'),copy=mkdtempSync(join(tmpdir(),'fm-trigger-mutations-')),env={...process.env};
for(const key of ['BB_CLI','BB_INFERENCE','BB_INFERENCE_FALLBACK','BB_TRANSCRIPTION','BB_THREAD_ID','BB_PROJECT_ID','BB_ENVIRONMENT_ID','BB_HOST_ID','BB_SERVER_URL','BB_HOST_DAEMON_PORT','BB_DATA_DIR'])delete env[key];
try{
 for(const path of ['package.json','server.ts','rpc.ts','server.native-policy.test.mjs','lib','overlay','skills','entry-skills','scripts','runtime-assets','docs'])cpSync(join(root,path),join(copy,path),{recursive:true,filter:p=>!p.includes('__pycache__')});
 symlinkSync(join(root,'node_modules'),join(copy,'node_modules'),'dir');
 function killed(name,file,from,to,pattern,diagnostic){
  const path=join(copy,file),original=readFileSync(path,'utf8');assert.ok(original.includes(from),'anchor: '+name);
  try{
   writeFileSync(path,original.replace(from,to));
   const r=spawnSync(process.execPath,['--test','--experimental-strip-types','--test-name-pattern='+pattern,'server.native-policy.test.mjs'],{cwd:copy,env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
   assert.equal(r.status,1,name+' must fail\n'+r.stdout+r.stderr);assert.doesNotMatch(r.stdout+r.stderr,/SyntaxError|ERR_MODULE_NOT_FOUND/);assert.match(r.stdout+r.stderr,diagnostic);
   console.log('KILLED '+name);
  }finally{writeFileSync(path,original);}
 }
 killed('missing required trigger catalog','lib/native-policy.ts','result.update(entries=entries,','result.update(entries=[],','selected 2d833ff1',/complete selected native trigger inventory/);
 killed('multiline description truncation','lib/native-policy.ts','frontmatter=match[1]','frontmatter=match[1].splitlines()[0]','selected 1f3e7696',/complete verbatim trigger frontmatter/);
 killed('global home catalog instead of selected home','lib/native-policy.ts','root=pathlib.Path(sys.argv[1]);','root=pathlib.Path(os.environ["HOME"]);','trigger catalog stays complete',/catalog must match selected home revision/);
 killed('unbound global contract fallback','server.ts','if (!homeScope.getStore()?.captain || !homeScope.getStore()?.home)','if (false)','unbound captain cannot consume',/0 !== 1/);
 killed('valid native relative links refused','lib/native-policy.ts','const base=normalize(source','if (reference?.includes("..")) throw new Error("Traversal refused");\n  const base=normalize(source','native relative references 1f3e7696',/Traversal refused/);
 killed('source file provenance ignored','lib/native-policy.ts'," verified(request['base'])"," pass # source verification removed",'reference escapes, symlinks',/0 !== 1/);
 killed('SDK transfer corruption accepted','server.ts',"if (data.length!==record.sizeBytes || createHash('sha256').update(data).digest('hex')!==record.sha256)",'if (false)','reference escapes, symlinks',/0 !== 1/);
 console.log('7/7 reviewed-defect mutations killed; source checkout and external homes untouched.');
}finally{rmSync(copy,{recursive:true,force:true});}
