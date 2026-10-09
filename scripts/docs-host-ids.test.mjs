// This repository is public. Its docs name threads, hosts and folders by
// placeholder, never by the live id or the path on the host that produced them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// A BB id is a prefix and exactly ten lowercase letters or digits. Placeholders
// such as thr_example01, thr_abc123 or thr_cap have another length.
const REAL_ID = /\b(?:thr|host|proj|env)_[a-z0-9]{10}\b/g;
// `/root` as a path, not the tail of another word ("home/root").
const HOST_PATH = /(?<![\w.$}>~-])\/root(?=[/\s`"'):;,]|$)/gm;

export function hostIdentifiers(text) {
  return [...text.matchAll(REAL_ID), ...text.matchAll(HOST_PATH)].map((match) => match[0]);
}

function docs() {
  return execFileSync('git', ['ls-files', 'docs', 'entry-skills', '*.md'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\n').filter((file) => file !== '' && !/^(?:native-snapshot|third-party|skills|overlay|test)\//.test(file));
}

test('the detector finds live ids and host paths and passes placeholders', () => {
  assert.deepEqual(hostIdentifiers('captain `thr_jm4qnewqmf` on host_m4jkvpkw67, project proj_5s59gfpfqq, env_wyzbtysv6s'), ['thr_jm4qnewqmf', 'host_m4jkvpkw67', 'proj_5s59gfpfqq', 'env_wyzbtysv6s']);
  assert.deepEqual(hostIdentifiers('`/root/firstmate` and HOME=/root and (/root/github_projects/x.ts:1)'), ['/root', '/root', '/root']);
  assert.deepEqual(hostIdentifiers('thr_example01 thr_abc123 thr_cap thr_<id> host_example01 $HOME/.local/bin exact home/root; $FIRSTMATE_HOME/bin thr_… fm-thr_x'), []);
});

test('no doc names a live thread, host, project or environment id, or a path under /root', () => {
  const files = docs();
  assert.ok(files.length > 60 && files.includes('README.md') && files.includes('docs/verification/plugin-runtime.md'), `${files.length} files`);
  const found = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => { for (const hit of hostIdentifiers(line)) found.push(`${file}:${index + 1}: ${hit}`); });
  }
  assert.deepEqual(found, [], `replace each with a placeholder (thr_example01, $FIRSTMATE_HOME, $HOME):\n${found.join('\n')}`);
});
