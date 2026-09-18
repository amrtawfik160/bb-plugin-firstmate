#!/usr/bin/env python3
"""Install the BB session backend into a firstmate home.

Copies backends/bb.sh + docs, then applies firstmate-bb-backend.patch unless
fm-backend.sh already lists bb. Does not rewrite the rest of bin/.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def already_patched(home: Path) -> bool:
    known = ""
    for line in (home / "bin" / "fm-backend.sh").read_text().splitlines():
        if line.startswith("FM_BACKEND_KNOWN="):
            known = line
            break
    return " bb" in known or known.endswith('bb"')


def write_config(home: Path, project_id: str | None) -> None:
    cfg = home / "config"
    cfg.mkdir(parents=True, exist_ok=True)
    backend = cfg / "backend"
    current = backend.read_text().strip() if backend.exists() else ""
    if current in ("", "tmux"):
        backend.write_text("bb\n")
        print(f"wrote {backend}")
    if project_id:
        (cfg / "bb-project").write_text(project_id + "\n")
        print(f"wrote {cfg / 'bb-project'}")


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
    src = overlay / "bin" / "backends" / "bb.sh"
    if not src.is_file():
        die(f"missing adapter {src}")
    dest_dir = home / "bin" / "backends"
    dest_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest_dir / "bb.sh")
    os.chmod(dest_dir / "bb.sh", 0o755)
    print(f"copied {dest_dir / 'bb.sh'}")
    docs_src = overlay / "docs" / "bb-backend.md"
    if docs_src.is_file():
        (home / "docs").mkdir(parents=True, exist_ok=True)
        shutil.copy2(docs_src, home / "docs" / "bb-backend.md")
        print(f"copied {home / 'docs' / 'bb-backend.md'}")
    if already_patched(home):
        print("fm-backend.sh already lists bb; skip patch")
    else:
        patch = overlay / "firstmate-bb-backend.patch"
        if not patch.is_file():
            die(f"missing {patch}")
        result = subprocess.run(
            ["patch", "-p1", "--forward", "--batch", "-i", str(patch)],
            cwd=home,
            capture_output=True,
            text=True,
        )
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        if result.returncode != 0:
            die("could not patch this firstmate checkout for backend=bb")
    teardown = home / "bin" / "fm-teardown.sh"
    teardown_text = teardown.read_text() if teardown.is_file() else ""
    if '[ "$BACKEND" = bb ]' in teardown_text:
        print("fm-teardown.sh already handles bb; skip teardown patch")
    else:
        patch = overlay / "firstmate-bb-teardown.patch"
        if not patch.is_file():
            die(f"missing {patch}")
        result = subprocess.run(
            ["patch", "-p1", "--forward", "--batch", "-i", str(patch)],
            cwd=home,
            capture_output=True,
            text=True,
        )
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        if result.returncode != 0:
            die("could not patch fm-teardown.sh for backend=bb")
    write_config(home, args.project_id or None)
    print("BB backend ready. FM_BACKEND=bb via config/backend.")


if __name__ == "__main__":
    main()
