import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  WATCHDOG_MAX_429,
  WATCHDOG_MAX_TURNS,
  createWatchdogStore,
  emptyWatchdog,
  observeIdleTurn,
  observeRateLimit,
  providerErrorIsRateLimit,
  tripWatchdog,
  watchdogNoticeText,
  watchdogTrip,
} from "./crew-watchdog.ts";

test("watchdog trips on repeated output, empty turns, and 429s", () => {
  let state = emptyWatchdog("c1", "thr_c1", 0);
  for (let i = 0; i <= WATCHDOG_MAX_TURNS; i++) state = observeIdleTurn(state, "replace /foo/ with /bar/");
  assert.equal(watchdogTrip(state, 10), "loop");
  state = emptyWatchdog("c2", "thr_c2", 0);
  for (let i = 0; i < WATCHDOG_MAX_TURNS; i++) state = observeIdleTurn(state, "");
  assert.equal(watchdogTrip(state, 10), "turns");
  state = emptyWatchdog("c3", "thr_c3", 0);
  for (let i = 0; i < WATCHDOG_MAX_429; i++) state = observeRateLimit(state);
  assert.equal(watchdogTrip(state, 10), "rate-limit");
});

test("new output resets the count and a long run alone never trips", () => {
  let state = emptyWatchdog("c1", "thr_c1", 0);
  for (let i = 0; i < WATCHDOG_MAX_TURNS * 3; i++) state = observeIdleTurn(state, `step ${i}`);
  assert.equal(watchdogTrip(state, 24 * 60 * 60_000), null);
  for (let i = 0; i < WATCHDOG_MAX_TURNS; i++) state = observeIdleTurn(state, "");
  state = tripWatchdog(state, 50, "");
  assert.equal(state.reason, "turns");
  state = observeIdleTurn(state, "fresh progress");
  assert.equal(state.trippedAt, null);
  assert.equal(watchdogTrip(state, 60), null);
});

test("a tripped watchdog saves state and says the crew was not stopped", () => {
  let state = emptyWatchdog("c1", "thr_c1", 0);
  state = observeRateLimit(observeRateLimit(state));
  state = tripWatchdog(state, 50, JSON.stringify({ last: "regex round" }));
  assert.equal(state.reason, "rate-limit");
  assert.match(state.savedState ?? "", /regex/);
  assert.match(watchdogNoticeText(state), /not stopped/);
  assert.doesNotMatch(watchdogNoticeText(state), /done|stopped crew/);
  const store = createWatchdogStore(new Database(":memory:"));
  store.save(state);
  assert.equal(store.get("c1")?.trippedAt, 50);
});

test("provider 429 parser matches captain-style events", () => {
  assert.equal(providerErrorIsRateLimit({ type: "provider/error", data: { errorInfo: { category: "rate-limit" } } }), true);
  assert.equal(providerErrorIsRateLimit({ type: "provider/error", data: { detail: "429 quota exceeded" } }), true);
  assert.equal(providerErrorIsRateLimit({ type: "turn/completed", data: {} }), false);
});
