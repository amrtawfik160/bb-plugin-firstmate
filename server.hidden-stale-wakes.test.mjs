import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { runtimeFixture } from './scripts/native-runtime-fixture.mjs';

for (const scenario of ['paused', 'waiting', 'working', 'late-report', 'open-decision']) test(`API: ${scenario} crew with six watcher refills preserves only actionable reports`, async () => {
  const runtime = runtimeFixture();
  const nativeBin = join(runtime.ready(), 'bin');
  const root = mkdtempSync(join(tmpdir(), 'checker164-'));
  const home = join(root, 'firstmate-bb-homes/thr_cap');
  mkdirSync(join(home, 'state'), { recursive: true });
  cpSync(nativeBin, join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin/fm-wake-drain.sh'), `#!/bin/bash
'${nativeBin}/fm-wake-drain.sh' "$@" || exit $?
if [ "$#" -eq 0 ]; then
  . "$FM_HOME/bin/fm-wake-lib.sh"
  fm_wake_append stale bb:thr_wait 'stale: bb:thr_wait (idle 291s, possible wedge, escalation 5)'
  if [ -f \"$FM_HOME/state/inject-real\" ]; then
    fm_wake_append signal late-report 'late real report ready'
    rm -f \"$FM_HOME/state/inject-real\"
  fi
  echo 'WARNING: queued wakes pending - drain them with bin/fm-wake-drain.sh before anything else.'
fi
`, { mode: 0o755 });
  writeFileSync(join(home, 'state/wait1.status'), `${scenario === 'working' ? 'working' : scenario === 'waiting' ? 'waiting' : 'paused'} [at=1]: external CI\n`);
  if (scenario === 'open-decision') writeFileSync(join(home, 'state/ab0123cd.status'), 'needs-decision [at=1] [key=owner]: owner answer required\n');
  const shell = (cmd) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 30000, env: { ...process.env, FM_HOME: home, FM_ROOT_OVERRIDE: home } });
  const initial = shell(`. '${home}/bin/fm-wake-lib.sh'; fm_wake_append stale bb:thr_wait 'stale: bb:thr_wait (possible wedge)'; fm_wake_append signal real-report 'real report ready'`);
  assert.equal(initial.status, 0, initial.stderr);
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: ['captain', 'firstmate'], settings: { fmHome: home, fmHostId: 'host_1' } });
  await plugin(host.bb);
  try {
    await host.bb.storage.kv.set('crews', [{ id: 'wait1', task: 'external CI', projectId: 'proj_1', threadId: 'thr_wait', parentThreadId: 'thr_cap', nativeHome: home, worktree: true, shape: 'ship', posture: 'local-only', createdAt: '2026-10-18T00:00:00Z', providerId: null, model: null, reasoningLevel: null }]);
    host.harness.sdk.stub('threads.get', async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: 'proj_1', status: 'idle', environmentId: null }));
    host.harness.sdk.stub('threads.getPluginMetadata', async () => ({}));
    host.harness.sdk.stub('threads.list', async () => []);
    host.harness.sdk.stub('threads.events.list', async () => []);
    host.harness.sdk.stub('threads.output', async () => ({ output: '' }));
    host.harness.sdk.stub('environments.list', async () => [{ hostId: 'host_1', status: 'ready', isWorktree: false, path: root }]);
    const commands = new Map();
    let n = 0;
    host.harness.sdk.stub('terminals.create', async ({ start }) => { const id = `t${++n}`; commands.set(id, start.command); return { id }; });
    host.harness.sdk.stub('terminals.get', async () => ({ status: 'running' }));
    host.harness.sdk.stub('terminals.close', async () => ({}));
    host.harness.sdk.stub('terminals.output', async ({ terminalId }) => {
      const wrapped = commands.get(terminalId);
      const match = /^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(wrapped);
      const r = shell(match ? match[1].replace(/'\\''/g, "'") : wrapped);
      return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${r.stdout}${r.stderr}\n__FM_HOST_RC:${r.status ?? 1}\n`).toString('base64') }] };
    });
    const wake = host.harness.inspection.registrations.agentTools.find(t => t.name === 'firstmate_wake');
    const ctx = { threadId: 'thr_cap', projectId: 'proj_1' };
    const first = String(await wake.execute({}, ctx));
    assert.match(first, /real report ready/);
    if (scenario === 'open-decision') assert.match(first, /owner answer required/);
    if (scenario === 'working') assert.match(first, /stale: bb:thr_wait/);
    else assert.doesNotMatch(first, /stale: bb:thr_wait/);
    const receipt = /WAKE_RECEIPT: ([a-f0-9]+)/.exec(first)?.[1];
    assert.ok(receipt, first);
    assert.match(readFileSync(join(home, 'state/.wake-queue'), 'utf8'), /real report ready/);
    let current = receipt;
    if (scenario === 'late-report') {
      writeFileSync(join(home, 'state/inject-real'), '1');
      const late = String(await wake.execute({ handledWake: current }, ctx));
      assert.match(late, /late real report ready/);
      assert.doesNotMatch(late, /stale: bb:thr_wait/);
      current = /WAKE_RECEIPT: ([a-f0-9]+)/.exec(late)?.[1];
      assert.ok(current);
      assert.match(readFileSync(join(home, 'state/.wake-queue'), 'utf8'), /late real report ready/);
    }
    const refills = [];
    const outputs = [];
    for (let poll = 0; poll < 6; poll++) {
      const output = String(await wake.execute(current ? { handledWake: current } : {}, ctx));
      outputs.push(output);
      current = /WAKE_RECEIPT: ([a-f0-9]+)/.exec(output)?.[1];
      refills.push({ receipt: Boolean(current), stale: output.includes('stale: bb:thr_wait'), empty: output.includes('No unread reports.') });
      assert.doesNotMatch(output, /real report ready|late real report ready/, 'the real report is acknowledged once');
    }
    assert.doesNotMatch(readFileSync(join(home, 'state/.wake-queue'), 'utf8'), /real report ready/);
    const working = scenario === 'working';
    assert.deepEqual(refills, Array.from({ length: 6 }, () => ({ receipt: working, stale: working, empty: !working })), outputs.join("\n---next refill---\n"));
    if (!working) assert.equal(existsSync(join(home, 'state/.bb-wake-receipt.json')), false, 'no hidden receipt remains');
  } finally { await host.harness.lifecycle.dispose(); rmSync(root, { recursive: true, force: true }); runtime.clean(); }
});
