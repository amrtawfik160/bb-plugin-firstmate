// Read-only, explicit owned-fixture preflight. Does not bind, enable or launch.
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {readFileSync,realpathSync} from 'node:fs';import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
const exec=promisify(execFile);
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
export function validateAcceptance(snapshot,expected) {
 if(snapshot.health.launchId!==expected.launchId)throw new Error('Wrong server launch identity. No model launch is permitted.');
 if(realpathSync(snapshot.status.dataDir)!==realpathSync(expected.dataDir))throw new Error('Wrong server data directory.');
 if(snapshot.version!=='0.44.0')throw new Error('Unsupported BB acceptance CLI: '+snapshot.version+'; expected audited 0.44.0.');
 const plugins=snapshot.plugins.plugins.filter(p=>p.id==='firstmate');
 if(plugins.length!==1)throw new Error('Firstmate is not uniquely registered.');
 const plugin=plugins[0];
 if(plugin.enabled!==true || plugin.status!=='running')throw new Error(`Firstmate registered but not enabled/running: enabled=${plugin.enabled}, status=${plugin.status}. Reload does not enable. Owner must prepare this exact isolated fixture.`);
 if(realpathSync(plugin.rootDir)!==realpathSync(expected.pluginRoot))throw new Error('Wrong installed plugin root.');
 if(!/^[a-f0-9]{64}$/.test(expected.buildSha256) || digest(join(plugin.rootDir,'dist/server.js'))!==expected.buildSha256)throw new Error('Installed build differs from the explicit reviewed artifact hash.');
 const distribution=JSON.parse(readFileSync(join(plugin.rootDir,'runtime-assets/distribution.json')));
 if(distribution.release!==expected.release || digest(join(plugin.rootDir,'runtime-assets/runtime.tar.gz'))!==distribution.archiveSha256)throw new Error('Wrong or corrupt bundled runtime.');
 const hosts=snapshot.hosts.filter(h=>h.id===expected.hostId);
 if(hosts.length!==1 || hosts[0].status!=='connected')throw new Error('Exact execution host is absent/disconnected.');
 if(expected.projectId && !snapshot.environments?.some(e=>e.projectId===expected.projectId && e.hostId===expected.hostId && e.status==='ready'))throw new Error('No ready environment on the exact project/host.');
 return {scope:'pre-model fixture prerequisites',server:expected.serverUrl,launchId:expected.launchId,hostId:expected.hostId,
  plugin:{registered:true,enabled:true,running:true,root:plugin.rootDir,buildSha256:expected.buildSha256},
  bundledRuntime:{release:distribution.release,upstreamCommit:distribution.upstreamCommit,archiveVerified:true},
  selectedRuntime:{checked:false,reason:'Per-captain selection/read-back and native harness startup are required after deck binding; no home was read or changed.'},
  project:expected.projectId??null,modelLaunchObserved:false};
}
export async function acceptancePreflight(expected,{binary='bb',environment=process.env,fetcher=fetch}={}) {
 const url=new URL(expected.serverUrl);
 if(url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname!=='/')throw new Error('Use an explicit loopback owned server origin.');
 for(const key of ['launchId','dataDir','pluginRoot','hostId','buildSha256','release'])if(!expected[key])throw new Error('Missing exact acceptance identity: '+key);
 const env={...environment};for(const key of Object.keys(env))if(key.startsWith('BB_'))delete env[key];env.BB_SERVER_URL=url.origin;
 const health=await fetcher(url.origin+'/health',{signal:AbortSignal.timeout(5000)});
 if(!health.ok)throw new Error('Owned server health lookup failed: '+health.status);
 const identity=await health.json();if(identity.launchId!==expected.launchId)throw new Error('Wrong server launch identity; no CLI reads performed.');
 const cli=async args=>{const r=await exec(binary,args,{env,timeout:10_000,maxBuffer:1024*1024});const result=JSON.parse(r.stdout);if(result?.ok===false)throw new Error('Acceptance read failed: '+JSON.stringify(result.error));return result;};
 const version=(await exec(binary,['--version'],{env,timeout:5000,maxBuffer:4096})).stdout.trim();
 const [status,plugins,hosts]=await Promise.all([cli(['status','--json']),cli(['plugin','list','--json']),cli(['machine','list','--json'])]);
 const environments=expected.projectId?await cli(['environment','list','--project',expected.projectId,'--host',expected.hostId,'--status','ready','--limit','20','--json']):undefined;
 return validateAcceptance({health:identity,version,status,plugins,hosts,environments},expected);
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 try {const path=process.argv[2];if(!path)throw new Error('Usage: node scripts/acceptance-preflight.mjs <owned-expectations.json>; see CONTRIBUTING.md acceptance preflight.');console.log(JSON.stringify(await acceptancePreflight(JSON.parse(readFileSync(path))),null,2));}
 catch(error){console.error(String(error));process.exitCode=1;}
}
