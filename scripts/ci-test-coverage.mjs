#!/usr/bin/env node
// One source for which test files CI runs. `--run-list` prints the package.json
// test list minus the reasoned skips in .github/ci-skipped-tests.json; the
// default mode fails when a tracked test file is neither run nor on that list.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TEST_FILE = /\.test\.(?:ts|tsx|mjs|js)$/;
// Vendored copies of upstream trees; their tests belong to upstream.
const VENDORED = /^(?:native-snapshot|third-party|node_modules)\//;

export function coverage({ tracked, listed, skipped }) {
  const tests = tracked.filter((file) => TEST_FILE.test(file) && !VENDORED.test(file));
  const errors = [];
  for (const file of tests) if (!listed.includes(file)) errors.push(`${file}: tracked test file is not in the package.json test list, so nothing runs it`);
  for (const file of listed) if (!tests.includes(file)) errors.push(`${file}: in the package.json test list but not a tracked test file`);
  for (const [file, reason] of Object.entries(skipped)) {
    if (!listed.includes(file)) errors.push(`${file}: on the CI skip list but not in the package.json test list`);
    if (typeof reason !== 'string' || reason.trim().length < 20) errors.push(`${file}: a CI skip needs a reason of at least 20 characters`);
  }
  return { run: listed.filter((file) => !(file in skipped)), skipped: Object.keys(skipped), errors };
}

export function load(root = '.') {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean);
  const listed = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).scripts.test.split(/\s+/).filter((word) => TEST_FILE.test(word));
  const skipped = JSON.parse(readFileSync(`${root}/.github/ci-skipped-tests.json`, 'utf8'));
  return { tracked, listed, skipped };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = coverage(load());
  if (process.argv.includes('--run-list')) {
    console.log(result.run.join(' '));
  } else {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.log(`${result.run.length} test files run in CI, ${result.skipped.length} skipped with a reason`);
    for (const file of result.skipped) console.log(`skipped: ${file}`);
    if (result.errors.length > 0) process.exit(1);
  }
}
