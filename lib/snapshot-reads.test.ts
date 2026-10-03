import assert from "node:assert/strict";
import test from "node:test";
import { createSnapshotReads } from "./snapshot-reads.ts";

test("snapshot reads bound concurrency across owners and share the same owner", async () => {
  const reads = createSnapshotReads<number>({ concurrency: 2, signal: new AbortController().signal });
  const releases: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  let calls = 0;
  const build = async () => {
    const id = ++calls;
    peak = Math.max(peak, ++active);
    await new Promise<void>(resolve => releases.push(resolve));
    active--;
    return id;
  };
  const requests = [reads.read("a", build), reads.read("a", build), reads.read("b", build), reads.read("c", build)];
  await Promise.resolve();
  assert.equal(calls, 2);
  releases.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3);
  releases.splice(0).forEach(resolve => resolve());
  assert.deepEqual(await Promise.all(requests), [1, 1, 2, 3]);
  assert.equal(peak, 2);
});

test("snapshot cache expires, invalidates and never caches a failed read", async () => {
  let now = 0;
  let calls = 0;
  const reads = createSnapshotReads<number>({ concurrency: 1, signal: new AbortController().signal, now: () => now });
  const build = async () => ++calls;
  assert.equal(await reads.read("a", build, 100), 1);
  assert.equal(await reads.read("a", build, 100), 1);
  now = 101;
  assert.equal(await reads.read("a", build, 100), 2);
  reads.invalidate();
  assert.equal(await reads.read("a", build, 100), 3);
  await assert.rejects(reads.read("b", async () => { throw new Error("unavailable"); }, 100), /unavailable/);
  assert.equal(await reads.read("b", build, 100), 4);
});

test("invalidation during a snapshot prevents a stale response entering the cache", async () => {
  const reads = createSnapshotReads<number>({ concurrency: 1, signal: new AbortController().signal });
  let release!: (value: number) => void;
  const pending = reads.read("a", () => new Promise(resolve => { release = resolve; }), 1000);
  await Promise.resolve();
  reads.invalidate();
  release(1);
  assert.equal(await pending, 1);
  assert.equal(await reads.read("a", async () => 2, 1000), 2);
});

test("disposal rejects queued snapshots without starting their host work", async () => {
  const abort = new AbortController();
  const reads = createSnapshotReads<number>({ concurrency: 1, signal: abort.signal });
  let release!: () => void;
  const active = reads.read("a", () => new Promise(resolve => { release = () => resolve(1); }));
  let queuedCalls = 0;
  const queued = reads.read("b", async () => ++queuedCalls);
  await Promise.resolve();
  abort.abort();
  await Promise.all([assert.rejects(active, { name: "AbortError" }), assert.rejects(queued, { name: "AbortError" })]);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queuedCalls, 0);
});
