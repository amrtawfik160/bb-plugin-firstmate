# Automatic compaction verification

## Reproduction

The idle-event regression supplied 510,862 measured tokens in a 1,000,000-token
window. The old implementation called `threads.compact` because it exceeded the
fixed 200,000-token minimum. The regression failed with `1 !== 0` before the fix.

Live logs also showed failed attempts using multi-million-token provider totals.
A read-only context query returned 2,103,251 used tokens for a 256,000-token window,
despite marking the count as measured. That cannot establish current window
pressure. A second live query returned estimated usage.

## Behavior

Automatic compaction requires measured, finite usage within a known window,
at least 90% window usage, and the configured token minimum. A reported provider
automatic-compaction threshold leaves ownership with the provider. The current
thread must still be idle and unarchived immediately before the request.

One in-flight check is allowed per thread. The attempted measurement persists
across cooldown expiry and reload; an identical reading cannot request another
compaction. A later low-pressure reading clears that measurement. The existing
20-minute minimum interval and `0 = off` setting still apply.

## Verification on 2026-10-03

- All 13 focused compaction and abort tests passed.
- Six isolated mutations were caught: removing the capacity threshold, measured
  usage requirement, provider ownership check, persisted-reading check,
  concurrent-check guard, or current-thread-status check fails its regression.
- Type checking, plugin build, and diff whitespace checks passed.
- The actual predicate rejected both captured live contexts without issuing a
  compaction request.
- The plugin reloaded with all four services running.

The live context check is read-only. Positive compaction and concurrency behavior
were exercised through the SDK test harness, not by compacting a user's session.
This change does not change manual compaction or provider-owned compaction.
