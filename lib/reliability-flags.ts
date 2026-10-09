export type InboundLedgerMode = "off" | "shadow" | "on";
export type FlagToggle = "off" | "on";

export type ReliabilityFlags = {
  inboundLedger: InboundLedgerMode;
  honestStatus: FlagToggle;
  handoffContract: FlagToggle;
  asyncDispatch: FlagToggle;
  telegramThreading: FlagToggle;
};

export const DEFAULT_RELIABILITY_FLAGS: ReliabilityFlags = {
  inboundLedger: "off",
  honestStatus: "off",
  handoffContract: "off",
  asyncDispatch: "off",
  telegramThreading: "off",
};

const INBOUND = new Set<InboundLedgerMode>(["off", "shadow", "on"]);
const TOGGLE = new Set<FlagToggle>(["off", "on"]);

function asToggle(value: unknown, fallback: FlagToggle): FlagToggle {
  return typeof value === "string" && TOGGLE.has(value as FlagToggle) ? (value as FlagToggle) : fallback;
}

export function parseReliabilityFlags(raw: unknown): ReliabilityFlags {
  if (raw == null || raw === "") return { ...DEFAULT_RELIABILITY_FLAGS };
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return { ...DEFAULT_RELIABILITY_FLAGS };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ...DEFAULT_RELIABILITY_FLAGS };
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_RELIABILITY_FLAGS };
  }
  const row = parsed as Record<string, unknown>;
  const inbound = row.inboundLedger;
  return {
    inboundLedger: typeof inbound === "string" && INBOUND.has(inbound as InboundLedgerMode)
      ? (inbound as InboundLedgerMode)
      : DEFAULT_RELIABILITY_FLAGS.inboundLedger,
    honestStatus: asToggle(row.honestStatus, DEFAULT_RELIABILITY_FLAGS.honestStatus),
    handoffContract: asToggle(row.handoffContract, DEFAULT_RELIABILITY_FLAGS.handoffContract),
    asyncDispatch: asToggle(row.asyncDispatch, DEFAULT_RELIABILITY_FLAGS.asyncDispatch),
    telegramThreading: asToggle(row.telegramThreading, DEFAULT_RELIABILITY_FLAGS.telegramThreading),
  };
}

export function reliabilityFlagsFromSettings(settings: { fmReliability?: unknown } | null | undefined): ReliabilityFlags {
  return parseReliabilityFlags(settings?.fmReliability);
}
