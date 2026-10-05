// Causal guard verification in the isolated implementation checkout only.
// Restore every source byte even when an expected mutant unexpectedly survives.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const cases=[
 ['native isolation','overlay/bin/fm-launch-adopt.sh','spawn_worktree_isolated "$WT" ||','true ||','native repair refuses'],
 ['repository identity','overlay/bin/fm-launch-adopt.py',"require(repository(r['path']) == repository(plan['worktree']),",'require(True,','native repair refuses'],
 ['source project','overlay/bin/fm-launch-adopt.py',"require(len(setup) == 1 and setup[0] in (r['path'], 'crew'),",'require(True,','factory refuses'],
 ['legacy generic token','overlay/bin/fm-launch-adopt.py',"setup[0] in (r['path'], 'crew')","setup[0] == r['path']",'actual factory legacy repair.*crew'],
 ['immutable setup correspondence','overlay/bin/fm-launch-adopt.py','require(prompt.count(setup_anchor) == 1,','require(True,','factory refuses'],
 ['immutable native branch','overlay/bin/fm-launch-adopt.py',"branch=branch[0], bb_adopt_observed_branch=current_branch","branch=current_branch, bb_adopt_observed_branch=current_branch",'native immutable branch'],
 ['existing branch collision','overlay/bin/fm-launch-adopt.py',"if key != 'bb_adopt_observed_branch':","if key not in ('branch', 'bb_adopt_observed_branch'):",'native immutable branch'],
 ['BB parent identity','lib/launch-adoption.ts','thread.parentThreadId !== record.owner || ','','factory refuses'],
 ['BB task metadata collision','lib/launch-adoption.ts','metadata[key] !== undefined && metadata[key] !== value','false','factory refuses'],
 ['incomplete publication readiness','server.ts','if (record.adoption?.phase === "publishing") return false;','// mutation: certify incomplete publication','interrupted completion'],
];
const selected=process.argv.slice(2);
assert.ok(selected.every(name=>cases.some(row=>row[0]===name)), 'unknown mutation selection');
for(const [name,file,from,to,pattern] of cases) {
 if(selected.length && !selected.includes(name)) continue;
 const original=readFileSync(file,'utf8');assert.equal(original.split(from).length,2,`unique mutation anchor ${name}`);
 try {
  writeFileSync(file,original.replace(from,to));
  const result=spawnSync(process.execPath,['--test','--experimental-strip-types','--test-name-pattern='+pattern,'scripts/launch-adoption.test.mjs'],{encoding:'utf8',env:process.env,timeout:60000});
  assert.equal(result.error,undefined,`${name}: test process must settle`);
  assert.notEqual(result.status,0,`${name} mutant survived:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout+result.stderr,/AssertionError/,`${name}: must fail its behavioral assertion`);
  console.log(`KILLED: ${name}`);
 }finally{writeFileSync(file,original);}
}
