import assert from "node:assert/strict";
import test from "node:test";
import { createFleetRefresh } from "./fleet-refresh.ts";

test("fleet refresh coalesces event bursts and waits for the running read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let calls = 0;
  let release!: () => void;
  const refresh = createFleetRefresh(async () => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
  }, 5000);
  for (let i = 0; i < 50; i++) refresh.refresh();
  t.mock.timers.tick(0);
  assert.equal(calls, 1);
  for (let i = 0; i < 50; i++) refresh.refresh();
  t.mock.timers.tick(10000);
  assert.equal(calls, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(0);
  assert.equal(calls, 2);
  release();
  await new Promise(resolve => setImmediate(resolve));
  refresh.refresh();
  refresh.dispose();
  t.mock.timers.tick(10000);
  assert.equal(calls, 2);
});
