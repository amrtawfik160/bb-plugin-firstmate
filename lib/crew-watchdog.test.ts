import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  WATCHDOG_MAX_429,
  WATCHDOG_MAX_TURNS,
  WATCHDOG_MAX_WALL_MS,
  WATCHDOG_NEAR_IDENTICAL,
  createWatchdogStore,
  emptyWatchdog,
  observeOutput,
  observeRateLimit,
  observeTurn,
  providerErrorIsRateLimit,
  tripWatchdog,
  watchdogFailText,
  watchdogTrip,
} from "./crew-watchdog.ts";

test("watchdog trips on loops and 429s", () => {
  let state = emptyWatchdog("c1", "thr_c1", 0);
  for (let i = 0; i < WATCHDOG_NEAR_IDENTICAL + 1; i++) state = observeOutput(state, "replace /foo/ with /bar/");
  assert.equal(watchdogTrip(state, 10), "loop");
  state = emptyWatchdog("c2", "thr_c2", 0);
  for (let i = 0; i < WATCHDOG_MAX_429; i++) state = observeRateLimit(state);
  assert.equal(watchdogTrip(state, 10), "rate-limit");
});

test("watchdog trips on turn count and wall clock", () => {
  let state = emptyWatchdog("c1", "thr_c1", 0);
  for (let i = 0; i < WATCHDOG_MAX_TURNS; i++) state = observeTurn(state);
  assert.equal(watchdogTrip(state, 1), "turns");
  assert.equal(watchdogTrip(emptyWatchdog("c1", "thr_c1", 0), WATCHDOG_MAX_WALL_MS), "wall-clock");
});

test("a tripped watchdog saves state and reports failed, not done", () => {
  let state = emptyWatchdog("c1", "thr_c1", 0);
  state = observeRateLimit(observeRateLimit(state));
  state = tripWatchdog(state, 50, JSON.stringify({ last: "regex round" }));
  assert.equal(state.reason, "rate-limit");
  assert.match(state.savedState ?? "", /regex/);
  assert.match(watchdogFailText(state), /failed|stopped/i);
  assert.doesNotMatch(watchdogFailText(state), /done/);
  const store = createWatchdogStore(new Database(":memory:"));
  store.save(state);
  assert.equal(store.get("c1")?.trippedAt, 50);
});

test("provider 429 parser matches captain-style events", () => {
  assert.equal(providerErrorIsRateLimit({ type: "provider/error", data: { errorInfo: { category: "rate-limit" } } }), true);
  assert.equal(providerErrorIsRateLimit({ type: "provider/error", data: { detail: "429 quota exceeded" } }), true);
  assert.equal(providerErrorIsRateLimit({ type: "turn/completed", data: {} }), false);
});
