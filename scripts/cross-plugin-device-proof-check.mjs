// Cross-plugin check (owner decision Q5): a crew's device proof card goes through the real Telegram
// connector engine, the owner taps Works on it, and the real Firstmate plugin records the proof.
// Both plugins run in-process: Firstmate on the SDK fake host, the connector on its own test harness
// with a fake Telegram. Their RPC calls are wired to each other in the order BB delivers them.
//
// Not part of `npm test`: it needs a Telegram connector checkout.
//   TELEGRAM_CHECKOUT=<bb-plugin-telegram checkout> node --experimental-transform-types \
//     --import "$TELEGRAM_CHECKOUT/test/register.mjs" scripts/cross-plugin-device-proof-check.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
import { createDeliveries } from '../lib/pr-delivery.ts';

process.env.FM_MERGEABLE_POLL_MS = '0';
const TG = process.env.TELEGRAM_CHECKOUT;
if (!TG) { console.error('Set TELEGRAM_CHECKOUT to a bb-plugin-telegram checkout.'); process.exit(2); }
const { baseConfig, cycle, makeHarness, openStore } = await import(pathToFileURL(join(TG, 'test/support.ts')).href);

const CAPTAIN = 'thr_captain';
const PR = 'https://github.com/amrtawfik160/dr.woo/pull/130';
const ID = 'amrtawfik160/dr.woo#130';
const HEAD = '1301301301301301301301301301301301301301';

const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: ['firstmate', 'captain'], settings: { fmHome: '/native', fmHostId: 'host_1' } });
await host.bb.storage.kv.set(`captain-project:${CAPTAIN}`, 'proj_1');
await plugin(host.bb);
await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: 'on', telegramThreading: 'on' }) });
host.harness.sdk.stub('threads.list', async () => []);
host.harness.sdk.stub('threads.getPluginMetadata', async ({ threadId }) => (threadId === CAPTAIN ? { captain: 'true' } : {}));
host.harness.sdk.stub('threads.get', async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: 'proj_1', status: 'idle' }));
host.harness.sdk.stub('threads.send', async () => ({ delivery: 'queued' }));
host.harness.sdk.stub('projects.get', async () => ({ id: 'proj_1', name: 'woo-app', kind: 'repo' }));
host.harness.sdk.stub('environments.list', async () => [{ id: 'env_source', hostId: 'host_1', status: 'ready', isWorktree: false, path: '/repo' }]);
await host.bb.storage.kv.set('crews', [{ id: 'woo1', task: 'x', title: 'Fix the photo upload', projectId: 'proj_1', threadId: 'thr_woo', parentThreadId: CAPTAIN, nativeHome: '/native', worktree: true, shape: 'ship', posture: 'direct-PR', createdAt: '2026-10-18T00:00:00.000Z', providerId: 'claude-code', model: 'claude-opus-5-5', reasoningLevel: null }]);
const deliveries = createDeliveries(host.bb.storage.database());
deliveries.register({ url: PR, taskId: 'woo1', projectId: 'proj_1', owner: CAPTAIN, home: '/native', worker: 'thr_woo', requirement: 'merged', title: 'Change 130' });
deliveries.observe(ID, { headSha: HEAD, state: 'open', draft: false, checks: 'passing', review: 'approved', reviewHeadSha: HEAD, mergeCommitSha: null, mergeable: 'mergeable' }, true);

// The connector: its resolveAsk calls Firstmate's RPC, as its server.ts does.
const { store } = openStore();
const tg = makeHarness({ store, config: baseConfig({ threadedReplies: 'on' }), resolveAsk: (input) => host.harness.behavior.callRpc('resolveAsk', input) });
// Firstmate's calls to the connector reach the real engine methods its server.ts registers.
host.harness.sdk.stub('plugins.callRpc', async ({ pluginId, method, input }) => {
  if (pluginId !== 'telegram') return { ok: true };
  if (method === 'ask') return tg.engine.enqueueAskRouted(input);
  if (method === 'ownerAnswer') return tg.engine.ownerAnswer(input);
  if (method === 'editAsk') return tg.engine.editAsk(input);
  return { ok: true };
});

const results = [];
const check = (name, fn) => { try { fn(); results.push(`PASS ${name}`); } catch (error) { results.push(`FAIL ${name}: ${error.message}`); } };
try {
  await cycle(tg.engine);
  const tool = host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_deliveries');
  const opened = await tool.execute({ action: 'device-proof', id: ID, commitSha: HEAD.slice(0, 7), build: '8', link: 'https://testflight.apple.com/join/abc', check: 'Send a photo and see it arrive' }, { threadId: 'thr_woo', projectId: 'proj_1' });
  const askId = /card (a[0-9a-z]{6})/.exec(String(opened))?.[1];
  check('the crew opens a device proof card', () => assert.ok(askId, String(opened)));
  await cycle(tg.engine);
  const card = tg.telegram.sent.find((row) => /build 8/.test(row.text));
  check('the connector sends the card to Telegram with its buttons', () => assert.ok(card?.reply_markup, JSON.stringify(tg.telegram.sent.map((row) => row.text))));
  const button = card?.reply_markup?.inline_keyboard.flat().find((item) => /^Works/.test(item.text));
  tg.telegram.updates.push({ update_id: 9001, callback_query: { id: 'cb-proof', from: { id: 42, is_bot: false }, message: { message_id: card?.message_id, chat: { id: 42, type: 'private' } }, data: button?.callback_data } });
  await cycle(tg.engine);
  await cycle(tg.engine);
  const verification = deliveries.get(ID).verification;
  check('the owner\'s Works tap records the proof for build 8 at the head', () => assert.deepEqual([verification?.actor, verification?.build, verification?.surface, verification?.commitSha], ['owner', '8', 'iphone', HEAD]));
} finally {
  await host.harness.lifecycle.dispose();
}
for (const line of results) console.log(line);
process.exit(results.every((line) => line.startsWith('PASS')) ? 0 : 1);
