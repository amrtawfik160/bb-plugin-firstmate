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
import os
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


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


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


def generate_patched_copies(home: Path, overlay: Path, dest_dir: Path) -> None:
    """Apply the overlay patches to pristine native sources in a scratch tree and
    copy the three resulting files into the mirror. Fails loudly if a patch does
    not apply (surfacing upstream drift instead of shipping a stale copy)."""
    backend_patch = overlay / "firstmate-bb-backend.patch"
    teardown_patch = overlay / "firstmate-bb-teardown.patch"
    for patch in (backend_patch, teardown_patch):
        if not patch.is_file():
            die(f"missing {patch}")

    with tempfile.TemporaryDirectory(prefix="fm-bb-patch-") as tmp:
        tmproot = Path(tmp)
        staged = [f"bin/{f}" for f in PATCHED_FILES] + list(PATCH_STAGE_EXTRA)
        for rel in staged:
            target = tmproot / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(pristine_source(home, rel))
        for patch in (backend_patch, teardown_patch):
            result = subprocess.run(
                ["patch", "-p1", "--forward", "--batch", "-i", str(patch)],
                cwd=tmproot,
                capture_output=True,
                text=True,
            )
            sys.stdout.write(result.stdout)
            sys.stderr.write(result.stderr)
            if result.returncode != 0:
                die(
                    f"could not apply {patch.name} to pristine native source; "
                    "upstream likely changed one of the backend files. Refusing to "
                    "ship a stale copy. Rebase the overlay patches on the new source."
                )
        for f in PATCHED_FILES:
            src = tmproot / "bin" / f
            if not src.is_file():
                die(f"patched {f} was not produced")
            shutil.copy2(src, dest_dir / f)
            os.chmod(dest_dir / f, 0o755)
            print(f"generated {dest_dir / f} (patched copy)")


def build_mirror(home: Path, overlay: Path) -> Path:
    """(Re)build <home>/bin-bb: symlink every native bin entry, generate the three
    patched copies, and install the bb.sh adapter."""
    bin_dir = home / "bin"
    mirror = home / MIRROR_DIRNAME
    if mirror.exists() or mirror.is_symlink():
        if not mirror.is_dir() or mirror.is_symlink():
            die(f"{mirror} exists and is not a plain directory; refusing to touch it")
        shutil.rmtree(mirror)
    mirror.mkdir(mode=0o755)

    patched = set(PATCHED_FILES)
    for entry in sorted(os.listdir(bin_dir)):
        src = bin_dir / entry
        if entry == "backends" and src.is_dir():
            _mirror_backends(src, mirror / "backends", overlay)
            continue
        if entry in patched:
            continue  # generated below as a real copy
        # Relative symlink so the mirror survives a home move.
        os.symlink(os.path.join("..", "bin", entry), mirror / entry)

    generate_patched_copies(home, overlay, mirror)
    return mirror


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
    git_dir = home / ".git"
    if git_dir.is_file():
        # Worktree/submodule: .git is a file pointing at the real gitdir.
        text = git_dir.read_text().strip()
        if text.startswith("gitdir:"):
            git_dir = Path(text.split(":", 1)[1].strip())
            if not git_dir.is_absolute():
                git_dir = (home / git_dir).resolve()
    if not git_dir.is_dir():
        print(f"note: {home} has no .git; skipping info/exclude (config/ ignore still applies)")
        return
    info = git_dir / "info"
    info.mkdir(parents=True, exist_ok=True)
    exclude = info / "exclude"
    existing = exclude.read_text() if exclude.exists() else ""
    if EXCLUDE_MARKER in existing:
        return
    patterns = [EXCLUDE_MARKER, f"/{MIRROR_DIRNAME}/", "/docs/bb-backend.md", ""]
    with exclude.open("a") as fh:
        if existing and not existing.endswith("\n"):
            fh.write("\n")
        fh.write("\n".join(patterns) + "\n")
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
    args = parser.parse_args()
    home = Path(args.home).resolve()
    if not (home / "bin" / "fm-backend.sh").is_file():
        die(f"{home} is not a firstmate root")
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
