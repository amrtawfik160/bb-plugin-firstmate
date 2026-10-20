/** Why a captain home needs (or does not need) an fm-watch keeper. */
export type WatchNeedReason =
  | "running-crew"
  | "in-flight-launch"
  | "queued-wake"
  | "captain-turn"
  | "native-source"
  | "nothing-live";

/** Log phrase for the one info line per stop or restart. */
export const WATCH_NEED_LOG: Record<WatchNeedReason, string> = {
  "running-crew": "running crew",
  "in-flight-launch": "in-flight launch",
  "queued-wake": "queued wake",
  "captain-turn": "captain turn",
  "native-source": "native wake source",
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

/**
 * Durable records in a captain home's state dir that fm-watch turns into a wake with no new
 * plugin event. `unreadable` fails closed: the probe could not load the native libraries.
 */
export const NATIVE_WATCH_SOURCES = {
  "wake-queue": "queued wake rows",
  check: "registered check",
  "process-event": "process-event source",
  "pending-reply": "pending secondmate reply",
  "reconcile-request": "secondmate reconcile request",
  "terminal-outcome": "unreconciled terminal outcome",
  secondmate: "registered secondmate",
  "steering-inbox": "unread crew instruction",
  "declared-wait": "paused or captain-held crew",
  "unsurfaced-signal": "unreported crew status",
  unreadable: "unreadable state",
} as const;

export type NativeWatchSource = keyof typeof NATIVE_WATCH_SOURCES;

const q = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * One host command that names the first live native wake source, or `none`. Read-only.
 * `binDirAssign` must set FM_BINDIR (and FM_BUNDLED_VERIFIED for a bundled runtime).
 */
export function nativeWatchSourceScript(input: { binDirAssign: string; fmHome: string; stateDir: string }): string {
  return [
    input.binDirAssign,
    `S=${q(input.stateDir)}`,
    `[ -d "$S" ] || { echo FM_WATCH_SOURCE=none; exit 0; }`,
    `any() { for f in "$@"; do [ -e "$f" ] && return 0; done; return 1; }`,
    `src=none`,
    `if [ -s "$S/.wake-queue" ] || [ -s "$S/.bb-wake-receipt.json" ]; then src=wake-queue`,
    `elif any "$S"/*.check.sh "$S"/*.pr-poll-retirement; then src=check`,
    `elif any "$S"/procevent/*.source; then src=process-event`,
    `elif any "$S"/pending-replies/[!.]*; then src=pending-reply`,
    `elif any "$S"/reconcile-notify/request-*.json "$S"/reconcile-notify/.processing-request-*.json; then src=reconcile-request`,
    `elif any "$S"/terminal-outcomes/*.pending; then src=terminal-outcome`,
    `elif any "$S"/*.meta "$S"/*.status "$S"/*.turn-ended; then`,
    // fm-watch supervises only tasks with a .meta; their pause recheck and inbox re-ring are timers.
    `  src=$(`,
    `    for meta in "$S"/*.meta; do`,
    `      [ -e "$meta" ] || continue`,
    `      kind=$(awk -F= '$1 == "kind" { k = substr($0, 6) } END { print k }' "$meta" 2>/dev/null)`,
    `      [ "$kind" != secondmate ] || { echo secondmate; exit 0; }`,
    `      task=\${meta##*/}; task=\${task%.meta}`,
    `      ! any "$S/$task.inbox"/*.msg || { echo steering-inbox; exit 0; }`,
    `    done`,
    `    export FM_HOME=${q(input.fmHome)} FM_STATE_OVERRIDE="$S"`,
    `    lib=${q(`${input.fmHome}/bin/fm-wake-lib.sh`)}; [ "\${FM_BUNDLED_VERIFIED:-}" != 1 ] || lib="$FM_BINDIR/fm-wake-lib.sh"`,
    `    { . "$lib" && . "$(dirname "$lib")/fm-classify-lib.sh"; } >/dev/null 2>&1 || { echo unreadable; exit 0; }`,
    `    for meta in "$S"/*.meta; do`,
    `      [ -e "$meta" ] || continue`,
    `      task=\${meta##*/}; task=\${task%.meta}`,
    `      [ -f "$S/$task.status" ] || continue`,
    `      line=$(status_declared_wait_line "$S/$task.status" 2>/dev/null) || line=`,
    `      [ -z "$line" ] || ! status_is_paused_or_captain_held "$line" || { echo declared-wait; exit 0; }`,
    `    done`,
    // Same scan as fm-watch scan_signals: a status or turn-end it has not reported yet.
    `    exclude=$(status_scan_parent_channel_exclude "$S" 2>/dev/null) || exclude=`,
    `    for f in "$S"/*.status "$S"/*.turn-ended; do`,
    `      [ -e "$f" ] && [ "$f" != "$exclude" ] || continue`,
    `      sig=$(fm_wake_signal_sig "$f" 2>/dev/null) || continue`,
    `      [ -n "$sig" ] || continue`,
    `      case "$f" in`,
    `        *.status) fm_wake_signal_seen_current "$S" "$f" 2>/dev/null && continue ;;`,
    `        *) [ "$sig" = "$(cat "$(fm_wake_signal_seen_path "$S" "$f")" 2>/dev/null)" ] && continue ;;`,
    `      esac`,
    `      echo unsurfaced-signal; exit 0`,
    `    done`,
    `    echo none`,
    `  )`,
    `fi`,
    `printf 'FM_WATCH_SOURCE=%s\\n' "\${src:-unreadable}"`,
  ].join("\n");
}

/** The probe's verdict: a live source, `none`, or null when the output carries no verdict. */
export function parseNativeWatchSource(output: string): NativeWatchSource | "none" | null {
  const value = /^FM_WATCH_SOURCE=(\S+)$/m.exec(output)?.[1];
  if (value === "none") return "none";
  if (value !== undefined && Object.hasOwn(NATIVE_WATCH_SOURCES, value)) return value as NativeWatchSource;
  return null;
}

/** A live native source keeps the watcher for this long before the next host probe. */
export const NATIVE_SOURCE_REPROBE_MS = 10 * 60_000;
