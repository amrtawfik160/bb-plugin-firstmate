# Supervisor efficiency validation

Base: `5357fde`. Native/skills/overlay target: `b42d4fa8`.

The changes address recorded false alarms and repeated reconciliation. They do
not establish a measured fleet-wide token-saving percentage.

| Path | Before | After | Measured or expected effect |
| --- | --- | --- | --- |
| Healthy tool work | Last assistant message could remain unchanged; native busy bound also ignored capture churn | Actual event sequence changes capture and recorded event time updates native progress | Live healthy work survives accelerated busy and wedge bounds; a silent active tool still trips the watcher |
| Running crew steer | Classified as a pending composer draft; native send skipped it | No terminal draft; accepted sent/queued receipt checked, queued inbox ring reused | Live steering accepted; repeated ring keeps one accepted queue row |
| Two routine plugin reports inside one batch window | Two supervisor inputs | One durable grouped input after 1.5s | Test: 2 → 1 inputs, 50% for this specific burst; decisions/failures bypass delay |
| Read → action → acknowledgement | Three model tool calls with separate ack | Read → final action carrying handledWake | 3 → 2 model tool calls, 33% for this workflow; host journal operations add latency inside the action |
| Prior ack=true convenience | Acknowledged before the model handled anything | Recoverable read, completion only after handling | Improves durability. No-action batches need a completion call; this path can cost more than unsafe early ack |
| Secondmate scope miss | Sole/newest project-eligible mate accepted unrelated work | No meaningful scope overlap stays with primary | Regression tests preserve dispatch authority and avoid unrelated handoffs |

## Recorded baseline

Exported histories were analyzed with `scripts/supervisor-benchmark.mjs` using the
last usage record per covered turn. Coverage is partial. Wake-only turns may
still be necessary. Counts include cached processed context; these are not dollar
savings and cumulative provider totals are never added together.

| Captain | Usage-covered turns | Processed tokens | Wake-only share |
| --- | ---: | ---: | ---: |
| Cyndra h4t9jt3w5k | 91 | 48,901,439 | 11.45% |
| Cyndra 4e7xd2z94s | 70 | 54,850,451 | 8.81% |
| Safi v7ehre4ak5 | 57 | 116,497,119 | 22.00% |

## Context-budget experiment

The 200,000 default remains until a smaller budget passes a controlled quality
comparison. The existing `captainCompactAtTokens` setting supports a 120,000-token
trial without changing provider/model or adding supervisors. Use matched task
batches at 200k and 120k; record cache reads/writes, uncached input, output,
compaction latency, missed decisions, duplicated work, review findings and handoff
latency. Reducing a comparable 190k input to 120k is a modeled 36.8% reduction,
not an observed saving. Compaction cost and lost-context re-reads must be included.

```sh
bb thread log <captain-id> --json > /tmp/captain-window.json
node scripts/supervisor-benchmark.mjs /tmp/captain-window.json
```

Use only equivalent time/task windows. Derive fleet savings by weighting measured
captain savings by the captain share of fleet usage; do not add overlapping
percentages. A production comparison begins after deployment and deliberate
contract refresh, not while old sessions retain earlier instructions.

## Remaining SDK boundaries

BB core completion messages bypass the plugin dispatch hook. This change batches
plugin-owned durable wakes only. Full notification ownership, event identity and
provider-independent lifecycle gating require BB SDK support; see
[native parity](../native-parity.md). The opt-in native supervision host stays off.
