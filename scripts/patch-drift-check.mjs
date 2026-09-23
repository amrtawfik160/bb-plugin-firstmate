#!/usr/bin/env node
// Patch drift alarm. The overlay patches (fm-backend.sh, fm-spawn.sh,
// fm-teardown.sh, fm-merge-local.sh) plus docs/configuration.md edit upstream prose/comments, so they are
// version-specific: they apply cleanly at the pinned base (overlay/patch-base.txt) and
// drift as upstream evolves. A migration re-installs the mirror against the NEW upstream
// HEAD, and if a hunk no longer applies the install now aborts atomically (loud, mirror
// preserved) — but that is a migration blocked at the worst time. This check surfaces the
// same drift AHEAD of a migration: it fetches the live upstream HEAD and dry-run-applies
// the patches exactly as install-bb-backend.py does, failing when any hunk no longer
// applies.
//
//   node scripts/patch-drift-check.mjs
//
// Exit 0  = patches still apply cleanly to current upstream HEAD (fuzz counts as drift).
// Exit 1  = a hunk no longer applies — refresh the patches (regenerate against HEAD) and
//           bump overlay/patch-base.txt.
// Exit 2  = could not check (no checkout / no network) — a skip, not a pass or a failure.
//
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OVERLAY, sh, git, discoverCheckout, patchBase, UPSTREAM_URL } from "./fm-fixture.mjs";

const checkout = discoverCheckout();
if (!checkout) {
  console.log("SKIP: no firstmate checkout discoverable (set FM_TEST_HOME).");
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "fm-drift-"));
const clone = join(scratch, "up");
let exitCode = 0;
try {
  if (sh("git", ["clone", "--quiet", "--local", checkout, clone]).code !== 0) {
    console.log("SKIP: could not clone the local checkout.");
    process.exit(2);
  }
  const ls = sh("git", ["ls-remote", UPSTREAM_URL, "HEAD"]);
  if (ls.code !== 0) {
    console.log(`SKIP: could not reach upstream (${UPSTREAM_URL}) — no network?`);
    process.exit(2);
  }
  const head = ls.stdout.trim().split(/\s+/)[0];
  const base = patchBase();
  console.log(`# patch-drift-check`);
  console.log(`# pinned base   = ${base}`);
  console.log(`# upstream HEAD = ${head}`);
  if (git(clone, "cat-file", "-e", head).code !== 0) {
    if (git(clone, "fetch", "--quiet", UPSTREAM_URL, head).code !== 0) {
      console.log(`SKIP: could not fetch upstream HEAD ${head.slice(0, 12)}.`);
      process.exit(2);
    }
  }
  if (git(clone, "checkout", "--quiet", "--detach", head).code !== 0) {
    console.log(`SKIP: could not checkout upstream HEAD ${head.slice(0, 12)}.`);
    process.exit(2);
  }
  if (head === base) {
    console.log("note: upstream HEAD == pinned base (expected clean).");
  } else {
    console.log("note: upstream HEAD has moved past the pinned base; verifying the patches still apply.");
  }

  // Dry-run apply exactly as install-bb-backend.py does (patch -p1 --forward --batch),
  // but with --dry-run so nothing is written. A failure is ANY of: non-zero exit, a
  // "FAILED" line, or an "ignored" (already/partly-applied) line.
  let drifted = false;
  for (const p of ["firstmate-bb-backend.patch", "firstmate-bb-teardown.patch", "firstmate-bb-local-merge.patch", "firstmate-bb-browser.patch"]) {
    const r = sh("patch", ["-p1", "--forward", "--batch", "--dry-run", "-i", join(OVERLAY, p)], { cwd: clone });
    const bad = r.code !== 0 || /FAILED/.test(r.out) || /hunks ignored|fuzz/.test(r.out);
    console.log(`\n== ${p}: ${bad ? "DRIFTED" : "applies clean"} (patch exit=${r.code}) ==`);
    if (bad) {
      drifted = true;
      for (const line of r.out.split("\n").filter((l) => /FAILED|ignored|fuzz/.test(l))) console.log(`   ${line}`);
    }
  }
  if (drifted) {
    console.log("\nDRIFT: at least one hunk no longer applies to upstream HEAD.");
    console.log("Refresh the overlay patches against HEAD, re-run the live proofs, and bump overlay/patch-base.txt.");
    exitCode = 1;
  } else {
    console.log("\nOK: all overlay patches still apply cleanly to current upstream HEAD.");
    exitCode = 0;
  }
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}
process.exit(exitCode);
