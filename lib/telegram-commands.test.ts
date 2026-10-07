import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkersForTelegram } from "./telegram-commands.ts";

const crew = (id: string, task: string, status = "running", prUrl = "") => ({ id, task, status, prUrl });

test("/workers puts what waits for the owner first, then running and ready workers", () => {
  const text = formatWorkersForTelegram({
    calls: ["Merge PR #2112 (chat search)? All checks passed."],
    running: [crew("fix-a", "Fix the login redirect"), crew("fix-b", "Add dark mode")],
    ready: [crew("fix-c", "Chat search", "done", "https://github.com/o/r/pull/2112")],
    afk: true,
    quiet: false,
  });
  assert.equal(text, [
    "Waiting for you (1):\n- Merge PR #2112 (chat search)? All checks passed.",
    "Running (2):\n- Fix the login redirect (running)\n- Add dark mode (running)",
    "Ready for review (1):\n- Chat search (done) https://github.com/o/r/pull/2112",
    "Mode: away (/afk).",
  ].join("\n\n"));
});

test("/workers says so when nothing runs, and caps a long list", () => {
  assert.equal(formatWorkersForTelegram({ calls: [], running: [], ready: [], afk: false, quiet: false }), "No workers are running, and nothing is waiting for you.");
  const many = Array.from({ length: 13 }, (_, i) => crew(`w${i}`, `Task ${i}`));
  const text = formatWorkersForTelegram({ calls: [], running: many, ready: [], afk: false, quiet: false });
  assert.match(text, /^Running \(13\):/);
  assert.match(text, /- and 3 more$/);
});
