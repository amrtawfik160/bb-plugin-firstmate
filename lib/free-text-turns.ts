/**
 * The captain's turns, as Firstmate saw them, for the connector's free-text obligations: when each turn
 * started and ended, whether it sent a typed message (firstmate_reply, firstmate_ask, firstmate_alert),
 * and whether it resolved free texts (firstmate_free_text). It decides from tool calls only, never from
 * the text. In memory: after a reload, a text from a turn it did not see is reminded as before.
 */
export type FreeTextRow = { ref: string; text: string; at: number };

type Turn = { startedAt: number; endedAt?: number; typed: boolean; resolved: boolean };

export const TYPED_MESSAGE_TOOLS: ReadonlySet<string> = new Set(["firstmate_reply", "firstmate_ask", "firstmate_alert"]);
export const FREE_TEXT_TOOL = "firstmate_free_text";

const TURNS_KEPT = 50;

export function createCaptainTurns() {
  const byCaptain = new Map<string, Turn[]>();
  const running = (captain: string): Turn | undefined => {
    const last = byCaptain.get(captain)?.at(-1);
    return last && last.endedAt === undefined ? last : undefined;
  };
  const start = (captain: string, at: number): Turn => {
    const turns = byCaptain.get(captain) ?? [];
    const turn: Turn = { startedAt: at, typed: false, resolved: false };
    turns.push(turn);
    if (turns.length > TURNS_KEPT) turns.splice(0, turns.length - TURNS_KEPT);
    byCaptain.set(captain, turns);
    return turn;
  };
  return {
    started(captain: string, at: number): void {
      const open = running(captain);
      if (open) open.endedAt = at;
      start(captain, at);
    },
    ended(captain: string, at: number): void {
      const open = running(captain);
      if (open) open.endedAt = at;
    },
    /** A tool call that succeeded in the captain's running turn. One seen without a start opens the turn there. */
    used(captain: string, tool: string, at: number): void {
      const typed = TYPED_MESSAGE_TOOLS.has(tool);
      if (!typed && tool !== FREE_TEXT_TOOL) return;
      const turn = running(captain) ?? start(captain, at);
      if (typed) turn.typed = true;
      else turn.resolved = true;
    },
    /**
     * Sorts the untold free texts. noSend: closed with no reminder, because their turn sent a typed message
     * or resolved free texts, or a later free text of the same turn exists. remind: a turn's last free text
     * when that turn did neither, and any text from a turn this load did not see. A text of the running
     * turn is in neither: it waits for that turn to end.
     */
    sort(captain: string, rows: readonly FreeTextRow[]): { noSend: string[]; remind: FreeTextRow[] } {
      const turns = byCaptain.get(captain) ?? [];
      const noSend: string[] = [];
      const remind: FreeTextRow[] = [];
      const grouped = new Map<Turn, FreeTextRow[]>();
      for (const row of rows) {
        let turn: Turn | undefined;
        for (let index = turns.length - 1; index >= 0; index--) {
          if (turns[index]!.startedAt <= row.at) { turn = turns[index]; break; }
        }
        if (turn === undefined) { remind.push(row); continue; }
        if (turn.endedAt === undefined) continue;
        grouped.set(turn, [...(grouped.get(turn) ?? []), row]);
      }
      for (const [turn, group] of grouped) {
        const ordered = [...group].sort((a, b) => a.at - b.at);
        if (turn.typed || turn.resolved) { noSend.push(...ordered.map((row) => row.ref)); continue; }
        noSend.push(...ordered.slice(0, -1).map((row) => row.ref));
        remind.push(ordered.at(-1)!);
      }
      return { noSend, remind };
    },
    forget(captain: string): void {
      byCaptain.delete(captain);
    },
  };
}
