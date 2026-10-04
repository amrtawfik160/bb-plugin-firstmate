// Run only in the isolated implementation checkout. Restore every source byte.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const source=readFileSync('server.ts','utf8');
const start=source.indexOf('    const result = receipt ? await (async () => {');
const end=source.indexOf('    if (result.output.includes("FM_MIRROR_STALE"))',start);
assert.ok(start>0 && end>start,'unique staged receipt transport boundary');
try {
 writeFileSync('server.ts',source.slice(0,start)+'    const result = await runOnHost(input.hostId, prelude, input.timeoutMs, input.signal, input.stdin);\n'+source.slice(end));
 const r=spawnSync(process.execPath,['--test','--experimental-strip-types','--test-name-pattern=reported captain wake command','server.wake-command-size.test.mjs'],{encoding:'utf8',timeout:30000});
 assert.equal(r.error,undefined);assert.notEqual(r.status,0,'inline receipt command mutation survived');
 assert.match(r.stdout+r.stderr,/ERR_ASSERTION/);assert.match(r.stdout+r.stderr,/10011 > 10000/);
 console.log('KILLED: inline composed receipt transport; actual factory reproduced 10011 > 10000 before any host/native execution.');
}finally{writeFileSync('server.ts',source);}
