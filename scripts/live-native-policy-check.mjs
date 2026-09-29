// Real native scripts on a disposable pinned home; BB worker operations recorded,
// never dispatched. Hook commands run beneath the calling agent's actual harness.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync, readdirSync, readlinkSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { cloneAtBase, discoverCheckout, INSTALLER, OVERLAY } from './fm-fixture.mjs';

const checkout = discoverCheckout();
assert.ok(checkout, 'real Firstmate checkout required');
const work = mkdtempSync(join(tmpdir(), 'fm-policy-live-'));
const home = join(work, 'home');
const thread = `thr_fmproof_${randomUUID().replaceAll('-', '')}`;
const marker = join(homedir(), '.bb-firstmate/captains', thread);
const root = join(OVERLAY, '..');
const baseline = "ee1a87afc63d377d0cf69b610c142399f08ec062";
const mutant = process.argv.find(a => a.startsWith('--mutate='))?.slice(9);
const mutantPath = join(root, `.fm-policy-mutant-${randomUUID()}.ts`);
const mutantHelper = join(root, `.fm-orphan-mutant-${randomUUID()}.ts`);
let pluginHost;
const sh = (command, options = {}) => spawnSync('bash', ['-c', command], {
  encoding: 'utf8', timeout: 45000, maxBuffer: 4 << 20, ...options,
  env: { ...process.env, FM_SESSION_START_TIMEOUT: '30', ...(options.env ?? {}) },
});
const text = result => typeof result === 'string' ? result : result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const unwrap = wrapped => {
  const m = /^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(wrapped);
  return m ? m[1].replaceAll("'\\''", "'") : wrapped;
};
const fixtureProcesses = () => readdirSync('/proc').filter(p => /^\d+$/.test(p) && Number(p) !== process.pid).filter(p => {
  try {
    const env = readFileSync(`/proc/${p}/environ`).toString().split('\0');
    const cwd = readlinkSync(`/proc/${p}/cwd`);
    return env.includes(`FM_HOME=${home}`) || cwd === home || cwd.startsWith(home+'/');
  } catch { return false; }
}).map(Number);
try {
  const cloned = cloneAtBase(checkout, home);
  assert.ok(cloned.ok, cloned.reason);
  const installed = spawnSync('python3', [INSTALLER, '--home', home, '--overlay', OVERLAY], { encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  mkdirSync(join(home,'data'),{recursive:true});
  let source = readFileSync(join(root, 'server.ts'), 'utf8');
  if (mutant === 'tool-startup') {
    source = source.replace('const startup = captainStartupCommand(current.fmHome, script, args ?? []);', 'const startup = null;');
  } else if (mutant === 'cli-startup') {
    source = source.replace('const startup = captainStartupCommand(fmHome, parsed.script, parsed.args);', 'const startup = null;');
  } else if (mutant === 'retry-brief') {
    source = source.replace('workerPrompt = result.output;', 'workerPrompt = crewPrompt({task, parentThreadId: crew.parentThreadId ?? undefined, shape: crew.shape, mode: toMode(crew.posture, "direct-PR"), isolated: crew.worktree});');
  } else if (mutant === 'bearings') {
    source = source.replace('if ((await settings.get()).fmHome.trim() !== "") return nativeBearingsSnapshot(owner);', '');
  } else if (mutant === 'orphan-close') {
    const originalServer = spawnSync('git',['show',`${baseline}:server.ts`],{cwd:root,encoding:'utf8'}).stdout;
    const originalHelpers = spawnSync('git',['show',`${baseline}:lib/orphan-decisions.ts`],{cwd:root,encoding:'utf8'}).stdout;
    writeFileSync(mutantHelper,originalHelpers.replace('"./policy.ts"','"./lib/policy.ts"'));
    const start = originalServer.indexOf('  async function sweepOrphanDecisions(');
    const end = originalServer.indexOf('  async function drainWakes(',start);
    const currentStart=source.indexOf('  async function sweepOrphanDecisions(');
    const currentEnd=source.indexOf('  async function drainWakes(',currentStart);
    source = source.slice(0,currentStart)+originalServer.slice(start,end)+source.slice(currentEnd);
    source = `import {orphanCandidateScript, orphanResolveLines, parseOrphanCandidates, ORPHAN_DECISION_QUIET_SEC} from ${JSON.stringify('./'+mutantHelper.split('/').at(-1))};\n`+source;
  } else if (mutant === 'idle-nudge') {
    source = source.replace('if (await isNativeWorker(crew)) {\n      await dropNudge', 'if (false) {\n      await dropNudge');
    source = source.replace('isSecondmateRoute(crew) || await isNativeWorker(crew)', 'isSecondmateRoute(crew)');
  } else if (mutant === 'worker-config') {
    const prior = spawnSync('git',['show',`${baseline}:server.ts`],{cwd:root,encoding:'utf8'}).stdout;
    const start = prior.indexOf('  bb.agents.configure((context) => {');
    const end = prior.indexOf('    const marked = metaFlag(meta, "captain");',start);
    const currentStart = source.indexOf('  bb.agents.configure((context) => {');
    const currentEnd = source.indexOf('    const marked = metaFlag(meta, "captain");',currentStart);
    source = source.slice(0,currentStart)+prior.slice(start,end)+source.slice(currentEnd);
    source = 'import {AXI_TOOL_CONTRACT, CI_POLL_CONTRACT, WAITING_PROTOCOL, LEFTOVER_TIMER_CONTRACT} from "./lib/policy.ts";\n'+source;
  } else if (mutant === 'reconcile') {
    source = source.replace(/const request = await runFmScript\(\{ script: "secondmate-reconcile",[\s\S]*?timeoutMs: 30_000 \}\);/, 'const request = {exitCode:0,output:""};');
  } else if (mutant === 'hook-wrapper') {
    const prior=spawnSync('git',['show',`${baseline}:server.ts`],{cwd:root,encoding:'utf8'}).stdout;
    const begin=prior.indexOf('export function captainHookCommand(');
    const end=prior.indexOf('export function captainHookInstallScript(',begin);
    const here=source.indexOf('export function captainHookCommand(');
    const after=source.indexOf('export function captainHookInstallScript(',here);
    source=source.slice(0,here)+prior.slice(begin,end)+source.slice(after);
  }
  if (mutant && !['hook-startup', 'stop-guard', 'waiting'].includes(mutant)) writeFileSync(mutantPath, source);
  const module = await import(pathToFileURL(mutant && !['hook-startup', 'stop-guard', 'waiting'].includes(mutant) ? mutantPath : join(root, 'server.ts')).href);
  mkdirSync(join(work,'.bb-firstmate/captains'),{recursive:true});
  writeFileSync(join(work,'.bb-firstmate/captains',thread),'home=/fixture\n');
  const missingWrapper=sh(module.captainHookCommand('session-start').replaceAll('$HOME',work),{env:{...process.env,BB_THREAD_ID:thread}});
  assert.equal(missingWrapper.status,1,'registered captain must report a missing installed hook wrapper');
  pluginHost = createFakePluginHost({ pluginId: 'firstmate', settings: { fmHome: home, fmHostId: 'host_1', transport: 'real', watchOwner: 'fm-watch', supervisionEnabled: true } });
  await module.default(pluginHost.bb);
  const { harness, bb } = pluginHost;
  const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({pluginMetadata:{crew:'true', nativeHome:home, crewId:'c1'}}));
  assert.match(config.instructions, /native launch brief owns this worker role/);
  assert.doesNotMatch(config.instructions, /WAITING:|Never poll CI|scheduled resume|orphaned watcher|background timer/);
  const commands = new Map();
  const seen = [];
  harness.sdk.stub('hosts.list', async () => [{id:'host_1',name:'fixture'}]);
  harness.sdk.stub('environments.list', async () => [{ hostId: 'host_1', status: 'ready', path: '/repo' }]);
  harness.sdk.stub('environments.get', async () => ({ id: 'env_wt', hostId: 'host_1', status: 'ready', path: '/repo/isolated', isWorktree: true }));
  harness.sdk.stub('threads.list', async () => []);
  harness.sdk.stub('threads.get', async ({threadId}) => makeThreadResponse({ id: threadId, status: 'idle', environmentId: 'env_wt' }));
  harness.sdk.stub('threads.getPluginMetadata', async () => ({}));
  harness.sdk.stub('threads.events.list', async () => []);
  harness.sdk.stub('threads.send', async () => ({}));
  harness.sdk.stub('threads.output', async () => ({ output: 'DONE: fabricated chat outcome' }));
  harness.sdk.stub('threads.queuedMessages.list', async () => []);
  harness.sdk.stub('threads.stop', async () => ({}));
  harness.sdk.stub('threads.archive', async () => ({}));
  harness.sdk.stub('threads.spawn', async () => ({ id: 'thr_recorded_replacement' }));
  harness.sdk.stub('terminals.create', async args => { const id = `term_${commands.size}`; commands.set(id, args.start.command); return {id}; });
  harness.sdk.stub('terminals.get', async () => ({ status: 'running' }));
  harness.sdk.stub('terminals.close', async () => ({}));
  harness.sdk.stub('terminals.output', async ({terminalId}) => {
    const cmd = unwrap(commands.get(terminalId)); seen.push(cmd);
    const result = sh(cmd);
    const rc = result.status ?? 1;
    return {nextSeq:1, chunks:[{dataBase64:Buffer.from(`${result.stdout ?? ''}${result.stderr ?? ''}\n__FM_HOST_RC:${rc}\n`).toString('base64')}]};
  });
  // The actual tool handler must hand startup back to the agent shell.
  const tool = await harness.behavior.callAgentTool('firstmate_fm', {script:'session-start', args:['--source','startup']});
  const startup = text(tool).split('\n').find(line => line.startsWith('cd '));
  assert.ok(startup, `tool must return an agent-shell command: ${text(tool)}`);
  assert.equal(commands.size, 0, 'tool must not launch startup through host-terminal RPC');
  let started = sh(startup);
  assert.match(started.stdout, /lock acquired: harness pid \d+/);
  const cli = await harness.behavior.runCli(['fm','session-start','--machine','host_1','--json','--','--source','startup']);
  assert.equal(cli.exitCode, 0, cli.stderr);
  const payload = JSON.parse(cli.stdout);
  assert.equal(payload.requiresAgentShell, true, 'CLI must preserve the ancestry handoff');
  started = sh(payload.command);
  assert.equal(started.status, 0, started.stderr);
  assert.doesNotMatch(started.stdout, /READ-ONLY SESSION|cannot locate harness/);
  assert.equal(readFileSync(join(home,'state/.session-start-complete'),'utf8').trim(), readFileSync(join(home,'state/.lock'),'utf8').trim());
  if(process.argv.includes('--live-cli')) {
    const live = spawnSync('bb',['firstmate','fm','--home',home,'session-start','--json','--','--source','startup'],{encoding:'utf8',timeout:45000});
    assert.equal(live.status,0,live.stderr);
    const handoff=JSON.parse(live.stdout);
    assert.equal(handoff.requiresAgentShell,true,'installed BB CLI must use agent-shell startup');
    const actual=sh(handoff.command);
    assert.equal(actual.status,0,actual.stderr);
    assert.doesNotMatch(actual.stdout,/READ-ONLY SESSION|cannot locate harness/);
    assert.equal(readFileSync(join(home,'state/.session-start-complete'),'utf8').trim(),readFileSync(join(home,'state/.lock'),'utf8').trim());
    console.log('PASS: installed BB CLI returns the startup handoff; command acquires/completes the native lock beneath the real agent harness.');
  }

  // Execute the real BB hook adapter against native startup and native Stop.
  mkdirSync(join(homedir(), '.bb-firstmate/captains'), {recursive:true});
  writeFileSync(marker, `home=${home}\nstate=${home}/state\nown_home=1\n`);
  let hook = readFileSync(join(OVERLAY, 'bin/bb-captain-hook.sh'),'utf8');
  if (mutant === 'hook-startup') hook = hook.replace('run_native fm-sessionstart-run.sh', 'true');
  if (mutant === 'stop-guard') hook = hook.replace('run_native fm-turnend-guard.sh "${native_args[@]}"', 'true');
  if (mutant === 'silent-startup') hook = hook.replace('run_native fm-sessionstart-run.sh',
    'run="$home/bin-bb/fm-sessionstart-run.sh"; if [ -x "$run" ] && cd "$home"; then printf "%s" "$payload" | FM_HOME="$home" FM_ROOT_OVERRIDE="$home" FM_STATE_OVERRIDE="$state" FM_BACKEND=bb "$run"; fi');
  const hookPath = join(work,'bb-captain-hook.sh'); writeFileSync(hookPath, hook);
  rmSync(join(home,'state/.session-start-complete'), {force:true});
  const runHook = (mode, input='{}') => spawnSync('bash',[hookPath,mode], {encoding:'utf8', input, timeout:45000,
    env:{...process.env, BB_THREAD_ID:thread, FM_SESSION_START_TIMEOUT:'30'} });
  const hookStart = runHook('session-start','{"source":"startup"}');
  assert.equal(hookStart.status, 0, hookStart.stderr);
  assert.ok(existsSync(join(home,'state/.session-start-complete')), `hook must complete native startup: ${hookStart.stdout}\n${hookStart.stderr}`);
  assert.equal(readFileSync(join(home,'state/.session-start-complete'),'utf8').trim(), readFileSync(join(home,'state/.lock'),'utf8').trim());
  writeFileSync(join(home,'state/active.meta'),'kind=ship\n');
  const stop = runHook('stop');
  assert.equal(stop.status,2, 'empty queue with in-flight work and no watcher must block');
  assert.match(stop.stderr,/TURN WOULD END BLIND/);
  assert.equal(runHook('stop','{"stop_hook_active":true}').status,0);
  rmSync(join(home,'state/active.meta'));
  // Same adapter routes Claude's cooperation to native scripts, including the
  // inert empty-home autoarm case. Actual asyncRewake delivery is provider-owned.
  const claudeStop = spawnSync('bash',[hookPath,'stop','--claude'], {encoding:'utf8',input:'{}',timeout:45000,env:{...process.env,BB_THREAD_ID:thread}});
  assert.equal(claudeStop.status,0,claudeStop.stderr);
  assert.equal(runHook('stop-autoarm').status,0,'native autoarm on an empty home stays inert');
  const missingRunner = join(home,'bin-bb/fm-sessionstart-run.sh');
  rmSync(missingRunner);
  const broken = runHook('session-start','{"source":"startup"}');
  assert.notEqual(broken.status,0);
  assert.match(broken.stderr,/missing executable/);

  // Unregistered old status remains unanswered through the actual wake handler.
  const orphan = join(home,'state/release.status');
  const decision = 'needs-decision [key=release]: owner must approve release\n';
  writeFileSync(orphan,decision); const old = new Date(Date.now()-7200000); utimesSync(orphan,old,old);
  const wake = await harness.behavior.runCli(['wake']);
  assert.equal(wake.exitCode,0,wake.stderr);
  const nativeFold = spawnSync('bash',['-c','source "$1"; status_open_decisions "$2"','proof',join(home,'bin/fm-classify-lib.sh'),orphan],{encoding:'utf8'});
  assert.match(nativeFold.stdout,/owner must approve release/);

  // Bearings projects native backlog holds; metaless status is preserved by the
  // wake/fold plane above, not invented as a snapshot row by this renderer.
  const nativeEnv={...process.env,FM_HOME:home,FM_ROOT_OVERRIDE:home,FM_BACKEND:'bb'};
  for(const args of [['add','release-hold','Release review','--kind','ship'],['hold','release-hold','--reason','owner must approve release','--kind','captain']]) {
    const result=spawnSync(join(home,'bin-bb/fm-tasks-axi.sh'),args,{encoding:'utf8',env:nativeEnv});
    assert.equal(result.status,0,result.stderr);
  }
  // Canonical Bearings must report the durable hold, never fabricated chat.
  const bearings = await harness.behavior.runCli(['bearings','--json']);
  assert.equal(bearings.exitCode,0,bearings.stderr);
  const snapshot = JSON.parse(bearings.stdout);
  assert.equal(snapshot.schema,'fm-bearings.v1');
  assert.ok(snapshot.decisions_open.some(d=>d.id==='release-hold'),'canonical snapshot retains the native captain hold');
  assert.equal(harness.sdk.callsTo('threads.output').length,0);
  assert.ok(seen.some(c=>c.includes('fm-secondmate-reconcile.sh') && c.includes("'request' '--snapshot' '-'")), 'Bearings must execute the native reconcile request');
  const reconcilePath=join(home,'bin-bb/fm-secondmate-reconcile.sh');
  const reconcileBytes=readFileSync(reconcilePath); rmSync(reconcilePath);
  const failedRequest=await harness.behavior.runCli(['bearings']);
  assert.equal(failedRequest.exitCode,0,failedRequest.stderr);
  assert.match(failedRequest.stdout,/Secondmate reconcile request was not recorded/,'failed native publication must be disclosed');
  writeFileSync(reconcilePath,reconcileBytes); chmodSync(reconcilePath,0o755);

  // Scaffold upstream's actual brief, then reuse it through the actual retry handler.
  const briefed = spawnSync(join(home,'bin-bb/fm-brief.sh'),['c1','crew','--scout'],{encoding:'utf8',env:{...process.env,FM_HOME:home,FM_ROOT_OVERRIDE:home,FM_BACKEND:'bb'}});
  assert.equal(briefed.status,0,briefed.stderr);
  const briefPath=join(home,'data/c1/brief.md');
  const nativeBrief=readFileSync(briefPath,'utf8').replace('{TASK}','Audit the scratch fixture').replace('{FIRSTMATE_SPEC}','Preserve native policy exactly.');
  writeFileSync(briefPath,nativeBrief);
  if(mutant==='waiting') {
    const path=join(home,'bin-bb/backends/bb.sh');
    const prior=spawnSync('git',['show',`${baseline}:overlay/bin/backends/bb.sh`],{cwd:root,encoding:'utf8'}).stdout;
    const begin=prior.indexOf('fm_backend_bb_waiting_rule()');
    const end=prior.indexOf('fm_backend_bb_create_task()',begin);
    assert.ok(begin>=0 && end>begin);
    writeFileSync(path,readFileSync(path,'utf8')+'\n'+prior.slice(begin,end)+'\n'+
      'eval "$(declare -f fm_backend_bb_worker_prompt | sed s/fm_backend_bb_worker_prompt/fm_backend_bb_worker_prompt_clean/)"\n'+
      'fm_backend_bb_worker_prompt() { fm_backend_bb_waiting_rule; printf "\\n"; fm_backend_bb_leftover_timer_rule; printf "\\n"; fm_backend_bb_worker_prompt_clean "$@"; }\n');
  }
  const crew={id:'c1',task:'Audit the scratch fixture',projectId:'proj_1',threadId:'thr_fixture',parentThreadId:'thr_captain_fixture',providerId:null,worktree:true,shape:'scout',posture:'local-only',createdAt:'2026-09-29T00:00:00Z',nativeHome:home,backlogRow:true};
  await bb.storage.kv.set('crews',[crew]);
  const retry=await harness.behavior.runCli(['retry','c1','--reasoning-level','xhigh']);
  assert.equal(retry.exitCode,0,retry.stderr);
  const prompt=harness.sdk.callsTo('threads.spawn')[0][0].prompt;
  assert.ok(prompt.includes('States: working, needs-decision, blocked, paused, done, failed.'));
  assert.ok(prompt.includes('SCOUT task: the deliverable is a written report'));
  assert.doesNotMatch(prompt,/Never poll CI|WAITING:|stop every timer|scheduled resume/);
  const next=(await bb.storage.kv.get('crews'))[0];
  const before=harness.sdk.callsTo('threads.send').length;
  const idle=await harness.behavior.emitThreadEvent('thread.idle',{thread:makeThreadResponse({id:next.threadId,status:'idle'}),lastAssistantText:'Finished; report saved.'});
  assert.deepEqual(idle.errors,[]);
  assert.equal(harness.sdk.callsTo('threads.send').length,before,'native completion cannot start a chat-verdict repair turn');
  assert.ok(seen.some(c=>c.includes('fm_backend_bb_worker_prompt')));
  assert.equal(spawnSync('git',['-C',home,'status','--porcelain'],{encoding:'utf8'}).stdout,'');
  console.log('PASS: actual startup tool/CLI routes, native hook startup/Stop, orphan decisions, canonical Bearings, native retry brief, native idle without nudges. Native scripts executed; no real BB workers dispatched.');
} finally {
  if(pluginHost) await pluginHost.harness.lifecycle.dispose();
  rmSync(marker,{force:true}); rmSync(mutantPath,{force:true}); rmSync(mutantHelper,{force:true});
  // Native startup owns detached network workers. Retire only processes whose
  // environment/cwd binds them to this unique fixture before deleting its home.
  for(const pid of fixtureProcesses()) try {process.kill(pid,'SIGTERM');} catch {}
  for(let i=0;i<5 && fixtureProcesses().length;i++) await new Promise(resolve=>setTimeout(resolve,1000));
  for(const pid of fixtureProcesses()) try {process.kill(pid,'SIGKILL');} catch {}
  for(let i=0;i<5 && fixtureProcesses().length;i++) await new Promise(resolve=>setTimeout(resolve,1000));
  assert.deepEqual(fixtureProcesses(),[],'fixture processes must be gone before home teardown');
  rmSync(work,{recursive:true,force:true});
}
