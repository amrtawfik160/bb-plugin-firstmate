#!/usr/bin/env node
// Zero-window migration proof. fmHome is SHARED host-global across captains, so a
// migration must never have a moment when no bb-capable path exists — another
// captain's crew could dispatch at any instant and hit `unknown backend 'bb'`.
//
// This reproduces the LIVE dirty state on a throwaway clone chain (native bin patched
// in place, tree dirty, .orig present, behind upstream) and runs the migration while a
// dispatch-shaped probe is attempted BEFORE and AFTER every mutating step. The probe
// resolves FM_BINDIR exactly as the plugin does, then runs the same gate a real
// dispatch hits first (`. "$FM_BINDIR/fm-backend.sh"; fm_backend_validate bb`). A
// window exists iff any probe reports `unknown backend 'bb'`.
//
//   node scripts/live-migration-zero-window-check.mjs            # new order: expect 0 windows
//   node scripts/live-migration-zero-window-check.mjs --old-order # mutation: old order HAS a window
//
// The --old-order run is the mutation proof: it restores native BEFORE installing the
// mirror (the previous procedure), and the SAME zero-window assertion then goes RED,
// showing the probe is load-bearing. Deterministic: the probe is the validate gate, so
// NO bb thread is created and no real project is needed. /root/firstmate is never touched.
//
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY = join(HERE, "..", "overlay");
const INSTALLER = join(OVERLAY, "install-bb-backend.py");
const NATIVE_FM = "/root/firstmate";
const OLD_ORDER = process.argv.includes("--old-order");

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function git(home, ...args) { return sh("git", ["-C", home, ...args]); }

const REJECTS_BB = /unknown backend 'bb'/;
const scratch = mkdtempSync(join(tmpdir(), "fm-zerowin-"));
const upstream = join(scratch, "upstream");
const home = join(scratch, "home");
const probes = [];

// Resolve FM_BINDIR exactly as server.ts fmBinDirAssign does.
function binDir() {
  return existsSync(join(home, "config", "bb-overlay")) && existsSync(join(home, "bin-bb"))
    ? join(home, "bin-bb")
    : join(home, "bin");
}
// A dispatch-shaped probe: the validate gate a real fm-spawn hits first, via the
// plugin-resolved FM_BINDIR. Records whether a dispatch WOULD hit `unknown backend`.
function probe(label) {
  const bindir = binDir();
  const r = sh("bash", ["-c", `. "${join(bindir, "fm-backend.sh")}"; fm_backend_validate bb`], { env: { ...process.env, FM_HOME: home, FM_ROOT: home } });
  const hitWindow = REJECTS_BB.test(r.out) || r.code !== 0;
  probes.push({ label, bindir: bindir.endsWith("bin-bb") ? "bin-bb" : "bin", hitWindow, out: r.out.trim() });
  console.log(`  probe[${hitWindow ? "WINDOW" : "ok"}] ${label}  (FM_BINDIR=${bindir.endsWith("bin-bb") ? "bin-bb" : "bin"})`);
}

console.log(`# zero-window migration check (${OLD_ORDER ? "OLD order — expect a window" : "NEW order — expect none"})  scratch=${scratch}\n`);
try {
  // --- Reproduce the live dirty state ---------------------------------------
  // upstream = clone of native firstmate, advanced by 2 commits (a new sourced bin/
  // sibling + a doc edit) so `home` can be BEHIND it, exactly like the live home.
  if (sh("git", ["clone", "--quiet", "--no-local", `file://${NATIVE_FM}`, upstream]).code !== 0) throw new Error("clone upstream failed");
  sh("bash", ["-c", `printf '#!/usr/bin/env bash\\n' > "${join(upstream, "bin", "fm-extra-sibling.sh")}"; chmod +x "${join(upstream, "bin", "fm-extra-sibling.sh")}"`]);
  git(upstream, "add", "bin/fm-extra-sibling.sh");
  git(upstream, "-c", "user.email=x@x", "-c", "user.name=x", "commit", "-q", "-m", "upstream: new sibling");
  sh("bash", ["-c", `printf '\\n<!-- upstream doc edit -->\\n' >> "${join(upstream, "README.md")}"`]);
  git(upstream, "add", "README.md");
  git(upstream, "-c", "user.email=x@x", "-c", "user.name=x", "commit", "-q", "-m", "upstream: doc edit");

  // home = clone of upstream, reset BACK 2 so it is behind (its @{u} is ahead).
  if (sh("git", ["clone", "--quiet", "--no-local", `file://${upstream}`, home]).code !== 0) throw new Error("clone home failed");
  mkdirSync(join(home, "data"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  git(home, "reset", "--hard", "-q", "HEAD~2");

  // Apply the LEGACY in-place patch (with .orig backups), reproducing the live home:
  // native bin/*.sh carry bb, tree dirty, *.orig present.
  for (const p of ["firstmate-bb-backend.patch", "firstmate-bb-teardown.patch"]) {
    const r = sh("patch", ["-p1", "-b", "--forward", "--batch", "-i", join(OVERLAY, p)], { cwd: home });
    if (r.code !== 0) throw new Error(`legacy in-place patch ${p} failed: ${r.out}`);
  }
  const dirty = git(home, "status", "--porcelain").out;
  const reproduced = /M bin\/fm-backend\.sh/.test(dirty) && /fm-backend\.sh\.orig/.test(dirty) && !REJECTS_BB.test(sh("bash", ["-c", `. "${join(home, "bin", "fm-backend.sh")}"; fm_backend_validate bb`]).out);
  console.log(`reproduced live dirty state: in-place patched + dirty + .orig + behind upstream = ${reproduced}\n`);
  if (!reproduced) throw new Error(`failed to reproduce live state:\n${dirty}`);

  const install = (extra = []) => sh("python3", [INSTALLER, "--home", home, "--overlay", OVERLAY, ...extra]);
  const verify = () => sh("python3", [INSTALLER, "--home", home, "--verify"]);
  const restoreNative = () => git(home, "checkout", "--", "bin/fm-backend.sh", "bin/fm-spawn.sh", "bin/fm-teardown.sh", "docs/configuration.md");
  const rmOrig = () => sh("bash", ["-c", `rm -f "${home}"/bin/fm-*.sh.orig "${home}"/docs/*.md.orig`]);
  const fastForward = () => { git(home, "fetch", "--quiet", "origin"); const up = git(home, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").out.trim(); return git(home, "merge", "--ff-only", up); };

  probe("0: initial (native patched in place)");

  if (!OLD_ORDER) {
    // ---- NEW zero-window order: install the mirror FIRST ------------------
    if (install().code !== 0) throw new Error("install-first failed");
    probe("A: after install mirror FIRST (native still patched)");
    console.log(`  --verify after install: ${verify().code === 0 ? "healthy" : "STALE"}`);
    restoreNative();
    probe("C: after restore native (mirror serves bb)");
    rmOrig();
    probe("D: after rm .orig");
    if (fastForward().code !== 0) throw new Error("ff-only failed");
    probe("E: after fast-forward (mirror still dispatches bb; --verify flags stale)");
    console.log(`  --verify after ff (expected STALE): ${verify().code === 0 ? "healthy" : "STALE"}`);
    if (install().code !== 0) throw new Error("re-install failed");
    probe("F: after re-install against new HEAD");
    console.log(`  --verify after re-install (expected healthy): ${verify().code === 0 ? "healthy" : "STALE"}`);
  } else {
    // ---- OLD order (mutation): restore BEFORE install → a bb-less window --
    restoreNative();
    rmOrig();
    probe("X: after restore native, BEFORE install (OLD order)");
    fastForward();
    probe("Y: after ff, still BEFORE install (OLD order)");
    install();
    probe("Z: after install (OLD order)");
  }

  // End-state checks (new order only).
  if (!OLD_ORDER) {
    const clean = git(home, "status", "--porcelain").out.trim() === "";
    const healthy = verify().code === 0;
    const ffTip = git(home, "rev-parse", "HEAD").out.trim() === git(home, "rev-parse", "@{u}").out.trim();
    const nativeRejects = REJECTS_BB.test(sh("bash", ["-c", `. "${join(home, "bin", "fm-backend.sh")}"; fm_backend_validate bb`]).out);
    console.log(`\nend state: clean=${clean} verifyHealthy=${healthy} ff'd-to-upstream=${ffTip} nativeRejectsBb=${nativeRejects}`);
    if (!(clean && healthy && ffTip && nativeRejects)) throw new Error("end-state check failed");
  }
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}

const windows = probes.filter((p) => p.hitWindow);
console.log(`\nprobes: ${probes.length}, windows (unknown backend 'bb'): ${windows.length}`);
if (OLD_ORDER) {
  // Mutation expectation: the OLD order MUST expose at least one window; if it does,
  // the probe is load-bearing (it detects the very gap the new order removes).
  const ok = windows.length > 0;
  console.log(ok ? "OLD-ORDER MUTATION CONFIRMED: the probe detects the bb-less window." : "MUTATION FAILED: probe did not detect a window in the old order.");
  process.exit(ok ? 0 : 1);
}
// New order: the property is zero windows.
console.log(windows.length === 0 ? "ZERO-WINDOW CONFIRMED: no probe hit 'unknown backend' bb." : `FAIL: ${windows.length} window(s): ${windows.map((w) => w.label).join("; ")}`);
process.exit(windows.length === 0 ? 0 : 1);
