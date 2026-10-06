// Actual installed BB package discovery. Own server/data/HOME/ports only; no
// production enrollment, thread spawn, native home operation or model invocation.
import assert from 'node:assert/strict';import test from 'node:test';
import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {dirname,join,resolve} from 'node:path';import {createServer} from 'node:net';
import {createFakePluginHost,makePluginAgentConfigurationContext} from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';import {followRuntimeReferences} from './captain-packaging-check.mjs';
import {METHOD_ASSET_HASHES} from '../lib/method-assets.ts';
import {resolveInstalledBbRuntime} from './bb-runtime-fixture.mjs';
import {acceptancePreflight} from './acceptance-preflight.mjs';import {createHash} from 'node:crypto';
const exec=promisify(execFile),root=resolve('.');
async function freePort(){const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));return port;}
const discoveryEnv={...process.env};for(const key of Object.keys(discoveryEnv))if(key.startsWith('BB_'))delete discoveryEnv[key];
const pathBinary=realpathSync((await exec('sh',['-c','command -v bb'],{env:discoveryEnv})).stdout.trim());

test('installed BB runtime lookup accepts both official entrypoints from the same package',()=>{
 const runtime=resolveInstalledBbRuntime(pathBinary);
 for(const binary of [runtime.javascriptCli,runtime.nativeCli])assert.deepEqual(resolveInstalledBbRuntime(binary),runtime);
 assert.throws(()=>resolveInstalledBbRuntime(runtime.serverPath),/Unsupported official BB entrypoint/);
});

for(const entrypoint of ['javascriptCli','nativeCli'])test('installed BB discovers only shipped entry skills and resolves actual role configuration via '+entrypoint, {timeout:90000},async()=>{
 const located=resolveInstalledBbRuntime(pathBinary),runtime=resolveInstalledBbRuntime(located[entrypoint]),binary=runtime[entrypoint],serverPath=runtime.serverPath;
 const home=mkdtempSync(join(tmpdir(),'fm-package-discovery-')),data=join(home,'data');mkdirSync(data);
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('BB_'))delete env[key];
 const port=await freePort();let daemonPort=await freePort();
 for(let n=0;daemonPort===port && n<8;n++)daemonPort=await freePort();assert.notEqual(daemonPort,port,'distinct owned ports required');
 Object.assign(env,{HOME:home,BB_DATA_DIR:data,BB_SERVER_LAUNCH_ID:home,BB_SERVER_URL:`http://127.0.0.1:${port}`,BB_SERVER_PORT:String(port),BB_SERVER_BIND_HOST:'127.0.0.1',BB_HOST_DAEMON_PORT:String(daemonPort)});
 const logPath=join(home,'server.log'),fd=openSync(logPath,'w'),server=spawn(process.execPath,[serverPath],{env,stdio:['ignore',fd,fd]});closeSync(fd);
 let daemon;
 const cli=async args=>JSON.parse((await exec(binary,args,{env,timeout:30000,maxBuffer:4*1024*1024})).stdout);
 try{
  let ready=false;
  for(let n=0;n<100;n++){
   if(server.exitCode!==null)throw new Error('Owned BB server exited: '+readFileSync(logPath,'utf8'));
   try{const health=await fetch(env.BB_SERVER_URL+'/health',{signal:AbortSignal.timeout(500)});if(health.ok && (await health.json()).launchId===home){ready=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(ready,'owned BB server ready within bounded startup');
  // Same loopback bootstrap seam used by BB's launcher, in this test's owned
  // server only. Keep the credential in memory; never copy production auth.
  const bootstrap=await fetch(env.BB_SERVER_URL+'/internal/hosts/enroll-key',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
  assert.equal(bootstrap.status,201);const credential=await bootstrap.json();
  const daemonFd=openSync(join(home,'daemon.log'),'w');
  daemon=spawn(process.execPath,[runtime.daemonPath],{env:{...env,BB_CLI_DIR:dirname(runtime.nativeCli),BB_HOST_ID:credential.hostId,BB_HOST_ENROLL_KEY:credential.enrollKey},stdio:['ignore',daemonFd,daemonFd]});closeSync(daemonFd);
  let connected=false;
  for(let n=0;n<100;n++){
   if(daemon.exitCode!==null)throw new Error('Owned daemon exited: '+readFileSync(join(home,'daemon.log'),'utf8'));
   try{const health=await fetch(`http://127.0.0.1:${daemonPort}/health`,{signal:AbortSignal.timeout(500)});if(health.ok){connected=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(connected,'owned daemon ready within bounded startup');
  await cli(['plugin','install',root,'--yes','--json']);
  const result=await cli(['skill','list','--json']);
  const entries=result.skills.filter(s=>s.pluginId==='firstmate');
  const ids=entries.map(s=>s.name.replace(/^firstmate:/,'')).sort();
  assert.deepEqual(ids,['captain','firstmate'],'actual BB root discovery must supply both bootstrap skills and no native/method bodies');
  const source=join(root,'entry-skills');
  for(const entry of entries){assert.ok(entry.filePath.includes('/entry-skills/'));assert.ok(readFileSync(entry.filePath,'utf8').length);}
  for(const entry of ['captain/SKILL.md','firstmate/SKILL.md'])followRuntimeReferences(source,entry);
  const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:ids});await plugin(host.bb);
  try{
   for(const [metadata,skills] of [[{},['captain','firstmate']],[{captain:'true'},['captain','firstmate']],[{crew:'true',captain:'true'},[]]]){
    const cfg=await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({pluginMetadata:metadata}));assert.deepEqual(cfg.skills.sort(),skills);
    if(metadata.crew)assert.deepEqual(cfg.tools,[]);
   }
  }finally{await host.harness.lifecycle.dispose();}
  const state=await cli(['plugin','list','--json']);
  const installed=state.plugins.find(p=>p.id==='firstmate');
  for(const [asset,expectedHash] of Object.entries(METHOD_ASSET_HASHES))assert.equal(createHash('sha256').update(readFileSync(join(installed.rootDir,'skills',asset))).digest('hex'),expectedHash,'installed selected method asset '+asset);
  const selected=createFakePluginHost({pluginId:'firstmate',agentSkillIds:ids,settings:{selectedMethods:'selected-v1'}});await plugin(selected.bb);
  try{
   for(const role of [{captain:'true'},{crew:'true',captain:'true',shape:'ship',posture:'direct-PR'}]){
    const cfg=await selected.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({pluginMetadata:role}));
    assert.ok(cfg.tools.some(t=>t.name==='firstmate_methods'));assert.ok(!cfg.skills.some(id=>id.includes('methods')));assert.doesNotMatch(cfg.instructions,/Calm/);
    assert.match(cfg.instructions,role.crew?/worker-methods/:/captain-methods/);
   }
  }finally{await selected.harness.lifecycle.dispose();}

  const machines=await cli(['machine','list','--json']);const machine=machines.find(h=>h.status==='connected');assert.ok(machine,'exact owned host available: '+JSON.stringify(machines));
  const expected={serverUrl:env.BB_SERVER_URL,launchId:home,dataDir:data,pluginRoot:installed.rootDir,hostId:machine.id,
    buildSha256:createHash('sha256').update(readFileSync(join(installed.rootDir,'dist/server.js'))).digest('hex'),release:JSON.parse(readFileSync(join(installed.rootDir,'runtime-assets/distribution.json'))).release};
  const preflight=()=>acceptancePreflight(expected,{binary,environment:env});
  await cli(['plugin','disable','firstmate','--json']);
  await assert.rejects(preflight(),/not enabled\/running/);
  await cli(['plugin','reload','firstmate','--json']);
  await assert.rejects(preflight(),/not enabled\/running/,'reload must not be mistaken for enabling');
  await cli(['plugin','enable','firstmate','--json']);
  let accepted;
  for(let n=0;n<50;n++){try{accepted=await preflight();break;}catch(error){if(n===49)throw error;await new Promise(r=>setTimeout(r,100));}}
  assert.equal(accepted.plugin.running,true);assert.equal(accepted.selectedRuntime.checked,false);assert.equal(accepted.modelLaunchObserved,false);
  await assert.rejects(acceptancePreflight({...expected,launchId:'wrong-server'},{binary,environment:env}),/Wrong server launch identity/);
  await assert.rejects(acceptancePreflight({...expected,hostId:'host_foreign'},{binary,environment:env}),/absent\/disconnected/);
  await assert.rejects(acceptancePreflight({...expected,buildSha256:'0'.repeat(64)},{binary,environment:env}),/reviewed artifact hash/);
  writeFileSync(join(home,'evidence.json'),JSON.stringify({entrypoint,binary,runtime,entries,state},null,2));
 }catch(error){throw new Error(String(error)+'\nOwned server log: '+logPath+'\n'+readFileSync(logPath,'utf8').slice(-6000));}
 finally{
  for(const child of [daemon,server].filter(Boolean)){
   if(child.exitCode!==null)continue;
   child.kill('SIGTERM');let timer;
   await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>{timer=setTimeout(()=>{child.kill('SIGKILL');r();},3000);})]);clearTimeout(timer);
  }
  if(process.env.FIRSTMATE_KEEP_PACKAGE_EVIDENCE==='1')console.log('Owned package-discovery evidence: '+home);else rmSync(home,{recursive:true,force:true});
 }
});
