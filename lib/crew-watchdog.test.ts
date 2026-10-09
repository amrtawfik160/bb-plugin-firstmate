import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  WATCHDOG_MAX_TURNS,
  createWatchdogStore,
  emptyWatchdog,
  observeIdleTurn,
  tripWatchdog,
  watchdogNoticeText,
  watchdogTrip,
} from "./crew-watchdog.ts";

test("watchdog trips on repeated output and empty turns", () => {
  let state = emptyWatchdog("c1", "thr_c1", 0);
  for (let i = 0; i <= WATCHDOG_MAX_TURNS; i++) state = observeIdleTurn(state, "replace /foo/ with /bar/");
  assert.equal(watchdogTrip(state), "loop");
  state = emptyWatchdog("c2", "thr_c2", 0);
  for (let i = 0; i < WATCHDOG_MAX_TURNS; i++) state = observeIdleTurn(state, "");
  assert.equal(watchdogTrip(state), "turns");
});

test("new output resets the count and a long run alone never trips", () => {
  let state = emptyWatchdog("c1", "thr_c1", 0);
  for (let i = 0; i < WATCHDOG_MAX_TURNS * 3; i++) state = observeIdleTurn(state, `step ${i}`);
  assert.equal(watchdogTrip(state), null);
  for (let i = 0; i < WATCHDOG_MAX_TURNS; i++) state = observeIdleTurn(state, "");
  state = tripWatchdog(state, 50, "");
  assert.equal(state.reason, "turns");
  state = observeIdleTurn(state, "fresh progress");
  assert.equal(state.trippedAt, null);
  assert.equal(watchdogTrip(state), null);
});

test("a tripped watchdog saves state and says the crew was not stopped", () => {
  let state = emptyWatchdog("c1", "thr_c1", 0);
  for (let i = 0; i < WATCHDOG_MAX_TURNS; i++) state = observeIdleTurn(state, "");
  state = tripWatchdog(state, 50, JSON.stringify({ last: "regex round" }));
  assert.equal(state.reason, "turns");
  assert.match(state.savedState ?? "", /regex/);
  assert.match(watchdogNoticeText(state), /not stopped/);
  assert.doesNotMatch(watchdogNoticeText(state), /done|stopped crew/);
  const store = createWatchdogStore(new Database(":memory:"));
  store.save(state);
  assert.equal(store.get("c1")?.trippedAt, 50);
});
