import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries } from './lib/pr-delivery.ts';
import { createOwnerGate } from './lib/owner-gate.ts';
import { approvePr } from './test/production-approval.ts';

process.env.FM_MERGEABLE_POLL_MS = '0';

// A completed delivery leaves the due list, so its saved owner approval status post
// retries in the background pass on its own, without reading the PR again.
const REPO = 'amrtawfik160/dr.woo';
const N = 130;
const ID = `${REPO}#${N}`;
const URL = `https://github.com/${REPO}/pull/${N}`;
const HEAD = '1'.repeat(40);
const MERGE_SHA = 'ab73ad9242afa06ac55dcb74e279674578d65534';
const TREE = 'dcb1515659f1bed7f18973876fedd95f442c18da';
const CREW = { id: 'woo1', task: 'x', projectId: 'proj_1', threadId: 'thr_woo', parentThreadId: 'thr_cap', nativeHome: '/native', worktree: true, shape: 'ship', posture: 'direct-PR', createdAt: '2026-10-17T00:00:00.000Z', reasoningLevel: null, playbook: 'babysit', title: 'Fix the photo upload', providerId: 'claude-code', model: 'claude-opus-5-5', deliveryRequirement: 'merged-and-verified' };
const merged = { headRefOid: HEAD, state: 'MERGED', isDraft: false, mergeable: 'MERGEABLE', mergeCommit: { oid: MERGE_SHA }, reviewDecision: 'APPROVED', statusCheckRollup: [], createdAt: '2026-10-19T00:00:00Z' };

function forge(command, statusOk) {
  if (command.includes('/statuses/')) return statusOk() ? { code: 0, payload: '{}' } : { code: 1, payload: 'GitHub status temporarily unavailable' };
  if (/\/git\/commits\//.test(command)) return { payload: TREE };
  if (command.includes('gh pr view')) return { payload: JSON.stringify(merged) };
  return { code: 0 };
}

async function completedWithSavedRetry() {
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: ['firstmate', 'captain'], settings: { fmHome: '/native', fmHostId: 'host_1' } });
  await host.bb.storage.kv.set('captain-project:thr_cap', 'proj_1');
  await plugin(host.bb);
  host.harness.sdk.stub('threads.list', async () => []);
  host.harness.sdk.stub('threads.getPluginMetadata', async ({ threadId }) => threadId === 'thr_cap' ? { captain: 'true' } : {});
  host.harness.sdk.stub('threads.get', async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: 'proj_1', status: 'idle', environmentId: `env_${threadId}` }));
  host.harness.sdk.stub('environments.list', async () => [{ id: 'env_source', hostId: 'host_1', status: 'ready', isWorktree: false, path: '/repo' }]);
  host.harness.sdk.stub('environments.get', async ({ environmentId }) => ({ id: environmentId, hostId: 'host_1', status: 'ready', isWorktree: true, path: '/wt', branchName: `fm/woo1-change-${N}` }));
  host.harness.sdk.stub('environments.diffFiles', async () => ({ files: [] }));
  host.harness.sdk.stub('environments.pullRequest', async () => ({ outcome: 'unavailable' }));
  host.harness.sdk.stub('threads.output', async () => ({ output: 'DONE: PR open' }));
  host.harness.sdk.stub('threads.events.list', async () => []);
  host.harness.sdk.stub('threads.send', async () => ({ delivery: 'queued' }));
  host.harness.sdk.stub('projects.get', async () => ({ id: 'proj_1', name: 'woo-app', kind: 'repo' }));
  host.harness.sdk.stub('files.read', async () => { throw new Error('ENOENT'); });
  const taps = new Map();
  host.harness.sdk.stub('plugins.callRpc', async (call) => call.method === 'ownerAnswer' ? { answer: taps.get(call.input.askId) ?? null } : { ok: true, queued: 1, duplicate: false });
  let statusOk = false;
  const commands = [];
  const byId = new Map();
  host.harness.sdk.stub('terminals.create', async ({ start }) => { const id = `t${commands.length}`; byId.set(id, start.command); commands.push(start.command); return { id }; });
  host.harness.sdk.stub('terminals.get', async () => ({ status: 'running' }));
  host.harness.sdk.stub('terminals.close', async () => ({}));
  host.harness.sdk.stub('terminals.output', async ({ terminalId }) => {
    const command = byId.get(terminalId);
    const out = forge(command, () => statusOk);
    const captured = command.includes('FM_HOST_CAPTURE_V1');
    const payload = captured ? JSON.stringify({ protocol: 'FM_HOST_CAPTURE_V1', exitCode: out.code ?? 0, stdout: out.payload ?? '', stderr: '' }) : out.payload ?? '';
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${payload}\n__FM_HOST_RC:${captured ? 0 : out.code ?? 0}\n`).toString('base64') }] };
  });
  await host.bb.storage.kv.set('crews', [CREW]);
  const db = host.bb.storage.database();
  const store = createDeliveries(db);
  const gate = createOwnerGate(db);
  approvePr(db, 'thr_cap', ID, HEAD);
  const r = store.register({ url: URL, taskId: 'woo1', projectId: 'proj_1', owner: 'thr_cap', home: '/native', worker: 'thr_woo', requirement: 'merged-and-verified', title: `Change ${N}` });
  store.observe(r.id, { headSha: HEAD, state: 'open', draft: false, checks: 'passing', review: 'approved', reviewHeadSha: HEAD, mergeCommitSha: null, mergeable: 'mergeable' }, true);
  const tool = (name) => host.harness.inspection.registrations.agentTools.find((t) => t.name === name);
  const deliveries = (input, threadId) => tool('firstmate_deliveries').execute(input, { threadId, projectId: 'proj_1' });
  const asked = JSON.stringify(await deliveries({ action: 'device-proof', id: ID, commitSha: HEAD.slice(0, 7), build: '6', link: 'https://testflight.apple.com/join/abc', check: 'Send a photo' }, 'thr_woo'));
  const askId = /card (a[0-9a-z]{6})/.exec(asked)?.[1];
  assert.ok(askId, asked);
  taps.set(askId, 'Works');
  await host.harness.behavior.callRpc('resolveAsk', { threadId: 'thr_cap', id: askId, resolution: 'Works' });
  gate.needStatusPost(ID, HEAD, 'earlier transport failure', Date.now());
  // GitHub is down for status posts: the reconcile completes the delivery but keeps the retry.
  await deliveries({ action: 'reconcile', id: ID }, 'thr_cap');
  assert.equal(store.get(ID).status, 'complete');
  assert.equal(gate.statusPostNeeded(ID, HEAD), true);
  commands.length = 0;
  return { host, store, gate, commands, recover: () => { statusOk = true; } };
}

const posts = (commands) => commands.filter((c) => c.includes(`/statuses/${HEAD}`));
const prReads = (commands) => commands.filter((c) => c.includes('gh pr view') && c.includes(`/pull/${N}`));

test('background pass retries a completed delivery\'s saved status post without reading the PR again', async () => {
  const c = await completedWithSavedRetry();
  try {
    c.recover();
    await c.host.harness.behavior.runSchedule('pr-delivery-follow-up');
    assert.equal(posts(c.commands).length, 1);
    assert.equal(c.gate.statusPostNeeded(ID, HEAD), false);
    assert.deepEqual(prReads(c.commands), []);
    assert.equal(c.store.get(ID).status, 'complete');
    // Nothing is left to retry, so the next pass posts nothing.
    c.commands.length = 0;
    await c.host.harness.behavior.runSchedule('pr-delivery-follow-up');
    assert.deepEqual(posts(c.commands), []);
  } finally { await c.host.harness.lifecycle.dispose(); }
});

test('a background status retry that fails again keeps the saved post until one succeeds', async () => {
  const c = await completedWithSavedRetry();
  try {
    await c.host.harness.behavior.runSchedule('pr-delivery-follow-up');
    assert.equal(posts(c.commands).length, 1);
    assert.equal(c.gate.statusPostNeeded(ID, HEAD), true);
    c.recover();
    c.commands.length = 0;
    await c.host.harness.behavior.runSchedule('pr-delivery-follow-up');
    assert.equal(posts(c.commands).length, 1);
    assert.equal(c.gate.statusPostNeeded(ID, HEAD), false);
    assert.equal(c.store.get(ID).status, 'complete');
  } finally { await c.host.harness.lifecycle.dispose(); }
});
