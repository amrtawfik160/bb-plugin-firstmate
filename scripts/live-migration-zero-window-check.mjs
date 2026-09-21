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
// The clone chain is pinned to the patch base (overlay/patch-base.txt) so the overlay
// patches — which the migration installs — actually apply; the synthetic "upstream"
// commits deliberately do NOT touch the patched files, so the fast-forward and the
// re-install against the advanced HEAD both keep applying.
//
// The NEW order additionally exercises a FAILED re-install (step G): a re-install whose
// patch no longer applies must abort ATOMICALLY — exit non-zero and loud, leave the
// working mirror byte-for-byte intact, and keep dispatching bb. This is the exact
// failure that turned a routine migration into a host-wide outage; the probe proves the
// atomic installer now survives it with no bb-less window.
//
import { mkdtempSync, mkdirSync, rmSync, existsSync, cpSync, readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { OVERLAY, INSTALLER, sh, git, discoverCheckout, cloneAtBase, patchBase } from "./fm-fixture.mjs";

const OLD_ORDER = process.argv.includes("--old-order");
const REJECTS_BB = /unknown backend 'bb'/;

const checkout = discoverCheckout();
if (!checkout) {
  console.log("SKIP: no firstmate checkout discoverable (set FM_TEST_HOME).");
  process.exit(0);
}

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

// Content fingerprint of the mirror (file bytes + symlink targets) so an atomic
// install failure can be proven not to have touched a single byte of it.
function mirrorFingerprint() {
  const root = join(home, "bin-bb");
  const h = createHash("sha256");
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      const key = `${rel}/${name}`;
      if (st.isSymbolicLink()) h.update(`L ${key} -> ${readlinkSync(abs)}\n`);
      else if (st.isDirectory()) { h.update(`D ${key}\n`); walk(abs, key); }
      else h.update(`F ${key} ${createHash("sha256").update(readFileSync(abs)).digest("hex")}\n`);
    }
  };
  walk(root, "");
  return h.digest("hex");
}

console.log(`# zero-window migration check (${OLD_ORDER ? "OLD order — expect a window" : "NEW order — expect none"})  scratch=${scratch}`);
console.log(`# patch base = ${patchBase().slice(0, 12)}\n`);
try {
  // --- Reproduce the live dirty state ---------------------------------------
  // upstream = clone pinned at the patch base, then advanced by 2 commits (a new
  // sourced bin/ sibling + a doc edit that do NOT touch the patched files) so `home`
  // can be BEHIND it, exactly like the live home. Keeping the patched files untouched
  // is what lets the re-install against the advanced HEAD keep applying.
  const cloned = cloneAtBase(checkout, upstream);
  if (!cloned.ok) { console.log(`SKIP: ${cloned.reason}`); rmSync(scratch, { recursive: true, force: true }); process.exit(0); }
  // cloneAtBase leaves upstream DETACHED at the base; put it on a branch so the two
  // synthetic commits advance a ref that `home` can track and fast-forward to.
  git(upstream, "checkout", "-B", "main");
  sh("bash", ["-c", `printf '#!/usr/bin/env bash\\n' > "${join(upstream, "bin", "fm-extra-sibling.sh")}"; chmod +x "${join(upstream, "bin", "fm-extra-sibling.sh")}"`]);
  git(upstream, "add", "bin/fm-extra-sibling.sh");
  git(upstream, "-c", "user.email=x@x", "-c", "user.name=x", "commit", "-q", "-m", "upstream: new sibling");
  sh("bash", ["-c", `printf '\\n<!-- upstream doc edit -->\\n' >> "${join(upstream, "README.md")}"`]);
  git(upstream, "add", "README.md");
  git(upstream, "-c", "user.email=x@x", "-c", "user.name=x", "commit", "-q", "-m", "upstream: doc edit");

  // home = clone of upstream, reset BACK 2 so it is behind (its @{u} is ahead) and
  // sits exactly at the patch base.
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

    // ---- Step G: a FAILED re-install must not open a window ---------------
    // Simulate upstream drifting a patched file so a hunk no longer applies, then
    // re-install with the REAL overlay pointed at a broken copy of the patches. The
    // atomic installer must exit non-zero and loud, leave the healthy mirror exactly
    // as it was, and keep dispatching bb.
    const before = mirrorFingerprint();
    const brokenOverlay = join(scratch, "broken-overlay");
    cpSync(OVERLAY, brokenOverlay, { recursive: true });
    // Corrupt a REMOVED (-) line so patch cannot locate it -> the hunk FAILS hard
    // (a fuzz-tolerated context change would still apply and would not be a failure).
    const bp = join(brokenOverlay, "firstmate-bb-backend.patch");
    const patchText = readFileSync(bp, "utf8");
    const needle = '-FM_BACKEND_KNOWN="tmux herdr zellij orca cmux"';
    if (!patchText.includes(needle)) throw new Error("could not find anchor to corrupt in backend patch");
    writeFileSync(bp, patchText.replace(needle, '-FM_BACKEND_KNOWN="THIS_LINE_DOES_NOT_EXIST_UPSTREAM"'));
    const failed = spawnSync("python3", [INSTALLER, "--home", home, "--overlay", brokenOverlay, "--project-id", "proj_test"], { encoding: "utf8" });
    const loud = /INSTALL FAILED/.test(failed.stderr ?? "") && /did not apply/.test(failed.stderr ?? "");
    const notReady = !/BB backend ready/.test(`${failed.stdout ?? ""}${failed.stderr ?? ""}`);
    const noLeftover = !existsSync(join(home, "bin-bb.staging")) && !existsSync(join(home, "bin-bb.old"));
    const untouched = mirrorFingerprint() === before;
    console.log(`  FAILED re-install: exit=${failed.status} loud=${loud} notReady=${notReady} noLeftover=${noLeftover} mirrorUntouched=${untouched}`);
    probe("G: after a FAILED atomic re-install (working mirror must still serve bb)");
    if (failed.status === 0) throw new Error("failed re-install must exit non-zero");
    if (!loud) throw new Error(`failed re-install must be LOUD:\n${failed.stderr}`);
    if (!notReady) throw new Error("failed re-install must not print 'BB backend ready'");
    if (!noLeftover) throw new Error("failed re-install left a staging/backup dir behind");
    if (!untouched) throw new Error("failed re-install mutated the working mirror (not atomic)");
    console.log(`  --verify after FAILED re-install (mirror intact, expected healthy): ${verify().code === 0 ? "healthy" : "STALE"}`);
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
