#!/usr/bin/env python3
"""Install the BB session backend into a firstmate home WITHOUT editing tracked files.

Native firstmate exposes no runtime seam to register a spawn-capable backend:
`FM_BACKEND_KNOWN`/`FM_BACKEND_SPAWN` and every `fm_backend_*` dispatch `case`
are hardcoded in the TRACKED files bin/fm-backend.sh, bin/fm-spawn.sh, and
bin/fm-teardown.sh. The only extension host, bin/fm-extension.mjs, binds
process-event adapters only (poll/classify/terminal/silent) and cannot register
a spawn/worktree backend. See docs/bb-backend.md ("Why a mirror bin") and the
upstream-seam proposal there.

The previous overlay `patch`ed those three tracked files in place. That left the
working tree permanently dirty, which (1) froze the whole clone -- the plugin's
fetch + `git merge --ff-only` auto-update skips whenever the tree is dirty -- and
(2) put our private edits on a collision course with any upstream change to those
files.

This installer never edits a tracked file. It builds a parallel "mirror bin" at
<home>/bin-bb:

  - every native bin/ entry is SYMLINKED into bin-bb/ (so it keeps inheriting
    upstream on every ff-update),
  - EXCEPT the three files with no native seam -- fm-backend.sh, fm-spawn.sh,
    fm-teardown.sh -- which are generated as patched COPIES, and
  - bin-bb/backends/ mirrors the native adapters plus the real bb.sh adapter.

Native scripts derive SCRIPT_DIR and FM_BACKEND_LIB_DIR from their own
BASH_SOURCE, so invoking bin-bb/fm-*.sh makes every `. "$SCRIPT_DIR/fm-*.sh"`
resolve inside bin-bb: the patched fm-backend.sh (carrying the bb dispatch arms)
and the bb.sh adapter are picked up for ALL scripts, with zero edits to tracked
files. The plugin invokes bin-bb/ instead of bin/ when the marker written here
(config/bb-overlay) is present.

bin-bb/ is registered in <home>/.git/info/exclude -- a local, per-clone git
exclude that is NOT part of the repository -- so `git status --porcelain` stays
empty and the fetch + ff-only path actually fast-forwards. config/ is already
gitignored upstream, so config/backend and config/bb-project stay invisible too.

Re-run this installer after an ff-update: it re-mirrors (picking up any new native
bin files) and regenerates the three patched copies against the new native
source. If a patch no longer applies because upstream changed one of the three
files, the install fails LOUDLY here instead of silently shipping a stale copy.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# The three tracked files with no native registration/dispatch seam. Carried as
# patched copies in the mirror; everything else in bin/ is symlinked.
PATCHED_FILES = ("fm-backend.sh", "fm-spawn.sh", "fm-teardown.sh")
# Extra files the backend patch also touches but which we do NOT ship (docs only);
# staged in the temp tree so their hunks apply, then discarded.
PATCH_STAGE_EXTRA = ("docs/configuration.md",)
MIRROR_DIRNAME = "bin-bb"
EXCLUDE_MARKER = "# firstmate bb backend overlay (bb-plugin-firstmate)"
MANIFEST_NAME = ".mirror-manifest"
# Internal absolute-path self-references inside the patched copies must stay in the
# mirror, or a copy that is bb-aware would re-invoke PRISTINE native (no bb arm) and
# fail with `unknown backend 'bb'`. Real case: fm-spawn.sh batch/array dispatch
# re-invokes "$FM_ROOT/bin/fm-spawn.sh" per pair, carrying --backend bb (F4).
SELF_REF_RE = re.compile(r'\$(?:FM_ROOT|FM_HOME)/bin/(fm-(?:spawn|teardown|backend)\.sh)')


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def die_loud(title: str, detail: str) -> None:
    """A failure that must be impossible to miss. Used for patch-apply failures,
    which turned a routine migration into a live outage precisely because an earlier
    installer printed 'ready' over one. Never print a success line after this."""
    bar = "!" * 72
    print(bar, file=sys.stderr)
    print(f"INSTALL FAILED: {title}", file=sys.stderr)
    for line in detail.splitlines():
        print(f"  {line}", file=sys.stderr)
    print("  The mirror was NOT changed; any previously-working bin-bb is intact.", file=sys.stderr)
    print(bar, file=sys.stderr)
    raise SystemExit(1)


def _rm_path(path: Path) -> None:
    """Remove a file, symlink, or directory tree; ignore if already gone."""
    try:
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
    except FileNotFoundError:
        pass


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def head_commit(home: Path) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(home), "rev-parse", "HEAD"],
            capture_output=True, text=True,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except OSError:
        pass
    return ""


def pristine_source(home: Path, relpath: str) -> str:
    """Return the committed (HEAD) bytes of a tracked file, so patching works even
    when the live working tree still carries the old in-place edits."""
    try:
        out = subprocess.run(
            ["git", "-C", str(home), "show", f"HEAD:{relpath}"],
            capture_output=True,
            text=True,
        )
        if out.returncode == 0 and out.stdout:
            return out.stdout
    except OSError:
        pass
    # Fallback: read the working-tree file (best effort for a non-git home).
    return (home / relpath).read_text()


def generate_patched_copies(home: Path, overlay: Path, dest_dir: Path) -> dict[str, str]:
    """Apply the overlay patches to pristine native sources in a scratch tree, rewrite
    internal dispatch self-references to stay in the mirror (F4), and copy the three
    resulting files into the mirror. Fails loudly if a patch does not apply (surfacing
    upstream drift instead of shipping a stale copy). Returns {file: native-source-sha}
    so the manifest can detect a later out-of-band drift of the frozen copies (F2)."""
    backend_patch = overlay / "firstmate-bb-backend.patch"
    teardown_patch = overlay / "firstmate-bb-teardown.patch"
    for patch in (backend_patch, teardown_patch):
        if not patch.is_file():
            die(f"missing {patch}")

    source_shas: dict[str, str] = {}
    with tempfile.TemporaryDirectory(prefix="fm-bb-patch-") as tmp:
        tmproot = Path(tmp)
        staged = [f"bin/{f}" for f in PATCHED_FILES] + list(PATCH_STAGE_EXTRA)
        for rel in staged:
            native = pristine_source(home, rel)
            if rel.startswith("bin/"):
                source_shas[rel[len("bin/"):]] = sha256_text(native)
            target = tmproot / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(native)
        for patch in (backend_patch, teardown_patch):
            result = subprocess.run(
                ["patch", "-p1", "--forward", "--batch", "-i", str(patch)],
                cwd=tmproot,
                capture_output=True,
                text=True,
            )
            sys.stdout.write(result.stdout)
            sys.stderr.write(result.stderr)
            # Loud-failure gate. `patch`'s exit code alone is not trusted: with
            # --forward it can exit 0 while silently skipping an already/partly
            # applied hunk, and a silent skip on migration day is exactly what
            # produced the outage. So a failure is ANY of: non-zero exit, a .rej
            # file written anywhere under the scratch tree, or a "hunk FAILED"
            # line in the output. Any one of these aborts the whole install.
            combined = f"{result.stdout}\n{result.stderr}"
            rejects = sorted(str(p.relative_to(tmproot)) for p in tmproot.rglob("*.rej"))
            failed_hunks = "FAILED" in combined or "hunks ignored" in combined
            if result.returncode != 0 or rejects or failed_hunks:
                die_loud(
                    f"a hunk of {patch.name} did not apply to the pristine native source",
                    "Upstream almost certainly changed one of the backend files.\n"
                    "Refusing to ship a stale/partial copy over a working mirror.\n"
                    f"patch exit={result.returncode}"
                    + (f"; rejects: {', '.join(rejects)}" if rejects else "")
                    + "\nRebase the overlay patches on the new source "
                    "(scripts/patch-drift-check.mjs shows which hunks drifted).",
                )
        for f in PATCHED_FILES:
            src = tmproot / "bin" / f
            if not src.is_file():
                die(f"patched {f} was not produced")
            # F4: keep internal $FM_ROOT/bin/fm-{spawn,teardown,backend}.sh self-calls
            # inside the mirror. $SCRIPT_DIR is the running copy's dir (= bin-bb), and
            # bin-bb carries every sibling (symlink or copy), so this is always correct.
            text = src.read_text()
            rewritten, nsubs = SELF_REF_RE.subn(r"$SCRIPT_DIR/\1", text)
            (dest_dir / f).write_text(rewritten)
            os.chmod(dest_dir / f, 0o755)
            note = f" ({nsubs} internal self-ref(s) redirected to the mirror)" if nsubs else ""
            print(f"generated {dest_dir / f} (patched copy){note}")
    return source_shas


def build_mirror(home: Path, overlay: Path) -> Path:
    """ATOMICALLY (re)build <home>/bin-bb. The mirror is built in full inside a
    STAGING directory and swapped into place only on complete success, so a failed
    install (a patch that no longer applies, a missing adapter) can never replace a
    working mirror with a broken/partial one: on any failure the staging tree is
    discarded and the existing bin-bb is left EXACTLY as it was.

    (The previous version rmtree'd the live mirror first and rebuilt in place, so a
    patch failure mid-rebuild left bin-bb missing the three dispatch copies — a
    host-wide `unknown backend 'bb'` outage on a shared home. Never again.)"""
    bin_dir = home / "bin"
    mirror = home / MIRROR_DIRNAME
    if (mirror.exists() or mirror.is_symlink()) and (not mirror.is_dir() or mirror.is_symlink()):
        die(f"{mirror} exists and is not a plain directory; refusing to touch it")

    staging = home / f"{MIRROR_DIRNAME}.staging"
    _rm_path(staging)  # clear any leftover from a previously-crashed install
    try:
        staging.mkdir(mode=0o755)
        patched = set(PATCHED_FILES)
        native_entries = sorted(os.listdir(bin_dir))
        for entry in native_entries:
            src = bin_dir / entry
            if entry == "backends" and src.is_dir():
                _mirror_backends(src, staging / "backends", overlay)
                continue
            if entry in patched:
                continue  # generated below as a real copy
            # Relative symlink so the mirror survives a home move. The depth of
            # staging matches the final mirror, so ../bin resolves either way.
            os.symlink(os.path.join("..", "bin", entry), staging / entry)

        source_shas = generate_patched_copies(home, overlay, staging)
        write_manifest(home, staging, native_entries, source_shas)
    except BaseException:
        # Includes die_loud()/die()'s SystemExit: discard the half-built staging and
        # leave the previously-working mirror untouched.
        _rm_path(staging)
        raise

    _atomic_swap(mirror, staging)
    return mirror


def _atomic_swap(mirror: Path, staging: Path) -> None:
    """Swap the fully-built `staging` tree into place at `mirror`. `os.rename` is
    atomic within a filesystem (staging is a sibling of mirror, so always same fs).
    On the first install there is no prior mirror. On a rebuild the old mirror is
    renamed aside, the new one swapped in, and the old one discarded; if the swap-in
    somehow fails the old mirror is rolled back so a working mirror is never lost."""
    if not (mirror.exists() or mirror.is_symlink()):
        os.rename(staging, mirror)
        return
    backup = mirror.with_name(mirror.name + ".old")
    _rm_path(backup)
    os.rename(mirror, backup)
    try:
        os.rename(staging, mirror)
    except BaseException:
        os.rename(backup, mirror)  # roll back to the working mirror
        raise
    _rm_path(backup)


def write_manifest(home: Path, mirror: Path, native_entries: list[str], source_shas: dict[str, str]) -> None:
    """Record what the mirror was built from so a later out-of-band fast-forward can be
    detected as stale (F2). Lines: head=<sha>, entries=<name,name,...>, src=<file>:<sha>."""
    lines = [
        "# firstmate bb mirror manifest (bb-plugin-firstmate) — do not edit",
        f"head={head_commit(home)}",
        f"entries={','.join(native_entries)}",
    ]
    for f in PATCHED_FILES:
        lines.append(f"src={f}:{source_shas.get(f, '')}")
    (mirror / MANIFEST_NAME).write_text("\n".join(lines) + "\n")


def read_manifest(mirror: Path) -> dict[str, str] | None:
    path = mirror / MANIFEST_NAME
    if not path.is_file():
        return None
    data: dict[str, str] = {}
    for line in path.read_text().splitlines():
        if line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        if key == "src":
            name, _, sha = val.partition(":")
            data[f"src:{name}"] = sha
        else:
            data[key] = val
    return data


def verify_mirror(home: Path) -> list[str]:
    """Return a list of staleness/breakage reasons (empty == healthy). Checks that
    every native bin entry still has a live mirror counterpart (missing SCRIPT_DIR
    sibling), that the manifest HEAD matches the current HEAD, and that the pristine
    source of each frozen copy has not drifted since the copy was generated (F2)."""
    mirror = home / MIRROR_DIRNAME
    reasons: list[str] = []
    if not mirror.is_dir():
        return ["mirror bin-bb/ is absent"]
    manifest = read_manifest(mirror)
    if manifest is None:
        return ["mirror manifest is missing (built by an older overlay); re-run the installer"]
    # Missing siblings: any native bin entry without a mirror counterpart breaks a
    # SCRIPT_DIR source in whatever mirror script needs it.
    bin_dir = home / "bin"
    if bin_dir.is_dir():
        for entry in sorted(os.listdir(bin_dir)):
            target = mirror / entry
            if not (target.exists() or target.is_symlink()):
                reasons.append(f"mirror is missing sibling '{entry}' (native bin/ has it) — a ff without re-install")
            elif target.is_symlink() and not target.exists():
                reasons.append(f"mirror sibling '{entry}' is a dangling symlink")
    # HEAD drift: the plugin's own ff re-mirrors, but an out-of-band ff does not.
    current = head_commit(home)
    recorded = manifest.get("head", "")
    if current and recorded and current != recorded:
        reasons.append(f"HEAD moved since the mirror was built ({recorded[:12]} -> {current[:12]}); re-run the installer")
    # Frozen-copy drift: the pristine native source of a patched copy changed since the
    # copy was generated, so the copy no longer reflects upstream.
    for f in PATCHED_FILES:
        want = manifest.get(f"src:{f}", "")
        have = sha256_text(pristine_source(home, f"bin/{f}"))
        if want and have != want:
            reasons.append(f"frozen copy '{f}' is stale: native bin/{f} drifted from the copy's source")
    return reasons


def _mirror_backends(native_backends: Path, dest: Path, overlay: Path) -> None:
    dest.mkdir(mode=0o755, parents=True, exist_ok=True)
    for entry in sorted(os.listdir(native_backends)):
        if entry == "bb.sh":
            continue  # shipped as a real copy below
        os.symlink(
            os.path.join("..", "..", "bin", "backends", entry),
            dest / entry,
        )
    adapter = overlay / "bin" / "backends" / "bb.sh"
    if not adapter.is_file():
        die(f"missing adapter {adapter}")
    shutil.copy2(adapter, dest / "bb.sh")
    os.chmod(dest / "bb.sh", 0o755)
    print(f"installed {dest / 'bb.sh'}")


def write_exclude(home: Path) -> None:
    """Register the overlay's untracked paths in .git/info/exclude so the tree
    reads clean and the plugin's ff-only auto-update stops skipping."""
    # Resolve Git's shared exclude file. A linked worktree's `.git` pointer
    # names its private administrative directory, whose `info/exclude` is not
    # consulted by Git.
    try:
        resolved = subprocess.run(
            ["git", "-C", str(home), "rev-parse", "--git-path", "info/exclude"],
            capture_output=True,
            text=True,
        )
    except OSError:
        resolved = None
    if resolved is None or resolved.returncode != 0 or not resolved.stdout.strip():
        print(f"note: {home} has no .git; skipping info/exclude (config/ ignore still applies)")
        return
    exclude = Path(resolved.stdout.strip())
    if not exclude.is_absolute():
        exclude = (home / exclude).resolve()
    exclude.parent.mkdir(parents=True, exist_ok=True)
    existing = exclude.read_text() if exclude.exists() else ""
    existing_lines = set(existing.splitlines())
    # The transient staging/backup dirs of the atomic install must be excluded too,
    # so a rebuild never flashes the tree dirty and a leftover after a crash stays
    # untracked. Add any missing pattern even on a home whose marker already exists
    # (installed by an older overlay that only listed /bin-bb/).
    patterns = [
        EXCLUDE_MARKER,
        f"/{MIRROR_DIRNAME}/",
        f"/{MIRROR_DIRNAME}.staging/",
        f"/{MIRROR_DIRNAME}.old/",
        "/docs/bb-backend.md",
    ]
    missing = [p for p in patterns if p not in existing_lines]
    if not missing:
        return
    with exclude.open("a") as fh:
        if existing and not existing.endswith("\n"):
            fh.write("\n")
        fh.write("\n".join(missing) + "\n")
    print(f"registered overlay paths in {exclude}")


def warn_legacy_in_place_patch(home: Path) -> None:
    """The previous overlay patched tracked bin files in place. Detect that leftover
    state and tell the operator to run the migration procedure (docs/bb-backend.md,
    "Migrating a home off the in-place patch"). Never auto-reverts a tracked file."""
    try:
        out = subprocess.run(
            ["git", "-C", str(home), "status", "--porcelain", "--",
             "bin/fm-backend.sh", "bin/fm-spawn.sh", "bin/fm-teardown.sh", "docs/configuration.md"],
            capture_output=True,
            text=True,
        )
    except OSError:
        return
    dirty = [line for line in out.stdout.splitlines() if line.strip()]
    orig = [p.name for p in (home / "bin").glob("fm-*.sh.orig")]
    orig += [p.name for p in (home / "docs").glob("*.md.orig")] if (home / "docs").is_dir() else []
    if not dirty and not orig:
        return
    print("=" * 72, file=sys.stderr)
    print("WARNING: this home still carries the LEGACY in-place backend patch.", file=sys.stderr)
    if dirty:
        print("  Modified tracked files:", ", ".join(l[3:] for l in dirty), file=sys.stderr)
    if orig:
        print("  Leftover .orig files:", ", ".join(sorted(set(orig))), file=sys.stderr)
    print("  The mirror bin (bin-bb) is now installed and takes over, but the tracked", file=sys.stderr)
    print("  tree stays DIRTY (so ff-update keeps skipping) until you run the safe", file=sys.stderr)
    print("  migration in docs/bb-backend.md -> 'Migrating a home off the in-place", file=sys.stderr)
    print("  patch'. It restores the three files and removes .orig files WITHOUT", file=sys.stderr)
    print("  touching state/ or data/.", file=sys.stderr)
    print("=" * 72, file=sys.stderr)


def write_config(home: Path, project_id: str | None) -> None:
    cfg = home / "config"
    cfg.mkdir(parents=True, exist_ok=True)
    backend = cfg / "backend"
    current = backend.read_text().strip() if backend.exists() else ""
    if current in ("", "tmux"):
        backend.write_text("bb\n")
        print(f"wrote {backend}")
    # Marker the plugin reads to route bin -> bin-bb for this home.
    (cfg / "bb-overlay").write_text(MIRROR_DIRNAME + "\n")
    print(f"wrote {cfg / 'bb-overlay'}")
    if project_id:
        (cfg / "bb-project").write_text(project_id + "\n")
        print(f"wrote {cfg / 'bb-project'}")


def install_docs(home: Path, overlay: Path) -> None:
    docs_src = overlay / "docs" / "bb-backend.md"
    if docs_src.is_file():
        (home / "docs").mkdir(parents=True, exist_ok=True)
        shutil.copy2(docs_src, home / "docs" / "bb-backend.md")
        print(f"copied {home / 'docs' / 'bb-backend.md'}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True)
    parser.add_argument("--overlay", default="")
    parser.add_argument("--project-id", default="")
    parser.add_argument(
        "--verify", action="store_true",
        help="check the installed mirror for staleness/breakage and exit non-zero if stale (no install)",
    )
    args = parser.parse_args()
    home = Path(args.home).resolve()
    if not (home / "bin" / "fm-backend.sh").is_file():
        die(f"{home} is not a firstmate root")

    if args.verify:
        reasons = verify_mirror(home)
        if reasons:
            print("FM_MIRROR_STALE: the bb mirror is stale or broken:", file=sys.stderr)
            for r in reasons:
                print(f"  - {r}", file=sys.stderr)
            print("  Re-run install-bb-backend.py to rebuild the mirror.", file=sys.stderr)
            raise SystemExit(1)
        print("mirror OK: siblings present, HEAD matches, frozen copies current.")
        return

    overlay = Path(args.overlay).resolve() if args.overlay else Path(__file__).resolve().parent

    write_exclude(home)  # exclude first, so the mirror never flashes as dirty
    mirror = build_mirror(home, overlay)
    install_docs(home, overlay)
    write_config(home, args.project_id or None)
    warn_legacy_in_place_patch(home)
    print(f"BB backend ready. Mirror bin at {mirror}; FM_BACKEND=bb via config/backend.")
    print("Tracked files are untouched: `git status --porcelain` stays empty.")


if __name__ == "__main__":
    main()
