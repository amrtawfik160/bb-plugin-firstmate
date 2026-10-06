# Firstmate verification map

This map is the maintained source for Firstmate's CLI verification. Start with the package drive, then exercise every entry point listed for the changed feature.

1. [Plugin installation](package.md) verifies discovery, enabled/running status, and native method defaults through the actual BB CLI.
2. [Bundled runtime](runtime.md) verifies generated script and sibling-link integrity before execution.
3. [Assignments and recovery](assignments.md) verifies task ownership, replacement, recovery, and guarded legacy evidence.
4. [PR follow-up](pull-requests.md) verifies independent check recovery and refusal of stale failure accounting.
5. [Role instructions](instructions.md) verifies captain/worker methods, complete skill reads, and `/pr` source handling.

Each helper invocation creates isolated services and data. Evidence belongs in a new empty directory outside the checkout. Cleanup preserves it. Read `result.json` for the exact actual and simulated boundaries. A different entry point is not verified by implication.

The browser app, real model workers, merge/deployment, and Telegram require their own acceptance. This map's drives do not operate them.
