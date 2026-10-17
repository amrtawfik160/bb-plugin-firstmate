// Owner layer (decision Q15): each owner correction becomes a rule or skill edit. The ledger is
// data/corrections.jsonl in the captain home, one JSON event per line, append-only. The plugin
// creates it on the first write; `bb firstmate corrections` reads and writes it.

export const LEDGER_FILE = "data/corrections.jsonl";
export const CAPTAIN_FILE = "data/captain.md";
export const CAPTAIN_ARCHIVE_FILE = "data/captain.archive.md";
export const CAPTAIN_MAX_RULES = 40;

export const CORRECTION_RULE = "When the owner corrects you or says you repeated a mistake, follow firstmate_skill name=captain reference=references/corrections.md before you reply.";

export type Correction = { id: string; at: string; ref: string; words: string; fix?: { ref: string; changelog: string; at: string } };

type Event =
  | { type: "correction"; id: string; at: string; ref: string; words: string }
  | { type: "fix"; id: string; at: string; ref: string; changelog: string };

function events(text: string): Event[] {
  return text.split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
    try { return [JSON.parse(line) as Event]; } catch { return []; }
  });
}

export function readLedger(text: string): Correction[] {
  const rows = new Map<string, Correction>();
  for (const e of events(text)) {
    if (e.type === "correction" && !rows.has(e.id)) rows.set(e.id, { id: e.id, at: e.at, ref: e.ref, words: e.words });
    if (e.type === "fix" && rows.has(e.id)) rows.get(e.id)!.fix = { ref: e.ref, changelog: e.changelog, at: e.at };
  }
  return [...rows.values()];
}

const append = (text: string, event: Event) => `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${JSON.stringify(event)}\n`;

/** The same owner message ref is one correction, so a repeated add changes nothing. */
export function addCorrection(text: string, input: { ref: string; words: string; at: string }): { text: string; correction: Correction; added: boolean } {
  const rows = readLedger(text);
  const known = rows.find((c) => c.ref === input.ref);
  if (known !== undefined) return { text, correction: known, added: false };
  const id = `C${rows.reduce((max, c) => Math.max(max, Number(c.id.slice(1)) || 0), 0) + 1}`;
  const correction = { id, at: input.at, ref: input.ref, words: input.words };
  return { text: append(text, { type: "correction", ...correction }), correction, added: true };
}

export function captainRules(captainMd: string): number {
  return captainMd.split("\n").filter((line) => line.trim() !== "").length;
}

export function fixCorrection(text: string, input: { id: string; ref: string; changelog: string; at: string }, captainMd: string): string {
  if (!readLedger(text).some((c) => c.id === input.id)) throw new Error(`Unknown correction ${input.id}. See bb firstmate corrections list.`);
  if (input.ref.trim() === "") throw new Error("Pass --fix <PR url, or data/captain.md>.");
  if (input.changelog.trim() === "" || input.changelog.includes("\n")) throw new Error("Pass --changelog with one line for the owner.");
  const rules = captainRules(captainMd);
  if (rules > CAPTAIN_MAX_RULES) throw new Error(`${CAPTAIN_FILE} has ${rules} lines; the limit is ${CAPTAIN_MAX_RULES}. Move the oldest rules to ${CAPTAIN_ARCHIVE_FILE} first, then record the fix again.`);
  return append(text, { type: "fix", id: input.id, at: input.at, ref: input.ref.trim(), changelog: input.changelog.trim() });
}

export function within<T extends { at: string }>(rows: readonly T[], since: number, until: number): T[] {
  return rows.filter((row) => { const t = Date.parse(row.at); return t >= since && t < until; });
}

export function correctionBrief(c: Correction, home: string): string {
  return [
    `Owner correction ${c.id} (${c.at.slice(0, 10)}), owner message ${c.ref}:`,
    `> ${c.words.replace(/\n/g, "\n> ")}`,
    "",
    "Turn this correction into the smallest structural fix, so the mistake cannot happen again. Use pstack `correct` and `principle-encode-lessons-in-structure`.",
    "1. Find the root: the rule, skill, check or tool that let the mistake happen.",
    "2. Pick the smallest fix that holds by structure, in this order: a check or test that fails, a tool refusal, a skill edit, a captain.md rule.",
    "3. A check, tool or skill fix: open a PR with the `pr` skill.",
    `4. A captain.md rule: edit ${home}/${CAPTAIN_FILE}, one rule per line. It keeps at most ${CAPTAIN_MAX_RULES} lines: move the oldest rules to ${home}/${CAPTAIN_ARCHIVE_FILE} first.`,
    "5. End your final message with two lines:",
    "FIX: <the PR link, or data/captain.md>",
    "CHANGELOG: <one plain line for the owner, with no technical words>",
  ].join("\n");
}
