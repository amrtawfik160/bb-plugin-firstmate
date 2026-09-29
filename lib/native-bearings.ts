import { z } from "zod";

const row = z.record(z.string(), z.unknown());
const rows = z.array(row);
const schema = z.object({
  schema: z.literal("fm-bearings.v1"), home: z.string(),
  in_flight: rows, decisions_open: rows, landed: rows, gates: rows, omitted: rows,
}).passthrough();

// Selection and classification belong to the native snapshot and Bearings skill.
export function nativeBearingsProjection(value: unknown, warnings: string[] = []) {
  const model = schema.parse(value);
  const field = (r: Record<string, unknown>, key: string) => typeof r[key] === "string" && r[key] !== "-" ? r[key] as string : "";
  const describe = (r: Record<string, unknown>) => [...new Set([
    field(r, "id") || field(r, "task"),
    field(r, "summary") || field(r, "what") || field(r, "name") || field(r, "title"),
    field(r, "state"), field(r, "doing"), field(r, "reason"),
    field(r, "blocked_by"), field(r, "artifact"), field(r, "url"),
  ].filter(Boolean))].join(" · ");
  const contributions = model["contributions"] == null ? {} : row.parse(model["contributions"]);
  const captain = contributions["captain"] == null ? [] : rows.parse(contributions["captain"]);
  const calls = model.decisions_open.map(describe);
  const represented = new Set(model.decisions_open.map(r => `${field(r, "owner")}\t${field(r, "key") || field(r, "id")}`));
  const urls = new Set(model.decisions_open.map(r => field(r, "url")).filter(Boolean));
  for (const r of captain) {
    const hold = field(r, "hold") || field(r, "task") || field(r, "id");
    const url = field(r, "url");
    if (represented.has(`${field(r, "owner")}\t${hold}`) || (url && urls.has(url))) continue;
    calls.push(describe(r));
    represented.add(`${field(r, "owner")}\t${hold}`);
    if (url) urls.add(url);
  }
  const number = (key: string) => typeof contributions[key] === "number" ? contributions[key] : "unverified";
  const counts = contributions["counts"] == null ? {} : row.parse(contributions["counts"]);
  const coverage = `Contributions checked ${number("checked")}/${number("known")} known; ` +
    ["captain", "fleet", "maintainer", "nobody"].map(k => `${k} ${counts[k] ?? "unverified"}`).join(", ");
  const disclosures = ["captain_omitted", "unmeasured_homes", "unmeasured", "stale_verdicts", "missing_verdicts", "unreadable_records"]
    .filter(k => typeof contributions[k] === "number" && contributions[k] !== 0)
    .map(k => `${k}: ${contributions[k]}`);
  const landed = model.landed.map(describe);
  const running = model.in_flight.map(describe);
  const secondmates = model["secondmates"] == null ? [] : rows.parse(model["secondmates"]);
  const reconcile = model["secondmate_reconcile"] == null ? [] : rows.parse(model["secondmate_reconcile"]);
  const invalid = new Map(reconcile.filter(r => ["orphan_in_flight", "unowned_current", "terminal_in_flight"].includes(field(r, "kind")))
    .map(r => [field(r, "id"), r]));
  const next = [...model.gates.map(describe),
    ...secondmates.filter(r => ["unknown", "externally_held"].includes(field(r, "state")) || invalid.has(field(r, "id"))).map(describe),
    ...[...invalid].filter(([id]) => !secondmates.some(r => field(r, "id") === id)).map(([id, r]) => `${id} · inventory repair: ${field(r, "kind")}`),
    ...warnings];
  const omitted = model.omitted.map(r => `Omitted: ${field(r, "surface")} · ${field(r, "reveal")}`);
  const section = (title: string, items: string[], empty: string, extras: string[] = []) =>
    [title, ...(items.length ? items.map(s => `• ${s}`) : [empty]), ...extras].join("\n");
  const emptyCalls = contributions["proven_clear"] === true && model.decisions_open.length === 0
    ? "Captain, nothing needs your action right now."
    : `Captain, no decision is recorded; coverage checked ${number("checked")}/${number("known")} known is unverified.`;
  const text = [
    section("Captain's Call", calls, emptyCalls, [coverage, ...disclosures, ...(calls.length ? ["Captain, these calls need your action."] : [])]),
    section("Recently Landed", landed, "No recent completions are in the current baseline."),
    section("Underway", running, "Nothing is underway."),
    section("Charted Next", next, "Nothing is queued.", omitted),
  ].join("\n\n");
  return { model, text, calls, landed, next };
}
