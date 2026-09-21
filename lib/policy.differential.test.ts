import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldOpenDecisions, type OpenDecision } from "./policy.ts";

// ── Differential drift guard ─────────────────────────────────────────────────
// foldOpenDecisions is a hand port of fm-classify-lib.sh `status_open_decisions`.
// A port drifts silently: the TS keeps compiling, the tests keep passing, and the
// plugin quietly disagrees with the real watcher/bearings about which decisions a
// crew still has open. This guard runs OUR fold and the REAL native shell fold
// over the same crafted `.status` corpus and fails on any divergence — so the two
// cannot part ways without a red test.
//
// It drives the real script at FM_CLASSIFY_LIB (default /root/firstmate/bin/
// fm-classify-lib.sh). When that file is absent (a CI box without the native
// firstmate install) the guard SKIPS rather than failing — run it on a host that
// has native to get the proof. See CONTRIBUTING.md ("Differential drift guard").

const LIB = process.env["FM_CLASSIFY_LIB"] ?? "/root/firstmate/bin/fm-classify-lib.sh";
const HAVE_NATIVE = existsSync(LIB);

/** Drive the real shell `status_open_decisions` over a status file + explicit kind. */
function nativeFold(lines: string[], kind: string): OpenDecision[] {
  const dir = mkdtempSync(join(tmpdir(), "fmdiff-"));
  try {
    const f = join(dir, "crew.status");
    // Native reads the file line by line; a trailing newline keeps the last line
    // whole. Pass kind explicitly so no sibling .meta is needed.
    writeFileSync(f, lines.length > 0 ? lines.join("\n") + "\n" : "");
    const out = execFileSync(
      "bash",
      ["-c", '. "$1"; status_open_decisions "$2" "$3"', "_", LIB, f, kind],
      { encoding: "utf8" },
    );
    if (out === "") return [];
    return out.split("\n").map((row) => {
      const parts = row.split("\t");
      const key = parts[0] ?? "";
      const verb = (parts[1] ?? "") as OpenDecision["verb"];
      const note = parts.slice(2).join("\t");
      return { key, verb, note };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every crafted corpus a maintainer might touch. Each is run against BOTH folds
// under every kind, so a single new case protects both collapsing and
// non-collapsing behavior at once.
const CORPUS: Array<{ name: string; lines: string[] }> = [
  { name: "empty", lines: [] },
  { name: "prose + blank only", lines: ["just chatting", "", "   ", "no verb here"] },
  {
    name: "single keyed needs-decision",
    lines: ["working: go", "needs-decision [key=api]: rename or keep?"],
  },
  {
    name: "keyed resolved closes it",
    lines: ["needs-decision [key=api]: pick", "working: mid", "resolved [key=api]: chose keep"],
  },
  {
    name: "captain-held closes it",
    lines: ["blocked [key=db]: which db?", "captain-held [key=db]: I'll decide later"],
  },
  {
    name: "note-head key + no-colon closer",
    lines: ["needs-decision: [key=db] postgres or sqlite?", "resolved [key=db] we chose sqlite"],
  },
  {
    name: "corr token in the verb region",
    lines: ["blocked corr=0123456789abcdef [key=creds]: need token"],
  },
  {
    name: "reserved key wrong vocab is ignored; own vocab opens",
    lines: [
      "blocked [key=pending-reply-7]: hijack attempt",
      "blocked [key=pending-reply-8]: pending-reply-8: real owner note",
    ],
  },
  {
    name: "malformed slug is a no-op",
    lines: ["needs-decision [key=bad slug]: malformed", "needs-decision [key=ok]: fine"],
  },
  {
    name: "default (bare) key open + close",
    lines: ["needs-decision: bare question", "resolved: bare answer"],
  },
  {
    name: "multiple decisions, most-recently-opened last",
    lines: [
      "needs-decision [key=a]: first",
      "blocked [key=b]: second",
      "needs-decision [key=c]: third",
    ],
  },
  {
    name: "re-open same key updates verb/note in place",
    lines: ["needs-decision [key=a]: first ask", "blocked [key=a]: now blocked instead"],
  },
  // ── terminal-collapse cases (the ported bug) ──
  {
    name: "terminal done collapses a still-open decision",
    lines: ["needs-decision [key=x]: pick one", "working: kept going", "done: shipped part"],
  },
  {
    name: "terminal failed collapses, then a later decision re-opens",
    lines: [
      "needs-decision [key=x]: pick one",
      "failed: gave up",
      "needs-decision [key=y]: second question",
    ],
  },
  {
    name: "mid-stream done collapses several open decisions",
    lines: [
      "needs-decision [key=api-shape]: rename or keep?",
      "blocked [key=creds]: need token",
      "done: finished",
      "needs-decision: bare default question",
    ],
  },
  {
    name: "done with NO colon does not collapse (declaration guard)",
    lines: ["needs-decision [key=x]: pick one", "done [at=1790000000]"],
  },
  {
    name: "readable time tag with inner colon, note present, collapses",
    lines: ["needs-decision [key=x]: pick one", "done [at=10:30]: shipped"],
  },
  {
    name: "readable time tag, no note colon, does not collapse",
    lines: ["needs-decision [key=x]: pick one", "done [at=10:30]"],
  },
  {
    name: "readable time tag before a keyed blocked keeps key/note intact",
    lines: ["blocked [at=10:30] [key=k]: need it"],
  },
  {
    name: "epoch-stamped keyed lines fold normally",
    lines: [
      "needs-decision [at=1790000000] [key=a]: stamped ask",
      "resolved [at=1790000100] [key=a]: stamped answer",
    ],
  },
];

const KINDS = ["ship", "scout", "secondmate", "unknown"];

for (const { name, lines } of CORPUS) {
  test(`differential: ${name}`, { skip: !HAVE_NATIVE ? "native fm-classify-lib not present" : false }, () => {
    for (const kind of KINDS) {
      const ours = foldOpenDecisions(lines, kind);
      const theirs = nativeFold(lines, kind);
      assert.deepEqual(
        ours,
        theirs,
        `fold diverged from native for kind=${kind}\n  lines: ${JSON.stringify(lines)}\n  ours:   ${JSON.stringify(ours)}\n  native: ${JSON.stringify(theirs)}`,
      );
    }
  });
}
