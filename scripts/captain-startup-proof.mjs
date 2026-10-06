// Real native startup under the invoking agent's harness, in owned homes only.
// No BB server calls or model launches: the fixture bb records read-only commands.
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture, pins, run, ok} from './prompt-fixture.mjs';
import {captainStartupCommand} from '../server.ts';

const evidence = resolve(process.argv[2] ?? '/tmp/fm-captain-startup-proof');
mkdirSync(evidence, {recursive:true});
for (const pin of pins) {
  const home = fixture(pin);
  const runtime = join(home, 'test-runtime');
  mkdirSync(join(runtime, 'bin'), {recursive:true});
  const log = join(runtime, 'bb-commands');
  writeFileSync(join(runtime, 'bin/bb'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BB_FIXTURE_LOG"\nprintf "{}\\n"\n', {mode:0o755});
  const env = {...process.env, HOME:runtime, PATH:`${runtime}/bin:${process.env.PATH}`, BB_FIXTURE_LOG:log, FM_STATE_OVERRIDE:join(home,'state'), FM_CONFIG_OVERRIDE:join(home,'config')};
  try {
    ok(run('python3', ['overlay/install-bb-backend.py', '--home', home]));
    writeFileSync(join(home, 'config/crew-harness'), 'cursor\n');
    writeFileSync(join(home, 'state/unrelated.status'), 'UNRELATED SENTINEL\n');
    const command = captainStartupCommand(home, 'session-start');
    assert.ok(command);
    const before = Date.now();
    const result = spawnSync('bash', ['-c', command], {env, encoding:'utf8', timeout:125000, maxBuffer:8*1024*1024});
    const elapsedMs = Date.now()-before;
    const output = result.stdout + result.stderr;
    const stem = join(evidence, pin.slice(0,8));
    writeFileSync(`${stem}.output`, output);
    writeFileSync(`${stem}.json`, JSON.stringify({home, pin, command, exit:result.status, elapsedMs}, null, 2)+'\n');
    assert.equal(result.status, 0, output);
    assert.match(output, /lock acquired: harness pid [0-9]+/);
    assert.match(output, /BOOTSTRAP/);
    assert.match(output, /WAKE QUEUE/);
    assert.match(output, /NEXT STEP/);
    assert.doesNotMatch(output, /^●  STARTUP TRUNCATED|^error: cannot locate harness|MISSING:|MISSING_MANUAL:|BACKEND_INVALID:|BB_STARTUP_PROBE_FAILED:/m);
    assert.equal(readFileSync(join(home, 'state/unrelated.status'), 'utf8'), 'UNRELATED SENTINEL\n');
    assert.equal(ok(run('git', ['-C',home,'diff','--','bin'])), '');
    const calls = (()=>{try {return readFileSync(log,'utf8');}catch{return '';}})();
    assert.doesNotMatch(calls, /(?:^|\s)(?:spawn|send|retry|dispatch|create|delete)(?:\s|$)/m);
    writeFileSync(`${stem}.bb-commands`, calls);
    console.log(`PASS native ${pin.slice(0,8)} complete locked startup in ${elapsedMs}ms; no worker commands`);
  } finally {
    // Stop only processes whose actual command names this unique owned home.
    for (const pid of readdirSync('/proc').filter(p=>/^[0-9]+$/.test(p))) {
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0',' ');
        if (args.includes(`${home}/bin-bb/fm-`)) process.kill(Number(pid), 'SIGTERM');
      } catch {}
    }
    await new Promise(r=>setTimeout(r,100));
    rmSync(home, {recursive:true,force:true});
  }
}
