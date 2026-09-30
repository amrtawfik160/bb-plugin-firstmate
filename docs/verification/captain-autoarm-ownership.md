# Captain autoarm ownership

Claude's asynchronous Stop hook defers to the BB watcher keeper when all three
conditions hold: the recorded PID runs this state's exact keeper script, the
plugin owner timestamp is at most 600 seconds old, and the watcher beacon is at
most 300 seconds old. These bounds match the keeper's owner TTL and native's
default watcher grace. Missing or uncertain evidence falls through to native
autoarm, which retains its own scope, session ownership, and eligibility gates.
The synchronous unread-wake and receipt guards still run.

```text
Stop autoarm
  verified healthy BB keeper -> exit silently
  otherwise -> native autoarm eligibility and supervision
```

Every native captain-hook invocation now declares `FM_SUPERVISION_MODEL=autoarm`,
matching the plugin's other native calls.

Verified on 2026-09-30:

- On a live registered captain home, the hook exited 0 without invoking native
  autoarm while the real BB keeper and watcher remained healthy.
- With isolated state containing no keeper, the actual installed native
  `fm-claude-stop-autoarm.sh` ran its eligibility gate with the autoarm model.
  Its native eligibility checks declined to arm for that isolated state. This
  proves fallback invocation, not an outage recovery or new watcher launch.
- Removing `bb_keeper_healthy && exit 0` made the regression test
  `captain autoarm defers to a healthy BB keeper and falls back during an outage`
  fail. Removing the supervision-model binding independently killed that test.
  Restoring both passed.
- `npx tsc --noEmit`, shell syntax, and `git diff --check` passed. The full test
  suite passed on the final code: 568 passed, two skipped, zero failed.
