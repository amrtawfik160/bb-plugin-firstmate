/** Why a captain home needs (or does not need) an fm-watch keeper. */
export type WatchNeedReason =
  | "running-crew"
  | "in-flight-launch"
  | "queued-wake"
  | "captain-turn"
  | "nothing-live";

/** Log phrase for the one info line per stop or restart. */
export const WATCH_NEED_LOG: Record<WatchNeedReason, string> = {
  "running-crew": "running crew",
  "in-flight-launch": "in-flight launch",
  "queued-wake": "queued wake",
  "captain-turn": "captain turn",
  "nothing-live": "nothing live",
};

/** Launch still creating a worker. `running` is the crew thread's job. */
export const IN_FLIGHT_LAUNCH_STATES = new Set([
  "reserved",
  "creating",
  "provisioning",
  "uncertain",
]);

const RESTING_THREAD = new Set(["idle", "error"]);
const RESTING_CAPTAIN = new Set(["idle", "error"]);

export type CrewWatchInput = {
  threadId: string;
  /** Null when the thread could not be read. Fail closed: treat as live. */
  threadStatus: string | null;
  archived?: boolean;
  secondmate?: boolean;
};

export type LaunchWatchInput = {
  state: string;
};

export type CaptainWatchNeedInput = {
  captainStatus: string;
  crews: readonly CrewWatchInput[];
  launches: readonly LaunchWatchInput[];
  queuedWake: boolean;
};

function crewIsLive(crew: CrewWatchInput): boolean {
  if (crew.secondmate) return false;
  if (crew.threadId === "") return true;
  if (crew.archived) return false;
  if (crew.threadStatus === null || crew.threadStatus === "") return true;
  return !RESTING_THREAD.has(crew.threadStatus);
}

export function captainWatchNeed(input: CaptainWatchNeedInput): WatchNeedReason {
  if (input.crews.some(crewIsLive)) return "running-crew";
  if (input.launches.some((row) => IN_FLIGHT_LAUNCH_STATES.has(row.state))) return "in-flight-launch";
  if (input.queuedWake) return "queued-wake";
  if (input.captainStatus !== "" && !RESTING_CAPTAIN.has(input.captainStatus)) return "captain-turn";
  return "nothing-live";
}
