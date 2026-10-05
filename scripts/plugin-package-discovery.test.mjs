// Actual installed BB package discovery. Own server/data/HOME/ports only; no
// production enrollment, thread spawn, native home operation or model invocation.
import assert from 'node:assert/strict';import test from 'node:test';
import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {dirname,join,resolve} from 'node:path';import {createServer} from 'node:net';
import {createFakePluginHost,makePluginAgentConfigurationContext} from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';import {followRuntimeReferences} from './captain-packaging-check.mjs';
const exec=promisify(execFile),root=resolve('.');
async function freePort(){const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));return port;}

test('installed BB discovers only shipped entry skills and resolves actual role configuration', {timeout:90000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'fm-package-discovery-')),data=join(home,'data');mkdirSync(data);
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('BB_'))delete env[key];
 const port=await freePort();let daemonPort=await freePort();
 for(let n=0;daemonPort===port && n<8;n++)daemonPort=await freePort();assert.notEqual(daemonPort,port,'distinct owned ports required');
 Object.assign(env,{HOME:home,BB_DATA_DIR:data,BB_SERVER_LAUNCH_ID:home,BB_SERVER_URL:`http://127.0.0.1:${port}`,BB_SERVER_PORT:String(port),BB_SERVER_BIND_HOST:'127.0.0.1',BB_HOST_DAEMON_PORT:String(daemonPort)});
 const binary=realpathSync((await exec('sh',['-c','command -v bb'],{env})).stdout.trim());
 const packageRoot=resolve(dirname(binary),'../..'),serverPath=join(packageRoot,'server/dist/index.js');
 assert.ok(readFileSync(serverPath).length,'installed BB runtime required');
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
  daemon=spawn(process.execPath,[join(packageRoot,'host-daemon/dist/daemon-bundle.mjs')],{env:{...env,BB_CLI_DIR:dirname(binary),BB_HOST_ID:credential.hostId,BB_HOST_ENROLL_KEY:credential.enrollKey},stdio:['ignore',daemonFd,daemonFd]});closeSync(daemonFd);
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
  writeFileSync(join(home,'evidence.json'),JSON.stringify({entries,state},null,2));
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
