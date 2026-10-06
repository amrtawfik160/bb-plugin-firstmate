#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,openSync,closeSync,existsSync,rmSync,readdirSync,realpathSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const {resolveInstalledBbRuntime}=await import(pathToFileURL(join(root,'scripts/bb-runtime-fixture.mjs')));
const {acceptancePreflight}=await import(pathToFileURL(join(root,'scripts/acceptance-preflight.mjs')));
const execute=promisify(execFile),args=process.argv.slice(2);
const features={
 package:null,
 runtime:['scripts/native-runtime.test.mjs','audit regression: generated runtime'],
 assignments:['server.launch-delivery.test.mjs','audit regression: (same-ID|cache-loss|legacy cache loss|ambiguous legacy|legacy task migration)'],
 'pull-requests':['server.launch-delivery.test.mjs','audit regression: public PR reconciliation'],
 instructions:['server.methods.test.mjs',null],
};
function option(name){const at=args.indexOf(name);if(at<0)return undefined;if(!args[at+1] || args[at+1].startsWith('--'))throw new Error('Missing value for '+name);return args[at+1];}
const feature=option('--feature')??'package',evidence=option('--evidence');
assert.ok(feature in features,'Use --feature package|runtime|assignments|pull-requests|instructions');
assert.ok(evidence,'Supply --evidence with a new or empty directory outside the checkout');
assert.equal(args.length,(args.includes('--feature')?2:0)+2,'Only --feature and --evidence are supported');
const saved=resolve(evidence);
assert.ok(saved!==root && !saved.startsWith(root+'/'),'Keep verification evidence outside the project');
mkdirSync(saved,{recursive:true,mode:0o700});assert.equal(readdirSync(saved).length,0,'Evidence directory must be empty; previous proof is preserved');
const baseEnv=Object.fromEntries(['PATH','LANG','LC_ALL','TZ','SHELL','USER','LOGNAME','TERM'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
const home=mkdtempSync(join(tmpdir(),'firstmate-verify-owned-')),data=join(home,'data');mkdirSync(data);
const children=[],commands=[],abort=new AbortController();
const stop=()=>abort.abort(new Error('Verification interrupted'));
process.once('SIGINT',stop);process.once('SIGTERM',stop);
const save=(name,value)=>writeFileSync(join(saved,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
async function port(){const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const value=socket.address().port;await new Promise(r=>socket.close(r));return value;}
function start(program,argv,env,name){const fd=openSync(join(saved,name),'w',0o600);try{const child=spawn(program,argv,{cwd:root,env,stdio:['ignore',fd,fd]});children.push(child);return child;}finally{closeSync(fd);}}
async function waitFor(check,child){const deadline=Date.now()+20_000;while(Date.now()<deadline){abort.signal.throwIfAborted();if(child.exitCode!==null)throw new Error('Owned service exited before readiness');try{if(await check())return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('Owned service readiness exceeded 20 seconds');}
async function command(program,argv,env){
 const entry={program,args:argv};commands.push(entry);
 try {const result=await execute(program,argv,{cwd:root,env,signal:abort.signal,timeout:120_000,maxBuffer:8*1024*1024});Object.assign(entry,{exitCode:0,stdout:result.stdout,stderr:result.stderr});return result.stdout;}
 catch(error){Object.assign(entry,{exitCode:error.code??null,stdout:error.stdout??'',stderr:error.stderr??'',error:error.message});throw error;}
 finally{save('commands.json',commands);}
}
let outcome;
try {
 const built=join(root,'dist/server.js');assert.ok(existsSync(built),'Build the current candidate with bb plugin build . first');
 const buildSha256=createHash('sha256').update(readFileSync(built)).digest('hex');
 const distribution=JSON.parse(readFileSync(join(root,'runtime-assets/distribution.json')));
 const binary=realpathSync((await execute('sh',['-c','command -v bb'],{env:baseEnv})).stdout.trim());
 const runtime=resolveInstalledBbRuntime(binary),httpPort=await port();let daemonPort=await port();while(httpPort===daemonPort)daemonPort=await port();
 const env={...baseEnv,HOME:home,BB_DATA_DIR:data,BB_SERVER_LAUNCH_ID:home,BB_SERVER_URL:`http://127.0.0.1:${httpPort}`,BB_SERVER_PORT:String(httpPort),BB_SERVER_BIND_HOST:'127.0.0.1',BB_HOST_DAEMON_PORT:String(daemonPort)};
 const server=start(process.execPath,[runtime.serverPath],env,'server.log');
 await waitFor(async()=>{const response=await fetch(env.BB_SERVER_URL+'/health',{signal:AbortSignal.timeout(500)});return response.ok && (await response.json()).launchId===home;},server);
 // Same private loopback enrollment used by BB's launcher. Only this run's
 // credential stays in memory; evidence contains the public host identity.
 const response=await fetch(env.BB_SERVER_URL+'/internal/hosts/enroll-key',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
 assert.equal(response.status,201);const credential=await response.json();
 const daemon=start(process.execPath,[runtime.daemonPath],{...env,BB_CLI_DIR:dirname(runtime.nativeCli),BB_HOST_ID:credential.hostId,BB_HOST_ENROLL_KEY:credential.enrollKey},'daemon.log');
 await waitFor(async()=>{const response=await fetch(`http://127.0.0.1:${daemonPort}/health`,{signal:AbortSignal.timeout(500)});return response.ok;},daemon);
 const cli=async argv=>JSON.parse(await command(runtime.nativeCli,argv,env));
 await cli(['plugin','install',root,'--yes','--json']);
 const hosts=await cli(['machine','list','--json']);assert.ok(hosts.some(h=>h.id===credential.hostId && h.status==='connected'));
 const expected={serverUrl:env.BB_SERVER_URL,launchId:home,dataDir:data,pluginRoot:root,hostId:credential.hostId,buildSha256,release:distribution.release};
 save('expectations.json',expected);
 const doctor=await acceptancePreflight(expected,{binary:runtime.nativeCli,environment:env});save('doctor.json',doctor);
 assert.equal(doctor.modelLaunchObserved,false);
 const inventory=await cli(['skill','list','--json']);const entrySkills=inventory.skills.filter(s=>s.pluginId==='firstmate');
 assert.deepEqual(entrySkills.map(s=>s.name.replace(/^firstmate:/,'')).sort(),['captain','firstmate']);
 const settings=await cli(['firstmate','methods','status','--json']);assert.equal(settings.profile,'off');
 if(features[feature]){
  const [file,pattern]=features[feature];
  const output=await command(process.execPath,['--test','--experimental-strip-types','--test-reporter=tap',...(pattern?['--test-name-pattern='+pattern]:[]),file],{...baseEnv,HOME:home});
  writeFileSync(join(saved,'drive.tap'),output,{mode:0o600});
  assert.match(output,/^# fail 0$/m);assert.match(output,/^# skipped 0$/m);assert.match(output,/^# tests [1-9]\d*$/m);
 }
 outcome={passed:true,feature,buildSha256,release:distribution.release,realBbServer:true,realBbHost:true,realBbCli:true,
  realNativeScripts:feature==='runtime',mockedSdkBoundary:['assignments','pull-requests','instructions'].includes(feature),
  realModelWorker:false,realForge:false,entrySkills:entrySkills.map(s=>s.name),methodsProfile:settings.profile};
 save('result.json',outcome);
} catch(error){save('result.json',{passed:false,feature,error:error.message});process.exitCode=1;}
finally {
 process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
 for(const child of children.reverse()){
  if(child.exitCode!==null || child.signalCode!==null)continue;
  const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');let timer;
  await Promise.race([exited,new Promise(r=>{timer=setTimeout(()=>{child.kill('SIGKILL');r();},3000);})]);clearTimeout(timer);
  if(child.exitCode===null && child.signalCode===null)await Promise.race([exited,new Promise(r=>setTimeout(r,1000))]);
 }
 const stopped=children.every(child=>child.exitCode!==null || child.signalCode!==null);
 rmSync(home,{recursive:true,force:true});
 const cleanup={stopped,ownedPids:children.map(child=>child.pid),scratchRemoved:!existsSync(home),evidenceRetained:existsSync(join(saved,'result.json'))};save('cleanup.json',cleanup);
 if(!stopped || !cleanup.scratchRemoved)process.exitCode=1;
 console.log(JSON.stringify({passed:outcome?.passed===true && stopped,feature,evidence:saved,cleanup}));
}
