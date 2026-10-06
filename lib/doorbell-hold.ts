const URGENT_RE = /needs-decision|blocked|failed|failure|error|interaction|NEEDS DECISION/i;
const PLUGIN_DOORBELL_RE = /^(?:FIRSTMATE INTERNAL WAKE|🔔|🛰️\s*fm-watch:)/u;

export function isUrgentDoorbell(text: string): boolean {
  return URGENT_RE.test(text);
}

export function isPluginDoorbell(text: string): boolean {
  return PLUGIN_DOORBELL_RE.test(text.trim());
}

export function doorbellHoldDecision(input: {
  attempt: string;
  initiator: string;
  text: string;
  targetIsCaptain: boolean;
  flagOn: boolean;
  urgent?: boolean;
}): "hold" | "proceed" {
  if (!input.flagOn || !input.targetIsCaptain) return "proceed";
  if (input.attempt !== "join-turn") return "proceed";
  if (input.urgent === true || isUrgentDoorbell(input.text)) return "proceed";
  if (input.initiator === "user") return "proceed";
  if (input.initiator === "system" || input.initiator === "agent" || input.initiator === "plugin") {
    if (isPluginDoorbell(input.text) || input.initiator === "system") return "hold";
  }
  return "proceed";
}

export type HeldDoorbell = {
  captainThreadId: string;
  seq: number;
  text: string;
  crewId: string | null;
  urgent: boolean;
  createdAt: number;
};

type Database = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

export function createDoorbellHold(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS doorbell_hold (
    captain TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, crew_id TEXT, urgent INTEGER NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (captain, seq));`);
  function enqueue(row: Omit<HeldDoorbell, "seq">): HeldDoorbell {
    const last = db.prepare("SELECT max(seq) AS seq FROM doorbell_hold WHERE captain=?").get(row.captainThreadId) as { seq: number | null };
    const seq = (last.seq ?? 0) + 1;
    db.prepare("INSERT INTO doorbell_hold VALUES (?,?,?,?,?,?)").run(row.captainThreadId, seq, row.text, row.crewId, row.urgent ? 1 : 0, row.createdAt);
    return { ...row, seq };
  }
  function drain(captainThreadId: string): HeldDoorbell[] {
    const rows = db.prepare("SELECT captain, seq, text, crew_id, urgent, created_at FROM doorbell_hold WHERE captain=? ORDER BY seq").all(captainThreadId) as {
      captain: string; seq: number; text: string; crew_id: string | null; urgent: number; created_at: number;
    }[];
    db.prepare("DELETE FROM doorbell_hold WHERE captain=?").run(captainThreadId);
    return rows.map((r) => ({
      captainThreadId: r.captain,
      seq: r.seq,
      text: r.text,
      crewId: r.crew_id,
      urgent: r.urgent === 1,
      createdAt: r.created_at,
    }));
  }
  function pending(captainThreadId: string): number {
    const row = db.prepare("SELECT count(*) AS n FROM doorbell_hold WHERE captain=?").get(captainThreadId) as { n: number };
    return row.n;
  }
  return { enqueue, drain, pending };
}
