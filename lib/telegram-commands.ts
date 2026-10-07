/** Plain-text answers for the Telegram /workers command. The owner reads these on a phone. */
type CrewLine = { id: string; status: string; task: string; prUrl: string };

export type WorkersView = {
  calls: string[];
  ready: CrewLine[];
  running: CrewLine[];
  afk: boolean;
  quiet: boolean;
};

const MAX_ROWS = 10;

function clip(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function crewLines(rows: CrewLine[]): string[] {
  const lines = rows.slice(0, MAX_ROWS).map((row) => {
    const pr = row.prUrl ? ` ${row.prUrl}` : "";
    return `- ${clip(row.task || row.id)} (${row.status})${pr}`;
  });
  if (rows.length > MAX_ROWS) lines.push(`- and ${rows.length - MAX_ROWS} more`);
  return lines;
}

export function formatWorkersForTelegram(view: WorkersView): string {
  const sections: string[] = [];
  if (view.calls.length > 0) {
    sections.push([`Waiting for you (${view.calls.length}):`, ...view.calls.slice(0, MAX_ROWS).map((call) => `- ${clip(call, 160)}`)].join("\n"));
  }
  if (view.running.length > 0) sections.push([`Running (${view.running.length}):`, ...crewLines(view.running)].join("\n"));
  if (view.ready.length > 0) sections.push([`Ready for review (${view.ready.length}):`, ...crewLines(view.ready)].join("\n"));
  if (sections.length === 0) sections.push("No workers are running, and nothing is waiting for you.");
  const modes = [view.afk ? "away (/afk)" : "", view.quiet ? "quiet" : ""].filter(Boolean);
  if (modes.length > 0) sections.push(`Mode: ${modes.join(", ")}.`);
  return sections.join("\n\n");
}
