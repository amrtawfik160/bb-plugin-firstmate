#!/usr/bin/env node
// Revert each adapter repair independently; its behavioral regression must fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baseline = spawnSync("git", ["show", "5357fde:overlay/bin/backends/bb.sh"], { cwd: root, encoding: "utf8" });
assert.equal(baseline.status, 0, baseline.stderr);
const fixed = readFileSync(join(root, "overlay/bin/backends/bb.sh"), "utf8");
const dir = mkdtempSync(join(tmpdir(), "fm-activity-mutation-"));
function kill(name, mutation, expected) {
  const path = join(dir, `${name}.sh`); writeFileSync(path, mutation);
  const run = spawnSync("node", ["--test", "--experimental-strip-types", "lib/bb-activity.test.ts"], {
    cwd: root, encoding: "utf8", env: { ...process.env, FM_TEST_BB_ADAPTER: path },
  });
  assert.notEqual(run.status, 0, `${name} mutation survived`);
  assert.ok(run.stdout.split("\n").some(line => line.startsWith("✖") && line.includes(expected)), `${name} failed for the wrong reason:\n${run.stdout}\n${run.stderr}`);
  console.log(`KILLED ${name}: ${expected}`);
}
try {
  for (const [name, start, end, expected] of [
    ["capture", "fm_backend_bb_capture()", "fm_backend_bb_current_path()", "native capture changes for tool work"],
    ["composer", "fm_backend_bb_composer_state()", "fm_backend_bb_busy_state()", "has no terminal draft"],
    ["busy", "fm_backend_bb_busy_state()", "fm_backend_bb_agent_state()", "open interaction, unavailable host"],
    ["delivery", "fm_backend_bb_send_literal()", "fm_backend_bb_send_text_line()", "native submit distinguishes accepted delivery"],
  ]) {
    const old = baseline.stdout.slice(baseline.stdout.indexOf(start), baseline.stdout.indexOf(end));
    const mutation = fixed.slice(0, fixed.indexOf(start)) + old + fixed.slice(fixed.indexOf(end));
    kill(name, mutation, expected);
  }
  const start = fixed.indexOf("    # Native bounds long busy turns");
  const end = fixed.indexOf("    lines = max(1, int(sys.argv[2]))", start);
  assert.ok(start >= 0 && end > start);
  kill("progress", fixed.slice(0, start) + fixed.slice(end), "native busy-turn progress uses recorded event time");
} finally { rmSync(dir, { recursive: true, force: true }); }
