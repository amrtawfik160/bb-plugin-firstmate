import assert from 'node:assert/strict';
import test from 'node:test';
import { captureHostCommand,decodeHostCapture } from './host-capture.ts';

import { runPty,mergedJson } from './host-capture.fixture.mjs';

test('real PTY progress breaks direct JSON; capture gives complete stdout and separate stderr',()=>{
  // A small Python program models gh's TTY-dependent progress, with JSON passed
  // as an argument rather than interpreted as Python source.
  const command=`python3 -c 'import sys; print("Working...") if sys.stdout.isatty() else None; print("forge stderr diagnostic",file=sys.stderr); print(sys.argv[1])' '${mergedJson}'`;
  const original=runPty(command);assert.match(original,/Working\.\.\./);assert.throws(()=>JSON.parse(original));
  const result=decodeHostCapture(runPty(captureHostCommand(command)));
  assert.equal(result.exitCode,0);assert.equal(JSON.parse(result.output).state,'MERGED');
  assert.equal(result.stderr,'forge stderr diagnostic\n');assert.doesNotMatch(result.output,/Working|diagnostic/);
});

test('capture preserves nonzero command exit and rejects contaminated or incomplete envelopes',()=>{
  const result=decodeHostCapture(runPty(captureHostCommand(`printf '%s' '${mergedJson}'; printf '%s' 'authentication failed' >&2; exit 7`)));
  assert.equal(result.exitCode,7);assert.equal(result.stderr,'authentication failed');assert.equal(JSON.parse(result.output).state,'MERGED');
  for (const output of ['Working...\n'+JSON.stringify(result),JSON.stringify(result)+'\ntrailing', '{}','{"protocol":"FM_HOST_CAPTURE_V1","exitCode":null,"stdout":"{}","stderr":""}']) {
    assert.throws(()=>decodeHostCapture(output));
  }
});
