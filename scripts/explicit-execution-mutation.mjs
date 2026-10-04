import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const original=readFileSync('server.ts','utf8');
function check(name,path,source,pattern,diagnostic) {
 const saved=readFileSync(path,'utf8');try {
  writeFileSync(path,source);
  const result=spawnSync(process.execPath,['--test','--experimental-strip-types',`--test-name-pattern=${pattern}`,'server.explicit-execution.test.mjs'],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stdout+result.stderr,diagnostic);console.log(`KILLED ${name}`);
 }finally{writeFileSync(path,saved);}
}
check('blanket stuck-ladder guard','server.ts',original.replace('if (!explicit && (crew.relaunches ?? 0) >= MAX_CREW_RELAUNCHES)','if ((crew.relaunches ?? 0) >= MAX_CREW_RELAUNCHES)'),'second user-directed',/second failure/);
check('generation reused from recovery count','server.ts',original.replace('crew.id,plan.generation);','crew.id,(crew.relaunches??0)+2);'),'second user-directed',/conflicts with this exact request/);
const helper='overlay/bin/fm-worker-rebind.py',source=readFileSync(helper,'utf8');
check('native branch-contract collision guard',helper,source.replace("    a.require(len(branches)==1 and fields.get('branch',branches[0])==branches[0],'immutable source branch conflict')","    a.require(len(branches)==1,'source branch missing')"),'native rebind refuses',/AssertionError/);
assert.equal(readFileSync('server.ts','utf8'),original);console.log('Restored source bytes.');
