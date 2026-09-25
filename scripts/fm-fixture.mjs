// Shared fixture helpers for the live proof scripts.
//
// The overlay patches are refreshed against a PINNED upstream commit recorded in
// overlay/patch-base.txt (an audited kunchenguid/firstmate commit). Live
// proofs and the migration check must run against that exact base, because a patch
// that edits upstream prose is version-specific: it applies at the base it was cut
// against, and scripts/patch-drift-check.mjs is what alarms when upstream moves past
// it. So a proof clones the local firstmate home and checks out the PINNED base
// rather than whatever the local clone's HEAD happens to be.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const OVERLAY = join(HERE, "..", "overlay");
export const INSTALLER = join(OVERLAY, "install-bb-backend.py");
export const UPSTREAM_URL = "https://github.com/kunchenguid/firstmate";

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
export function git(home, ...args) {
  return sh("git", ["-C", home, ...args]);
}

/** The pinned upstream commit the overlay patches were cut against. */
export function patchBase() {
  return readFileSync(join(OVERLAY, "patch-base.txt"), "utf8").trim();
}

/** Discover a local firstmate checkout to clone from (never mutated). */
export function discoverCheckout() {
  for (const p of [process.env.FM_TEST_HOME, process.env.FM_HOME, "/root/firstmate"]) {
    if (p && existsSync(join(p, "bin", "fm-backend.sh")) && existsSync(join(p, ".git"))) return p;
  }
  return null;
}

/**
 * Clone `checkout` into `dest` and detach at the pinned patch base. A --local clone
 * copies every object (including the loose base commit even when it is unreachable
 * from the checkout's HEAD); if the base is still missing, fetch it from origin.
 * Returns { ok, reason }.
 */
export function cloneAtBase(checkout, dest, base = patchBase()) {
  if (git(checkout, "cat-file", "-e", base).code !== 0) {
    // Base not in the local checkout at all — try to bring it in from origin below
    // after the clone (the clone still succeeds; we fetch the commit into dest).
  }
  if (sh("git", ["clone", "--quiet", "--local", checkout, dest]).code !== 0) {
    return { ok: false, reason: "clone failed" };
  }
  if (git(dest, "cat-file", "-e", base).code !== 0) {
    const f = git(dest, "fetch", "--quiet", UPSTREAM_URL, base);
    if (f.code !== 0) return { ok: false, reason: `patch base ${base.slice(0, 12)} unavailable (no local object, fetch failed)` };
  }
  if (git(dest, "checkout", "--quiet", "--detach", base).code !== 0) {
    return { ok: false, reason: `could not checkout patch base ${base.slice(0, 12)}` };
  }
  return { ok: true, reason: "" };
}
