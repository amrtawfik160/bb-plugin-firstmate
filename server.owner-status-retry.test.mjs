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

// The fake host's BB and GitHub answers; a reloaded host needs them again. metered: GitHub answers
// carry GraphQL rate-limit headers, so the background pass reads due PRs.
function stubHost(host, commands, statusOk, taps, metered = false) {
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
  host.harness.sdk.stub('plugins.callRpc', async (call) => call.method === 'ownerAnswer' ? { answer: taps.get(call.input.askId) ?? null } : { ok: true, queued: 1, duplicate: false });
  const byId = new Map();
  host.harness.sdk.stub('terminals.create', async ({ start }) => { const id = `t${commands.length}`; byId.set(id, start.command); commands.push(start.command); return { id }; });
  host.harness.sdk.stub('terminals.get', async () => ({ status: 'running' }));
  host.harness.sdk.stub('terminals.close', async () => ({}));
  host.harness.sdk.stub('terminals.output', async ({ terminalId }) => {
    const command = byId.get(terminalId);
    const out = forge(command, statusOk);
    const captured = command.includes('FM_HOST_CAPTURE_V1');
    const stderr = metered ? `< X-Ratelimit-Remaining: 5000\n< X-Ratelimit-Reset: ${Math.floor(Date.now() / 1000) + 7200}\n< X-Ratelimit-Resource: graphql\n` : '';
    const payload = captured ? JSON.stringify({ protocol: 'FM_HOST_CAPTURE_V1', exitCode: out.code ?? 0, stdout: out.payload ?? '', stderr }) : out.payload ?? '';
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${payload}\n__FM_HOST_RC:${captured ? 0 : out.code ?? 0}\n`).toString('base64') }] };
  });
}

async function completedWithSavedRetry() {
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: ['firstmate', 'captain'], settings: { fmHome: '/native', fmHostId: 'host_1' } });
  await host.bb.storage.kv.set('captain-project:thr_cap', 'proj_1');
  await plugin(host.bb);
  const taps = new Map();
  let statusOk = false;
  const commands = [];
  stubHost(host, commands, () => statusOk, taps);
  await host.bb.storage.kv.set('crews', [CREW]);
  const db = host.bb.storage.database();
  const store = createDeliveries(db);
  const gate = createOwnerGate(db);
  approvePr(db, 'thr_cap', ID, HEAD);
  const r = store.register({ url: URL, taskId: 'woo1', projectId: 'proj_1', owner: 'thr_cap', home: '/native', worker: 'thr_woo', requirement: 'merged-and-verified', title: `Change ${N}` });
  store.observe(r.id, { headSha: HEAD, state: 'open', draft: false, checks: 'passing', review: 'approved', reviewHeadSha: HEAD, mergeCommitSha: null, mergeable: 'mergeable' }, true);
  const tool = (name) => host.harness.inspection.registrations.agentTools.find((t) => t.name === name);
  const deliveries = (input, threadId = 'thr_cap') => tool('firstmate_deliveries').execute(input, { threadId, projectId: 'proj_1' });
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
  return { host, store, gate, commands, deliveries, taps, statusOk: () => statusOk, recover: () => { statusOk = true; } };
}

const posts = (commands) => commands.filter((c) => c.includes(`/statuses/${HEAD}`));
const prReads = (commands) => commands.filter((c) => c.includes('gh pr view') && c.includes(`/pull/${N}`));
const retryRows = (c) => c.host.bb.storage.database().prepare('SELECT pr, last_error FROM production_status_retry ORDER BY pr').all();
// More completed deliveries of the same repository, each with a saved status post.
function addCompleted(c, from, to, error) {
  for (let n = from; n <= to; n++) {
    const r = c.store.register({ url: `https://github.com/${REPO}/pull/${n}`, taskId: 'woo1', projectId: 'proj_1', owner: 'thr_cap', home: '/native', worker: 'thr_woo', requirement: 'merged', title: `Change ${n}` });
    c.store.observe(r.id, { headSha: HEAD, state: 'merged', draft: false, checks: 'passing', review: 'approved', reviewHeadSha: HEAD, mergeCommitSha: MERGE_SHA, mergeable: 'mergeable' }, true);
    c.store.verify(r.id, 'thr_cap', MERGE_SHA, { driven: 'Opened the changed screen', seen: 'The change worked' });
    assert.equal(c.store.get(r.id).status, 'complete');
    c.gate.needStatusPost(r.id, HEAD, error, Date.now());
  }
}

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

test('a background pass posts at most the shared burst; held-back posts stay saved with their last error', async () => {
  const c = await completedWithSavedRetry();
  const realNow = Date.now;
  try {
    let simulated = realNow() + 3_600_000;
    Date.now = () => simulated;
    addCompleted(c, 131, 150, 'GitHub outage');
    const saved = new Map(retryRows(c).map((row) => [row.pr, row.last_error]));
    assert.equal(saved.size, 21);
    c.recover();
    await c.host.harness.behavior.runSchedule('pr-delivery-follow-up');
    const first = posts(c.commands).length;
    assert.ok(first >= 1 && first <= 10, `${first} status posts in one pass; the shared burst is 10`);
    const left = retryRows(c);
    assert.equal(left.length, 21 - first);
    // A post the allowance held back is not a transport failure: its saved error is unchanged.
    for (const row of left) assert.equal(row.last_error, saved.get(row.pr), row.pr);
    for (let pass = 0; pass < 10 && retryRows(c).length > 0; pass++) {
      simulated += 60_000;
      await c.host.harness.behavior.runSchedule('pr-delivery-follow-up');
    }
    assert.deepEqual(retryRows(c), []);
    assert.equal(posts(c.commands).length, 21, 'each saved post is sent once');
    assert.deepEqual(prReads(c.commands), []);
  } finally { Date.now = realNow; await c.host.harness.lifecycle.dispose(); }
});

test('a long outage keeps background status posts within the rolling hourly allowance; an explicit reconcile is not charged', async () => {
  const c = await completedWithSavedRetry();
  const realNow = Date.now;
  try {
    let simulated = realNow() + 3_600_000;
    Date.now = () => simulated;
    addCompleted(c, 131, 142, 'GitHub outage');
    // One pass a minute. The burst of 10 and the pace of 470 an hour would allow 472 posts in
    // the first 60 passes, all inside one hour: the hourly allowance of 470 stops the last ones.
    const passes = [];
    const pass = async () => {
      const before = posts(c.commands).length;
      await c.host.harness.behavior.runSchedule('pr-delivery-follow-up');
      passes.push({ at: simulated, posts: posts(c.commands).length - before });
    };
    for (let n = 0; n < 60; n++) {
      if (n > 0) simulated += 60_000;
      await pass();
    }
    const counts = passes.map((p) => p.posts);
    assert.ok(counts[0] <= 10, `${counts[0]} status posts in the first pass; the shared burst is 10`);
    assert.equal(counts.reduce((sum, n) => sum + n, 0), 470, counts.join(','));
    // An explicit reconcile is the captain's own request: it posts though the background allowance is used up.
    const before = posts(c.commands).length;
    await c.deliveries({ action: 'reconcile', id: ID });
    assert.equal(posts(c.commands).length - before, 1);
    for (let n = 0; n < 15; n++) {
      simulated += 60_000;
      await pass();
    }
    for (const end of passes) {
      const inHour = passes.filter((p) => p.at > end.at - 3_600_000 && p.at <= end.at).reduce((sum, p) => sum + p.posts, 0);
      assert.ok(inHour <= 470, `${inHour} background status posts in the hour up to ${end.at}; the hourly allowance is 470`);
    }
    assert.ok(passes.slice(60).some((p) => p.posts > 0), 'posts resume once the first passes leave the hour');
    assert.equal(retryRows(c).length, 13, 'every failed or held-back post stays saved');
    assert.deepEqual(prReads(c.commands), []);
  } finally { Date.now = realNow; await c.host.harness.lifecycle.dispose(); }
});

test('a background approval read the allowance refuses defers the whole status sync, saved with its last error', async () => {
  const c = await completedWithSavedRetry();
  const realNow = Date.now;
  try {
    let simulated = realNow() + 3_600_000;
    Date.now = () => simulated;
    addCompleted(c, 131, 150, 'GitHub outage');
    // Each later delivery was approved on an older head, so its status first reads the comparison.
    for (let n = 131; n <= 150; n++) approvePr(c.host.bb.storage.database(), 'thr_cap', `${REPO}#${n}`, '2'.repeat(40));
    const compares = (commands) => commands.filter((cmd) => cmd.includes('/compare/'));
    const saved = new Map(retryRows(c).map((row) => [row.pr, row.last_error]));
    c.recover();
    await c.host.harness.behavior.runSchedule('pr-delivery-follow-up');
    const sent = posts(c.commands).length;
    const read = compares(c.commands).length;
    assert.ok(sent >= 1 && sent + read <= 10, `${sent} posts and ${read} comparison reads in one pass; the shared burst is 10`);
    const left = retryRows(c);
    assert.equal(left.length, 21 - sent);
    for (const row of left) assert.equal(row.last_error, saved.get(row.pr), row.pr);
    // The captain's own reconcile is not charged: it reads and posts with the allowance used up.
    await c.deliveries({ action: 'reconcile', id: left[0].pr });
    assert.equal(posts(c.commands).length, sent + 1);
    assert.equal(compares(c.commands).length, read + 1);
    for (let pass = 0; pass < 10 && retryRows(c).length > 0; pass++) {
      simulated += 60_000;
      await c.host.harness.behavior.runSchedule('pr-delivery-follow-up');
    }
    assert.deepEqual(retryRows(c), []);
    assert.equal(posts(c.commands).length, 21, 'each saved post is sent once');
  } finally { Date.now = realNow; await c.host.harness.lifecycle.dispose(); }
});

test('a new head\'s first status post waits for the end of the pass and the allowance, saved without an error across a restart', async () => {
  const c = await completedWithSavedRetry();
  const realNow = Date.now;
  let host = c.host;
  const rows = () => retryRows({ host });
  try {
    let simulated = realNow() + 3_600_000;
    Date.now = () => simulated;
    c.gate.clearStatusPost(ID, HEAD);
    stubHost(host, c.commands, c.statusOk, c.taps, true);
    for (let n = 131; n <= 142; n++) c.store.register({ url: `https://github.com/${REPO}/pull/${n}`, taskId: 'woo1', projectId: 'proj_1', owner: 'thr_cap', home: '/native', worker: 'thr_woo', requirement: 'pr', title: `Change ${n}` });
    const reads = () => c.commands.filter((cmd) => cmd.includes('gh pr view'));
    c.recover();
    await host.harness.behavior.runSchedule('pr-delivery-follow-up');
    // The burst of 10 goes to the quota probe and the PR reads; their first posts wait, saved with no error.
    const first = reads().length;
    assert.ok(first >= 8 && first < 12, `${first} PR reads in the first pass`);
    assert.deepEqual(posts(c.commands), []);
    assert.equal(rows().length, first);
    assert.ok(rows().every((row) => row.last_error === ''), JSON.stringify(rows()));
    host = await host.harness.lifecycle.reload(plugin);
    stubHost(host, c.commands, c.statusOk, c.taps, true);
    assert.equal(rows().length, first, 'the saved first posts survive the restart');
    c.commands.length = 0;
    simulated += 60_000;
    await host.harness.behavior.runSchedule('pr-delivery-follow-up');
    assert.equal(reads().length, 12 - first, 'the PRs not read yet come first');
    const firstPost = c.commands.findIndex((cmd) => cmd.includes('/statuses/'));
    assert.ok(firstPost > c.commands.findLastIndex((cmd) => cmd.includes('gh pr view')), 'status posts go after the PR reads');
    for (let pass = 0; pass < 10 && rows().length > 0; pass++) {
      simulated += 60_000;
      await host.harness.behavior.runSchedule('pr-delivery-follow-up');
    }
    assert.deepEqual(rows(), []);
    assert.equal(posts(c.commands).length, 12, 'each first post is sent once');
  } finally { Date.now = realNow; await host.harness.lifecycle.dispose(); }
});
