// Workstream dispatch gaps found live on 20 Oct (captain thr_pse43vv6tn, workstream ws-32df9211-06b "Cyndra SaaS UI"):
// 1. acp-antigravity crews died on a model BB lists but the agy CLI refuses (gemini-4-argon).
// 2. A dispatch without workstreamId (Hermes split, taskRef T333) joined the UI workstream.
// 3. A workstream dispatch answered "Reserved" and its job then stayed "starting" behind the crew cap.
// 4. A failed workstream crew could not be relaunched, and dead crews held crew slots.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createOwnerTasks } from './lib/owner-tasks.ts';
import { createWorkstreams } from './lib/workstreams.ts';
import { createLaunches, launchKey } from './lib/launch.ts';
import { PROVIDER_CATALOG, stubProviderCatalog } from './test/provider-catalog.mjs';
import { manifestSkillIds } from './scripts/plugin-skill-fixture.mjs';

const skills = manifestSkillIds(new URL('.', import.meta.url).pathname);
type Host = ReturnType<typeof createFakePluginHost>;
const ctx = { threadId: 'cap', projectId: 'cyndra' } as never;
const text = (out: unknown) => (typeof out === 'string' ? out : (out as { content?: Array<{ text?: string }> })?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(out));
const tool = (host: Host, name: string) => host.harness.inspection.registrations.agentTools.find((t) => t.name === name)!;
const sentTo = (host: Host, threadId: string) => host.harness.sdk.callsTo('threads.send').map((call) => call[0] as { threadId: string; input?: Array<{ text?: string }> })
  .filter((call) => call.threadId === threadId).map((call) => call.input?.map((part) => part.text ?? '').join('') ?? '');

// `agy models` on host_m4jkvpkw67, 20 Oct 11:20 UTC.
const AGY = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n';
// BB's catalog for acp-antigravity came from the host bridge's own table, which still listed gemini-4-argon.
const CATALOG = { ...PROVIDER_CATALOG, 'acp-antigravity': ['gemini-4-argon', 'gemini-3.8-flash', 'claude-sonnet-4-6'] };

async function gapsHost(opts: { async?: boolean; cap?: number; catalog?: Record<string, string[]> } = {}) {
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: skills, settings: opts.async ? { fmReliability: JSON.stringify({ asyncDispatch: 'on' }) } : {} });
  const seeded = createWorkstreams(host.bb.storage.database(), {
    now: () => 0, provision: async () => [{ repository: 'cyndra-ai/cyndra-saas', projectId: 'cyndra', hostId: 'h1', path: '/repo/ws', sourcePath: '/repo/main', branch: 'workstream/ws-ui', environmentId: 'env_ws' }],
    start: async () => 'unused', status: async () => 'unknown', startDev: async () => '', stopDev: async () => {}, unsaved: async () => [], remove: async () => {}, ship: async () => {}, taskState: () => 'working',
  });
  const w = await seeded.create({ threadId: 'cap', projectId: 'cyndra', name: 'Cyndra SaaS UI', requestId: 'create' });
  await plugin(host.bb); stubProviderCatalog(host);
  const catalog = opts.catalog ?? CATALOG;
  host.harness.sdk.stub('providers.models', async ({ providerId }: { providerId?: string } = {}) => ({ modelLoadError: null, models: (catalog[providerId ?? 'claude-code'] ?? []).map((id) => ({ id, model: id })) }));
  await host.harness.behavior.setSettings({ signInCheck: false, fmHome: '', maxActiveCrews: opts.cap ?? 0 });
  await host.bb.storage.kv.set('captain-project:cap', 'cyndra');
  const statuses = new Map<string, string>();
  const spawned: Array<Record<string, unknown>> = [];
  host.harness.sdk.stub('threads.getPluginMetadata', async ({ threadId }: { threadId: string }) => (threadId === 'cap' ? { captain: 'true' } : {}));
  host.harness.sdk.stub('threads.get', async ({ threadId }: { threadId: string }) => ({ ...makeThreadResponse({ id: threadId, projectId: 'cyndra', status: statuses.get(threadId) ?? (threadId === 'cap' ? 'idle' : 'active') }), environmentId: threadId === 'cap' ? 'env_main' : `env_${threadId}` }));
  host.harness.sdk.stub('threads.list', async () => []);
  host.harness.sdk.stub('threads.events.list', async () => []);
  host.harness.sdk.stub('threads.output', async () => ({ output: '' }));
  host.harness.sdk.stub('projects.get', async () => ({ id: 'cyndra', name: 'Cyndra SaaS', kind: 'repo', sources: [{ hostId: 'h1', path: '/repo/main', isDefault: true }] }));
  host.harness.sdk.stub('projects.list', async () => [{ id: 'cyndra', name: 'Cyndra SaaS' }]);
  host.harness.sdk.stub('projects.defaultExecutionOptions', async () => ({ providerId: 'claude-code', model: 'claude-opus-5-5' }));
  host.harness.sdk.stub('environments.list', async () => [{ id: 'env_main', hostId: 'h1', path: '/repo/main', status: 'ready', isWorktree: false }]);
  host.harness.sdk.stub('environments.get', async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: 'h1', path: environmentId === 'env_main' ? '/repo/main' : `/wt/${environmentId}`, status: 'ready', isWorktree: environmentId !== 'env_main' }));
  host.harness.sdk.stub('threads.spawn', async (args: Record<string, unknown>) => { spawned.push(args); return { id: `thr_worker${spawned.length}` }; });
  host.harness.sdk.stub('threads.defaultExecutionOptions', async () => ({ model: 'claude-sonnet-5-5', reasoningLevel: 'high' }));
  host.harness.sdk.stub('threads.send', async () => ({}));
  host.harness.sdk.stub('threadSections.list', async () => []);
  host.harness.sdk.stub('threadSections.create', async () => ({ id: 'sec' }));
  host.harness.sdk.stub('plugins.callRpc', async () => ({ ok: true, queued: 1, duplicate: false }));
  // Host commands: `agy models` answers with the CLI's own list; every other command succeeds silently.
  const commands: string[] = [];
  const byId = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub('terminals.create', async (args: { start?: { command?: string } }) => { const id = `t_${++n}`; byId.set(id, args.start?.command ?? ''); commands.push(args.start?.command ?? ''); return { id }; });
  host.harness.sdk.stub('terminals.get', async () => ({ status: 'running' }));
  host.harness.sdk.stub('terminals.close', async () => ({}));
  host.harness.sdk.stub('terminals.output', async ({ terminalId }: { terminalId: string }) => {
    const cmd = byId.get(terminalId) ?? '';
    const payload = cmd.includes('agy models') ? AGY : '';
    const captured = cmd.includes('FM_HOST_CAPTURE_V1');
    const out = captured ? JSON.stringify({ protocol: 'FM_HOST_CAPTURE_V1', exitCode: 0, stdout: payload, stderr: '' }) : payload;
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${out}\n__FM_HOST_RC:0\n`).toString('base64') }] };
  });
  const tasks = createOwnerTasks(host.bb.storage.database());
  const dispatch = async (input: Record<string, unknown>) => text(await tool(host, 'firstmate_dispatch').execute({ projectId: 'cyndra', ...input }, ctx));
  return { host, seeded, w, statuses, spawned, commands, tasks, dispatch };
}

const crewRow = (id: string, threadId: string, extra: Record<string, unknown> = {}) => ({
  id, task: 'x', title: id, projectId: 'cyndra', threadId, parentThreadId: 'cap', nativeHome: '', worktree: true,
  shape: 'ship', posture: 'direct-PR', createdAt: '2026-10-20T00:00:00.000Z', providerId: 'claude-code', model: 'claude-sonnet-5-5', reasoningLevel: null, ...extra,
});

test('a model BB lists but the provider CLI refuses is refused at dispatch, before anything is reserved, naming the models it accepts', async () => {
  const f = await gapsHost({ async: true });
  try {
    const out = await f.dispatch({ task: 'Fix the dashboard that loads forever', taskId: 'dashboard-loading-1020b', workstreamId: f.w.id, origin: { kind: 'captain', reason: 'owner asked' }, providerId: 'acp-antigravity', model: 'gemini-4-argon', reasoningLevel: 'xhigh', ownerRequestedProvider: true });
    assert.match(out, /Provider "acp-antigravity" lists model "gemini-4-argon", but its CLI on host h1 does not accept it \(`agy models`\)\. Models it accepts: gemini-3\.8-flash, claude-sonnet-4-6\. Nothing was spawned\./);
    assert.doesNotMatch(out, /Reserved/);
    assert.equal(f.spawned.length, 0);
    assert.deepEqual(f.seeded.get(f.w.id, 'cap').jobs, [], 'no workstream job waits for a slot');
    assert.deepEqual(f.tasks.list('cap'), [], 'no owner task was opened');
    const fine = await f.dispatch({ task: 'Fix the dashboard that loads forever', taskId: 'dashboard-flash', workstreamId: f.w.id, origin: { kind: 'captain', reason: 'owner asked' }, providerId: 'acp-antigravity', model: 'gemini-3.8-flash', ownerRequestedProvider: true });
    assert.match(fine, /Reserved crew dashboard-flash/);
    assert.equal(f.commands.filter((c) => c.includes('agy models')).length, 1, 'the CLI list is read once and reused');
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('a dispatch without workstreamId never joins the workstream of the owner message it answers', async () => {
  const f = await gapsHost();
  try {
    await f.host.bb.storage.kv.set('workstream-ref:tg:985604794:6243', f.w.id);
    const hermes = f.tasks.open({ captain: 'cap', project: 'Cyndra SaaS', projectId: 'cyndra', title: 'Hermes split', sourceRefs: ['tg:985604794:6210'], crewId: '5801d05e', at: Date.now() });
    const out = await f.dispatch({ task: 'Continue the Hermes split on fm/5801d05e', taskId: 'hermes-claude', taskRef: hermes.id, sourceRefs: ['tg:985604794:6243'], providerId: 'claude-code', model: 'claude-opus-5-5' });
    assert.match(out, /Dispatched ship crew hermes-claude/);
    assert.match(out, /Owner message tg:985604794:6243 came from the topic of workstream Cyndra SaaS UI \(ws-[\w-]+\); this crew is not in it\. To work there, dispatch with workstreamId=ws-/);
    const crew = ((await f.host.bb.storage.kv.get('crews')) as Array<{ id: string; workstreamId?: string }>).find((c) => c.id === 'hermes-claude');
    assert.equal(crew?.workstreamId, undefined);
    assert.deepEqual(f.seeded.get(f.w.id, 'cap').taskIds, []);
    assert.deepEqual(f.seeded.get(f.w.id, 'cap').jobs, []);
    assert.doesNotMatch(String(f.spawned[0]!.prompt), /Workstream ws-/);
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('the captain takes a wrongly attached task out of a workstream; folded work stays; the task then runs outside it', async () => {
  const f = await gapsHost();
  try {
    const ui = f.tasks.open({ captain: 'cap', project: 'Cyndra SaaS', projectId: 'cyndra', title: 'Web chat image preview', sourceRefs: ['tg:985604794:6100'], crewId: 'f3a726e7', at: Date.now() });
    const hermes = f.tasks.open({ captain: 'cap', project: 'Cyndra SaaS', projectId: 'cyndra', title: 'Hermes split', sourceRefs: ['tg:985604794:6210'], crewId: '43864fce', at: Date.now() });
    await f.seeded.attachTask(f.w.id, 'cap', ui.id);
    await f.seeded.attachTask(f.w.id, 'cap', hermes.id);
    await f.seeded.submit(f.w.id, 'cap', { id: 'f3a726e7', editing: true, payload: '{"task":"Image preview"}', taskId: ui.id });
    f.seeded.noteJob(f.w.id, 'cap', 'f3a726e7', { state: 'folded', foldedAt: 1, cleanup: 'done' });
    await f.seeded.submit(f.w.id, 'cap', { id: '43864fce', editing: true, payload: '{"task":"Hermes split"}', taskId: hermes.id });
    f.seeded.noteJob(f.w.id, 'cap', '43864fce', { state: 'failed', failedAt: 1, threadId: 'thr_5uy6emcueb' });
    await f.host.bb.storage.kv.set('crews', [crewRow('43864fce', 'thr_5uy6emcueb', { workstreamId: f.w.id })]);
    f.statuses.set('thr_5uy6emcueb', 'error');
    const folded = f.seeded.get(f.w.id, 'cap').jobs.find((j) => j.id === 'f3a726e7');
    const blocked = await f.dispatch({ task: 'Continue the Hermes split', taskId: 'hermes-claude', taskRef: hermes.id, providerId: 'claude-code', model: 'claude-opus-5-5' });
    assert.match(blocked, /Task belongs to another workstream/);
    const ws = tool(f.host, 'firstmate_workstream');
    const removed = text(await ws.execute({ action: 'removeTask', workstreamId: f.w.id, taskId: hermes.id }, ctx));
    assert.match(removed, new RegExp(`${hermes.id} left workstream Cyndra SaaS UI`));
    const after = f.seeded.get(f.w.id, 'cap');
    assert.deepEqual(after.taskIds, [ui.id]);
    assert.deepEqual(after.jobs.find((j) => j.id === 'f3a726e7'), folded, 'folded work is untouched');
    assert.equal(after.jobs.find((j) => j.id === '43864fce')!.state, 'dropped');
    const refusedFolded = text(await ws.execute({ action: 'removeTask', workstreamId: f.w.id, taskId: ui.id }, ctx));
    assert.match(refusedFolded, /folded work/);
    const out = await f.dispatch({ task: 'Continue the Hermes split', taskId: 'hermes-claude', taskRef: hermes.id, providerId: 'claude-code', model: 'claude-opus-5-5' });
    assert.match(out, /Dispatched ship crew hermes-claude/);
    assert.deepEqual(f.seeded.get(f.w.id, 'cap').taskIds, [ui.id]);
    const forget = text(await tool(f.host, 'firstmate_forget').execute({ crewId: '43864fce' }, ctx));
    assert.doesNotMatch(forget, /Workstream crew kept/, 'a crew whose task left the workstream is no longer kept by it');
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('a provisioning launch whose crew thread ended holds no crew slot; one whose thread works still does', async () => {
  const f = await gapsHost({ cap: 1 });
  try {
    const launches = createLaunches(f.host.bb.storage.database());
    const key = launchKey('cyndra', 'cap', '', '9ade6f3a');
    launches.save({ key, taskId: '9ade6f3a', projectId: 'cyndra', owner: 'cap', home: '', generation: 1, shape: 'ship', deliveryMode: 'direct-PR', deliveryRequirement: 'pr', state: 'provisioning', threadId: 'thr_nh2pwqve28', creationRequested: true, updatedAt: Date.now() });
    f.statuses.set('thr_nh2pwqve28', 'active');
    const held = await f.dispatch({ task: 'Fix the dashboard', taskId: 'dash-a', origin: { kind: 'captain', reason: 'owner asked' }, providerId: 'claude-code', model: 'claude-sonnet-5-5' });
    assert.match(held, /Crew cap reached: 1 crews running or reserved \(cap 1\)/);
    f.statuses.set('thr_nh2pwqve28', 'error');
    const out = await f.dispatch({ task: 'Fix the dashboard', taskId: 'dash-b', origin: { kind: 'captain', reason: 'owner asked' }, providerId: 'claude-code', model: 'claude-sonnet-5-5' });
    assert.match(out, /Dispatched ship crew dash-b/);
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('a workstream job without a crew slot says why it waits, tells the captain, and tells him again when it starts', async () => {
  const f = await gapsHost({ cap: 1 });
  try {
    await f.host.bb.storage.kv.set('crews', [crewRow('holder', 'thr_holder')]);
    f.statuses.set('thr_holder', 'active');
    const out = await f.dispatch({ task: 'Fix the dashboard that loads forever', taskId: 'dashboard-loading-1020c', title: 'Dashboard loads forever', workstreamId: f.w.id, origin: { kind: 'captain', reason: 'owner asked' }, providerId: 'claude-code', model: 'claude-sonnet-5-5' });
    assert.match(out, /Queued crew dashboard-loading-1020c in workstream ws-[\w-]+; it waits for a free crew slot \(Crew cap reached: 1 crews running or reserved \(cap 1\)/);
    const job = () => f.seeded.get(f.w.id, 'cap').jobs.find((j) => j.id === 'dashboard-loading-1020c')!;
    assert.equal(job().state, 'queued');
    assert.ok(sentTo(f.host, 'cap').some((m) => /Crew dashboard-loading-1020c \((?:T\d+, )?Dashboard loads forever\) in workstream Cyndra SaaS UI has not started: it waits for a free crew slot\. Crew cap reached: 1 crews running or reserved \(cap 1\)\..*Slots are held by: holder/s.test(m)), sentTo(f.host, 'cap').join('\n---\n'));
    assert.ok(sentTo(f.host, 'cap').some((m) => /firstmate_workstream action=cancel workstreamId=ws-[\w-]+ crewId=dashboard-loading-1020c/.test(m)));
    const view = text(await tool(f.host, 'firstmate_workstream').execute({ action: 'view', workstreamId: f.w.id }, ctx));
    assert.match(view, /T\d+ Dashboard loads forever claude-sonnet-5-5 queued \(waits: Crew cap reached/);
    await f.host.harness.behavior.runSchedule('workstreams');
    assert.equal(sentTo(f.host, 'cap').filter((m) => /has not started/.test(m)).length, 1, 'one notice, not one per pass');
    f.statuses.set('thr_holder', 'idle');
    await f.host.harness.behavior.runSchedule('workstreams');
    assert.equal(job().state, 'running');
    assert.equal(f.spawned.length, 1);
    assert.ok(sentTo(f.host, 'cap').some((m) => /Crew dashboard-loading-1020c \(T\d+, Dashboard loads forever\) in workstream Cyndra SaaS UI started as thread thr_worker1\./.test(m)), sentTo(f.host, 'cap').join('\n---\n'));
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('a waiting workstream job whose start is refused ends failed with the reason; the captain hears how to run it again', async () => {
  const f = await gapsHost({ cap: 1 });
  try {
    await f.host.bb.storage.kv.set('crews', [crewRow('holder', 'thr_holder')]);
    f.statuses.set('thr_holder', 'active');
    await f.dispatch({ task: 'Fix the dashboard', taskId: 'dash-codex', title: 'Dashboard', workstreamId: f.w.id, origin: { kind: 'captain', reason: 'owner asked' }, providerId: 'codex', model: 'gpt-6.1-sol' });
    // The model left the catalog while the job waited.
    f.host.harness.sdk.stub('providers.models', async ({ providerId }: { providerId?: string } = {}) => ({ modelLoadError: null, models: (providerId === 'codex' ? ['gpt-6-luna'] : CATALOG[providerId ?? 'claude-code'] ?? []).map((id) => ({ id, model: id })) }));
    f.statuses.set('thr_holder', 'idle');
    await f.host.harness.behavior.runSchedule('workstreams');
    const job = f.seeded.get(f.w.id, 'cap').jobs.find((j) => j.id === 'dash-codex')!;
    assert.equal(job.state, 'failed');
    assert.match(job.error ?? '', /does not offer model "gpt-6.1-sol"/);
    assert.equal(f.spawned.length, 0);
    const told = sentTo(f.host, 'cap').find((m) => /did not start/.test(m)) ?? '';
    assert.match(told, /Crew dash-codex \(T\d+, Dashboard\) in workstream Cyndra SaaS UI did not start: .*does not offer model "gpt-6\.1-sol".*Nothing was spawned/s);
    assert.match(told, /To run the task again: firstmate_dispatch with workstreamId=ws-[\w-]+ taskRef=T\d+ and a provider and model that work\./);
    const view = text(await tool(f.host, 'firstmate_workstream').execute({ action: 'view', workstreamId: f.w.id }, ctx));
    assert.match(view, /failed \(did not start: /);
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('the captain cancels a workstream job that waits for a slot; it never starts', async () => {
  const f = await gapsHost({ cap: 1 });
  try {
    await f.host.bb.storage.kv.set('crews', [crewRow('holder', 'thr_holder')]);
    f.statuses.set('thr_holder', 'active');
    await f.dispatch({ task: 'Fix the dashboard', taskId: 'dashboard-loading-1020b', workstreamId: f.w.id, origin: { kind: 'captain', reason: 'owner asked' }, providerId: 'claude-code', model: 'claude-sonnet-5-5' });
    const ws = tool(f.host, 'firstmate_workstream');
    const out = text(await ws.execute({ action: 'cancel', workstreamId: f.w.id, crewId: 'dashboard-loading-1020b' }, ctx));
    assert.match(out, /Cancelled crew dashboard-loading-1020b in workstream Cyndra SaaS UI before it started/);
    f.statuses.set('thr_holder', 'idle');
    await f.host.harness.behavior.runSchedule('workstreams');
    assert.equal(f.spawned.length, 0);
    assert.equal(f.seeded.get(f.w.id, 'cap').jobs[0]!.state, 'dropped');
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('retrying a failed workstream crew names the follow-up dispatch that relaunches it on another provider', async () => {
  const f = await gapsHost();
  try {
    const task = f.tasks.open({ captain: 'cap', project: 'Cyndra SaaS', projectId: 'cyndra', title: 'Dashboard loads forever', sourceRefs: ['tg:985604794:6243'], crewId: '9ade6f3a', at: Date.now() });
    await f.seeded.attachTask(f.w.id, 'cap', task.id);
    await f.seeded.submit(f.w.id, 'cap', { id: '9ade6f3a', editing: true, payload: '{"task":"Fix the dashboard"}', taskId: task.id });
    f.seeded.noteJob(f.w.id, 'cap', '9ade6f3a', { state: 'failed', failedAt: 1, threadId: 'thr_nh2pwqve28', environmentId: 'env_thr_nh2pwqve28' });
    await f.host.bb.storage.kv.set('crews', [crewRow('9ade6f3a', 'thr_nh2pwqve28', { workstreamId: f.w.id, providerId: 'acp-antigravity', model: 'gemini-4-argon' })]);
    f.statuses.set('thr_nh2pwqve28', 'error');
    const out = text(await tool(f.host, 'firstmate_retry').execute({ crewId: '9ade6f3a', providerId: 'claude-code', model: 'claude-sonnet-5-5', reason: 'agy refused gemini-4-argon' }, ctx));
    assert.match(out, new RegExp(`Crew 9ade6f3a works in workstream ${f.w.id}: relaunch it as a follow-up, which reuses its worktree: firstmate_dispatch workstreamId=${f.w.id} taskRef=${task.id} providerId=claude-code model=claude-sonnet-5-5 with the task`));
    const follow = await f.dispatch({ task: 'Fix the dashboard', taskId: 'dashboard-loading-1020d', workstreamId: f.w.id, taskRef: task.id, providerId: 'claude-code', model: 'claude-sonnet-5-5' });
    assert.match(follow, /Dispatched ship crew dashboard-loading-1020d/);
    assert.deepEqual(f.spawned.at(-1)!.environment, { type: 'reuse', environmentId: 'env_thr_nh2pwqve28' }, 'the follow-up continues in the failed crew\'s worktree');
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('a background workstream dispatch that answered Reserved tells the captain once why its job waits (dashboard-loading-1020b)', async () => {
  const f = await gapsHost({ async: true, cap: 1 });
  try {
    await f.host.bb.storage.kv.set('crews', [crewRow('holder', 'thr_holder')]);
    f.statuses.set('thr_holder', 'active');
    const out = await f.dispatch({ task: 'Fix the dashboard that loads forever', taskId: 'dashboard-loading-1020b', title: 'Dashboard loads forever', workstreamId: f.w.id, sourceRefs: ['tg:985604794:6243'], providerId: 'claude-code', model: 'claude-sonnet-5-5' });
    assert.match(out, /Reserved crew dashboard-loading-1020b/);
    for (let n = 0; n < 150 && !sentTo(f.host, 'cap').some((m) => /has not started/.test(m)); n++) await new Promise((resolve) => setTimeout(resolve, 20));
    const waits = sentTo(f.host, 'cap').filter((m) => /dashboard-loading-1020b/.test(m));
    assert.equal(waits.length, 1, waits.join('\n---\n'));
    assert.match(waits[0]!, /Crew dashboard-loading-1020b \(T1, Dashboard loads forever\) in workstream Cyndra SaaS UI has not started: it waits for a free crew slot\. Crew cap reached: 1 crews running or reserved \(cap 1\)\./);
    const job = f.seeded.get(f.w.id, 'cap').jobs.find((j) => j.id === 'dashboard-loading-1020b')!;
    assert.deepEqual([job.state, job.taskId, job.told], ['queued', 'T1', 'waiting']);
  } finally { await f.host.harness.lifecycle.dispose(); }
});
