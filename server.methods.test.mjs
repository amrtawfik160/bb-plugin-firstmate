import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';

const root = dirname(fileURLToPath(import.meta.url));
const skillRoot = join(root, 'skills');
// Declare skills from the actual manifest directory, not from the routing code.
const skillIds = readdirSync(skillRoot).filter(name =>
  readdirSync(join(skillRoot, name)).includes('SKILL.md'));

async function configuredHost(settings = {}) {
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: skillIds, settings });
  await plugin(host.bb);
  return host;
}
const configure = (host, pluginMetadata) => host.harness.behavior.resolveAgentConfiguration(
  makePluginAgentConfigurationContext({ pluginMetadata }));

test('role methods route through actual configuration across resume and reload without side effects', async () => {
  let host = await configuredHost();
  try {
    const cases = [
      [{}, [], ['firstmate']],
      [{ captain: 'true' }, ['captain-methods'], ['captain']],
      [{ captain: 'true', nativeHome: '/owned-home' }, ['captain-methods'], ['captain']],
      [{ crew: 'true' }, ['worker-methods'], []],
      [{ crew: 'true', captain: 'true', nativeHome: '/owned-home' }, ['worker-methods'], []],
    ];
    const stateBefore = await host.bb.storage.kv.get('crews');
    for (const reload of [false, true]) {
      if (reload) host = await host.harness.lifecycle.reload(plugin);
      for (const [metadata, methods, otherSkills] of cases) {
        const cfg = await configure(host, metadata);
        assert.deepEqual(cfg.skills.filter(id => id.endsWith('-methods')), methods);
        for (const id of otherSkills) assert.ok(cfg.skills.includes(id));
        assert.ok((cfg.instructions ?? '').length <= 4096);
        if (metadata.crew) {
          assert.deepEqual(cfg.tools, []);
          assert.deepEqual(cfg.skills, ['worker-methods']);
          for (const obligation of [/native launch brief/, /exact-ID steering inbox/,
            /Read worker-methods/, /Do not delegate/, /selected provider, model, or effort/,
            /not captain merge or deployment completion/]) assert.match(cfg.instructions, obligation);
          assert.doesNotMatch(cfg.instructions, /firstmate_contract|captain-methods|Calm reporting/);
        } else if (metadata.captain) {
          assert.ok(cfg.tools.some(tool => tool.name === 'firstmate_deliveries'));
          assert.ok(cfg.tools.some(tool => tool.name === 'firstmate_merge'));
          assert.match(cfg.instructions, /Read captain-methods/);
          assert.match(cfg.instructions, /load only its matching reference/);
        }
      }
    }
    assert.equal(await host.bb.storage.kv.get('crews'), stateBefore);
    assert.equal(host.harness.inspection.sdk.calls.length, 0, 'configure must not invoke SDK writes or reads');
  } finally { await host.harness.lifecycle.dispose(); }
});

test('saturated captain instruction budget preserves every runtime obligation and role pointer', async () => {
  const empty = await configuredHost();
  let base;
  try { base = (await configure(empty, { captain: 'true' })).instructions; }
  finally { await empty.harness.lifecycle.dispose(); }
  const host = await configuredHost({
    captainMemory: 'MEMORY_START\n' + 'bounded remembered fact\n'.repeat(1000),
    fmSkillsManifest: JSON.stringify({ head: 'abc1234567890', skills:
      Array.from({ length: 200 }, (_, n) => ({ name: `method-${n}`, desc: 'conditional native reference' })) }),
  });
  try {
    for (const metadata of [{ captain: 'true' }, { captain: 'true', nativeHome: '/resumed-home' }]) {
      const cfg = await configure(host, metadata);
      assert.ok(cfg.instructions.length <= 4096);
      assert.ok(cfg.instructions.startsWith(base), 'optional caches cannot truncate the complete runtime base');
      for (const obligation of [/read firstmate_contract without a section/, /script=session-start/,
        /Calm reporting is the captain default/, /silent routine wakes/, /keep required outcomes and escalations visible/,
        /Read captain-methods/, /firstmate_watch once per batch/, /End the turn; never retry or poll/,
        /author for fixes/, /independent review when required/, /merge through firstmate_merge/,
        /Inspect unresolved delivery records after compaction or handoff/,
        /profileId unset for the thread-isolated default/,
        /Treat tmux, herdr, zellij, cmux, orca/]) assert.match(cfg.instructions, obligation);
      if (!metadata.nativeHome) assert.match(cfg.instructions, /MEMORY_START/);
      assert.match(cfg.instructions, /method-0: conditional native reference/);
    }
  } finally { await host.harness.lifecycle.dispose(); }
});

test('method references resolve within the manifest package without global skill paths', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.bb.skills.includes('skills'));
  const pending = ['captain-methods/SKILL.md', 'worker-methods/SKILL.md', 'calm/SKILL.md', 'catch-up/SKILL.md']
    .map(path => join(skillRoot, path));
  const seen = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(text, /~\/\.codex|~\/\.cursor|\/root\/|\/Users\//);
    for (const [, target] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^https:\/\//.test(target)) continue;
      const destination = resolve(dirname(path), target.split('#')[0]);
      const local = relative(skillRoot, destination);
      assert.ok(!local.startsWith('..'), `${target} must stay in packaged skills`);
      const sourceSkill = relative(skillRoot, path).split('/')[0];
      if (sourceSkill.endsWith('-methods') && /^(captain-methods|worker-methods)\//.test(local)) {
        assert.equal(local.split('/')[0], sourceSkill, 'each selected method skill carries its own method references');
      }
      readFileSync(destination); // Throws if the package-local reference is absent.
      // Existing native references can use fmHome anchors. Check the new graph only.
      if (/^(captain-methods|worker-methods)\//.test(local)) pending.push(destination);
    }
  }
  assert.equal([...seen].filter(path => path.includes('/captain-methods/') || path.includes('/worker-methods/')).length, 11);
  const read = (skill, name) => readFileSync(join(skillRoot, skill, 'references', name), 'utf8');
  assert.equal(read('captain-methods', 'decision-trail.md'), read('worker-methods', 'decision-trail.md'));
  const methodSteps = text => text.slice(text.indexOf('1. To explain current behavior'));
  assert.equal(methodSteps(read('captain-methods', 'research-design-review.md')),
    methodSteps(read('worker-methods', 'research-design-review.md')), 'shared procedure stays equal after role-specific boundary');
});
