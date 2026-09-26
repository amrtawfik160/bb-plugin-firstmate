#!/usr/bin/env node
// B1 live proof: real-transport dispatch actually spawns a ship AND a scout.
//
// This is NOT part of `npm test` (it needs the `bb` CLI, a connected host, and the
// real native firstmate scripts). It proves, end to end with the REAL scripts, why
// transport=real never spawned and that the fix repairs it:
//
//   1. A captain phrases task text as "Captain's intent (verbatim): <words>" (as this
//      captain does). Written verbatim into the brief's `## Captain's intent` body, the
//      real fm-spawn.sh REFUSES it via fm_brief_intent_address_line in fm-dod-lib.sh —
//      so every real spawn failed and fell back to native ("real transport unavailable").
//   2. normalizeCaptainIntent (imported from server.ts — the ACTUAL function under test)
//      strips the leading operator-address label. The same brief then passes the gate and
//      the REAL fm-spawn.sh --backend bb --harness bb spawns a real bb thread.
//
// Everything mutating happens under a scratch FM_HOME (a copy of the native firstmate
// with fresh empty data/ and state/) and a throwaway project; the live /root/firstmate
// data and state are never touched. Every real bb thread it spawns is torn down.
//
//   node scripts/live-brief-intent-check.mjs
//
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCaptainIntent } from "../server.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const NATIVE_FM = process.env.FM_TEST_HOME ?? "/root/firstmate";
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The EXACT operator-address rule native refuses on (fm-dod-lib.sh). We assert the raw
// label trips it and the normalized body does not, using the real script's own output.
const REFUSAL = /## Captain's intent has an operator-address line/;
const SPAWNED = /^spawned .* window=bb:(thr_[a-z0-9]+)/m;

const createdThreads = [];
function teardownThread(tid) {
  sh("bb", ["thread", "stop", tid]);
  sh("bb", ["thread", "archive", tid]);
  sh("bb", ["thread", "delete", tid, "--yes"]);
  const wt = `/root/.bb-server/plugins/environment-git-worktree/host-data/worktrees/${tid}-1`;
  if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
}

const scratch = mkdtempSync(join(tmpdir(), "fm-b1-"));
const fmh = join(scratch, "fmhome");
const proj = join(scratch, "proj");
console.log(`# live-brief-intent-check scratch=${scratch}\n`);

try {
  // Scratch FM_HOME: copy native firstmate WITHOUT its live data/ and state/.
  const rc = sh("rsync", ["-a", "--exclude", "data/", "--exclude", "state/", `${NATIVE_FM}/`, `${fmh}/`]);
  if (rc.code !== 0) throw new Error(`rsync scratch FM_HOME failed: ${rc.out}`);
  mkdirSync(join(fmh, "data"), { recursive: true });
  mkdirSync(join(fmh, "state"), { recursive: true });
  // Throwaway git project.
  mkdirSync(proj, { recursive: true });
  sh("git", ["init", "-q"], { cwd: proj });
  sh("git", ["config", "user.email", "x@x"], { cwd: proj });
  sh("git", ["config", "user.name", "x"], { cwd: proj });
  sh("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: proj });

  const env = { ...process.env, FM_HOME: fmh, FM_ROOT: fmh };
  const brief = (id) => join(fmh, "data", id, "brief.md");
  function scaffold(id, kind) {
    const args = kind === "scout" ? [id, "crew", "--scout"] : [id, "crew", "--mode", "direct-PR"];
    const r = sh(join(fmh, "bin", "fm-brief.sh"), args, { env });
    if (!existsSync(brief(id))) throw new Error(`fm-brief.sh did not scaffold ${id}: ${r.out}`);
  }
  function fill(id, task) {
    const spec = "Implement the captain's intent above exactly; small diff; report DONE/BLOCKED/FAILED.";
    const s = readFileSync(brief(id), "utf8").replace("{TASK}", task).replace("{FIRSTMATE_SPEC}", spec);
    writeFileSync(brief(id), s);
  }
  function spawn(id, kind) {
    const args =
      kind === "scout"
        ? [id, proj, "--scout", "--backend", "bb", "--harness", "bb"]
        : [id, proj, "--mode", "direct-PR", "--yolo", "off", "--backend", "bb", "--harness", "bb"];
    return sh(join(fmh, "bin", "fm-spawn.sh"), args, { env, timeout: 90_000 });
  }

  // The bare "Captain's intent:" label is the exact form native REFUSES and the form
  // the captain skill (SKILL.md:166) and the plugin's own auto-dispatches emit.
  const BARE = "Captain's intent: live-check the real transport end to end";

  for (const kind of ["ship", "scout"]) {
    // (A) RAW bare-label brief reproduces the 100%-refusal from the live evidence.
    const rawId = `b1-${kind}-raw`;
    scaffold(rawId, kind);
    fill(rawId, BARE);
    const raw = spawn(rawId, kind);
    const refused = REFUSAL.test(raw.out) && !SPAWNED.test(raw.out);
    record(`${kind}: RAW captain-label brief is REFUSED by real fm-spawn (bug reproduced)`, refused,
      refused ? "no thread created — this is what made real transport fall back" : `unexpected: ${raw.out.slice(-300)}`);

    // (B) The SAME text through the ACTUAL normalizeCaptainIntent must pass the gate and
    // REAL-spawn a bb thread — proving the fix repairs the exact failing case.
    const okId = `b1-${kind}-fixed`;
    scaffold(okId, kind);
    const normalized = normalizeCaptainIntent(BARE);
    fill(okId, normalized);
    const good = spawn(okId, kind);
    const m = SPAWNED.exec(good.out);
    if (m) createdThreads.push(m[1]);
    const spawnedOk = m !== null && !REFUSAL.test(good.out);
    record(`${kind}: normalized brief SPAWNS via real transport (no operator-address refusal)`, spawnedOk,
      spawnedOk ? `real bb thread=${m[1]} (normalized body=${JSON.stringify(normalized)})` : `no spawn: ${good.out.slice(-400)}`);
  }

  // (C) Do-not-over-strip, checked against the REAL native gate (no spawn needed): a
  // provenance-bearing "(verbatim)" / "(per the spec)" form is one native ACCEPTS, so
  // normalizeCaptainIntent must leave it byte-for-byte untouched, and the real
  // fm_brief_intent_address_line (sourced from the actual fm-dod-lib.sh) must NOT flag
  // the scaffolded brief. Editing words native would have accepted is a defect.
  for (const provenance of [
    "Captain's intent (verbatim): live-check the real transport end to end",
    "Captain's ask (per the spec): keep the diff small",
  ]) {
    const unchanged = normalizeCaptainIntent(provenance) === provenance;
    const pid = `b1-accept-${provenance.length}`;
    scaffold(pid, "ship");
    fill(pid, provenance);
    // Run native's EXACT refusal predicate against the real brief.
    const gate = sh("bash", [
      "-c",
      `. "${join(fmh, "bin", "fm-dod-lib.sh")}"; if fm_brief_intent_address_line "${brief(pid)}" >/dev/null; then echo NATIVE_REFUSES; else echo NATIVE_ACCEPTS; fi`,
    ], { env });
    const nativeAccepts = /NATIVE_ACCEPTS/.test(gate.out);
    record(`don't-over-strip: native ACCEPTS + normalizer preserves ${JSON.stringify(provenance)}`,
      unchanged && nativeAccepts,
      `normalizerUnchanged=${unchanged} nativeGate=${gate.out.trim()}`);
  }
} finally {
  for (const tid of createdThreads) teardownThread(tid);
  sh("bb", ["thread", "prune"]); // best-effort
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  if (createdThreads.length) console.log(`\n(cleaned up real threads: ${createdThreads.join(", ")})`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
