import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimeFixture } from "../scripts/native-runtime-fixture.mjs";
import { captainWatchNeed, nativeWatchSourceScript, parseNativeWatchSource, WATCH_NEED_LOG, type CaptainWatchNeedInput } from "./captain-watch-need.ts";

const idle: CaptainWatchNeedInput = {
  captainStatus: "idle",
  crews: [],
  launches: [],
  queuedWake: false,
};

test("nothing live when the captain is idle or in error with no crews, launches, or queued wake", () => {
  assert.equal(captainWatchNeed(idle), "nothing-live");
  assert.equal(captainWatchNeed({ ...idle, captainStatus: "error" }), "nothing-live");
  assert.equal(WATCH_NEED_LOG["nothing-live"], "nothing live");
});

test("a running crew keeps the watcher even when the captain thread is in error", () => {
  assert.equal(
    captainWatchNeed({
      ...idle,
      captainStatus: "error",
      crews: [{ threadId: "thr_crew", threadStatus: "active" }],
    }),
    "running-crew",
  );
});

test("idle and error crew threads do not keep the watcher", () => {
  assert.equal(
    captainWatchNeed({
      ...idle,
      crews: [
        { threadId: "thr_a", threadStatus: "idle" },
        { threadId: "thr_b", threadStatus: "error" },
        { threadId: "thr_c", threadStatus: "idle", archived: true },
      ],
    }),
    "nothing-live",
  );
});

test("unknown crew status, an empty thread id, and a starting crew fail closed", () => {
  assert.equal(
    captainWatchNeed({ ...idle, crews: [{ threadId: "thr_crew", threadStatus: null }] }),
    "running-crew",
  );
  assert.equal(
    captainWatchNeed({ ...idle, crews: [{ threadId: "", threadStatus: "idle" }] }),
    "running-crew",
  );
  assert.equal(
    captainWatchNeed({ ...idle, crews: [{ threadId: "thr_crew", threadStatus: "starting" }] }),
    "running-crew",
  );
});

test("a secondmate route is not a plugin keep reason; the native probe covers registered secondmates", () => {
  assert.equal(
    captainWatchNeed({
      ...idle,
      crews: [{ threadId: "thr_mate", threadStatus: "active", secondmate: true }],
    }),
    "nothing-live",
  );
});

test("in-flight launches keep the watcher; a running launch does not by itself", () => {
  for (const state of ["reserved", "creating", "provisioning", "uncertain"]) {
    assert.equal(captainWatchNeed({ ...idle, launches: [{ state }] }), "in-flight-launch", state);
  }
  assert.equal(captainWatchNeed({ ...idle, launches: [{ state: "running" }] }), "nothing-live");
  assert.equal(captainWatchNeed({ ...idle, launches: [{ state: "failed" }] }), "nothing-live");
  assert.equal(captainWatchNeed({ ...idle, launches: [{ state: "deleted" }] }), "nothing-live");
});

test("a queued wake keeps the watcher", () => {
  assert.equal(captainWatchNeed({ ...idle, queuedWake: true }), "queued-wake");
});

test("an active or starting captain turn keeps the watcher", () => {
  assert.equal(captainWatchNeed({ ...idle, captainStatus: "active" }), "captain-turn");
  assert.equal(captainWatchNeed({ ...idle, captainStatus: "starting" }), "captain-turn");
});

test("a live crew wins over launch, wake, and captain turn for the logged reason", () => {
  assert.equal(
    captainWatchNeed({
      captainStatus: "active",
      queuedWake: true,
      launches: [{ state: "reserved" }],
      crews: [{ threadId: "thr_crew", threadStatus: "active" }],
    }),
    "running-crew",
  );
});

function probe(setup: (state: string, bin: string) => void, libs = true): string {
  const dir = mkdtempSync(join(tmpdir(), "fm-watch-source-"));
  try {
    const state = join(dir, "home", "state");
    const bin = join(dir, "bin");
    mkdirSync(state, { recursive: true });
    mkdirSync(bin);
    if (libs) {
      // Stand-ins for the native libraries: a status line naming `paused:` is a declared wait,
      // and a status or turn-end with no matching .seen-<name> marker is unreported.
      writeFileSync(join(bin, "fm-wake-lib.sh"), [
        `fm_wake_signal_sig() { cat "$1"; }`,
        `fm_wake_signal_seen_path() { b=\${2##*/}; printf '%s/.seen-%s' "$1" "\${b//./_}"; }`,
        `fm_wake_signal_seen_current() { [ "$(cat "$(fm_wake_signal_seen_path "$1" "$2")" 2>/dev/null)" = "$(cat "$2")" ]; }`,
      ].join("\n"));
      writeFileSync(join(bin, "fm-classify-lib.sh"), [
        `status_declared_wait_line() { tail -n 1 "$1"; }`,
        `status_is_paused_or_captain_held() { case "$1" in paused:*|captain-held:*) return 0 ;; esac; return 1; }`,
        `status_scan_parent_channel_exclude() { :; }`,
      ].join("\n"));
    }
    setup(state, bin);
    const script = nativeWatchSourceScript({ binDirAssign: `FM_BINDIR=${bin}; FM_BUNDLED_VERIFIED=1`, fmHome: join(dir, "home"), stateDir: state });
    const res = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    const source = parseNativeWatchSource(res.stdout);
    assert.ok(source !== null, res.stdout);
    return source;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const crew = (state: string, id: string, status?: string, meta = "kind=ship\n") => {
  writeFileSync(join(state, `${id}.meta`), meta);
  if (status !== undefined) writeFileSync(join(state, `${id}.status`), status);
};

test("the native probe reports none for an empty, missing, or away-only home", () => {
  assert.equal(probe(() => {}), "none");
  assert.equal(probe((state) => rmSync(state, { recursive: true })), "none");
  assert.equal(probe((state) => writeFileSync(join(state, ".afk"), "")), "none");
  assert.equal(probe((state) => writeFileSync(join(state, ".wake-queue"), "")), "none");
});

test("the native probe names each durable wake source", () => {
  assert.equal(probe((state) => writeFileSync(join(state, ".wake-queue"), "1\t7\tsignal\tc1.status\tcrew c1 update\n")), "wake-queue");
  assert.equal(probe((state) => writeFileSync(join(state, ".bb-wake-receipt.json"), "{}")), "wake-queue");
  assert.equal(probe((state) => writeFileSync(join(state, "c1.check.sh"), "#!/bin/sh\n")), "check");
  assert.equal(probe((state) => writeFileSync(join(state, "c1.pr-poll-retirement"), "x")), "check");
  assert.equal(probe((state) => { mkdirSync(join(state, "procevent")); writeFileSync(join(state, "procevent", "lavish-1.source"), "x"); }), "process-event");
  assert.equal(probe((state) => { mkdirSync(join(state, "pending-replies")); writeFileSync(join(state, "pending-replies", "0123456789abcdef"), "x"); }), "pending-reply");
  assert.equal(probe((state) => { mkdirSync(join(state, "reconcile-notify")); writeFileSync(join(state, "reconcile-notify", "request-k.json"), "{}"); }), "reconcile-request");
  assert.equal(probe((state) => { mkdirSync(join(state, "terminal-outcomes")); writeFileSync(join(state, "terminal-outcomes", "ab12.pending"), "x"); }), "terminal-outcome");
  assert.equal(probe((state) => crew(state, "mate1", undefined, "kind=ship\nkind=secondmate\n")), "secondmate");
  assert.equal(probe((state) => { crew(state, "c1"); mkdirSync(join(state, "c1.inbox")); writeFileSync(join(state, "c1.inbox", "000001.msg"), "x"); }), "steering-inbox");
  assert.equal(probe((state) => crew(state, "c1", "paused: waiting on the owner\n")), "declared-wait");
  assert.equal(probe((state) => crew(state, "c1", "done: shipped\n")), "unsurfaced-signal");
});

test("empty directories and reported status do not keep the watcher", () => {
  assert.equal(probe((state) => {
    for (const dir of ["procevent", "pending-replies", "reconcile-notify", "terminal-outcomes"]) mkdirSync(join(state, dir));
    writeFileSync(join(state, "terminal-outcomes", "ab12.presented"), "x");
    crew(state, "c1", "done: shipped\n");
    writeFileSync(join(state, ".seen-c1_status"), "done: shipped\n");
    mkdirSync(join(state, "c1.inbox", "handled"), { recursive: true });
    writeFileSync(join(state, "c1.inbox", "handled", "000001.msg"), "x");
  }), "none");
});

test("a crew home whose native libraries cannot load fails closed", () => {
  assert.equal(probe((state) => crew(state, "c1", "done: shipped\n"), false), "unreadable");
  assert.equal(probe(() => {}, false), "none");
});

test("probe output without a known verdict is not trusted", () => {
  assert.equal(parseNativeWatchSource(""), null);
  assert.equal(parseNativeWatchSource("FM_WATCH_SOURCE=bogus\n"), null);
  assert.equal(parseNativeWatchSource("noise\nFM_WATCH_SOURCE=check\n"), "check");
});

test("the native probe reads declared waits and unreported status with the packaged runtime", () => {
  const runtime = runtimeFixture();
  try {
    const bin = join(runtime.ready(), "bin");
    const now = Math.floor(Date.now() / 1000);
    const real = (setup: (state: string) => void) => {
      const home = join(runtime.directory, `home-${Math.random().toString(36).slice(2)}`);
      const state = join(home, "state");
      mkdirSync(state, { recursive: true });
      setup(state);
      const script = nativeWatchSourceScript({ binDirAssign: `FM_BINDIR=${bin}; FM_BUNDLED_VERIFIED=1`, fmHome: home, stateDir: state });
      const res = spawnSync("bash", ["-c", script], { encoding: "utf8" });
      assert.equal(res.status, 0, res.stderr);
      return parseNativeWatchSource(res.stdout);
    };
    const markReported = (state: string, file: string) => {
      const res = spawnSync("bash", ["-c", `export FM_HOME="$1/.." FM_STATE_OVERRIDE="$1"; . "$2/fm-wake-lib.sh" && . "$2/fm-classify-lib.sh" && fm_wake_status_mark_current "$1" "$1/$3"`, "_", state, bin, file], { encoding: "utf8" });
      assert.equal(res.status, 0, res.stderr);
    };
    assert.equal(real((state) => crew(state, "c1", `working: started [at=${now - 60}]\npaused: waiting on the vendor [at=${now}]\n`)), "declared-wait");
    assert.equal(real((state) => crew(state, "c1", `done: shipped [at=${now}]\n`)), "unsurfaced-signal");
    assert.equal(real((state) => {
      crew(state, "c1", `done: shipped [at=${now}]\n`);
      markReported(state, "c1.status");
    }), "none");
    assert.equal(real(() => {}), "none");
  } finally {
    runtime.clean();
  }
});
