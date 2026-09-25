#!/usr/bin/env python3
"""Keep native presentations until explicit handling completion.

Usage: bb-wake-receipt.py STATE ACTION EXPECTED NATIVE_SCRIPT
Actions: receive, inspect ID, mark-success ID, complete ID,
         legacy-ack THROUGH:GENERATION. receive uses an empty EXPECTED.
Returns one bounded FM_BB_RECEIPT=<JSON> line; full reports stay on disk.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import uuid


FRAME_LIMIT = 6000
PHASES = {"presenting", "ready", "handled", "acknowledging", "acknowledged", "refreshing"}
ACK = re.compile(
    r"^WAKE_ACK_REQUIRED: [^\n]* --ack-through (\d+) --recovery-generation ([A-Za-z0-9._-]+)\s*$",
    re.MULTILINE,
)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path, value):
    atomic_text(path, json.dumps(value, ensure_ascii=False))


def atomic_text(path, text):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)


def ack_pair(report):
    matches = list(ACK.finditer(report))
    if len(matches) > 1:
        raise RuntimeError("Ambiguous native acknowledgement; report retained")
    return {"through": int(matches[0][1]), "generation": matches[0][2]} if matches else None


def meaningful(report):
    lines = []
    for line in report.splitlines():
        if ACK.fullmatch(line) or not line.strip():
            continue
        if line.strip() in {"Wake queue empty.", "No unread reports."}:
            continue
        if line.startswith("wake drain: acknowledged wakes through "):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


class Journal:
    def __init__(self, state, script):
        self.state = state
        self.script = script
        self.path = state / ".bb-wake-receipt.json"
        self.reports = state / ".bb-wake-reports"
        self.reports.mkdir(mode=0o700, exist_ok=True)
        self.current = json.loads(self.path.read_text()) if self.path.exists() else None
        if self.current is not None:
            value = self.current
            if (value.get("version") != 1 or value.get("phase") not in PHASES
                    or not re.fullmatch(r"[a-f0-9]{32}", value.get("id", ""))):
                raise RuntimeError("Invalid wake receipt journal; retained for recovery")
            pair = value.get("pair")
            if pair is not None and (not isinstance(pair.get("through"), int)
                    or pair["through"] < 0
                    or not re.fullmatch(r"[A-Za-z0-9._-]+", pair.get("generation", ""))):
                raise RuntimeError("Invalid native acknowledgement in journal; retained")
            if value["phase"] != "presenting" and not self.report_path().is_file():
                raise RuntimeError("Wake receipt report is missing; no acknowledgement authorized")

    def report_path(self):
        return self.reports / (self.current["id"] + ".txt")

    def save(self):
        atomic_json(self.path, self.current)

    def clear(self):
        self.path.unlink(missing_ok=True)
        sync_directory(self.state)
        self.current = None

    def check_id(self, expected):
        if self.current is None or self.current["id"] != expected:
            raise RuntimeError("Wake receipt absent or changed; no action or acknowledgement authorized")

    def report(self):
        path = self.report_path()
        return path.read_text() if path.exists() else ""

    def publish(self, replayed=False, completed=None):
        value = self.current
        payload = {
            "id": value["id"] if value else None,
            "phase": value["phase"] if value else "empty",
            "report": self.report() if value else "No unread reports.",
            "path": str(self.report_path()) if value else "",
            "replayed": replayed,
            "truncated": False,
            "actionSucceeded": bool(value and value.get("actionSucceeded")),
        }
        if completed:
            payload["completed"] = completed
        if value and value.get("pair"):
            payload["pair"] = value["pair"]
        original = payload["report"]
        while True:
            encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            excess = len(("FM_BB_RECEIPT=" + encoded + "\n").encode()) - FRAME_LIMIT
            if excess <= 0:
                break
            payload["truncated"] = True
            payload["reportBytes"] = len(original.encode())
            raw = payload["report"].encode()
            keep = min(len(raw) - 1, max(1, len(raw) * (FRAME_LIMIT - 1024) // len(encoded.encode())))
            payload["report"] = raw[:keep].decode("utf8", "ignore")
            if not payload["report"]:
                raise RuntimeError("Receipt metadata exceeds transport frame budget")
        print("FM_BB_RECEIPT=" + encoded)

    def capture_paths(self):
        token = self.current["capture"]
        if not re.fullmatch(r"[a-f0-9]{32}", token):
            raise RuntimeError("Invalid native capture reference; journal retained")
        return self.reports / (token + ".native.txt"), self.reports / (token + ".result.json")

    def native(self, arguments, phase):
        self.current["phase"] = phase
        self.current["capture"] = uuid.uuid4().hex
        output, result_path = self.capture_paths()
        atomic_text(output, "")
        self.save()
        # The guardian keeps the flock after transport death. Native descendants
        # do not inherit it, so an unrelated daemon cannot retain this lock.
        pid = os.fork()
        if pid == 0:
            try:
                os.setsid()
                null = os.open(os.devnull, os.O_RDWR)
                for descriptor in (0, 1, 2):
                    os.dup2(null, descriptor)
                if null > 2:
                    os.close(null)
                env = dict(os.environ, FM_STATE_OVERRIDE=str(self.state))
                with output.open("w") as stream:
                    try:
                        process = subprocess.Popen(
                            [self.script, *arguments], stdin=subprocess.DEVNULL,
                            stdout=stream, stderr=subprocess.STDOUT, env=env,
                            close_fds=True, start_new_session=True,
                        )
                        try:
                            code = process.wait(timeout=180)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait()
                            stream.write("\nNative execution timed out after 180 seconds\n")
                            code = 124
                    except Exception as error:
                        stream.write("\nNative execution failed: " + str(error) + "\n")
                        code = 1
                    stream.flush()
                    os.fsync(stream.fileno())
                atomic_json(result_path, {"exitCode": code})
                os._exit(0)
            except BaseException:
                os._exit(1)
        os.waitpid(pid, 0)
        return self.capture_result()

    def capture_result(self):
        output, result_path = self.capture_paths()
        if not result_path.exists():
            raise RuntimeError(f"Interrupted native operation; captured report retained at {output}")
        result = json.loads(result_path.read_text())
        report = output.read_text()
        if result.get("exitCode") != 0:
            raise RuntimeError(f"Native wake operation failed ({result.get('exitCode')}); report retained at {output}")
        return report

    def start(self):
        self.current = {"version": 1, "id": uuid.uuid4().hex, "phase": "presenting", "pair": None}
        report = self.native([], "presenting")
        self.finish_presentation(report)

    def finish_presentation(self, report):
        pair = ack_pair(report)
        preserved = self.current.pop("preservedReport", "")
        if preserved:
            report = "RECOVERED PRESENTATION (reconcile before repeating actions):\n" + preserved + "\nCURRENT NATIVE PRESENTATION:\n" + report
        atomic_text(self.report_path(), report)
        self.current["pair"] = pair
        self.current["phase"] = "ready"
        self.current.pop("capture", None)
        self.save()
        if not self.current["pair"] and not meaningful(report):
            self.clear()

    def recover_presentation(self):
        try:
            report = self.capture_result()
        except RuntimeError:
            output, _ = self.capture_paths()
            prior = output.read_text() if output.exists() else ""
            prior_path = self.report_path()
            previous = self.current.get("preservedReport", "") or (prior_path.read_text() if prior_path.exists() else "")
            preserved = previous + "\n" + prior
            # The native status read receipt can commit before the command fails.
            atomic_text(prior_path, preserved)
            self.current["preservedReport"] = preserved
            self.save()
            report = self.native([], "presenting")
            self.finish_presentation(report)
            return
        self.finish_presentation(report)

    def inspect(self, expected):
        self.check_id(expected)
        if self.current["phase"] != "ready":
            raise RuntimeError("Wake handling already completed or is uncertain; retry firstmate_wake completion only, do not repeat the action")
        self.publish(True)

    def mark_success(self, expected):
        self.check_id(expected)
        if self.current["phase"] not in {"ready", "handled"}:
            raise RuntimeError("Wake already completing; retry completion only, do not repeat the action")
        self.current.update(phase="handled", actionSucceeded=True)
        self.save()
        self.publish(True)

    def complete(self, expected):
        self.check_id(expected)
        completed = self.current["id"]
        if self.current["phase"] == "ready":
            self.current["phase"] = "handled"
            self.save()
        if self.current["phase"] == "presenting":
            raise RuntimeError("Incomplete wake presentation; receive it before completing")
        if self.current["phase"] in {"handled", "acknowledging"}:
            pair = self.current["pair"]
            prior = self.current.get("ackReport", "")
            if self.current["phase"] == "acknowledging":
                try:
                    acknowledgement = self.capture_result()
                except RuntimeError:
                    output, _ = self.capture_paths()
                    prior += "\n" + (output.read_text() if output.exists() else "")
                    self.current["ackReport"] = prior
                    self.save()
                    acknowledgement = self.native([
                        "--ack-through", str(pair["through"]), "--recovery-generation", pair["generation"],
                    ], "acknowledging")
            elif pair:
                acknowledgement = self.native([
                    "--ack-through", str(pair["through"]), "--recovery-generation", pair["generation"],
                ], "acknowledging")
            else:
                acknowledgement = ""
            self.current.update(phase="acknowledged", ackReport=prior + acknowledgement)
            self.save()
        if self.current["phase"] == "acknowledged":
            fresh = self.native([], "refreshing")
        elif self.current["phase"] == "refreshing":
            try:
                fresh = self.capture_result()
            except RuntimeError:
                output, _ = self.capture_paths()
                partial = output.read_text() if output.exists() else ""
                self.current["ackReport"] = self.current.get("ackReport", "") + "\n" + partial
                self.save()
                fresh = self.native([], "refreshing")
        else:
            raise RuntimeError("Invalid completion phase; journal retained")
        acknowledgement = self.current.get("ackReport", "")
        old_report = self.report()
        pair = ack_pair(fresh)
        if not pair and not meaningful(acknowledgement) and meaningful(fresh) in {"", meaningful(old_report)}:
            self.clear()
        else:
            report = ("NATIVE ACKNOWLEDGEMENT OUTPUT (previous handling completed):\n" + acknowledgement + "\n" if meaningful(acknowledgement) else "") + fresh
            self.current = {"version": 1, "id": uuid.uuid4().hex, "phase": "ready", "pair": pair}
            atomic_text(self.report_path(), report)
            self.save()
        self.publish(completed=completed)

    def receive(self):
        replayed = self.current is not None
        if self.current is None:
            self.start()
        elif self.current["phase"] == "presenting":
            self.recover_presentation()
        elif self.current["phase"] in {"handled", "acknowledging", "acknowledged", "refreshing"}:
            self.complete(self.current["id"])
            return
        self.publish(replayed)


def main():
    if len(sys.argv) != 5:
        raise RuntimeError("Usage: bb-wake-receipt.py STATE ACTION EXPECTED NATIVE_SCRIPT")
    state, action, expected, script = sys.argv[1:]
    if action not in {"receive", "inspect", "mark-success", "complete", "legacy-ack"}:
        raise RuntimeError("Unknown wake receipt action")
    os.umask(0o077)
    state = Path(state).resolve()
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state / ".bb-wake-receipt.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        journal = Journal(state, script)
        if action == "receive":
            journal.receive()
        elif action == "inspect":
            journal.inspect(expected)
        elif action == "mark-success":
            journal.mark_success(expected)
        elif action == "complete":
            journal.complete(expected)
        else:
            pair = journal.current.get("pair") if journal.current else None
            if not pair or expected != str(pair["through"]) + ":" + pair["generation"]:
                raise RuntimeError("Legacy acknowledgement does not match the current receipt; nothing consumed")
            journal.complete(journal.current["id"])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
