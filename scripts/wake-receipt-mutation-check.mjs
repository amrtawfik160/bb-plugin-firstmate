#!/usr/bin/env node
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const native = process.env.FIRSTMATE_TEST_NATIVE ?? "/tmp/firstmate-upstream-audit";
assert.ok(existsSync(join(native, "bin/fm-wake-drain.sh")), "real native fixture required");
const scratch = mkdtempSync(join(tmpdir(), "fm-receipt-mutations-"));
const cases = [
  ["discard equal text despite a new native status event", "unchanged = self.status_unchanged and", "unchanged =", "real native preserves a repeated new status"],
  ["retain completed and empty captures forever", "        journal.prune_reports()", "        # cleanup disabled by mutation", "empty reads and completed receipts do not accumulate"],
];
try {
  mkdirSync(join(scratch, "scripts"));
  mkdirSync(join(scratch, "overlay/bin"), { recursive: true });
  cpSync(join(root, "scripts/wake-receipt.test.ts"), join(scratch, "scripts/wake-receipt.test.ts"));
  writeFileSync(join(scratch, "package.json"), '{"type":"module"}\n');
  const helper = join(scratch, "overlay/bin/bb-wake-receipt.py");
  const source = readFileSync(join(root, "overlay/bin/bb-wake-receipt.py"), "utf8");
  const run = pattern => spawnSync(process.execPath, ["--test", "--experimental-strip-types", "--test-name-pattern", pattern, "scripts/wake-receipt.test.ts"], { cwd: scratch, encoding: "utf8", timeout: 90_000, env: { ...process.env, FIRSTMATE_TEST_NATIVE: native } });
  writeFileSync(helper, source);
  const baseline = run(cases.map(row => row[3]).join("|"));
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.doesNotMatch(baseline.stdout, /# SKIP|skip:|skipped [1-9]/i);
  for (const [name, before, after, pattern] of cases) {
    assert.ok(source.includes(before), `missing mutation anchor: ${name}`);
    writeFileSync(helper, source.replaceAll(before, after));
    const result = run(pattern);
    assert.notEqual(result.status, 0, `SURVIVED: ${name}\n${result.stdout}`);
    assert.match(result.stdout + result.stderr, /ERR_ASSERTION/, `wrong failure: ${name}\n${result.stdout}${result.stderr}`);
    console.log(`KILLED: ${name} → ${pattern}`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
