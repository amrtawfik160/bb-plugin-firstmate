# Weekly native sync

The weekly sync moves this plugin to the latest native Firstmate
(github.com/kunchenguid/firstmate). A BB automation starts a sync crew when
upstream HEAD differs from the pin. The crew opens one PR and stops. A checker
crew on a different model checks that PR. The repair thread gets one message
with both results; it merges, reloads and switches the live home.

When every change from the pin to upstream HEAD modifies or adds a test
entrypoint (`tests/<name>.test.<ext>`) or a file under `tests/fixtures/` or
`tests/captures/`, the weekly run starts nothing. A deletion, a rename, or a
change to a test helper such as `tests/lib.sh` runs the full sync. For a
test-only move, the run tells the repair thread once for that HEAD and
records it in the state file. The pin stays, so the next other change syncs
every change since the pin. A list it cannot read runs the full sync.

This file is the sync crew's brief. It repeats what the 17 Oct sync did
([upstream update 2026-10-17](verification/upstream-update-2026-10-17.md)).
Owner decisions: Q3 (weekly sync PR, checker, repair thread merges), Q12 (the
crew resolves clashes itself), Q13 (an isolated test captain first).

## Sync crew

Use poteto mode with the refactoring playbook, and the principles
prove-it-works, fix-root-causes, attack-the-premise and
test-behavior-not-implementation. Do every step yourself. Spawn no
sub-agents. Run the full suite and the type check as
`flock /tmp/hanoon/full-suite.lock nice -n 10 ~/.bb-firstmate/bin/fm-heavy <command>`.

1. Clone native Firstmate fresh into a scratch folder outside the worktree.
   Read the target commit from your brief.
2. Re-pin with the guard, from a clean checkout of this branch:
   `FM_HOME=<live captain home> node scripts/refresh-native-pin.mjs <clone> <target>`.
   The live home is read-only for you: the guard only hashes its
   `data/captain.md`. If the guard prints `PIN REFUSED` for an owner path, a
   native copy or a host file, find the cause and fix it at the root. Never
   edit the owner layer to make the guard pass. A refusal for skill fidelity
   only leaves the branch `native-pin/<sha8>`; fix the skills that copy native
   text on that branch. The skill list comes from native's `.agents/skills`
   at the target. If the writer prints `NEW_NATIVE_SKILL <name>`, commit a
   verbatim copy `skills/<name>/SKILL.md` and its snapshot at the old pin on
   your branch, then run the guard again. Leave a native skill out only when
   the owner says so, in `EXCLUDED_NATIVE_SKILLS` in
   `scripts/vendor-native-pin.mjs`.
3. Run `npm run fidelity -- --native <clone>` and
   `FM_TEST_HOME=<clone> node scripts/patch-drift-check.mjs --ref <target>`,
   and the same drift check for every pin a live home still runs. Rebuild a
   patch hunk that no longer applies with a 3-way merge (pristine old pin,
   BB-patched old pin, pristine new pin). Keep every BB-added line.
4. Classify every upstream commit from the old pin to the target in
   `docs/verification/upstream-update-<date>.md`, one table row per commit:
   **Vendored** (comes in with the bundle or a skill copy), **Plugin change**
   (name the file you changed and why), or **Does not apply** (say why). Copy
   the shape of the 2026-10-17 file: how the pin moved, plugin code changes,
   the commit table, known gaps, verification, the live switch steps, and
   what the live captain sees after the reload. The live switch steps name
   both releases by their full 64-character release IDs (the previous one
   from `firstmate_runtime action=status`, the new one from `install`). A
   native commit is a check, never the selector.
5. Port behaviour: when a native change needs a BB change (a new script
   argument, a renamed brief rule, a new meta key), change the plugin and add
   a failing test first. Add the new pin to every audited pin list:
   `AUDITED_POLICY_COMMITS`, the legacy repair pins, the patch registry, the
   install-input lists, the test fixtures and
   `docs/verification/native-transport-allowlist.v1.json`.
6. Keep the owner layer byte-identical. `owner/`, `entry-skills/skill-routing/`,
   the captain references and every owner region of a mixed skill stay as they
   are. The guard proves it; run it again on your final head and paste its
   result in the PR.
7. Run the full suite and the type check:
   `FIRSTMATE_TEST_NATIVE=<clone> FM_TEST_HOME=<clone> flock /tmp/hanoon/full-suite.lock nice -n 10 ~/.bb-firstmate/bin/fm-heavy npm test`
   and `flock /tmp/hanoon/full-suite.lock nice -n 10 ~/.bb-firstmate/bin/fm-heavy npx tsc --noEmit`.
8. Run a canary on an isolated BB server: its own data folder, its own server
   and host-daemon ports, and its own launch id (set `BB_DATA_DIR`,
   `BB_SERVER_PORT`, `BB_SERVER_URL`, `BB_SERVER_BIND_HOST`,
   `BB_HOST_DAEMON_PORT` and `BB_SERVER_LAUNCH_ID`, and unset every other
   `BB_` variable, before each canary `bb` call). Install main there, bind a
   test captain, dispatch one crew, then install your branch. Show all three:
   1. one dispatch on the new release, with its PR;
   2. one merge with `firstmate_merge`;
   3. a runtime switch while a crew's model turn is running, with the crew's
      done line delivered after the switch.
   Use a scratch repo named `fm-canary-*`. The live server must never see a
   canary thread. Stop the isolated server when you finish.
9. Open the PR from branch `native-sync/<target sha8>` with the `pr` skill.
   The body names the commit counts per decision, the guard result, the
   tests, the canary results, and the live switch steps. Then stop: do not
   merge, reload, or switch any live home. Your final message names the PR,
   its head, the canary result and anything you could not prove.

## Checker

You check the sync PR on a model other than the sync crew's. Do not change
its branch.

1. Read the diff at the PR's head with `code-review` and `blast-radius`.
2. Check each row of the commit table against the upstream commit: is the
   decision right, and is a plugin change present where the row says so?
3. Run the guard on the PR head against a fresh clone (step 2 above). It must
   pass with no owner change.
4. Run the full suite and the fidelity and drift checks (steps 3 and 7).
5. Read the canary evidence in the PR. Say what it proves and what it does not.
6. End your final message with the findings, one per line, then one last
   line: `VERDICT: pass`, or `VERDICT: fail (<n> findings)`. Anything after
   it, or no such line, counts as a fail.

## What the automation does

`scripts/native-sync.ts` runs as two BB script automations. Each run does at
most one step and records it in a state file, so a repeated run changes
nothing.

| Automation | Schedule | Command |
| --- | --- | --- |
| Native sync (weekly) | Sunday 06:00, Africa/Cairo | `node scripts/native-sync.ts tick --start` |
| Native sync follow-up | every 30 minutes | `node scripts/native-sync.ts tick` |

The steps, in order:

1. A spawn or a message whose result is unknown (the run died between the
   call and saving its result) comes first. The run saves each result the
   moment the call returns (the thread id; the message receipt), so this
   case covers only that short window. Its operation id was saved before
   the call:
   1. A lost spawn: the run looks among the repair thread's children
      (visible, hidden and archived) created within 10 minutes after the
      intent for the title marker `[op:<id>]`. One match is adopted. Two or
      more stop the loop with a message naming them. None means the spawn
      did not happen, and it runs again with the same id.
   2. A lost message: its first line is `[native-sync <id>]`. The run reads
      the repair thread's structured log from the intent's time to the end,
      within a 3-minute budget, and looks for a user message with that exact
      line among its first 3 lines. Found: done. Searched to the end and
      not found: sent again. Search unfinished: nothing; it tries again on
      the next run.
   Limit: the marker is in an editable title. A person who renames that
   thread inside the crash window, or copies the marker into another child's
   title inside the window, can mislead this step.
2. A sync crew is still working: nothing.
3. A sync PR is open and the sync crew finished: start one checker crew
   (checker model) on the PR's branch, once per PR head. An older checker
   finishes first. When the checker finishes, send the repair thread one
   message with the PR, the checker's verdict, both crews' final messages and
   the owner card decision. Once per PR head.
4. No sync PR is open and the pin on GitHub main is upstream HEAD: nothing.
5. The last sync was for this upstream HEAD and left no open PR:
   1. its PR was closed without a merge: one message to the repair thread,
      then nothing for this HEAD;
   2. it ended without a PR: start it again, up to 2 attempts in all; after
      the last one, one message to the repair thread with its final message,
      then nothing for this HEAD.
   `tick --start --retry` starts this HEAD again after either message.
6. Otherwise, on the weekly run only: start one sync crew (builder model).

One run at a time: the run holds a kernel lock (`flock`) on
`<state file>.lock` for its whole life. A second run exits at once.

The owner gets a card only when the PR changes a file that shapes how Hanoon
talks to the owner (`OWNER_FACING_PATHS` in `owner/native-sync.ts`: the
captain skill and its references, the captain's owner rules, the Telegram
paths, and the allowlist that pins the captain's prompt). The PR's file list
decides, not words.
