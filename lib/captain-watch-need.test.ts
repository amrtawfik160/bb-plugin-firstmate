import assert from "node:assert/strict";
import test from "node:test";
import { captainWatchNeed, WATCH_NEED_LOG, type CaptainWatchNeedInput } from "./captain-watch-need.ts";

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

test("a secondmate crew is not a keep reason", () => {
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
