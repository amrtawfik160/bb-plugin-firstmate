import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWakeReceipt, renderWakeReceipt } from './wake-receipt.ts';

test('receipt parsing fails closed on absent, truncated, duplicate or invalid frames', () => {
  for (const text of ['', 'native exit zero', 'FM_BB_RECEIPT={', 'FM_BB_RECEIPT={}\nFM_BB_RECEIPT={}', 'FM_BB_RECEIPT={"id":"x"}']) {
    assert.throws(() => parseWakeReceipt(text));
  }
});

test('truncated and handled reports retain their required recovery instruction', () => {
  const receipt = { id: 'abc', phase: 'ready', report: 'An unresolved decision', path: '/state/report.txt', replayed: true, truncated: true };
  const parsed = parseWakeReceipt(`FM_BB_RECEIPT=${JSON.stringify(receipt)}`);
  assert.match(renderWakeReceipt(parsed), /read the full report.*before completing/);
  assert.match(renderWakeReceipt(parsed), /final successful/);
  const completed = renderWakeReceipt({ ...parsed, phase: 'handled' });
  assert.match(completed, /do not repeat the successful action/);
});
