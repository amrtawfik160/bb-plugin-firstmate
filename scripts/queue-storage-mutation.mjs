import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const path='server.ts',original=readFileSync(path,'utf8');
function check(name,source,pattern,diagnostic) {
 try {
  writeFileSync(path,source);
  const result=spawnSync(process.execPath,['--test','--experimental-strip-types',`--test-name-pattern=${pattern}`,'server.queue-storage.test.mjs'],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
  assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stdout+result.stderr,diagnostic);console.log(`KILLED ${name}`);
 }finally{writeFileSync(path,original);}
}
const baseline=spawnSync('git',['show','8ca0ccc:server.ts'],{encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(baseline.status,0);
check('original aggregate KV storage, actual factory 184-record reproduction',baseline.stdout,'aggregate cap',/262144|exceeds/);
check('native add before durable local intent',original.replace('queueStore.add(item);\n              await publishQueueAdd(item);','await publishQueueAdd(item);\n              queueStore.add(item);'),'factory migration',/Native backlog add .*host unavailable/);
check('missing exact native row id guard',original.replace('tasksAxiField(read!.output,"id")!==id || ',''),'native-only queued',/AssertionError|false !== true|undefined/);
check('whole array KV mark after worker completion',original.replace('queueStore.transform(row => row.crewId === crew.id && row.projectId === crew.projectId && (row.parentThreadId??null) === crew.parentThreadId && row.status === "dispatched", row => ({...row,status}));','await bb.storage.kv.set(QUEUE_KEY, (await readQueue()).map(row => row.crewId===crew.id ? {...row,status} : row));'),'read-through completion',/dispatched.*done|AssertionError/);
assert.equal(readFileSync(path,'utf8'),original);console.log('Restored source bytes.');
