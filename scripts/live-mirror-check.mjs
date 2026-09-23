#!/usr/bin/env node
// F1 / B2 live proof: the bb backend actually runs THROUGH THE MIRROR (bin-bb), not
// through native bin/, and it does so from the REFRESHED patches applied against the
// PINNED upstream base (overlay/patch-base.txt) — i.e. the fast-forward a live home
// needs can actually complete and still spawn bb. This is the proof PR #16's review
// found missing plus the B2 acceptance: on a scratch clone AT THE PATCH BASE,
// install → verify healthy → all five copies present → native rejects bb →
// mirror accepts bb → a real fm-spawn reaches bb thread spawn.
//
// NOT part of `npm test` (needs the `bb` CLI, a connected host, and the real native
// firstmate scripts). Everything mutating happens under scratch clones and a throwaway
// project; /root/firstmate is never touched. Every real bb thread spawned is torn down.
//
//   node scripts/live-mirror-check.mjs
//
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCaptainIntent } from "../server.ts";
import { OVERLAY, INSTALLER, sh, discoverCheckout, cloneAtBase, patchBase } from "./fm-fixture.mjs";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const SPAWNED = /^spawned .* window=bb:(thr_[a-z0-9]+)/m;
const REJECTS_BB = /unknown backend 'bb'/;

const createdThreads = [];
let createdProject = "";
function teardownThread(tid) {
  sh("bb", ["thread", "stop", tid]);
  sh("bb", ["thread", "archive", tid]);
  sh("bb", ["thread", "delete", tid, "--yes"]);

}

const checkout = discoverCheckout();
if (!checkout) {
  console.log("SKIP: no firstmate checkout discoverable (set FM_TEST_HOME).");
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "fm-mirror-"));
const fmh = join(scratch, "fmhome");
const proj = join(scratch, "proj");
console.log(`# live-mirror-check scratch=${scratch}  patch base=${patchBase().slice(0, 12)}\n`);

// Resolve FM_BINDIR exactly as the plugin's fmBinDirAssign does.
function binDir() {
  return existsSync(join(fmh, "config", "bb-overlay")) && existsSync(join(fmh, "bin-bb"))
    ? join(fmh, "bin-bb")
    : join(fmh, "bin");
}

try {
  // (1) PRISTINE clone AT THE PATCH BASE — native bin/ must NOT carry bb (unlike the
  //     live in-place home), and the base is the exact upstream commit the refreshed
  //     patches target, so this proves the fast-forward destination actually installs.
  const cloned = cloneAtBase(checkout, fmh);
  if (!cloned.ok) { console.log(`SKIP: ${cloned.reason}`); rmSync(scratch, { recursive: true, force: true }); process.exit(0); }
  mkdirSync(join(fmh, "data"), { recursive: true });
  mkdirSync(join(fmh, "state"), { recursive: true });

  const nativePreInstall = sh("bash", ["-c", `. "${join(fmh, "bin", "fm-backend.sh")}"; fm_backend_validate bb`]);
  record("pristine native bin/ REJECTS bb before install (proves clone is not pre-patched)",
    REJECTS_BB.test(nativePreInstall.out) && nativePreInstall.code !== 0,
    nativePreInstall.out.trim() || "(no output)");

  // Own the project as well as the home; never select a customer checkout.
  mkdirSync(proj, { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "Fixture"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
    const result = sh("git", args, { cwd: proj });
    if (result.code !== 0) throw new Error(result.out);
  }
  let realProjectId = "";
  if (process.env.FM_MIRROR_CHECK_NO_REAL_PROJECT !== "1") {
    const created = sh("bb", ["project", "create", "--name", `mirror-acceptance-${process.pid}`, "--root", proj, "--json"]);
    if (created.code !== 0) throw new Error(`scratch project creation failed: ${created.out}`);
    const data = JSON.parse(created.stdout);
    realProjectId = data.id || data.project?.id;
    if (!realProjectId) throw new Error("scratch project creation returned no ID");
    createdProject = realProjectId;
  }

  // (2) Install the overlay → mirror bin. No fake --project-id: without a real project
  //     the adapter resolves by path (like live-brief-intent-check), and the dispatch
  //     proof does not depend on real thread creation.
  const instArgs = [INSTALLER, "--home", fmh, "--overlay", OVERLAY];
  if (realProjectId) instArgs.push("--project-id", realProjectId);
  const inst = sh("python3", instArgs);
  record("installer applied the refreshed patches at the base and left the tree clean",
    inst.code === 0 && existsSync(join(fmh, "bin-bb", "fm-spawn.sh")) &&
      sh("git", ["-C", fmh, "status", "--porcelain"]).out.trim() === "",
    inst.code === 0 ? `bin-bb=${binDir()}` : `installer failed:\n${inst.out.slice(-400)}`);
  if (inst.code !== 0) throw new Error(`installer failed: ${inst.out}`);

  // (2b) --verify reports the fresh mirror healthy.
  const okVerify = sh("python3", [INSTALLER, "--home", fmh, "--verify"]);
  record("installer --verify reports the fresh mirror healthy", okVerify.code === 0, okVerify.out.trim());

  // (2c) all five no-seam files are carried as REAL copies (not symlinks) in the mirror.
  const copiesOk = ["fm-backend.sh", "fm-spawn.sh", "fm-teardown.sh", "fm-merge-local.sh", "fm-bootstrap.sh"].every((f) => {
    const p = join(fmh, "bin-bb", f);
    return existsSync(p) && !lstatSync(p).isSymbolicLink();
  });
  record("all five no-seam files are real patched copies in the mirror", copiesOk,
    copiesOk ? "five backend/landing/bootstrap files present as copies" : "a copy is missing or is a symlink");

  // (3) MUTATION PROOF: same call, native REJECTS bb, mirror ACCEPTS it. The mirror
  //     is what makes bb dispatch work; nothing else changed.
  const nativeReject = sh("bash", ["-c", `. "${join(fmh, "bin", "fm-backend.sh")}"; fm_backend_validate bb`]);
  const mirrorAccept = sh("bash", ["-c", `. "${join(fmh, "bin-bb", "fm-backend.sh")}"; fm_backend_validate bb`]);
  record("MUTATION: native bin REJECTS bb, mirror bin ACCEPTS bb",
    REJECTS_BB.test(nativeReject.out) && nativeReject.code !== 0 && mirrorAccept.code === 0 && !REJECTS_BB.test(mirrorAccept.out),
    `native=${nativeReject.code} mirror=${mirrorAccept.code}`);

  const env = { ...process.env, FM_HOME: fmh, FM_ROOT: fmh, FM_BB_HIDDEN: "1", FM_BB_PARENT_THREAD_ID: "", BB_THREAD_ID: "" };
  const brief = (id) => join(fmh, "data", id, "brief.md");
  function scaffold(id, kind) {
    const args = kind === "scout" ? [id, "crew", "--scout"] : [id, "crew", "--mode", "direct-PR"];
    const r = sh(join(binDir(), "fm-brief.sh"), args, { env });
    if (!existsSync(brief(id))) throw new Error(`fm-brief.sh did not scaffold ${id}: ${r.out}`);
  }
  function fill(id, task) {
    const spec = "Implement the captain's intent above exactly; small diff; report DONE/BLOCKED/FAILED.";
    const s = readFileSync(brief(id), "utf8").replace("{TASK}", task).replace("{FIRSTMATE_SPEC}", spec);
    writeFileSync(brief(id), s);
  }
  const projDir = proj;
  const spawnEnv = realProjectId ? { ...env, FM_BB_PROJECT_ID: realProjectId } : env;
  function spawnInProject(bindir, id, kind) {
    const args =
      kind === "scout"
        ? [id, projDir, "--scout", "--backend", "bb", "--harness", "bb"]
        : [id, projDir, "--mode", "direct-PR", "--yolo", "off", "--backend", "bb", "--harness", "bb"];
    return sh(join(bindir, "fm-spawn.sh"), args, { env: spawnEnv, timeout: 120_000 });
  }
  // "The mirror dispatched bb to the real bb layer": it did NOT reject bb and reached
  // `bb thread spawn` (a real thread id, or the bb thread-creation call itself). This is
  // deterministic and independent of whether a registered project is reachable.
  // Messages that ONLY the bb adapter (bin-bb) emits — proof dispatch resolved bb and
  // ran fm_backend_bb_*: the adapter's own project-resolution error, the real bb
  // thread-spawn call, or a spawned bb window. Native bin never reaches any of these
  // (it stops at "unknown backend 'bb'").
  const REACHED_BB = /backend=bb spawn needs|Failed to create thread|thread spawn|window=bb:|bb thread/i;

  for (const kind of ["ship", "scout"]) {
    const intent = normalizeCaptainIntent(`Captain's intent: Disposable transport acceptance for ${kind}. Do not edit files, call tools, dispatch workers, or perform Git operations. Reply DONE: transport accepted.`);

    // (4a) MIRROR path: dispatches bb (no "unknown backend") through to the real bb
    //      thread-spawn layer. Records the real bb_thread_id when one is produced.
    const okId = `mir-${kind}`;
    scaffold(okId, kind);
    fill(okId, intent);
    const good = spawnInProject(binDir(), okId, kind);
    const m = SPAWNED.exec(good.out);
    if (m) createdThreads.push(m[1]);
    const dispatched = !REJECTS_BB.test(good.out) && (realProjectId ? good.code === 0 && m !== null : REACHED_BB.test(good.out));
    record(`${kind}: "$FM_BINDIR/fm-spawn.sh" (MIRROR) dispatches bb to the real bb layer`, dispatched,
      m ? `real bb thread=${m[1]}` : dispatched ? "reached bb thread spawn (no 'unknown backend')" : `unexpected: ${good.out.slice(-400)}`);
    if (m) record(`${kind}: MIRROR produced a real bb_thread_id`, true, m[1]);

    // (4b) NATIVE-bin path, same brief, REJECTS bb — proving the mirror (not native
    //      bin) is what carried the dispatch. Fresh id so no brief/meta clash.
    const natId = `nat-${kind}`;
    scaffold(natId, kind);
    fill(natId, intent);
    const nat = spawnInProject(join(fmh, "bin"), natId, kind);
    record(`${kind}: native bin/fm-spawn.sh REJECTS bb (mirror was load-bearing)`,
      REJECTS_BB.test(nat.out) && !SPAWNED.test(nat.out),
      REJECTS_BB.test(nat.out) ? "native rejected bb as expected" : `unexpected: ${nat.out.slice(-300)}`);
  }
} finally {
  for (const tid of createdThreads) teardownThread(tid);
  if (createdProject) {
    const removed = sh("bb", ["project", "delete", createdProject, "--yes"]);
    record("disposable project cleanup succeeded", removed.code === 0, removed.code ? removed.out : undefined);
  }
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  if (createdThreads.length) console.log(`\n(cleaned up real threads: ${createdThreads.join(", ")})`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
