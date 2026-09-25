#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Consume exported `bb thread log <id> --json` events, never cumulative thread totals.
export function analyze(events) {
  const turns = new Map(), eventIds = new Set(), calls = {};
  let context = null;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.id && eventIds.has(event.id)) continue;
    if (event.id) eventIds.add(event.id);
    if (event.type === 'thread/contextWindowUsage/updated') context = event.data?.contextWindowUsage?.usedTokens ?? context;
    const id = event.scope?.turnId;
    if (!id) continue;
    const turn = turns.get(id) ?? { tools: new Map(), usage: null, completed: false };
    turns.set(id, turn);
    if (event.type === 'turn/completed') turn.completed = true;
    if (event.type === 'thread/tokenUsage/updated') turn.usage = event.data?.tokenUsage?.last ?? null;
    const item = event.data?.item;
    if (event.type === 'item/completed' && item && !['toolCall', 'agentMessage', 'reasoning', 'contextCompaction', 'plan'].includes(item.type)) {
      turn.tools.set(item.id ?? event.id, { name: item.type });
    }
    if (event.type === 'item/completed' && item?.type === 'toolCall') {
      const name = item.tool?.match(/firstmate_[a-z_]+/)?.[0] ?? item.tool;
      if (name && name !== 'ToolSearch') turn.tools.set(item.id ?? event.id, { name, args: item.arguments });
    }
  }
  const zero = () => ({ totalTokens: 0, inputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 });
  const usage = zero(), wakeOnlyUsage = zero();
  let covered = 0, wakeOnly = 0, wakeOnlyCovered = 0, ackOnlyCalls = 0;
  for (const turn of turns.values()) {
    const tools = [...turn.tools.values()];
    const onlyWake = tools.length > 0 && tools.every(t => t.name === 'firstmate_wake');
    if (onlyWake) wakeOnly++;
    for (const tool of tools) {
      calls[tool.name] = (calls[tool.name] ?? 0) + 1;
      if (tool.name === 'firstmate_wake' && (tool.args?.ackThrough != null || tool.args?.handledWake != null)) ackOnlyCalls++;
    }
    if (!turn.usage) continue;
    covered++;
    if (onlyWake) wakeOnlyCovered++;
    for (const key of Object.keys(usage)) {
      usage[key] += turn.usage[key] ?? 0;
      if (onlyWake) wakeOnlyUsage[key] += turn.usage[key] ?? 0;
    }
  }
  return {
    completedTurns: [...turns.values()].filter(t => t.completed).length,
    usageCoveredTurns: covered, wakeOnlyTurns: wakeOnly, wakeOnlyCoveredTurns: wakeOnlyCovered,
    wakeOnlyProcessedSharePercent: usage.totalTokens ? Number((100 * wakeOnlyUsage.totalTokens / usage.totalTokens).toFixed(2)) : null,
    ackOnlyCalls, calls, latestContextTokens: context, usage, wakeOnlyUsage,
    caveat: 'Observed last usage per covered turn; coverage may be partial. Wake-only does not mean unnecessary. Processed/cache tokens are not dollar savings. Compare matched workload, provider and outcome quality; do not sum cumulative totals.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Usage: node scripts/supervisor-benchmark.mjs <bb-thread-log.json> [...]');
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(files.map(file => ({ file, ...analyze(JSON.parse(readFileSync(file, 'utf8'))) })), null, 2));
  }
}
