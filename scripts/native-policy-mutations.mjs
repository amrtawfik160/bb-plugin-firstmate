// Each restored defect must fail an actual SDK/native behavior regression.
// Copy candidates privately; never mutate the source checkout or native homes.
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const root=resolve('.'),copy=mkdtempSync(join(tmpdir(),'fm-policy-mutations-'));
const env={...process.env};
for(const key of ['BB_CLI','BB_INFERENCE','BB_INFERENCE_FALLBACK','BB_TRANSCRIPTION','BB_THREAD_ID','BB_PROJECT_ID','BB_ENVIRONMENT_ID','BB_HOST_ID','BB_SERVER_URL','BB_HOST_DAEMON_PORT','BB_DATA_DIR'])delete env[key];
try {
 for(const path of ['package.json','server.ts','rpc.ts','server.test.ts','server.native-policy.test.mjs','server.methods.test.mjs','server.launch-delivery.test.mjs','lib','overlay','skills','scripts','runtime-assets','docs'])cpSync(join(root,path),join(copy,path),{recursive:true,filter:path=>!path.includes('__pycache__')});
 symlinkSync(join(root,'node_modules'),join(copy,'node_modules'),'dir');
 function killed(name,file,from,to,testFile,pattern,diagnostic) {
   const path=join(copy,file),original=readFileSync(path,'utf8');assert.ok(original.includes(from),'mutation anchor: '+name);
   try {
     writeFileSync(path,original.replace(from,to));
     const r=spawnSync(process.execPath,['--test','--experimental-strip-types','--test-name-pattern='+pattern,testFile],{cwd:copy,env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
     assert.equal(r.status,1,name+' must fail its causal assertion\n'+r.stdout+r.stderr);
     assert.doesNotMatch(r.stdout+r.stderr,/SyntaxError|ERR_MODULE_NOT_FOUND/);
     assert.match(r.stdout+r.stderr,diagnostic,name+' must fail for the restored defect');
     console.log('KILLED '+name);
   }finally{writeFileSync(path,original);}
 }
 killed('mandatory worker method injection','server.ts','The native launch brief owns this worker role','Read worker-methods before work. The native launch brief owns this worker role','server.native-policy.test.mjs','selected 2d833ff1',/explicit transport review/);
 killed('global native skill manifest injection','server.ts','const skillsBlock = "";', 'const skillsBlock = marked && skillsManifestCache ? `\\n\\n${truncate(skillsManifestCache, 400)}` : "";','server.methods.test.mjs','saturated captain instruction budget',/doesNotMatch|must not match|method-0/);
 killed('changed selected policy accepted','lib/native-policy.ts','if data!=expected:', 'if False:', 'server.native-policy.test.mjs','unknown policy, changed bytes',/0 !== 1/);
 killed('unknown native revision accepted','lib/native-policy.ts','if identity not in allowed:', 'if False:', 'server.native-policy.test.mjs','unknown policy, changed bytes',/0 !== 1/);
 killed('minimal CLI help','server.ts','usage: dispatchHelp','usage: "dispatch <task>"','server.native-policy.test.mjs','registered CLI help',/dispatch <task>/);
 killed('PR artifact incorrectly terminal','lib/pr-delivery.ts',"r.status='pr-delivered'; r.blocker=", "r.status='complete'; r.blocker=",'server.launch-delivery.test.mjs','PR-only delivered artifact',/complete.*pr-delivered|pr-delivered.*complete/s);
 killed('independent check identities omitted from notification','lib/pr-delivery.ts',"(r.failures??[]).filter(f=>f.resolvedAt===null).map(f=>[f.id,f.accounting??null])",'[]','server.launch-delivery.test.mjs','PR-only delivered artifact',/strictly unequal/);
 killed('current project mode replaces existing task mode','server.ts','crew.posture === "no-mistakes"','crew.posture === "no-mistakes" || posture.mode === "no-mistakes"','server.test.ts',"merge lands a PR with zero checks",/no-mistakes|1 !== 0/);
 killed('standing approval requires another per-PR request','server.ts','if (!posture.yolo && !yes)', 'if (!yes)','server.launch-delivery.test.mjs','recorded standing yolo',/Guarded native preflight|captain.s word/);
 killed('explicit task mode silently disables native standing yolo','server.ts','return {mode:explicitMode,yolo:context.plugin?.yolo ?? context.native?.yolo ?? false};','return {mode:explicitMode,yolo:false};','server.native-policy.test.mjs','native posture 2d833ff1',/FIXTURE_NO_WORKER|false !== true/);
 killed('method policy hides in a transitive captain reference','skills/captain/references/bb.md','## Operations','Read captain-methods before all assignments.\n\n## Operations','server.native-policy.test.mjs','selected 2d833ff1',/captain transport changes require explicit review/);
 killed('orphan PR discovery changes recorded native mode','server.ts','posture:modeSchema.parse(recovered.deliveryMode)','posture:"direct-PR"','server.launch-delivery.test.mjs','durable launch orphan',/direct-PR.*no-mistakes|no-mistakes.*direct-PR/s);
 console.log('12/12 mutations killed; source checkout and external native homes untouched.');
}finally{rmSync(copy,{recursive:true,force:true});}
