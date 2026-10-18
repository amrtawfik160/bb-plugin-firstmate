/**
 * The connector's free-text obligations, each keyed to the captain turn that wrote it, never to the time
 * the connector read it: the connector reads a turn's events later, so its `at` is ingestion time. A ref
 * `agent:<itemId>` names the text's item; the thread's own `item/completed` event for that item carries the
 * turn id. Per turn, Firstmate records from its own tool calls whether the turn sent a typed message
 * (firstmate_reply, firstmate_ask, firstmate_alert) or resolved free texts (firstmate_free_text). It decides
 * from tool calls only, never from the text. The records are in memory: after a reload, a text from a turn
 * this load did not see is reminded as before.
 */
export type FreeTextRow = { ref: string; text: string; at: number };

/** What the captain thread's events say of each text's item: its turn and its order, and which turns ended. */
export type TurnIndex = { itemTurn: ReadonlyMap<string, { turnId: string; seq: number }>; endedTurns: ReadonlySet<string> };

type TurnFacts = { typed: boolean; resolved: boolean };

export const TYPED_MESSAGE_TOOLS: ReadonlySet<string> = new Set(["firstmate_reply", "firstmate_ask", "firstmate_alert"]);
export const FREE_TEXT_TOOL = "firstmate_free_text";
export const countsForFreeText = (tool: string): boolean => TYPED_MESSAGE_TOOLS.has(tool) || tool === FREE_TEXT_TOOL;

const TURNS_KEPT = 200;

/** Builds the index from thread event rows (any order). */
export function turnIndexFromEvents(rows: ReadonlyArray<{ seq: number | string; type: string; data?: unknown; scope?: unknown }>): TurnIndex {
  const itemTurn = new Map<string, { turnId: string; seq: number }>();
  const endedTurns = new Set<string>();
  for (const row of rows) {
    const scope = row.scope as { turnId?: unknown } | undefined;
    const turnId = typeof scope?.turnId === "string" && scope.turnId !== "" ? scope.turnId : null;
    if (turnId === null) continue;
    if (row.type === "turn/completed") endedTurns.add(turnId);
    if (row.type !== "item/completed") continue;
    const item = (row.data as { item?: { id?: unknown } } | undefined)?.item;
    if (typeof item?.id === "string" && item.id !== "") itemTurn.set(item.id, { turnId, seq: Number(row.seq) });
  }
  return { itemTurn, endedTurns };
}

export function createCaptainTurns() {
  const byCaptain = new Map<string, Map<string, TurnFacts>>();
  return {
    /** A typed message or a free-text resolve that succeeded in the captain's turn `turnId`. */
    used(captain: string, turnId: string, tool: string): void {
      if (!countsForFreeText(tool)) return;
      const turns = byCaptain.get(captain) ?? new Map<string, TurnFacts>();
      const facts = turns.get(turnId) ?? { typed: false, resolved: false };
      if (TYPED_MESSAGE_TOOLS.has(tool)) facts.typed = true;
      else facts.resolved = true;
      turns.delete(turnId);
      turns.set(turnId, facts);
      for (const old of turns.keys()) { if (turns.size <= TURNS_KEPT) break; turns.delete(old); }
      byCaptain.set(captain, turns);
    },
    /**
     * Sorts the untold free texts by the turn that wrote them. noSend: closed with no reminder, because that
     * turn sent a typed message or resolved free texts, or a later free text of the same turn exists. remind:
     * a turn's last free text when that turn did neither, and any text whose turn is not known. A text of a
     * turn that has not ended is in neither: it waits for that turn to end.
     */
    sort(captain: string, rows: readonly FreeTextRow[], index: TurnIndex): { noSend: string[]; remind: FreeTextRow[] } {
      const turns = byCaptain.get(captain);
      const noSend: string[] = [];
      const remind: FreeTextRow[] = [];
      const grouped = new Map<string, Array<{ row: FreeTextRow; seq: number }>>();
      for (const row of rows) {
        const found = row.ref.startsWith("agent:") ? index.itemTurn.get(row.ref.slice("agent:".length)) : undefined;
        if (found === undefined) { remind.push(row); continue; }
        if (!index.endedTurns.has(found.turnId)) continue;
        grouped.set(found.turnId, [...(grouped.get(found.turnId) ?? []), { row, seq: found.seq }]);
      }
      for (const [turnId, group] of grouped) {
        const ordered = [...group].sort((a, b) => a.seq - b.seq).map((entry) => entry.row);
        const facts = turns?.get(turnId);
        if (facts?.typed || facts?.resolved) { noSend.push(...ordered.map((row) => row.ref)); continue; }
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
