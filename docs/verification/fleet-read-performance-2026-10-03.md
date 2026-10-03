# Fleet read performance verification — 2026-10-03

The fleet RPC previously ran native Bearings before checking captain metadata. Eight concurrent requests could start eight native snapshots. Realtime events could also start overlapping frontend reads.

The server now checks captain metadata first, shares pending reads by owner, limits concurrent snapshots to two, and caches UI responses for 15 seconds. Fleet publications invalidate that cache. The frontend coalesces refreshes and allows one pending read per component. Disposal aborts snapshot work.

## Regression evidence

Before the server fix, the ordinary-thread RPC test observed one native invocation instead of zero. The concurrent RPC test observed eight invocations instead of one. Both tests passed after the fix.

The snapshot scheduler tests exercise owner sharing, concurrency limits, expiration, failed reads, invalidation during a pending read, and disposal. The frontend scheduler test exercises event bursts, an unresolved request, a later refresh, and disposal.

The original working checkout passed 582 tests, skipped eight tests, and failed zero tests. A clean PR checkout then passed 574 tests, skipped eight tests, and failed zero tests; the eight additional passing tests belonged to pre-existing automatic-compaction edits. Those edits were preserved and excluded from the PR. Server and frontend TypeScript checks and the plugin build passed.

## Live evidence

BB 0.44.0 on the VPS, using its authenticated loopback browser:

- Eight ordinary-thread fleet requests completed in 23 ms and returned captain=false.
- Eight simultaneous requests for an existing captain returned identical results. Sampling `/proc` observed one native Bearings process for that burst.
- The initial captain read took 11,939 ms. The repeated read took 77 ms.
- A six-second sample after deployment observed 74 concurrent Firstmate processes at peak and 59 new process IDs. The earlier sample observed 184–293 concurrent processes and 333 new process IDs over 6.3 seconds. These are separate samples, with different activity, rather than a controlled benchmark.

The first native summary remains expensive in a large captain home. Sharing and caching remove duplicate work; they preserve the canonical native snapshot and its policy. The summary stays asynchronous and does not block thread-history processing.

No thread was spawned or sent a message for these measurements.
