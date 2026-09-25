import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze } from './supervisor-benchmark.mjs';

test('usage counts latest per turn once despite replay and cumulative counter resets', () => {
  const event = (seq, turnId, type, data) => ({ id: `e${seq}`, seq, scope: { turnId }, type, data });
  const first = event(1, 'a', 'thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 10, cacheReadInputTokens: 8 }, total: { totalTokens: 900000 } } });
  const second = event(2, 'b', 'thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 20 }, total: { totalTokens: 20 } } });
  const call = event(3, 'a', 'item/completed', { item: { id: 'i1', type: 'toolCall', tool: 'mcp__bb__firstmate_wake', arguments: { ackThrough: 2 } } });
  const result = analyze([first, second, first, call, call]);
  assert.equal(result.usage.totalTokens, 30);
  assert.equal(result.calls.firstmate_wake, 1);
  assert.equal(result.ackOnlyCalls, 1);
  assert.equal(result.wakeOnlyProcessedSharePercent, 33.33);
});

test('mixed useful work is not classified as wake-only; missing usage stays unknown', () => {
  const events = ['firstmate_wake', 'firstmate_merge'].map((tool, seq) => ({ seq, id: `e${seq}`, scope: { turnId: 'a' }, type: 'item/completed', data: { item: { id: `i${seq}`, type: 'toolCall', tool } } }));
  const result = analyze(events);
  assert.equal(result.wakeOnlyTurns, 0);
  assert.equal(result.usageCoveredTurns, 0);
  assert.equal(result.wakeOnlyProcessedSharePercent, null);
});

test('shell and file work prevent false wake-only classification', () => {
  const events = ['toolCall', 'commandExecution', 'fileRead'].map((type, seq) => ({ seq, id: `e${seq}`, scope: { turnId: 'a' }, type: 'item/completed', data: { item: { id: `i${seq}`, type, tool: type === 'toolCall' ? 'firstmate_wake' : undefined } } }));
  assert.equal(analyze(events).wakeOnlyTurns, 0);
});
