#!/usr/bin/env python3
"""Exact task-inbox read/ack transport; native owns records and their bodies."""
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys

FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def regular(directory, name):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise ValueError(f"not a regular message: {name}")
    return descriptor


def same(left, right):
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def main():
    args = sys.argv[1:]
    home = os.environ.get("FM_HOME", "")
    if not args or not home or not os.path.isabs(home):
        raise ValueError("usage: FM_HOME=<absolute-home> fm-inbox-take.sh <task-id> [--ack <message-id> ...]")
    task, *options = args
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", task) or task in (".", ".."):
        raise ValueError("invalid task id")
    ack = bool(options)
    if ack and (options[0] != "--ack" or len(options) < 2):
        raise ValueError("bare --ack is no longer supported: read first, act, then acknowledge only displayed IDs with --ack 001.msg [002.msg ...]")
    ids = options[1:] if ack else []
    if any(not re.fullmatch(r"[0-9]{3,}\.msg", name) for name in ids) or len(set(ids)) != len(ids):
        raise ValueError("ack requires unique immutable numeric message basenames, e.g. 001.msg; paths are forbidden")
    handles = []
    opened = []
    try:
        root = os.open(home, FLAGS); handles.append(root)
        try:
            state = os.open("state", FLAGS, dir_fd=root); handles.append(state)
        except FileNotFoundError:
            if ack:
                raise ValueError("unknown message IDs: task state does not exist")
            print("inbox empty")
            return
        try:
            inbox = os.open(f"{task}.inbox", FLAGS, dir_fd=state); handles.append(inbox)
        except FileNotFoundError:
            if ack:
                raise ValueError("unknown message IDs: task inbox does not exist")
            print("inbox empty")
            return
        if ack:
            # Validate the entire requested set before any acknowledgement. Never
            # overwrite handled evidence. Same-inode pairs are crash recovery for
            # a successful link followed by an interrupted unlink.
            try:
                os.mkdir("handled", dir_fd=inbox)
            except FileExistsError:
                pass
            handled = os.open("handled", FLAGS, dir_fd=inbox); handles.append(handled)
            pending = []
            for name in ids:
                source = destination = None
                try:
                    source = regular(inbox, name); opened.append(source)
                except FileNotFoundError:
                    pass
                try:
                    destination = regular(handled, name); opened.append(destination)
                except FileNotFoundError:
                    pass
                if source is None and destination is None:
                    raise ValueError(f"unknown message ID: {name}")
                if source is not None and destination is not None and not same(os.fstat(source), os.fstat(destination)):
                    raise ValueError(f"handled record conflict; nothing overwritten: {name}")
                pending.append((name, source, destination))
            for name, source, destination in pending:
                if source is None:
                    print(f"already handled: {name}")
                    continue
                if destination is None:
                    try:
                        os.link(name, name, src_dir_fd=inbox, dst_dir_fd=handled, follow_symlinks=False)
                    except (FileExistsError, FileNotFoundError):
                        destination = regular(handled, name); opened.append(destination)
                        if not same(os.fstat(source), os.fstat(destination)):
                            raise ValueError(f"concurrent handled record conflict: {name}")
                linked = os.stat(name, dir_fd=handled, follow_symlinks=False)
                if not stat.S_ISREG(linked.st_mode) or not same(os.fstat(source), linked):
                    raise ValueError(f"message identity changed; acknowledgement refused: {name}")
                try:
                    current = os.stat(name, dir_fd=inbox, follow_symlinks=False)
                except FileNotFoundError:
                    current = None
                if current is not None:
                    if not same(os.fstat(source), current):
                        raise ValueError(f"message identity changed; acknowledgement refused: {name}")
                    try:
                        os.unlink(name, dir_fd=inbox)
                    except FileNotFoundError:
                        pass  # Another exact-ID ack already removed the same link.
                print(f"handled: {name}")
            os.fsync(handled); os.fsync(inbox)
            return
        names = sorted((name for name in os.listdir(inbox) if name.endswith(".msg")), key=lambda name: (len(name), name))
        if any(not re.fullmatch(r"[0-9]{3,}\.msg", name) for name in names):
            raise ValueError("inbox contains an invalid message basename")
        for name in names:
            descriptor = regular(inbox, name); opened.append(descriptor)
            print(f"----- {name} -----", flush=True)
            library = Path(home) / "bin/fm-task-inbox-lib.sh"
            if library.is_file():
                # The library is Bash, not sh. Pass our already opened regular
                # file rather than following the inbox path again during decode.
                result = subprocess.run(["bash", "-c", '. "$1"; fm_task_inbox_body "$2"', "fm-inbox-body", str(library), f"/proc/self/fd/{descriptor}"], pass_fds=(descriptor,))
                if result.returncode:
                    raise ValueError(f"native envelope decode failed: {name}")
            else:
                # Legacy plain-message fixture/home without native library.
                with os.fdopen(os.dup(descriptor), "rb") as record:
                    body = record.read()
                    if body.startswith(b"schema=fm-task-inbox."):
                        raise ValueError(f"native inbox library required to decode envelope: {name}")
                    sys.stdout.buffer.write(body); sys.stdout.buffer.flush()
            print()
        if names:
            command = ["bash", str(Path(__file__).with_suffix(".sh")), task, "--ack", *names]
            print("After acting on these exact records, acknowledge only the handled IDs:")
            print(f"FM_HOME={shlex.quote(home)} {shlex.join(command)}")
        else:
            print("inbox empty")
    finally:
        for descriptor in reversed(opened + handles):
            os.close(descriptor)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(2)
