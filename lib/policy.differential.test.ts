import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyMetaKind, foldOpenDecisions, type OpenDecision } from "./policy.ts";

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
  // ── MUT-E shape: a done|failed line whose key MATCHES an open decision. Under a
  // collapsing kind the collapse wins; under a NON-collapsing kind the terminal is
  // a plain no-op and MUST NOT drop the matching decision via the closer branch.
  // (Removing the `verb === done|failed → continue` no-op reddens these.)
  {
    name: "MUT-E: keyed done matching an open decision (no-op under non-collapsing kind)",
    lines: ["needs-decision [key=a]: q", "done [key=a]: x"],
  },
  {
    name: "MUT-E: bare done matching a default decision",
    lines: ["needs-decision: q", "done: x"],
  },
  {
    name: "MUT-E: keyed failed matching an open blocked",
    lines: ["blocked [key=a]: q", "failed [key=a]: x"],
  },
  {
    name: "MUT-E: keyed done matching one of several open decisions",
    lines: ["needs-decision [key=a]: first", "blocked [key=b]: second", "failed [key=a]: bail"],
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

// ── kind resolution: classifyMetaKind vs native `_fm_status_kind` ─────────────
// The fold is only faithful if the caller passes the kind native would derive
// from the crew's `.meta`. classifyMetaKind is that pure derivation; prove it
// equals native's `_fm_status_kind` (its meta-derived branch) over crafted metas,
// including the metaless case that must classify `unknown` (non-collapsing).

/** Drive the real shell `_fm_status_kind` for a status file + a crafted (or absent) `.meta`. */
function nativeKind(meta: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "fmkind-"));
  try {
    const status = join(dir, "crew.status");
    writeFileSync(status, "working: x\n");
    if (meta !== null) writeFileSync(join(dir, "crew.meta"), meta);
    // No explicit kind arg → native reads the sibling .meta and falls back.
    return execFileSync("bash", ["-c", '. "$1"; _fm_status_kind "$2"', "_", LIB, status], {
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const META_CORPUS: Array<{ name: string; meta: string | null }> = [
  { name: "absent meta → unknown", meta: null },
  { name: "empty meta → ship (no kind=)", meta: "" },
  { name: "no kind= line → ship", meta: "id=c1\nthreadId=thr_x\n" },
  { name: "kind=ship", meta: "id=c1\nkind=ship\n" },
  { name: "kind=scout", meta: "kind=scout\n" },
  { name: "kind=secondmate", meta: "kind=secondmate\n" },
  { name: "unrecognized kind → unknown", meta: "kind=weird\n" },
  { name: "empty kind value → ship", meta: "kind=\n" },
  { name: "last kind= wins", meta: "kind=ship\nkind=scout\n" },
  { name: "no trailing newline", meta: "kind=scout" },
  { name: "CRLF keeps \\r → unknown (native read -r keeps it)", meta: "kind=ship\r\n" },
];

for (const { name, meta } of META_CORPUS) {
  test(`kind resolution: ${name}`, { skip: !HAVE_NATIVE ? "native fm-classify-lib not present" : false }, () => {
    assert.equal(
      classifyMetaKind(meta),
      nativeKind(meta),
      `classifyMetaKind diverged from native _fm_status_kind\n  meta: ${JSON.stringify(meta)}`,
    );
  });
}

// ── Loud-CI gate (do not let a native-less run look "verified") ───────────────
// The differential + kind cases SKIP without native, so a green run on a
// native-less CI proves nothing about the port. Fail loudly unless the operator
// knowingly opts out (FM_ALLOW_NO_NATIVE=1), so a plain green always means the
// port was actually checked against native.
test("drift guard must run against native (set FM_ALLOW_NO_NATIVE=1 to knowingly skip)", () => {
  if (!HAVE_NATIVE && process.env["FM_ALLOW_NO_NATIVE"] !== "1") {
    assert.fail(
      `Differential drift guard is INERT: native fm-classify-lib not found at ${LIB}. ` +
        `Run on a host with native firstmate, point FM_CLASSIFY_LIB at it, or set ` +
        `FM_ALLOW_NO_NATIVE=1 to accept an unverified port for this run.`,
    );
  }
});

// KNOWN DIVERGENCE (deliberately NOT in the corpus, so the guard stays green):
// foldOpenDecisions strips a trailing \r from each line (policy.ts, pre-existing),
// so a CRLF-terminated decision line yields note "q" (ours) vs "q\r" (native's
// `read -r`). It affects note TEXT only — never the open/close/collapse decision —
// and real host status files are LF, so impact is nil on-host. Documented in
// CONTRIBUTING.md ("known divergences"). Adding a CRLF line here would (correctly)
// fail the guard; it is recorded rather than fixed in this change.
