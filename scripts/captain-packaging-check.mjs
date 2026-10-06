// Read-only check of the selected runtime skill package, never the source tree.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function followRuntimeReferences(directory, entry) {
  const pending = [join(directory, entry)], visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const text = readFileSync(path, 'utf8');
    for (const [, target] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^https:\/\//.test(target)) continue;
      const destination = resolve(dirname(path), target.split('#')[0]);
      assert.ok(!relative(directory, destination).startsWith('..'),
        `cold startup must resolve inside the selected runtime package: ${target}`);
      readFileSync(destination); // Every required local startup reference must exist; no global fallback.
      pending.push(destination);
    }
  }
  return [...visited].map(path => relative(directory, path)).sort();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: node scripts/captain-packaging-check.mjs <runtime-package>/skills');
  for (const entry of ['firstmate/SKILL.md', 'captain/SKILL.md']) {
    const visited = followRuntimeReferences(resolve(directory), entry);
    console.log(`${entry}: ${visited.length} reachable resources; all local links resolve`);
  }
}
