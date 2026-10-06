// Execute behavioral regressions with one fix removed in an isolated copy.
// No plugin is installed and no real worker or fleet is accessed.
import { cpSync,mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync } from 'node:fs';
import { basename,join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root=resolve('.');
const scratch=mkdtempSync(join(tmpdir(),'fm-launch-pr-mutations-'));
const cases=[
  {name:'Structured forge stdout',file:'server.ts',from:'runOnHost(hostId,captureHostCommand(command),timeoutMs,signal)',to:'runOnHost(hostId,command,timeoutMs,signal)',test:'server.launch-delivery.test.mjs',pattern:'registered PR schedule parses real PTY'},
  {name:'Exact deleted worker reservation release',file:'server.ts',from:'launches.workerDeleted(thread.id);',to:'',test:'server.launch-delivery.test.mjs',pattern:'native creation provisioning releases capacity'},
  {name:'Atomic launch admission',file:'lib/launch.ts',from:'active.size >= cap',to:'false',test:'server.launch-delivery.test.mjs',pattern:'dispatch admission fixes actual concurrent cap probe'},
  {name:'Creation role metadata',file:'server.ts',from:'pluginMetadata: { launchKey:key,generation:1,nativeHome:',to:'pluginMetadata: { launchKey:key,generation:1,crew:"false",nativeHome:',test:'server.launch-delivery.test.mjs',pattern:'native bridge seeds role/home/generation'},
  {name:'Host and checkout selection',file:'lib/execution-selection.ts',from:"(!preferredHost || e.hostId===preferredHost)",to:'true',test:'lib/launch-delivery.test.mjs',pattern:'coherent checkout selection refuses'},
  {name:'PR retention after acknowledged notification',file:'lib/pr-delivery.ts',from:'latest.notification.delivered=signature; latest.notification.retryAt=0;',to:'latest.notification.delivered=signature; latest.notification.retryAt=0; latest.status="complete";',test:'lib/launch-delivery.test.mjs',pattern:'PR completion is separate from worker'},
  {name:'Current-head readiness invalidation',file:'lib/pr-delivery.ts',from:'const changedHead = prior.headSha !== o.headSha;',to:'const changedHead = false;',test:'lib/launch-delivery.test.mjs',pattern:'PR completion is separate from worker'},
  {name:'Immutable recovery contract',file:'server.ts',from:'deliveryRequirement:recoveredContract(meta,launch),',to:'deliveryRequirement:"merged",',test:'server.launch-delivery.test.mjs',pattern:'factory metadata adoption and dispatch recovery'},
  {name:'Registration contract inheritance',file:'server.ts',from:'worker:crew.threadId,requirement:original,continuation:',to:'worker:crew.threadId,requirement:"merged",continuation:',test:'server.launch-delivery.test.mjs',pattern:'CLI and tool registration inherit'},
  {name:'End-to-end follow-up cancellation',file:'server.ts',from:'await raceAbort(bb.sdk.environments.pullRequest({ environmentId: envId,signal }),signal,STUCK_HOST_CALL_MS)',to:'await bb.sdk.environments.pullRequest({ environmentId: envId })',more:[['try {return await raceAbort(action(signal),signal);}', 'try {return await action(signal);}']],test:'server.launch-delivery.test.mjs',pattern:'registered follow-up disposal settles',failurePattern:'disposal hung'},
  {name:'Late terminal cleanup',file:'server.ts',from:'if (creationLost) await closeOnce();',to:'if (false) await closeOnce();',test:'server.launch-delivery.test.mjs',pattern:'late terminal identity'},
  {name:'Native publication admission',file:'server.ts',from:'return await readFmMetaField(env.hostId,record.taskId,"bb_thread_id",record.home,signal) === record.threadId;',to:'return true;',test:'server.launch-delivery.test.mjs',pattern:'native guard failure after real bridge'},
  {name:'Partial handoff isolation',file:'server.ts',from:'selectedTask,failedTasks);',to:'selectedTask);',test:'server.launch-delivery.test.mjs',pattern:'partial handoff preserves'},
  {name:'Retained native authority',file:'server.ts',from:'if (!nativeTeardown && !preserveAuthority)',to:'if (!nativeTeardown)',test:'server.launch-delivery.test.mjs',pattern:'forgotten author retains'},
  {name:'Native review policy',file:'lib/pr-delivery.ts',from:"o.review === 'unknown' && mergeAuthorized",to:'false',test:'lib/launch-delivery.test.mjs',pattern:'native review path does not invent'},
  {name:'Startup workspace seam',file:'overlay/firstmate-bb-backend.patch',from:'+  [ "$BACKEND" = bb ] && return 0',to:'+  [ "$BACKEND" = bb ] && :',test:'lib/launch-delivery.test.mjs',pattern:'native startup workspace handoff'},
];
try {
  cpSync(root,scratch,{recursive:true,filter:path=>!['.git','node_modules','dist','__pycache__'].includes(basename(path))});
  symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir');
  for (const c of cases) {
    const path=join(scratch,c.file),original=readFileSync(path,'utf8');
    if (!original.includes(c.from)) throw new Error(`Mutation anchor disappeared: ${c.name}`);
    // For the role test, replace the explicit crew value rather than adding a
    // duplicate property, which would only prove a syntax check.
    let modified=c.name==='Creation role metadata'
      ? original.replace('crew:"true",crewId:taskId,shape','crew:"false",crewId:taskId,shape')
      : original.replace(c.from,c.to);
    for (const [from,to] of c.more ?? []) {if (!modified.includes(from)) throw new Error(`Additional mutation anchor disappeared: ${c.name}`);modified=modified.replace(from,to);}
    if (modified===original) throw new Error(`Mutation did not change ${c.name}`);
    writeFileSync(path,modified);
    const result=spawnSync(process.execPath,['--test','--experimental-strip-types',`--test-name-pattern=${c.pattern}`,c.test],{cwd:scratch,encoding:'utf8',timeout:30_000});
    writeFileSync(path,original);
    if (result.status===0 || result.error || !new RegExp(c.failurePattern ?? "AssertionError|ERR_ASSERTION").test(result.stdout+result.stderr)) throw new Error(`${c.name} did not kill its behavioral assertion:\n${result.stdout}\n${result.stderr}`);
    console.log(`PASS: removing ${c.name} fails ${c.pattern}`);
  }
  const native=process.env.FM_TEST_HOME;
  if (!native) throw new Error('FM_TEST_HOME must name the scratch native home for the loader mutation');
  const backend=readFileSync(join(native,'bin-bb/fm-backend.sh'),'utf8');
  const positional='set -- fm-composer-lib.sh fm-transition-lib.sh';
  if (!backend.includes(positional)) throw new Error('Missing positional native loader clause');
  const bad=join(scratch,'bad-backend.sh');
  writeFileSync(bad,backend.replace(positional,'siblings="fm-composer-lib.sh fm-transition-lib.sh"'));
  const result=spawnSync('bash',['-c','. "$FM_BAD_LOADER"; fm_backend_source bb; declare -F fm_backend_bb_create_task'],{cwd:scratch,encoding:'utf8',env:{...process.env,FM_HOME:native,FM_ROOT_OVERRIDE:native,FM_BAD_LOADER:bad},timeout:10_000});
  if (result.status===0) throw new Error('Reverting positional loader did not break actual BB backend source loading');
  console.log('PASS: reverting positional loader breaks actual BB backend source loading');
} finally {rmSync(scratch,{recursive:true,force:true});}
