// bb-plugin-firstmate — firstmate-style crews native to BB.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  afkShouldSend,
  bearingsText,
  capPermission,
  crewPrompt,
  decisionDue,
  hasStatusProtocol,
  looksReadOnly,
  parseOutcome,
  protocolNudgeText,
  queueGate,
  quietShouldSend,
  resolveWorktree,
  toMode,
  toPermissionMode,
  toShape,
  truncate,
  type DeliveryMode,
  type PermissionMode,
  type Shape,
} from "./lib/policy.ts";
import { rpcContract } from "./rpc.ts";

const shapeSchema = z.enum(["ship", "scout"]);
const modeSchema = z.enum(["direct-PR", "no-mistakes", "local-only"]);

const crewSchema = z.object({
  id: z.string(),
  task: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  parentThreadId: z.string().nullable(),
  providerId: z.string().nullable(),
  worktree: z.boolean(),
  shape: shapeSchema.default("ship"),
  posture: z.string().default("direct-PR"),
  createdAt: z.string(),
});
type Crew = z.infer<typeof crewSchema>;

const queueItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string().default(""),
  projectId: z.string(),
  shape: shapeSchema.default("ship"),
  mode: z.string().default(""),
  blockedBy: z.array(z.string()).default([]),
  waitUntil: z.string().nullable().default(null),
  status: z.enum(["queued", "dispatched", "done", "dropped"]).default("queued"),
  crewId: z.string().nullable().default(null),
  createdAt: z.string(),
});
type QueueItem = z.infer<typeof queueItemSchema>;

const decisionSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()).default([]),
  context: z.string().default(""),
  crewId: z.string().nullable().default(null),
  status: z.enum(["open", "answered", "deferred"]).default("open"),
  deferredUntil: z.string().nullable().default(null),
  answer: z.string().default(""),
  createdAt: z.string(),
});
type Decision = z.infer<typeof decisionSchema>;

const doneSchema = z.object({
  id: z.string(),
  task: z.string(),
  shape: shapeSchema.default("ship"),
  crewId: z.string(),
  outcome: z.string().default(""),
  pr: z.string().default(""),
  at: z.string(),
});
type DoneEntry = z.infer<typeof doneSchema>;

const postureSchema = z.object({
  mode: modeSchema.default("direct-PR"),
  yolo: z.boolean().default(false),
});
type Posture = z.infer<typeof postureSchema>;

const secondmateSchema = z.object({
  projectId: z.string(),
  threadId: z.string(),
  scope: z.string().default(""),
  createdAt: z.string(),
});
type Secondmate = z.infer<typeof secondmateSchema>;

const afkSchema = z.object({
  on: z.boolean(),
  words: z.string().default(""),
  since: z.string(),
  held: z.array(z.string()).default([]),
});
type AfkState = z.infer<typeof afkSchema>;

const CREWS_KEY = "crews";
const QUEUE_KEY = "queue";
const DECISIONS_KEY = "decisions";
const DONE_KEY = "done";
const POSTURES_KEY = "postures";
const MEM_CAPTAIN_KEY = "memory-captain";
const MEM_LEARNINGS_KEY = "memory-learnings";
const SECONDMATES_KEY = "secondmates";
const AFK_KEY = "afk";
const QUIET_KEY = "quiet";
const NUDGE_KEY = "protocol-nudges";
const MAX_CREWS = 50;
// Newest of these is "tool/file activity". Output text alone false-alarms while a crew is editing.
const TOOL_ACTIVITY_TYPES = [
  "item/toolCall/progress",
  "item/mcpToolCall/progress",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
  "item/delegation/progress",
  "item/delegation/completed",
  "turn/diff/updated",
] as const;
const MAX_QUEUE = 100;
const MAX_DECISIONS = 100;
const MAX_DONE = 10;
const MAX_TASK = 4000;
const MAX_OUTPUT = 4000;
const MAX_FANOUT = 10;
const MAX_WATCH_CREWS = 10;
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = join(PLUGIN_ROOT, "overlay");
const FM_SCRIPT = /^[a-z0-9][a-z0-9-]*$/;

type FlagValue = string | true | string[];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function ctxString(ctx: unknown, key: string): string | undefined {
  const value = asRecord(ctx)[key];
  return typeof value === "string" ? value : undefined;
}

function threadField(thread: unknown, key: string): string {
  const value = asRecord(thread)[key];
  return typeof value === "string" ? value : "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
}

const HOST_RC_MARKER = "__FM_HOST_RC";
const HOST_STDIN_READY = "__FM_HOST_STDIN_READY";
const HOST_COMMAND_MAX = 10000;

function parseHostRc(raw: string): { exitCode: number; output: string } | null {
  const text = stripAnsi(raw);
  const match = new RegExp(`(?:\\r?\\n)${HOST_RC_MARKER}:([0-9]{1,3})(?:\\r?\\n)`).exec(text);
  if (!match || match.index === undefined) return null;
  return {
    exitCode: Number(match[1]),
    output: text.slice(0, match.index) + text.slice(match.index + match[0].length),
  };
}

function wrapHostCommand(command: string, stdinBytes: number | null): string {
  const assigned = `__fm_cmd=${shQuote(command)}`;
  const run =
    stdinBytes === null
      ? '"${SHELL:-/bin/bash}" -lc "$__fm_cmd"'
      : `printf '\\n${HOST_STDIN_READY}\\n'; head -c ${stdinBytes} | "\${SHELL:-/bin/bash}" -lc "$__fm_cmd"`;
  const script = `${assigned}; set +e; ${run}; __fm_ec=$?; printf '\\n${HOST_RC_MARKER}:%s\\n' "$__fm_ec"; sleep 86400`;
  if (script.length > HOST_COMMAND_MAX) {
    throw new Error(`Host command too long (${script.length} > ${HOST_COMMAND_MAX}). Pass bulky payloads as stdin.`);
  }
  return script;
}

function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function overlayBytes(rel: string): string {
  return readFileSync(join(OVERLAY_DIR, rel)).toString("base64");
}

function normalizeFmScript(raw: string): string {
  let name = raw.trim();
  if (name.startsWith("fm-")) name = name.slice(3);
  if (name.endsWith(".sh")) name = name.slice(0, -3);
  if (!FM_SCRIPT.test(name)) throw new Error(`Bad script name '${raw}'. Use a bin/fm-*.sh stem (spawn, peek, send, watch).`);
  return name;
}

function fmTimeoutMs(script: string, overrideSec: number | undefined): number {
  if (overrideSec !== undefined && Number.isFinite(overrideSec)) {
    return Math.min(1800, Math.max(15, overrideSec)) * 1000;
  }
  return ["spawn", "watch", "supervise-daemon", "session-start", "pr-merge"].includes(script) ? 600000 : 180000;
}

function parseArgs(argv: string[]): { flags: Map<string, FlagValue>; positional: string[] } {
  const flags = new Map<string, FlagValue>();
  const positional: string[] = [];
  const push = (key: string, value: string) => {
    const cur = flags.get(key);
    if (cur === undefined) flags.set(key, value);
    else if (Array.isArray(cur)) cur.push(value);
    else if (typeof cur === "string") flags.set(key, [cur, value]);
    else flags.set(key, value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        push(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        push(key, next);
        i++;
      } else if (!flags.has(key)) {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function flagFromArgv(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === `--${name}`) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) return next;
    }
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function parseFmArgv(argv: string[]): { script?: string; args: string[]; timeoutSec?: number } {
  const skip = new Set(["timeout", "home", "machine", "path", "project"]);
  const args: string[] = [];
  let script: string | undefined;
  let timeoutSec: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json" || arg === "--help") continue;
    if (arg === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2).split("=")[0] ?? "";
      if (arg === "--timeout" || arg.startsWith("--timeout=")) {
        timeoutSec = arg === "--timeout" ? Number(argv[++i]) : Number(arg.slice("--timeout=".length));
        continue;
      }
      if (skip.has(key)) {
        if (!arg.includes("=")) i++;
        continue;
      }
      args.push(arg);
      continue;
    }
    if (script === undefined) {
      script = arg;
      continue;
    }
    args.push(arg);
  }
  return { script, args, timeoutSec };
}

function flagStr(flags: Map<string, FlagValue>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = flags.get(key);
    if (typeof value === "string" && value !== "") return value;
    if (Array.isArray(value)) {
      const first = value.find((v) => v !== "");
      if (first !== undefined) return first;
    }
  }
  return undefined;
}

function flagAll(flags: Map<string, FlagValue>, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = flags.get(key);
    if (typeof value === "string") {
      if (value !== "") out.push(value);
    } else if (Array.isArray(value)) {
      out.push(...value.filter((v) => v !== ""));
    }
  }
  return out;
}

function extractPaths(value: unknown): string[] {
  const out: string[] = [];
  const push = (entry: unknown) => {
    const rec = asRecord(entry);
    const p = rec["path"] ?? rec["file"] ?? rec["filename"];
    if (typeof p === "string" && p !== "") out.push(p);
  };
  if (Array.isArray(value)) {
    value.forEach(push);
  } else {
    const rec = asRecord(value);
    const files = rec["files"];
    if (Array.isArray(files)) files.forEach(push);
  }
  return out;
}

interface PrFacts {
  available: boolean;
  url: string;
  number: number | null;
  title: string;
  state: string;
  attention: string;
  checksState: string;
  failed: number;
  pending: number;
  passed: number;
  mergeable: string;
}

function prFacts(value: unknown): PrFacts {
  const none: PrFacts = {
    available: false, url: "", number: null, title: "", state: "",
    attention: "", checksState: "", failed: 0, pending: 0, passed: 0, mergeable: "",
  };
  const rec = asRecord(value);
  if (rec["outcome"] === "absent" || rec["outcome"] === "unavailable") return none;
  const inner = asRecord(rec["pullRequest"] ?? value);
  if (Object.keys(inner).length === 0) return none;
  const checks = asRecord(inner["checks"]);
  const mergeability = asRecord(inner["mergeability"]);
  const num = inner["number"];
  return {
    available: true,
    url: typeof inner["url"] === "string" ? inner["url"] : "",
    number: typeof num === "number" ? num : null,
    title: typeof inner["title"] === "string" ? inner["title"] : "",
    state: typeof inner["state"] === "string" ? inner["state"] : "",
    attention: typeof inner["attention"] === "string" ? inner["attention"] : "",
    checksState: typeof checks["state"] === "string" ? checks["state"] : "unknown",
    failed: typeof checks["failedCount"] === "number" ? checks["failedCount"] : 0,
    pending: typeof checks["pendingCount"] === "number" ? checks["pendingCount"] : 0,
    passed: typeof checks["passedCount"] === "number" ? checks["passedCount"] : 0,
    mergeable: typeof mergeability["mergeable"] === "string" ? mergeability["mergeable"] : "UNKNOWN",
  };
}

function summarizePR(value: unknown): string {
  const f = prFacts(value);
  if (!f.available) return "none";
  const parts = [
    f.number !== null ? `#${f.number}` : null,
    f.title !== "" ? truncate(f.title, 60) : null,
    f.state !== "" ? `(${f.state})` : null,
    f.checksState !== "" && f.checksState !== "unknown" ? `[checks ${f.checksState}]` : null,
    f.url !== "" ? f.url : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" ") : "none";
}

const CAPTAIN_SKILLS = ["captain", "firstmate", "afk", "ahoy", "bearings", "quiet", "stow"] as const;
const CAPTAIN_TOOLS = [
  "firstmate_dispatch",
  "firstmate_deck",
  "firstmate_tell",
  "firstmate_interrupt",
  "firstmate_watch",
  "firstmate_bearings",
  "firstmate_deliver",
  "firstmate_merge",
  "firstmate_decide",
  "firstmate_crew",
  "firstmate_crews",
  "firstmate_session",
  "firstmate_stop",
  "firstmate_retry",
  "firstmate_promote",
  "firstmate_afk",
  "firstmate_quiet",
  "firstmate_queue",
  "firstmate_forget",
  "firstmate_memory",
  "firstmate_secondmate",
  "firstmate_posture",
  "firstmate_supervision",
  "firstmate_fm",
] as const;

function isSecondmateRoute(crew: Crew): boolean {
  return crew.posture.startsWith("secondmate:");
}

function threadIdOf(value: unknown): string {
  const rec = asRecord(value);
  const id = rec["id"];
  if (typeof id === "string" && id !== "") return id;
  throw new Error("spawn returned no thread id");
}

export function formatFmMeta(input: {
  id: string;
  threadId: string;
  worktree: string;
  project: string;
  kind: "ship" | "scout";
  mode?: string;
  yolo?: "on" | "off";
  model?: string;
  spawnGen?: string;
}): string {
  const spawnGen =
    input.spawnGen ?? `s${Math.floor(Date.now() / 1000)}.${process.pid}.${Math.floor(Math.random() * 10000)}`;
  const lines = [
    `window=${input.threadId}`,
    `endpoint_task_id=${input.id}`,
    `worktree=${input.worktree}`,
    `project=${input.project}`,
    "harness=bb",
    `kind=${input.kind}`,
  ];
  if (input.kind === "ship" && input.mode !== undefined && input.mode !== "") {
    lines.push(`mode=${input.mode}`);
  }
  if (input.kind === "ship" && input.yolo !== undefined) {
    lines.push(`yolo=${input.yolo}`);
  }
  lines.push(`tasktmp=/tmp/fm-${input.id}`);
  lines.push(`model=${input.model ?? "default"}`);
  lines.push("effort=default");
  lines.push(`spawn_gen=${spawnGen}`);
  lines.push("backend=bb");
  lines.push(`bb_thread_id=${input.threadId}`);
  return `${lines.join("\n")}\n`;
}

function metaFlag(meta: Record<string, unknown>, key: string): boolean {
  const value = meta[key];
  return value === true || value === "true";
}

function looksLikeCaptainPrompt(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim().toLowerCase();
  return (
    t === "/captain" ||
    t === "captain" ||
    t === "/skill:captain" ||
    t.startsWith("/captain ") ||
    t.startsWith("/skill:captain")
  );
}

function isBlankTitle(title: unknown): boolean {
  return typeof title !== "string" || title.trim() === "";
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    firstmateRepo: {
      type: "string",
      label: "Firstmate repo URL (used by init --real)",
      default: "https://github.com/kunchenguid/firstmate",
    },
    fmHome: {
      type: "string",
      label: "Firstmate home on the host (bin/ + config/). Set by init --real.",
      default: "",
    },
    defaultProvider: {
      type: "string",
      label: "Default crew provider id (blank = BB resolves)",
      default: "",
    },
    defaultPermissionMode: {
      type: "select",
      label: "Default crew permission mode",
      options: ["resolve", "accept-edits", "auto", "full"],
      default: "resolve",
    },
    supervisionEnabled: {
      type: "boolean",
      label: "Supervise crews: ping captain on done/failed/stuck",
      default: false,
    },
    supervisionIntervalMin: {
      type: "number",
      label: "Stuck-check interval (minutes); done/fail use thread events",
      default: 5,
    },
    supervisionStuckMin: {
      type: "number",
      label: "Stuck alert after N min with no output change",
      default: 30,
    },
    nudgeEnabled: {
      type: "boolean",
      label: "Doorbell a crew that idles without DONE:/BLOCKED:/FAILED:",
      default: true,
    },
    nudgeMaxPerCrew: {
      type: "number",
      label: "Protocol nudges per crew task before NEEDS DECISION",
      default: 3,
    },
    nudgeCooldownSeconds: {
      type: "number",
      label: "Minimum seconds between protocol nudges for one crew",
      default: 60,
    },
  });

  async function readList<T>(key: string, schema: z.ZodType<T>, cap: number): Promise<T[]> {
    const raw = await bb.storage.kv.get<unknown>(key);
    if (!Array.isArray(raw)) return [];
    const out: T[] = [];
    for (const entry of raw) {
      const parsed = schema.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
    }
    return out.slice(0, cap);
  }

  async function writeCrews(crews: Crew[]): Promise<void> {
    await bb.storage.kv.set(CREWS_KEY, crews.slice(0, MAX_CREWS));
  }
  async function readCrews(): Promise<Crew[]> {
    return readList(CREWS_KEY, crewSchema, MAX_CREWS);
  }
  async function readQueue(): Promise<QueueItem[]> {
    return readList(QUEUE_KEY, queueItemSchema, MAX_QUEUE);
  }
  async function writeQueue(items: QueueItem[]): Promise<void> {
    await bb.storage.kv.set(QUEUE_KEY, items.slice(0, MAX_QUEUE));
  }
  async function readDecisions(): Promise<Decision[]> {
    return readList(DECISIONS_KEY, decisionSchema, MAX_DECISIONS);
  }
  async function writeDecisions(items: Decision[]): Promise<void> {
    await bb.storage.kv.set(DECISIONS_KEY, items.slice(0, MAX_DECISIONS));
  }
  async function readDone(): Promise<DoneEntry[]> {
    return readList(DONE_KEY, doneSchema, MAX_DONE);
  }
  async function recordDone(entry: Omit<DoneEntry, "id" | "at">): Promise<void> {
    const full: DoneEntry = { ...entry, id: randomUUID().slice(0, 8), at: new Date().toISOString() };
    await bb.storage.kv.set(DONE_KEY, [full, ...(await readDone())].slice(0, MAX_DONE));
  }
  async function readPostures(): Promise<Record<string, Posture>> {
    const raw = asRecord(await bb.storage.kv.get<unknown>(POSTURES_KEY));
    const out: Record<string, Posture> = {};
    for (const [key, value] of Object.entries(raw)) {
      const parsed = postureSchema.safeParse(value);
      if (parsed.success) out[key] = parsed.data;
    }
    return out;
  }
  async function postureOf(projectId: string): Promise<Posture> {
    const all = await readPostures();
    return all[projectId] ?? { mode: "direct-PR", yolo: false };
  }
  async function readSecondmates(): Promise<Secondmate[]> {
    return readList(SECONDMATES_KEY, secondmateSchema, 50);
  }
  async function writeSecondmates(items: Secondmate[]): Promise<void> {
    await bb.storage.kv.set(SECONDMATES_KEY, items.slice(0, 50));
  }
  async function readAfk(): Promise<AfkState | null> {
    const parsed = afkSchema.safeParse(await bb.storage.kv.get<unknown>(AFK_KEY));
    return parsed.success && parsed.data.on ? parsed.data : parsed.success ? parsed.data : null;
  }
  async function writeAfk(state: AfkState | null): Promise<void> {
    await bb.storage.kv.set(AFK_KEY, state);
  }
  async function isQuiet(): Promise<boolean> {
    return (await bb.storage.kv.get<unknown>(QUIET_KEY)) === true;
  }
  async function markQueueForCrew(crewId: string, status: "done"): Promise<void> {
    const items = await readQueue();
    let changed = false;
    for (const item of items) {
      if (item.crewId === crewId && item.status === "dispatched") {
        item.status = status;
        changed = true;
      }
    }
    if (changed) await writeQueue(items);
  }

  const watchStateSchema = z.record(
    z.string(),
    z.object({
      status: z.string(),
      hash: z.string(),
      at: z.number(),
      stuck: z.boolean(),
      activityAt: z.number().optional(),
    }),
  );
  type WatchState = z.infer<typeof watchStateSchema>;

  async function publishFleet(): Promise<void> {
    try {
      await bb.realtime.publish("fleet", { at: Date.now() });
    } catch {
      // best effort
    }
  }

  async function notifyCaptain(crew: Crew, event: string, output: string | null): Promise<void> {
    if (crew.parentThreadId === null) return;
    let kind = event;
    let prUrl = "";
    if (event === "idle") {
      const pr = await prForCrew(crew);
      if (pr.url !== "") {
        kind = "review";
        prUrl = pr.url;
      }
    }
    const afk = await readAfk();
    const quiet = await isQuiet();
    const postureEvent = kind === "needs-decision" ? "idle" : kind;
    const hold = (afk?.on === true && !afkShouldSend(postureEvent)) || (quiet && !quietShouldSend(postureEvent));
    const head =
      kind === "idle"
        ? `✅ crew ${crew.id} done`
        : kind === "review"
          ? `🔎 crew ${crew.id} ready for review`
          : kind === "needs-decision"
            ? `⚖️ crew ${crew.id} NEEDS DECISION`
            : kind === "error"
              ? `❌ crew ${crew.id} failed`
              : kind === "unknown"
                ? `❓ crew ${crew.id} gone`
                : kind === "interaction"
                  ? `✋ crew ${crew.id} needs input`
                  : `⏳ crew ${crew.id} ${kind}`;
    const lines = [`${head} [${crew.shape}] :: ${truncate(crew.task, 100)}`];
    if (prUrl !== "") lines.push(prUrl);
    const outcome = parseOutcome(output);
    if (outcome !== null) lines.push(outcome);
    else if (output !== null && output !== "") lines.push(truncate(output.replace(/\n/g, " "), 400));
    lines.push(
      kind === "error"
        ? `next: bb firstmate retry|tell|forget ${crew.id}`
        : kind === "needs-decision"
          ? `next: bb firstmate tell|stop|forget ${crew.id}`
          : kind === "idle" || kind === "review"
            ? `next: bb firstmate deliver ${crew.id}`
            : `next: bb firstmate crew ${crew.id}`,
    );
    const text = lines.join("\n").slice(0, 1500);
    if (hold && afk !== null) {
      afk.held = [...afk.held, text].slice(-20);
      await writeAfk(afk);
      return;
    }
    try {
      await bb.sdk.threads.send({
        threadId: crew.parentThreadId,
        mode: "auto",
        input: [{ type: "text", text, mentions: [] }],
      });
    } catch {
      bb.log.warn(`notify failed for crew ${crew.id}`);
    }
    await publishFleet();
  }

  async function crewStatus(crew: Crew): Promise<string> {
    try {
      const thread = await bb.sdk.threads.get({ threadId: crew.threadId });
      return threadField(thread, "status");
    } catch {
      return "unknown";
    }
  }

  async function crewOutput(crew: Crew, max = MAX_OUTPUT): Promise<string | null> {
    try {
      const result = await bb.sdk.threads.output({ threadId: crew.threadId });
      const text = asRecord(result)["output"];
      return typeof text === "string" ? truncate(text, max) : null;
    } catch {
      return null;
    }
  }

  async function threadEnv(threadId: string): Promise<string | null> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      const envId = asRecord(thread)["environmentId"];
      return typeof envId === "string" ? envId : null;
    } catch {
      return null;
    }
  }

  async function waitThreadPath(threadId: string, timeoutMs: number): Promise<string | null> {
    if (timeoutMs <= 0) return null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const envId = await threadEnv(threadId);
      if (envId !== null) {
        try {
          const env = await bb.sdk.environments.get({ environmentId: envId });
          const path = env.path;
          if (typeof path === "string" && path !== "") return path;
        } catch {
          // keep polling
        }
      }
      if (Date.now() >= deadline) return null;
      await sleep(1000);
    }
  }

  async function projectCheckoutPath(projectId: string): Promise<string | null> {
    try {
      const listed = await bb.sdk.environments.list({ projectId });
      const preferred = listed.find((e) => !e.isWorktree && e.status === "ready" && typeof e.path === "string" && e.path !== "");
      if (preferred?.path) return preferred.path;
    } catch {
      // try project sources
    }
    try {
      const project = await bb.sdk.projects.get({ projectId });
      const def = project.sources.find((s) => s.isDefault) ?? project.sources[0];
      if (def !== undefined && def.path !== "") return def.path;
    } catch {
      // none
    }
    return null;
  }

  async function publishFmMeta(input: {
    crew: Crew;
    hostId?: string;
    scheduled: boolean;
    model?: string;
  }): Promise<boolean> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return false;
    let hostId = input.hostId;
    if (hostId === undefined || hostId === "") {
      try {
        hostId = await resolveHostForProject(input.crew.projectId, input.crew.parentThreadId ?? undefined);
      } catch (error) {
        bb.log.warn(
          `fm meta skipped: no host crew=${input.crew.id} ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    }
    const worktree = input.crew.worktree && !input.scheduled
      ? ((await waitThreadPath(input.crew.threadId, 45_000)) ?? "")
      : "";
    const project = (await projectCheckoutPath(input.crew.projectId)) ?? worktree;
    const posture = await postureOf(input.crew.projectId);
    const body = formatFmMeta({
      id: input.crew.id,
      threadId: input.crew.threadId,
      worktree,
      project,
      kind: input.crew.shape,
      mode: input.crew.shape === "ship" ? input.crew.posture : undefined,
      yolo: input.crew.shape === "ship" ? (posture.yolo ? "on" : "off") : undefined,
      model: input.model,
    });
    const stateDir = `${fmHome}/state`;
    const dest = `${stateDir}/${input.crew.id}.meta`;
    const tmp = `${stateDir}/.${input.crew.id}.meta.dispatch.${process.pid}.${Date.now()}`;
    const tasktmp = `/tmp/fm-${input.crew.id}`;
    const script = [
      `mkdir -p ${shQuote(stateDir)} ${shQuote(tasktmp)}`,
      `printf '%s' ${shQuote(body)} > ${shQuote(tmp)}`,
      `mv -f ${shQuote(tmp)} ${shQuote(dest)}`,
    ].join("\n");
    try {
      const result = await runOnHost(hostId, script, 20_000);
      if (result.exitCode !== 0) {
        bb.log.warn(
          `fm meta write failed crew=${input.crew.id} exit=${result.exitCode} ${result.output.slice(0, 500)}`,
        );
        return false;
      }
      bb.log.info(`fm meta written crew=${input.crew.id} path=${dest}`);
      return true;
    } catch (error) {
      bb.log.warn(
        `fm meta write failed crew=${input.crew.id} ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async function dropFmMeta(crew: Crew): Promise<void> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return;
    let hostId: string;
    try {
      hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
    } catch {
      return;
    }
    const dest = `${fmHome}/state/${crew.id}.meta`;
    try {
      const result = await runOnHost(hostId, `rm -f ${shQuote(dest)}`, 15_000);
      if (result.exitCode !== 0) {
        bb.log.warn(`fm meta drop failed crew=${crew.id} exit=${result.exitCode}`);
      }
    } catch (error) {
      bb.log.warn(
        `fm meta drop failed crew=${crew.id} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function parentPermission(parentThreadId: string | undefined): Promise<PermissionMode | undefined> {
    if (parentThreadId === undefined) return undefined;
    try {
      const opts = await bb.sdk.threads.defaultExecutionOptions({ threadId: parentThreadId });
      return toPermissionMode(asRecord(opts)["permissionMode"]);
    } catch {
      return undefined;
    }
  }

  async function prForCrew(crew: Crew): Promise<PrFacts> {
    const envId = await threadEnv(crew.threadId);
    if (envId === null) return prFacts(null);
    try {
      return prFacts(await bb.sdk.environments.pullRequest({ environmentId: envId }));
    } catch {
      return prFacts(null);
    }
  }

  async function listCrews(): Promise<Crew[]> {
    const crews = await readCrews();
    const known = new Set(crews.map((c) => c.threadId));
    try {
      const found = await bb.sdk.threads.list({
        originPluginId: "firstmate",
        includeHidden: true,
        limit: 50,
      });
      const rows: unknown[] = Array.isArray(found)
        ? found
        : Array.isArray(asRecord(found)["threads"])
          ? (asRecord(found)["threads"] as unknown[])
          : [];
      const missing = rows
        .map((row) => ({
          threadId: asRecord(row)["id"],
          projectId: asRecord(row)["projectId"],
          parentThreadId: asRecord(row)["parentThreadId"],
        }))
        .filter(
          (r): r is { threadId: string; projectId: string; parentThreadId: unknown } =>
            typeof r.threadId === "string" && typeof r.projectId === "string" && !known.has(r.threadId),
        )
        .slice(0, 20);
      const recovered = await Promise.all(
        missing.map(async (row): Promise<Crew | null> => {
          try {
            const meta = asRecord(
              await bb.sdk.threads.getPluginMetadata({ threadId: row.threadId, pluginId: "firstmate" }),
            );
            if (!metaFlag(meta, "crew")) return null;
            const id = typeof meta["crewId"] === "string" ? meta["crewId"] : row.threadId.slice(0, 8);
            return {
              id,
              task: typeof meta["task"] === "string" ? meta["task"] : "(recovered crew)",
              projectId: row.projectId,
              threadId: row.threadId,
              parentThreadId: typeof row.parentThreadId === "string" ? row.parentThreadId : null,
              providerId: null,
              worktree: metaFlag(meta, "worktree"),
              shape: toShape(meta["shape"]),
              posture: typeof meta["posture"] === "string" ? meta["posture"] : "direct-PR",
              createdAt: "",
            };
          } catch {
            return null;
          }
        }),
      );
      let dirty = false;
      for (const crew of recovered) {
        if (crew !== null && !crews.some((c) => c.id === crew.id)) {
          crews.push(crew);
          dirty = true;
        }
      }
      if (dirty) await writeCrews(crews);
    } catch {
      // kv alone still works
    }
    return crews;
  }

  async function findCrew(id: string): Promise<Crew | undefined> {
    return (await listCrews()).find((entry) => entry.id === id);
  }

  async function findCrewByThread(threadId: string): Promise<Crew | undefined> {
    return (await listCrews()).find((entry) => entry.threadId === threadId);
  }

  function formatCrew(crew: Crew, status: string): string {
    return `${crew.id} [${status}] ${crew.shape} ${crew.threadId} ${crew.worktree ? "worktree" : "shared-env"} :: ${truncate(crew.task, 80)}`;
  }

  async function resolveHostForProject(projectId: string, parentThreadId?: string): Promise<string> {
    if (parentThreadId !== undefined) {
      const envId = await threadEnv(parentThreadId);
      if (envId !== null) {
        try {
          const env = await bb.sdk.environments.get({ environmentId: envId });
          const hostId = asRecord(env)["hostId"];
          if (typeof hostId === "string" && hostId !== "") return hostId;
        } catch {
          // fall through to project environments
        }
      }
    }
    const listed = await bb.sdk.environments.list({ projectId });
    const preferred = listed.find((e) => e.isWorktree === false && e.status === "ready" && e.hostId !== "");
    const any = listed.find((e) => e.status === "ready" && e.hostId !== "");
    const pick = preferred ?? any;
    if (pick === undefined) {
      throw new Error("No host for an isolated worktree. Run dispatch from a thread on a machine, or use --shared-env.");
    }
    return pick.hostId;
  }

  async function dispatchCrew(input: {
    task: string;
    projectId: string;
    parentThreadId?: string;
    title?: string;
    providerId?: string;
    model?: string;
    permissionMode?: PermissionMode;
    worktree: boolean;
    visible: boolean;
    shape: Shape;
    mode: DeliveryMode;
    sendAt?: number;
  }): Promise<Crew> {
    const task = input.task.trim().slice(0, MAX_TASK);
    if (task === "") throw new Error("Empty task.");
    const mates = await readSecondmates();
    const mate = mates.find((m) => m.projectId === input.projectId);
    if (mate !== undefined && mate.threadId !== input.parentThreadId) {
      await bb.sdk.threads.send({
        threadId: mate.threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            text: `Routed work from main captain.\nShape: ${input.shape}\nMode: ${input.mode}\n\n${task}\n\nDispatch a crew for this. Reply with the crew id when underway.`,
            mentions: [],
          },
        ],
      });
      const routed: Crew = {
        id: `sm-${randomUUID().slice(0, 6)}`,
        task: `[secondmate ${mate.threadId}] ${task}`,
        projectId: input.projectId,
        threadId: mate.threadId,
        parentThreadId: input.parentThreadId ?? null,
        providerId: null,
        worktree: false,
        shape: input.shape,
        posture: `secondmate:${input.mode}`,
        createdAt: new Date().toISOString(),
      };
      await writeCrews([routed, ...(await readCrews())]);
      return routed;
    }
    const crew: Crew = {
      id: randomUUID().slice(0, 8),
      task,
      projectId: input.projectId,
      threadId: "",
      parentThreadId: input.parentThreadId ?? null,
      providerId: input.providerId ?? null,
      worktree: input.worktree,
      shape: input.shape,
      posture: input.shape === "scout" ? "scout" : input.mode,
      createdAt: new Date().toISOString(),
    };
    const capped = capPermission(input.permissionMode, await parentPermission(input.parentThreadId));
    let hostId: string | undefined;
    let environment: Parameters<typeof bb.sdk.threads.spawn>[0]["environment"];
    if (input.worktree) {
      hostId = await resolveHostForProject(input.projectId, input.parentThreadId);
      environment = {
        type: "host",
        hostId,
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      };
    } else {
      environment = { type: "project-default" };
    }
    const spawned = await bb.sdk.threads.spawn({
      projectId: input.projectId,
      environment,
      prompt: crewPrompt({
        task,
        parentThreadId: input.parentThreadId,
        shape: input.shape,
        mode: input.mode,
        isolated: input.worktree,
      }),
      title: input.title ?? `Crew: ${truncate(task, 60)}`,
      parentThreadId: input.parentThreadId,
      providerId: input.providerId,
      model: input.model,
      permissionMode: capped,
      visibility: input.visible ? "visible" : "hidden",
      sendAt: input.sendAt,
      pluginMetadata: {
        crew: "true",
        crewId: crew.id,
        task: task.slice(0, 500),
        shape: input.shape,
        posture: crew.posture,
        worktree: input.worktree,
      },
    });
    crew.threadId = threadIdOf(spawned);
    await writeCrews([crew, ...(await readCrews())]);
    await publishFleet();
    const scheduled = input.sendAt !== undefined && input.sendAt > Date.now();
    await publishFmMeta({ crew, hostId, scheduled, model: input.model });
    return crew;
  }

  async function tellCrew(crew: Crew, message: string, interrupt: boolean): Promise<string> {
    if (isSecondmateRoute(crew) && interrupt) {
      throw new Error(`Crew ${crew.id} is a secondmate route — do not interrupt the domain captain thread.`);
    }
    await bb.sdk.threads.send({
      threadId: crew.threadId,
      mode: interrupt ? "steer" : "queue-if-active",
      input: [{ type: "text", text: message.slice(0, MAX_TASK), mentions: [] }],
    });
    if (interrupt) return `Interrupted crew ${crew.id}`;
    const status = await crewStatus(crew);
    return status === "active" || status === "starting" || status === "pending"
      ? `Queued for crew ${crew.id} (doorbell; not interrupting)`
      : `Told crew ${crew.id}`;
  }

  async function waitOne(crew: Crew, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const st = await crewStatus(crew);
    if (st === "idle" || st === "error" || st === "unknown") return st;
    try {
      await Promise.race([
        bb.sdk.threads.wait({ threadId: crew.threadId, status: "idle", timeoutMs, signal }),
        bb.sdk.threads.wait({ threadId: crew.threadId, status: "error", timeoutMs, signal }),
      ]);
      return await crewStatus(crew);
    } catch {
      return "timeout";
    }
  }

  async function deliverLines(crew: Crew): Promise<{ text: string; json: Record<string, unknown> }> {
    const status = await crewStatus(crew);
    const output = await crewOutput(crew, 500);
    const envId = await threadEnv(crew.threadId);
    if (envId === null) {
      return {
        json: { ...crew, status, output, env: null },
        text: `${formatCrew(crew, status)}\nNo environment yet (thread starting?).`,
      };
    }
    const [envRes, uncommittedRes, prRes] = await Promise.allSettled([
      bb.sdk.environments.get({ environmentId: envId }),
      bb.sdk.environments.diffFiles({ environmentId: envId, target: "uncommitted" }),
      bb.sdk.environments.pullRequest({ environmentId: envId }),
    ]);
    const envRec = envRes.status === "fulfilled" ? asRecord(envRes.value) : {};
    const branch = envRec["branchName"] ?? envRec["branch"] ?? envRec["name"] ?? "unknown";
    const base =
      (typeof envRec["mergeBaseBranch"] === "string" && envRec["mergeBaseBranch"]) ||
      (typeof envRec["defaultBranch"] === "string" && envRec["defaultBranch"]) ||
      (typeof envRec["baseBranch"] === "string" && envRec["baseBranch"]) ||
      null;
    let committed: string[] = [];
    if (base !== null) {
      const committedRes = await bb.sdk.environments
        .diffFiles({ environmentId: envId, target: "branch_committed", mergeBaseBranch: base })
        .catch(() => null);
      committed = committedRes === null ? [] : extractPaths(committedRes);
    }
    const uncommitted = uncommittedRes.status === "fulfilled" ? extractPaths(uncommittedRes.value) : [];
    const pr = prRes.status === "fulfilled" ? summarizePR(prRes.value) : "unknown";
    const prF = prRes.status === "fulfilled" ? prFacts(prRes.value) : prFacts(null);
    const posture = await postureOf(crew.projectId);
    const files = [...new Set([...committed, ...uncommitted])];
    const lines = [
      formatCrew(crew, status),
      `env: ${envId} branch: ${typeof branch === "string" ? branch : "unknown"}`,
      committed.length === 0
        ? "committed vs base: none"
        : `committed (${committed.length}): ${committed.slice(0, 20).join(", ")}${committed.length > 20 ? "…" : ""}`,
      uncommitted.length === 0
        ? "uncommitted: none"
        : `uncommitted (${uncommitted.length}): ${uncommitted.slice(0, 20).join(", ")}`,
      `PR: ${pr}`,
      `posture: ${crew.posture}${posture.yolo ? "+yolo" : ""} — merge: bb firstmate merge ${crew.id}${posture.yolo ? "" : " --yes"}`,
    ];
    try {
      const thread = await bb.sdk.threads.get({ threadId: crew.threadId });
      const queued = asRecord(thread)["queuedMessageCount"];
      if (typeof queued === "number" && queued > 0) {
        lines.push(`inbox: ${queued} queued message(s)`);
      }
    } catch {
      // best effort
    }
    if (pr === "none" && crew.shape === "ship" && crew.posture !== "local-only") {
      lines.push(`create: open a PR from the crew branch, or bb environment pull-request show ${envId}`);
    }
    if (output !== null) {
      const outcome = parseOutcome(output);
      lines.push(
        outcome === null ? `last words: ${truncate(output.replace(/\n/g, " "), 300)}` : `outcome: ${outcome}`,
      );
    }
    return {
      json: {
        ...crew, status, output, envId, branch, files, committed, uncommitted, pr, prUrl: prF.url,
      },
      text: lines.join("\n"),
    };
  }

  async function bearingsSnapshot(): Promise<{
    text: string;
    json: Record<string, unknown>;
    rpc: {
      head: string;
      calls: string[];
      landed: string[];
      ready: Array<{
        id: string; status: string; shape: string; posture: string;
        task: string; threadId: string; prUrl: string; worktree: boolean;
      }>;
      running: Array<{
        id: string; status: string; shape: string; posture: string;
        task: string; threadId: string; prUrl: string; worktree: boolean;
      }>;
      next: string[];
      afk: boolean;
      quiet: boolean;
      supervision: boolean;
    };
  }> {
    const crews = (await listCrews()).slice(0, 20);
    const rows = await Promise.all(
      crews.map(async (crew) => {
        const status = await crewStatus(crew);
        const pr = status === "idle" || status === "error" ? await prForCrew(crew) : prFacts(null);
        return { ...crew, status, prUrl: pr.url, prSummary: summarizePR({ pullRequest: { url: pr.url, number: pr.number, title: pr.title, state: pr.state, checks: { state: pr.checksState } } }) };
      }),
    );
    const now = Date.now();
    const decisions = await readDecisions();
    const queue = await readQueue();
    const done = await readDone();
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    const idle = count("idle");
    const active = rows.filter((r) => r.status !== "idle" && r.status !== "error").length;
    const errors = count("error");
    const due = decisions.filter((d) => decisionDue(d, now));
    const dispatchable = queue.filter((q) => q.status === "queued" && queueGate(q, queue, now) === null);
    const calls = [
      ...due.map(
        (d) =>
          `? ${d.id} :: ${truncate(d.question, 90)}${d.options.length > 0 ? ` (${d.options.join(" / ")})` : ""}${d.crewId !== null ? ` [crew ${d.crewId}]` : ""} — answer: decide answer ${d.id} -- "<answer>"`,
      ),
      ...rows
        .filter((row) => row.status === "error")
        .map((row) => `! ${formatCrew(row, row.status)} — NEEDS DECISION: turn failed (retry? tell? forget?)`),
      ...rows
        .filter((row) => row.status === "idle" && row.prUrl !== "")
        .map(
          (row) =>
            `PR ready ${row.id}: ${row.prUrl} — merge: bb firstmate merge ${row.id} --yes`,
        ),
      ...dispatchable.map(
        (q) => `○ ${q.id} [${q.shape}] :: ${truncate(q.title, 70)} — dispatchable: bb firstmate queue dispatch ${q.id}`,
      ),
    ];
    const landed = done.map(
      (d) =>
        `✓ ${truncate(d.task.split("\n")[0] ?? d.task, 80)}${d.pr !== "" ? ` — ${d.pr}` : ""}${d.outcome !== "" ? ` (${truncate(d.outcome, 60)})` : ""}`,
    );
    const readyRows = rows.filter((row) => row.status === "idle");
    const ready = readyRows.map((row) => {
      const pr = row.prUrl !== "" ? ` ${row.prUrl}` : "";
      return `• ${formatCrew(row, row.status)}${pr} — ready to review (crew/deliver)`;
    });
    const runningRows = rows.filter((row) => row.status !== "idle" && row.status !== "error");
    const running = runningRows.map((row) => `• ${formatCrew(row, row.status)} — running`);
    const next = [
      ...queue
        .filter((q) => q.status === "queued")
        .map((q) => {
          const gate = queueGate(q, queue, now);
          return `○ ${q.id} [${q.shape}] :: ${truncate(q.title, 70)}${gate !== null ? ` — ${gate}` : " — dispatchable"}`;
        }),
      ...decisions
        .filter((d) => d.status === "deferred" && !decisionDue(d, now))
        .map(
          (d) =>
            `○ deferred ${d.id} :: ${truncate(d.question, 70)}${d.deferredUntil !== null ? ` (until ${d.deferredUntil})` : ""}`,
        ),
    ];
    const text = bearingsText({
      rows: rows.map((r) => ({ id: r.id, status: r.status, shape: r.shape, task: r.task, prUrl: r.prUrl })),
      calls, landed, ready, running, next, idle, active, errors,
      decisionsDue: due.length,
      queued: queue.filter((q) => q.status === "queued").length,
    });
    const toRow = (row: (typeof rows)[number]) => ({
      id: row.id,
      status: row.status,
      shape: row.shape,
      posture: row.posture,
      task: truncate(row.task, 120),
      threadId: row.threadId,
      prUrl: row.prUrl,
      worktree: row.worktree,
    });
    const rpc = {
      head: text.split("\n")[0] ?? text,
      calls,
      landed,
      ready: readyRows.map(toRow),
      running: runningRows.map(toRow),
      next,
      afk: (await readAfk())?.on === true,
      quiet: await isQuiet(),
      supervision: (await settings.get()).supervisionEnabled === true,
    };
    return {
      text,
      json: {
        total: rows.length, idle, active, errors, crews: rows, decisionsDue: due, queue: queue.filter((q) => q.status === "queued"), done,
      },
      rpc,
    };
  }

  async function sessionDigest(): Promise<string> {
    const cap = await bb.storage.kv.get<unknown>(MEM_CAPTAIN_KEY);
    const learn = await bb.storage.kv.get<unknown>(MEM_LEARNINGS_KEY);
    const capText = typeof cap === "string" && cap !== "" ? cap : "(empty)";
    const learnText = typeof learn === "string" && learn !== "" ? learn : "(empty)";
    const afk = await readAfk();
    const snap = await bearingsSnapshot();
    return [
      "== session ==",
      `afk: ${afk?.on === true ? `on since ${afk.since}` : "off"} · quiet: ${(await isQuiet()) ? "on" : "off"}`,
      snap.text,
      "== captain prefs ==",
      capText,
      "== learnings ==",
      learnText,
    ].join("\n");
  }

  async function captainLabel(projectId: unknown): Promise<string> {
    if (typeof projectId !== "string" || projectId === "") return "Captain";
    try {
      const project = await bb.sdk.projects.get({ projectId });
      if (project.kind !== "personal" && project.name.trim() !== "") {
        return `Captain · ${project.name}`;
      }
    } catch {
      // keep generic
    }
    return "Captain";
  }

  async function isCaptainThread(threadId: string): Promise<boolean> {
    try {
      const meta = asRecord(
        await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: "firstmate" }),
      );
      return metaFlag(meta, "captain");
    } catch {
      return false;
    }
  }

  async function settleDeck(threadId: string): Promise<void> {
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { captain: "true" },
    });
    try {
      await settings.experimental_set({ supervisionEnabled: true });
    } catch {
      // settings may already be on
    }
    try {
      const thread = asRecord(await bb.sdk.threads.get({ threadId }));
      const patch: { threadId: string; title?: string; visibility?: "visible" } = { threadId };
      if (isBlankTitle(thread["title"])) {
        patch.title = await captainLabel(thread["projectId"]);
      }
      if (thread["visibility"] !== "visible") patch.visibility = "visible";
      if (patch.title !== undefined || patch.visibility !== undefined) {
        await bb.sdk.threads.update(patch);
      }
      if (thread["pinnedAt"] == null) {
        await bb.sdk.threads.pin({ threadId });
      }
    } catch (error) {
      bb.log.warn(
        `deck settle failed thread=${threadId} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function markDeck(threadId: string): Promise<void> {
    await settleDeck(threadId);
  }

  function isCaptainSpawn(thread: { title?: string | null; titleFallback?: string | null }): boolean {
    return looksLikeCaptainPrompt(thread.titleFallback) || looksLikeCaptainPrompt(thread.title);
  }

  async function mergeCrew(crew: Crew, yes: boolean): Promise<string> {
    const posture = await postureOf(crew.projectId);
    if (!posture.yolo && !yes) {
      throw new Error(
        `Needs captain's word: re-run with --yes, or set yolo (bb firstmate posture set --project ${crew.projectId} --yolo on).`,
      );
    }
    const envId = await threadEnv(crew.threadId);
    if (envId === null) throw new Error(`Crew ${crew.id} has no environment yet.`);
    if (isSecondmateRoute(crew)) {
      throw new Error(`Crew ${crew.id} is a secondmate route, not a ship to merge.`);
    }
    const local = crew.posture === "local-only" || (crew.shape === "ship" && posture.mode === "local-only");
    if (local) return mergeLocal(crew, envId);
    if (crew.posture === "no-mistakes" || posture.mode === "no-mistakes") {
      const dirty = extractPaths(
        await bb.sdk.environments.diffFiles({ environmentId: envId, target: "uncommitted" }).catch(() => null),
      );
      if (dirty.length > 0) {
        throw new Error(`no-mistakes: ${dirty.length} uncommitted file(s) remain (${dirty.slice(0, 5).join(", ")}).`);
      }
    }
    const f = prFacts(await bb.sdk.environments.pullRequest({ environmentId: envId }));
    if (!f.available) throw new Error(`No PR for crew ${crew.id}. For local-only: bb firstmate posture set --project ${crew.projectId} --mode local-only then merge.`);
    if (f.state === "merged") {
      await retireLanded(crew, "merged (already landed)", f.url);
      return `Already merged: ${f.url}\nCrew ${crew.id} retired.`;
    }
    if (f.state !== "open") throw new Error(`Refusing: PR is ${f.state}, not open.`);
    if (f.checksState !== "passing") {
      throw new Error(`Refusing: checks ${f.checksState} (passed ${f.passed}, failed ${f.failed}, pending ${f.pending}).`);
    }
    if (f.mergeable !== "MERGEABLE") throw new Error(`Refusing: PR not mergeable (${f.mergeable}).`);
    await bb.sdk.environments.mergePullRequest({ environmentId: envId, method: "merge" });
    const output = await crewOutput(crew, 300);
    await retireLanded(crew, parseOutcome(output) ?? "merged", f.url);
    return `Merged ${f.url}\nCrew ${crew.id} retired (landed).`;
  }

  async function mergeLocal(crew: Crew, envId: string): Promise<string> {
    const env = asRecord(await bb.sdk.environments.get({ environmentId: envId }));
    const branch = typeof env["branchName"] === "string" ? env["branchName"] : "";
    if (branch === "") throw new Error("Crew environment has no branch.");
    const projectId = crew.projectId;
    const listed = await bb.sdk.environments.list({ projectId });
    const main = listed.find((e) => e.isWorktree === false && e.status === "ready" && e.path);
    if (main === undefined || main.path === null) {
      throw new Error("No project checkout to fast-forward (need a non-worktree ready environment).");
    }
    const hostId = main.hostId;
    const result = await runOnHost(
      hostId,
      `git -C ${shQuote(main.path)} merge --ff-only ${shQuote(branch)}`,
      120000,
    );
    if (result.exitCode !== 0) {
      throw new Error(`local ff-only merge failed:\n${truncate(result.output, 800)}`);
    }
    await retireLanded(crew, `local ff-only ${branch} → ${main.path}`, "");
    return `Landed locally (ff-only) ${branch}\nCrew ${crew.id} retired.`;
  }

  async function retireLanded(crew: Crew, outcome: string, pr: string): Promise<void> {
    await recordDone({ task: crew.task.slice(0, 200), shape: crew.shape, crewId: crew.id, outcome, pr });
    await markQueueForCrew(crew.id, "done");
    await writeCrews((await readCrews()).filter((c) => c.id !== crew.id));
    if (!(await isCaptainThread(crew.threadId))) {
      try { await bb.sdk.threads.archive({ threadId: crew.threadId }); } catch { /* best effort */ }
      try { await bb.sdk.threads.stop({ threadId: crew.threadId }); } catch { /* best effort */ }
    }
    await publishFleet();
  }

  async function forgetCrew(id: string, stop: boolean, force: boolean): Promise<string> {
    const crews = await readCrews();
    let crew = crews.find((entry) => entry.id === id);
    if (crew === undefined) {
      const recovered = await findCrew(id);
      if (recovered === undefined) throw new Error(`No crew ${id}. Run "bb firstmate crews".`);
      if (stop && (await isCaptainThread(recovered.threadId))) {
        throw new Error(
          "Refusing to archive the captain thread. Forget the crew without --stop.",
        );
      }
      try {
        await bb.sdk.threads.updatePluginMetadata({
          threadId: recovered.threadId,
          set: { crew: "false" },
          remove: ["crewId"],
        });
      } catch {
        // metadata-only
      }
      if (stop) {
        try { await bb.sdk.threads.archive({ threadId: recovered.threadId }); } catch { /* */ }
        try { await bb.sdk.threads.stop({ threadId: recovered.threadId }); } catch { /* */ }
      }
      await dropFmMeta(recovered);
      return `Forgot crew ${id} (was metadata-only)`;
    }
    await writeCrews(crews.filter((entry) => entry.id !== id));
    if (stop && isSecondmateRoute(crew) && !force) {
      await writeCrews([crew, ...(await readCrews())]);
      throw new Error(`Refusing: ${id} is a secondmate route. Drop with forget (no --stop), or --force to also stop that thread.`);
    }
    if (stop) {
      if (await isCaptainThread(crew.threadId)) {
        await writeCrews([crew, ...(await readCrews())]);
        throw new Error(
          "Refusing to archive the captain thread. Forget the crew without --stop.",
        );
      }
      if (!force) {
        const envId = await threadEnv(crew.threadId);
        if (envId !== null) {
          const diff = await bb.sdk.environments
            .diffFiles({ environmentId: envId, target: "uncommitted" })
            .catch(() => null);
          const dirty = diff === null ? [] : extractPaths(diff);
          if (dirty.length > 0) {
            await writeCrews([crew, ...(await readCrews())]);
            throw new Error(
              `Refusing: crew ${id} has ${dirty.length} uncommitted file(s) (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? "…" : ""}). Deliver first, or re-run with --force to discard.`,
            );
          }
        }
      }
      try { await bb.sdk.threads.archive({ threadId: crew.threadId }); } catch { /* */ }
      try { await bb.sdk.threads.stop({ threadId: crew.threadId }); } catch { /* */ }
    }
    try {
      if ((await crewStatus(crew)) === "idle") {
        const out = await crewOutput(crew, 300);
        const f = await prForCrew(crew);
        await recordDone({
          task: crew.task.slice(0, 200),
          shape: crew.shape,
          crewId: crew.id,
          outcome: parseOutcome(out) ?? "",
          pr: f.url,
        });
        await markQueueForCrew(crew.id, "done");
      }
    } catch {
      // best effort
    }
    await publishFleet();
    await dropFmMeta(crew);
    return `Forgot crew ${id}`;
  }

  async function resolveHostId(machineFlag: string | undefined, ctx: unknown): Promise<string> {
    if (machineFlag !== undefined) {
      const hosts = await bb.sdk.hosts.list();
      const rows: unknown[] = Array.isArray(hosts)
        ? hosts
        : Array.isArray(asRecord(hosts)["hosts"])
          ? (asRecord(hosts)["hosts"] as unknown[])
          : [];
      const match = rows.find((h) => {
        const rec = asRecord(h);
        return rec["id"] === machineFlag || rec["name"] === machineFlag;
      });
      const id = match === undefined ? undefined : asRecord(match)["id"];
      if (typeof id !== "string") throw new Error(`No machine ${machineFlag}. See bb machine list.`);
      return id;
    }
    const threadId = asRecord(ctx)["threadId"];
    if (typeof threadId !== "string") throw new Error("No machine: pass --machine <id-or-name> (see bb machine list).");
    const envId = await threadEnv(threadId);
    if (envId === null) throw new Error("No machine: pass --machine <id-or-name>.");
    const env = await bb.sdk.environments.get({ environmentId: envId });
    const hostId = asRecord(env)["hostId"];
    if (typeof hostId !== "string") throw new Error("No machine: pass --machine <id-or-name>.");
    return hostId;
  }

  function decodeChunks(value: unknown): string {
    const chunks = asRecord(value)["chunks"];
    if (!Array.isArray(chunks)) return "";
    return chunks
      .map((c) => {
        const b64 = asRecord(c)["dataBase64"];
        if (typeof b64 !== "string") return "";
        try {
          return Buffer.from(b64, "base64").toString("utf-8");
        } catch {
          return "";
        }
      })
      .join("");
  }

  async function runOnHost(
    hostId: string,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
    stdin?: string,
  ): Promise<{ exitCode: number | null; output: string }> {
    const stdinBytes = stdin === undefined ? null : Buffer.byteLength(stdin, "utf8");
    const session = await bb.sdk.terminals.create({
      cols: 120,
      rows: 30,
      scope: { kind: "host_path", hostId, cwd: "/tmp" },
      start: { mode: "command", command: wrapHostCommand(command, stdinBytes) },
      title: "firstmate-host",
    });
    const terminalId = asRecord(session)["id"] as string;
    let nextSeq = 0;
    let output = "";
    let stdinSent = stdinBytes === null;
    const started = Date.now();
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (signal?.aborted) throw new Error("Aborted.");
        if (Date.now() >= deadline) throw new Error("Timed out waiting for host command.");
        const cur = await bb.sdk.terminals.get({ terminalId });
        const status = asRecord(cur)["status"];
        if (status === "disconnected") throw new Error("Terminal disconnected.");
        try {
          const chunk = await bb.sdk.terminals.output({
            terminalId,
            sinceSeq: nextSeq,
            tailBytes: 65536,
          });
          const rec = asRecord(chunk);
          if (typeof rec["nextSeq"] === "number") nextSeq = rec["nextSeq"];
          output += decodeChunks(chunk);
        } catch (error) {
          bb.log.debug(
            `host terminal output terminal=${terminalId} status=${status} ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (
          !stdinSent &&
          stdinBytes !== null &&
          (stripAnsi(output).includes(HOST_STDIN_READY) || Date.now() - started > 2000)
        ) {
          await bb.sdk.terminals.input({
            terminalId,
            dataBase64: Buffer.from(stdin ?? "", "utf8").toString("base64"),
          });
          stdinSent = true;
        }
        const parsed = parseHostRc(output);
        if (parsed !== null) return parsed;
        if (status === "exited") {
          const exitCode = asRecord(cur)["exitCode"];
          return { exitCode: typeof exitCode === "number" ? exitCode : 1, output: stripAnsi(output) };
        }
        await sleep(250);
      }
    } finally {
      try {
        await bb.sdk.terminals.close({ terminalId, mode: "force" });
      } catch {
        // best effort
      }
    }
  }

  async function installBbBackend(
    hostId: string,
    home: string,
    projectId: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const overlayHome = OVERLAY_DIR;
    const installer = join(overlayHome, "install-bb-backend.py");
    const localProbe = await runOnHost(
      hostId,
      `[ -f ${shQuote(installer)} ] && echo FM_OVERLAY_LOCAL || echo FM_OVERLAY_REMOTE`,
      Math.min(30000, timeoutMs),
      signal,
    );
    if (localProbe.output.includes("FM_OVERLAY_LOCAL")) {
      const result = await runOnHost(
        hostId,
        `python3 ${shQuote(installer)} --home ${shQuote(home)} --overlay ${shQuote(overlayHome)}${projectId === undefined ? "" : ` --project-id ${shQuote(projectId)}`}`,
        timeoutMs,
        signal,
      );
      if (result.exitCode !== 0) {
        throw new Error(`BB backend overlay failed:\n${truncate(result.output, 1500)}`);
      }
      return result.output;
    }
    const files: Record<string, string> = {
      "bin/backends/bb.sh": overlayBytes("bin/backends/bb.sh"),
      "docs/bb-backend.md": overlayBytes("docs/bb-backend.md"),
      "firstmate-bb-backend.patch": overlayBytes("firstmate-bb-backend.patch"),
      "firstmate-bb-teardown.patch": overlayBytes("firstmate-bb-teardown.patch"),
      "install-bb-backend.py": overlayBytes("install-bb-backend.py"),
    };
    const py = [
      "import base64, json, os, pathlib, subprocess, sys, tempfile",
      "home = pathlib.Path(sys.argv[1])",
      "project_id = sys.argv[2] if len(sys.argv) > 2 else ''",
      "files = json.loads(sys.stdin.read())",
      "overlay = pathlib.Path(tempfile.mkdtemp(prefix='fm-bb-overlay-'))",
      "for rel, b64 in files.items():",
      "    dest = overlay / rel",
      "    dest.parent.mkdir(parents=True, exist_ok=True)",
      "    dest.write_bytes(base64.b64decode(b64))",
      "os.chmod(overlay / 'bin/backends/bb.sh', 0o755)",
      "os.chmod(overlay / 'install-bb-backend.py', 0o755)",
      "cmd = [sys.executable, str(overlay / 'install-bb-backend.py'), '--home', str(home), '--overlay', str(overlay)]",
      "if project_id:",
      "    cmd += ['--project-id', project_id]",
      "raise SystemExit(subprocess.call(cmd))",
    ].join("\n");
    const command = `python3 -c ${shQuote(py)} ${shQuote(home)}${projectId === undefined ? "" : ` ${shQuote(projectId)}`}`;
    const result = await runOnHost(hostId, command, timeoutMs, signal, JSON.stringify(files));
    if (result.exitCode !== 0) {
      throw new Error(`BB backend overlay failed:\n${truncate(result.output, 1500)}`);
    }
    return result.output;
  }

  async function runFmScript(input: {
    script: string;
    args: string[];
    hostId: string;
    fmHome: string;
    projectId?: string;
    parentThreadId?: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number | null; output: string; scriptPath: string }> {
    const script = normalizeFmScript(input.script);
    const scriptPath = `${input.fmHome}/bin/fm-${script}.sh`;
    const prelude = [
      `export FM_HOME=${shQuote(input.fmHome)}`,
      `export FM_ROOT=${shQuote(input.fmHome)}`,
      "export FM_BACKEND=bb",
      input.projectId !== undefined ? `export FM_BB_PROJECT_ID=${shQuote(input.projectId)}` : "",
      input.parentThreadId !== undefined ? `export FM_BB_PARENT_THREAD_ID=${shQuote(input.parentThreadId)}` : "",
      `export FM_BB_MACHINE=${shQuote(input.hostId)}`,
      "export FM_BB_VISIBLE=1",
      `if [ ! -f ${shQuote(scriptPath)} ]; then echo "error: missing ${scriptPath}" >&2; exit 127; fi`,
      `${shQuote(scriptPath)} ${input.args.map(shQuote).join(" ")}`,
    ]
      .filter((line) => line !== "")
      .join("\n");
    const result = await runOnHost(input.hostId, prelude, input.timeoutMs, input.signal);
    return { ...result, scriptPath };
  }

  async function readToolActivity(threadId: string): Promise<{ ok: true; at: number | null } | { ok: false }> {
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        order: "desc",
        limit: "1",
        types: TOOL_ACTIVITY_TYPES,
      });
      if (!Array.isArray(rows)) return { ok: false };
      const row = rows[0];
      if (row === undefined) return { ok: true, at: null };
      const createdAt = asRecord(row)["createdAt"];
      return typeof createdAt === "number" && Number.isFinite(createdAt)
        ? { ok: true, at: createdAt }
        : { ok: false };
    } catch (error) {
      bb.log.warn(
        `stuck activity read failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false };
    }
  }

  async function stuckPass(): Promise<{ checked: number; notified: number }> {
    const current = await settings.get();
    const stuckMs = Math.min(480, Math.max(5, Number(current.supervisionStuckMin) || 30)) * 60000;
    const crews = (await listCrews()).filter((c) => c.parentThreadId !== null).slice(0, MAX_CREWS);
    const parsed = watchStateSchema.safeParse(await bb.storage.kv.get<unknown>("watch"));
    const state: WatchState = parsed.success ? parsed.data : {};
    const now = Date.now();
    const seen = new Set<string>();
    let notified = 0;
    for (const crew of crews) {
      seen.add(crew.id);
      const status = await crewStatus(crew);
      const prev = state[crew.id];
      if (prev === undefined) {
        state[crew.id] = { status, hash: "", at: now, stuck: false };
        continue;
      }
      if (status === "idle" || status === "error" || status === "unknown") {
        state[crew.id] = { status, hash: "", at: now, stuck: false };
        continue;
      }
      const excerpt = (await crewOutput(crew, 300)) ?? "";
      if (excerpt !== prev.hash) {
        state[crew.id] = { status, hash: excerpt, at: now, stuck: false };
        continue;
      }
      const activity = await readToolActivity(crew.threadId);
      if (!activity.ok) {
        state[crew.id] = { ...prev, status, hash: excerpt };
        continue;
      }
      const activityAt = activity.at ?? undefined;
      const activityStale = activityAt === undefined || now - activityAt >= stuckMs;
      if (!activityStale) {
        state[crew.id] = {
          status,
          hash: excerpt,
          at: prev.at,
          stuck: false,
          ...(activityAt !== undefined ? { activityAt } : {}),
        };
        continue;
      }
      const outMin = Math.max(0, Math.round((now - prev.at) / 60000));
      const actMin = activityAt === undefined ? outMin : Math.max(0, Math.round((now - activityAt) / 60000));
      const row = {
        status,
        hash: excerpt,
        at: prev.at,
        stuck: prev.stuck,
        ...(activityAt !== undefined ? { activityAt } : {}),
      };
      if (!prev.stuck && now - prev.at >= stuckMs) {
        await notifyCaptain(
          crew,
          `stuck (${outMin}m no output change, no tool/file activity ${actMin}m)`,
          null,
        );
        notified++;
        row.stuck = true;
      }
      state[crew.id] = row;
    }
    for (const id of Object.keys(state)) {
      if (!seen.has(id)) delete state[id];
    }
    await bb.storage.kv.set("watch", state);
    await bb.storage.kv.set("watch-meta", { lastPassAt: now, checked: crews.length, notified });
    return { checked: crews.length, notified };
  }

  function guideText(repo: string): string {
    return [
      "firstmate inside BB — two planes, one runtime:",
      "1. Native deck (plugin SDK / Fleet UI): bb firstmate deck, then dispatch/tell/watch/merge.",
      "2. Real firstmate bin/ scripts: bb firstmate init --real, then bb firstmate fm <script> …",
      "   Scripts keep policy (brief, gate, inbox, watch, merge, afk, bearings, backlog).",
      "   BB is the session backend (threads + managed-worktree), like tmux/orca — not a rewrite of bin/.",
      "Native dispatch (writes state/<id>.meta when fmHome is set, so peek/send/teardown see Fleet crews):",
      "  bb firstmate dispatch --project <proj> -- \"fix flaky login test\"",
      "Script spawn (after init --real):",
      "  bb firstmate fm spawn -- --mode direct-PR -- ship \"fix flaky login test\"",
      `Optional clone: bb firstmate init --real  (repo ${repo}; overlays backends/bb.sh, sets config/backend=bb)`,
    ].join("\n");
  }

  const usage = [
    "Usage:",
    "  bb firstmate guide [--json]",
    "  bb firstmate init [--real] [--machine m] [--path p] [--name n] [--json]",
    "  bb firstmate fm [--timeout s] <script> [args...]   # real bin/fm-<script>.sh with FM_BACKEND=bb",
    "  bb firstmate deck | session [--json]",
    '  bb firstmate dispatch --project <id> [--task t ...] [--shape ship|scout] [--mode m] [--title t] [--provider p] [--model m] [--permission-mode m] [--shared-env] [--worktree] [--hidden] [--send-at ms] -- "<task>"',
    "  bb firstmate crews | crew <id> | watch [id ...] [--timeout s] [--json]",
    '  bb firstmate tell <id> -- "<message>" | interrupt <id> | stop <id> | retry <id>',
    "  bb firstmate bearings | deliver <id> | merge <id> [--yes] | promote <id>",
    '  bb firstmate queue add --project <id> [--shape s] [--mode m] [--after <qid>] [--wait-until <iso>] -- "<title>"',
    "  bb firstmate queue [list|next|dispatch <qid>|done <qid>|drop <qid>]",
    '  bb firstmate decide ask [--option o ...] [--crew <id>] -- "<question>"',
    "  bb firstmate decide [list|answer <id>|defer <id>|drop <id>]",
    "  bb firstmate posture [set --project <id> [--mode m] [--yolo on|off]]",
    "  bb firstmate memory [show|set-captain|add-learning|drop-learning <n>|clear <captain|learnings>]",
    "  bb firstmate afk [on|off|status] [-- \"words\"]",
    "  bb firstmate quiet [on|off|status]",
    "  bb firstmate secondmate [list|register --project <id> --thread <id>|drop <project>]",
    "  bb firstmate supervision [on|off|status]",
    "  bb firstmate forget <id> [--stop] [--force]",
  ].join("\n");

  const dispatchParams = z.object({
    task: z.string().min(1).max(MAX_TASK),
    projectId: z.string().optional().describe("BB project id; defaults to the current thread's project"),
    title: z.string().max(120).optional(),
    providerId: z.string().optional(),
    model: z.string().optional(),
    permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
    shape: shapeSchema.optional(),
    mode: modeSchema.optional(),
    worktree: z.boolean().optional(),
    sharedEnv: z.boolean().optional().describe("Ship on the project checkout instead of an isolated worktree"),
    visible: z.boolean().optional().describe("Show in the BB sidebar as a nested subagent (default true)"),
    sendAt: z.number().int().optional().describe("Epoch ms to start the crew (queued until then)"),
  });

  function toolError(text: string) {
    return { content: [{ type: "text" as const, text }], isError: true };
  }

  bb.agents.registerTool({
    name: "firstmate_dispatch",
    description:
      "Dispatch a firstmate-style crewmate: spawns a child BB thread for one task (ship crews get an isolated worktree by default) and records it as a crew.",
    presentation: { label: { pending: "Dispatching crewmate", completed: "Dispatched crewmate" } },
    parameters: dispatchParams,
    async execute({ task, projectId, title, providerId, model, permissionMode, shape, mode, worktree, sharedEnv, visible, sendAt }, ctx) {
      const ctxRecord = asRecord(ctx);
      const resolvedProject =
        projectId ?? (typeof ctxRecord["projectId"] === "string" ? ctxRecord["projectId"] : undefined);
      if (resolvedProject === undefined) return toolError("No project: pass projectId.");
      const current = await settings.get();
      const resolvedShape = shape ?? "ship";
      const posture = await postureOf(resolvedProject);
      const wt = resolveWorktree({
        shape: resolvedShape,
        sharedEnv: sharedEnv === true,
        worktreeFlag: worktree === true,
        explicit: worktree,
      });
      const crew = await dispatchCrew({
        task,
        projectId: resolvedProject,
        parentThreadId: typeof ctxRecord["threadId"] === "string" ? ctxRecord["threadId"] : undefined,
        title,
        providerId: providerId ?? (current.defaultProvider !== "" ? current.defaultProvider : undefined),
        model,
        permissionMode: toPermissionMode(permissionMode ?? current.defaultPermissionMode),
        worktree: wt.worktree,
        visible: visible !== false,
        shape: resolvedShape,
        mode: toMode(mode, posture.mode),
        sendAt,
      });
      const warn = wt.sharedOverride ? " WARN: ship crew on shared env." : "";
      return `Dispatched ${crew.shape} crew ${crew.id} as thread ${crew.threadId} (${await crewStatus(crew)}, ${crew.posture}).${warn} Track with: bb firstmate crew ${crew.id}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_deck",
    description: "Mark this thread as the firstmate captain and return the session digest (memory, bearings, afk).",
    presentation: { label: { pending: "Taking the deck", completed: "On deck" } },
    parameters: z.object({}),
    async execute(_args, ctx) {
      const threadId = asRecord(ctx)["threadId"];
      if (typeof threadId !== "string") return toolError("No thread to mark as captain.");
      await markDeck(threadId);
      return `Captain, on deck.\n${await sessionDigest()}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_tell",
    description: "Doorbell a crew: queues if the turn is active, starts a turn if idle. Use firstmate_interrupt to hard-stop.",
    parameters: z.object({ crewId: z.string(), message: z.string().min(1).max(MAX_TASK) }),
    async execute({ crewId, message }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      try {
        return await tellCrew(crew, message, false);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "Tell failed.");
      }
    },
  });

  bb.agents.registerTool({
    name: "firstmate_watch",
    description: "Wait until the given crews finish (idle or error) using BB thread wait — do not poll.",
    parameters: z.object({
      crewIds: z.array(z.string()).max(MAX_WATCH_CREWS).optional(),
      timeoutSec: z.number().int().min(10).max(1800).optional(),
    }),
    async execute({ crewIds, timeoutSec }, ctx) {
      const all = await listCrews();
      const targets = (crewIds === undefined ? all : all.filter((c) => crewIds.includes(c.id))).slice(0, MAX_WATCH_CREWS);
      if (targets.length === 0) return toolError("No matching crews.");
      const timeoutMs = (timeoutSec ?? 600) * 1000;
      const signal = asRecord(ctx)["signal"] as AbortSignal | undefined;
      const rows = await Promise.all(
        targets.map(async (crew) => {
          const status = await waitOne(crew, timeoutMs, signal);
          const output = status === "idle" || status === "error" ? await crewOutput(crew, 800) : null;
          return { ...crew, status, outcome: parseOutcome(output), output };
        }),
      );
      return rows.map((r) => `${formatCrew(r, r.status)}${r.outcome !== null ? `\n  ${r.outcome}` : ""}`).join("\n");
    },
  });

  bb.agents.registerTool({
    name: "firstmate_bearings",
    description: "Fleet digest: Captain's Call, Recently Landed, Ready, Underway, Charted Next.",
    parameters: z.object({}),
    async execute() {
      return (await bearingsSnapshot()).text;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_deliver",
    description: "Crew delivery: outcome + committed/uncommitted diff + PR state.",
    parameters: z.object({ crewId: z.string() }),
    async execute({ crewId }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      return (await deliverLines(crew)).text;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_merge",
    description: "Merge a crew PR (green+mergeable) or ff-only local-only land. Needs yes=true or yolo posture.",
    parameters: z.object({ crewId: z.string(), yes: z.boolean().optional() }),
    async execute({ crewId, yes }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      try {
        return await mergeCrew(crew, yes === true);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "Merge failed.");
      }
    },
  });

  bb.agents.registerTool({
    name: "firstmate_decide",
    description: "Durable captain decisions. ask stores a question; answer tells the linked crew.",
    parameters: z.object({
      action: z.enum(["ask", "list", "answer", "defer", "drop"]),
      question: z.string().optional(),
      decisionId: z.string().optional(),
      answer: z.string().optional(),
      options: z.array(z.string()).optional(),
      crewId: z.string().optional(),
    }),
    async execute({ action, question, decisionId, answer, options, crewId }) {
      const all = await readDecisions();
      if (action === "list") {
        if (all.length === 0) return "No decisions.";
        return all.map((d) => `${d.id} [${d.status}] :: ${truncate(d.question, 80)}`).join("\n");
      }
      if (action === "ask") {
        if (question === undefined || question.trim() === "") return toolError("Need question.");
        const d: Decision = {
          id: randomUUID().slice(0, 8),
          question: question.slice(0, 500),
          options: (options ?? []).slice(0, 10),
          context: "",
          crewId: crewId ?? null,
          status: "open",
          deferredUntil: null,
          answer: "",
          createdAt: new Date().toISOString(),
        };
        await writeDecisions([d, ...all]);
        return `Decision ${d.id}: ${truncate(question, 100)}. Prefer AskUserQuestion to collect the captain's choice, then firstmate_decide action=answer.`;
      }
      if (action === "answer") {
        const d = all.find((x) => x.id === decisionId);
        if (d === undefined || answer === undefined) return toolError("Need decisionId + answer.");
        d.status = "answered";
        d.answer = answer.slice(0, 500);
        await writeDecisions(all);
        if (d.crewId !== null) {
          const crew = await findCrew(d.crewId);
          if (crew !== undefined) {
            await bb.sdk.threads.send({
              threadId: crew.threadId,
              mode: "steer",
              input: [{ type: "text", text: `Captain's decision: ${answer.slice(0, MAX_TASK)}`, mentions: [] }],
            });
          }
        }
        return `Answered ${d.id}`;
      }
      if (action === "defer") {
        const d = all.find((x) => x.id === decisionId);
        if (d === undefined) return toolError("Need decisionId.");
        d.status = "deferred";
        await writeDecisions(all);
        return `Deferred ${d.id}`;
      }
      if (action === "drop") {
        await writeDecisions(all.filter((x) => x.id !== decisionId));
        return `Dropped ${decisionId ?? ""}`;
      }
      return toolError("Unknown action.");
    },
  });

  bb.agents.registerTool({
    name: "firstmate_crew",
    description: "Show one crew: status, parsed DONE/BLOCKED/FAILED, last output.",
    parameters: z.object({ crewId: z.string() }),
    async execute({ crewId }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      const status = await crewStatus(crew);
      const output = await crewOutput(crew);
      const outcome = parseOutcome(output);
      return [formatCrew(crew, status), outcome === null ? "" : `outcome: ${outcome}`, output ?? "(no output yet)"]
        .filter((l) => l !== "")
        .join("\n");
    },
  });

  bb.agents.registerTool({
    name: "firstmate_stop",
    description: "Stop a crew thread (keeps the record).",
    parameters: z.object({ crewId: z.string() }),
    async execute({ crewId }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      if (isSecondmateRoute(crew)) return toolError(`Crew ${crewId} is a secondmate route — do not stop the domain captain.`);
      if (await isCaptainThread(crew.threadId)) return toolError("Refusing to stop the captain thread.");
      await bb.sdk.threads.stop({ threadId: crew.threadId });
      return `Stopped crew ${crewId}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_retry",
    description: "Re-submit a crew's failed turn.",
    parameters: z.object({ crewId: z.string(), reason: z.string().optional() }),
    async execute({ crewId, reason }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      await bb.sdk.threads.retry({ threadId: crew.threadId, reason: reason ?? `firstmate retry crew ${crewId}` });
      return `Retried crew ${crewId}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_promote",
    description: "Promote a finished scout into a new ship crew carrying the scout report. Never expand the scout in place.",
    parameters: z.object({ crewId: z.string(), mode: modeSchema.optional() }),
    async execute({ crewId, mode }, ctx) {
      const scout = await findCrew(crewId);
      if (scout === undefined) return toolError(`No crew ${crewId}.`);
      if (scout.shape !== "scout") return toolError(`Crew ${crewId} is ${scout.shape}, not scout.`);
      const report = (await crewOutput(scout, 2000)) ?? "(no scout report)";
      const current = await settings.get();
      const posture = await postureOf(scout.projectId);
      const ctxRecord = asRecord(ctx);
      const ship = await dispatchCrew({
        task: `Captain's intent: implement the scout's recommended path. Do not reopen the investigation.\nAcceptance: the scout report's recommendation, nothing else.\n\nFirstmate spec: follow the report. Out of scope: extra hardening not named there.\n\nScout report (crew ${scout.id}):\n${report}`,
        projectId: scout.projectId,
        parentThreadId: typeof ctxRecord["threadId"] === "string" ? ctxRecord["threadId"] : scout.parentThreadId ?? undefined,
        title: `Ship from scout ${scout.id}`,
        providerId: current.defaultProvider !== "" ? current.defaultProvider : undefined,
        permissionMode: toPermissionMode(current.defaultPermissionMode),
        worktree: true,
        visible: true,
        shape: "ship",
        mode: toMode(mode, posture.mode),
      });
      await recordDone({
        task: scout.task.slice(0, 200),
        shape: "scout",
        crewId: scout.id,
        outcome: `promoted → ship ${ship.id}`,
        pr: "",
      });
      return `Promoted scout ${scout.id} → ship ${ship.id} (${ship.threadId}). Scout record kept until forget.`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_afk",
    description: "Away posture: on holds routine done-pings for the return brief; off prints the brief then clears.",
    parameters: z.object({
      action: z.enum(["on", "off", "status"]),
      words: z.string().optional(),
    }),
    async execute({ action, words }) {
      if (action === "on") {
        await writeAfk({
          on: true,
          words: words ?? "",
          since: new Date().toISOString(),
          held: (await readAfk())?.held ?? [],
        });
        try { await settings.experimental_set({ supervisionEnabled: true }); } catch { /* */ }
        return `AFK on. Words recorded, not executed as authority. Failures/credentials still surface.`;
      }
      if (action === "off") {
        const prev = await readAfk();
        await writeAfk({ on: false, words: "", since: new Date().toISOString(), held: [] });
        const held = prev?.held ?? [];
        const snap = await bearingsSnapshot();
        return [
          "== return brief ==",
          snap.text,
          held.length === 0 ? "Nothing held." : `Held while away:\n${held.join("\n---\n")}`,
        ].join("\n");
      }
      const afk = await readAfk();
      return `afk: ${afk?.on === true ? "on" : "off"}${afk?.words ? ` words: ${afk.words}` : ""} held=${afk?.held.length ?? 0}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_interrupt",
    description: "Hard-stop a crew's current action without teardown. Doorbell/tell does not interrupt.",
    parameters: z.object({ crewId: z.string() }),
    async execute({ crewId }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      try {
        return await tellCrew(
          crew,
          "INTERRUPT: stop the current action. Await new orders. Do not teardown or discard work.",
          true,
        );
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "Interrupt failed.");
      }
    },
  });

  bb.agents.registerTool({
    name: "firstmate_crews",
    description: "List recorded crews with live thread status.",
    parameters: z.object({}),
    async execute() {
      const crews = (await listCrews()).slice(0, 20);
      if (crews.length === 0) return "No crews.";
      const rows = await Promise.all(crews.map(async (crew) => formatCrew(crew, await crewStatus(crew))));
      return rows.join("\n");
    },
  });

  bb.agents.registerTool({
    name: "firstmate_session",
    description: "Session digest: memory, bearings, afk/quiet.",
    parameters: z.object({}),
    async execute() {
      return sessionDigest();
    },
  });

  bb.agents.registerTool({
    name: "firstmate_quiet",
    description: "Batch routine done-pings while the captain is present. Failures and review-ready PRs still surface.",
    parameters: z.object({ action: z.enum(["on", "off", "status"]) }),
    async execute({ action }) {
      if (action === "on" || action === "off") {
        await bb.storage.kv.set(QUIET_KEY, action === "on");
        return `Quiet ${action}`;
      }
      return `quiet: ${(await isQuiet()) ? "on" : "off"}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_queue",
    description: "Backlog with deps/time gates. add files work; dispatch starts a crew when ungated.",
    parameters: z.object({
      action: z.enum(["add", "list", "next", "dispatch", "done", "drop"]),
      title: z.string().optional(),
      projectId: z.string().optional(),
      queueId: z.string().optional(),
      shape: shapeSchema.optional(),
      mode: modeSchema.optional(),
      after: z.array(z.string()).optional(),
      waitUntil: z.string().optional(),
      detail: z.string().optional(),
    }),
    async execute({ action, title, projectId, queueId, shape, mode, after, waitUntil, detail }, ctx) {
      const items = await readQueue();
      const ctxProject = ctxString(ctx, "projectId");
      if (action === "list") {
        if (items.length === 0) return "Queue empty.";
        const now = Date.now();
        return items
          .map((q) => {
            const gate = q.status === "queued" ? queueGate(q, items, now) : null;
            return `${q.id} [${q.status}] ${q.shape} :: ${truncate(q.title, 70)}${gate !== null ? ` — ${gate}` : ""}${q.crewId !== null ? ` (crew ${q.crewId})` : ""}`;
          })
          .join("\n");
      }
      if (action === "next") {
        const now = Date.now();
        const open = items.filter((q) => q.status === "queued" && queueGate(q, items, now) === null);
        if (open.length === 0) return "Nothing dispatchable.";
        const first = [...open].reverse()[0] as QueueItem;
        return `${first.id} [${first.shape}] ${first.projectId} :: ${first.title}`;
      }
      if (action === "add") {
        if (title === undefined || title.trim() === "") return toolError("Need title.");
        const pid = projectId ?? ctxProject;
        if (pid === undefined) return toolError("Need projectId.");
        const item: QueueItem = {
          id: randomUUID().slice(0, 8),
          title: title.slice(0, 500),
          detail: (detail ?? "").slice(0, MAX_TASK),
          projectId: pid,
          shape: shape ?? "ship",
          mode: mode ?? "",
          blockedBy: after ?? [],
          waitUntil: waitUntil ?? null,
          status: "queued",
          crewId: null,
          createdAt: new Date().toISOString(),
        };
        await writeQueue([item, ...items]);
        await publishFleet();
        return `Queued ${item.id} [${item.shape}] :: ${truncate(item.title, 80)}`;
      }
      const item = items.find((q) => q.id === queueId);
      if (queueId === undefined || item === undefined) return toolError(`No queued item ${queueId ?? ""}.`);
      if (action === "drop" || action === "done") {
        item.status = action === "drop" ? "dropped" : "done";
        await writeQueue(items);
        await publishFleet();
        return `Queue ${queueId} ${item.status}`;
      }
      const gate = queueGate(item, items, Date.now());
      if (gate !== null) return toolError(`Item ${queueId} gated: ${gate}.`);
      const registry = await postureOf(item.projectId);
      const brief = item.detail !== "" ? `${item.title}\n\n${item.detail}` : item.title;
      const crew = await dispatchCrew({
        task: brief,
        projectId: item.projectId,
        parentThreadId: ctxString(ctx, "threadId"),
        title: `Crew: ${truncate(item.title, 60)}`,
        worktree: resolveWorktree({ shape: item.shape }).worktree,
        visible: true,
        shape: item.shape,
        mode: toMode(item.mode !== "" ? item.mode : undefined, registry.mode),
      });
      item.status = "dispatched";
      item.crewId = crew.id;
      await writeQueue(items);
      await publishFleet();
      return `Dispatched queue ${queueId} as ${crew.shape} crew ${crew.id}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_forget",
    description: "Drop a crew record. stop=true archives the thread (refuses dirty work unless force).",
    parameters: z.object({
      crewId: z.string(),
      stop: z.boolean().optional(),
      force: z.boolean().optional(),
    }),
    async execute({ crewId, stop, force }) {
      try {
        return await forgetCrew(crewId, stop === true, force === true);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "Forget failed.");
      }
    },
  });

  bb.agents.registerTool({
    name: "firstmate_memory",
    description: "Captain prefs and dated fleet learnings.",
    parameters: z.object({
      action: z.enum(["show", "set-captain", "add-learning", "drop-learning", "clear"]),
      text: z.string().optional(),
      n: z.number().int().optional(),
      which: z.enum(["captain", "learnings"]).optional(),
    }),
    async execute({ action, text, n, which }) {
      if (action === "show") {
        const cap = await bb.storage.kv.get<unknown>(MEM_CAPTAIN_KEY);
        const learn = await bb.storage.kv.get<unknown>(MEM_LEARNINGS_KEY);
        const capText = typeof cap === "string" ? cap : "";
        const learnText = typeof learn === "string" ? learn : "";
        return `== captain ==\n${capText !== "" ? capText : "(empty)"}\n== learnings ==\n${learnText !== "" ? learnText : "(empty)"}`;
      }
      if (action === "set-captain") {
        if (text === undefined || text.trim() === "") return toolError("Need text.");
        await bb.storage.kv.set(MEM_CAPTAIN_KEY, text.slice(0, 4000));
        return "Captain preferences saved.";
      }
      if (action === "add-learning") {
        if (text === undefined || text.trim() === "") return toolError("Need text.");
        const prev = await bb.storage.kv.get<unknown>(MEM_LEARNINGS_KEY);
        const line = `- ${new Date().toISOString().slice(0, 10)}: ${text}`;
        const next = `${typeof prev === "string" && prev !== "" ? `${prev}\n` : ""}${line}`.slice(-4000);
        await bb.storage.kv.set(MEM_LEARNINGS_KEY, next);
        return "Learning stored.";
      }
      if (action === "drop-learning") {
        const prev = await bb.storage.kv.get<unknown>(MEM_LEARNINGS_KEY);
        const lines = typeof prev === "string" ? prev.split("\n").filter((l) => l !== "") : [];
        if (n === undefined || !Number.isInteger(n) || n < 1 || n > lines.length) {
          return toolError(`No learning #${n ?? ""} (1-${lines.length}).`);
        }
        lines.splice(n - 1, 1);
        await bb.storage.kv.set(MEM_LEARNINGS_KEY, lines.join("\n"));
        return `Dropped learning #${n}.`;
      }
      if (which !== "captain" && which !== "learnings") return toolError("Need which=captain|learnings.");
      await bb.storage.kv.set(which === "captain" ? MEM_CAPTAIN_KEY : MEM_LEARNINGS_KEY, "");
      return `Cleared ${which}.`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_secondmate",
    description: "Register a domain-captain thread. Dispatch to that project routes there instead of spawning.",
    parameters: z.object({
      action: z.enum(["list", "register", "drop"]),
      projectId: z.string().optional(),
      threadId: z.string().optional(),
      scope: z.string().optional(),
    }),
    async execute({ action, projectId, threadId, scope }, ctx) {
      const items = await readSecondmates();
      const ctxRecord = asRecord(ctx);
      if (action === "list") {
        if (items.length === 0) return "No secondmates.";
        return items.map((m) => `${m.projectId} → ${m.threadId}${m.scope !== "" ? ` (${m.scope})` : ""}`).join("\n");
      }
      if (action === "register") {
        const pid = projectId ?? (typeof ctxRecord["projectId"] === "string" ? ctxRecord["projectId"] : undefined);
        const tid = threadId ?? (typeof ctxRecord["threadId"] === "string" ? ctxRecord["threadId"] : undefined);
        if (pid === undefined || tid === undefined) return toolError("Need projectId and threadId.");
        const next = items.filter((m) => m.projectId !== pid);
        const row: Secondmate = {
          projectId: pid,
          threadId: tid,
          scope: scope ?? "",
          createdAt: new Date().toISOString(),
        };
        next.push(row);
        await writeSecondmates(next);
        return `Secondmate ${pid} → ${tid}`;
      }
      const pid = projectId;
      if (pid === undefined) return toolError("Need projectId.");
      await writeSecondmates(items.filter((m) => m.projectId !== pid));
      return `Dropped secondmate ${pid}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_posture",
    description: "Per-project delivery mode (direct-PR / no-mistakes / local-only) and yolo merge authority.",
    parameters: z.object({
      action: z.enum(["get", "set"]),
      projectId: z.string().optional(),
      mode: modeSchema.optional(),
      yolo: z.boolean().optional(),
    }),
    async execute({ action, projectId, mode, yolo }, ctx) {
      const pid = projectId ?? ctxString(ctx, "projectId");
      const all = await readPostures();
      if (action === "get") {
        if (pid === undefined) {
          const keys = Object.keys(all);
          if (keys.length === 0) return "No postures set (default everywhere: direct-PR, yolo off).";
          return keys.map((k) => `${k}: ${all[k]?.mode}${all[k]?.yolo ? "+yolo" : ""}`).join("\n");
        }
        const p = all[pid] ?? { mode: "direct-PR" as DeliveryMode, yolo: false };
        return `Posture ${pid}: ${p.mode}${p.yolo ? "+yolo" : ""}`;
      }
      if (pid === undefined) return toolError("Need projectId.");
      const cur = all[pid] ?? { mode: "direct-PR" as DeliveryMode, yolo: false };
      const next = { mode: toMode(mode, cur.mode), yolo: yolo ?? cur.yolo };
      all[pid] = next;
      await bb.storage.kv.set(POSTURES_KEY, all);
      return `Posture ${pid}: ${next.mode}${next.yolo ? "+yolo" : ""}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_supervision",
    description: "Event pings (idle/fail/interaction) plus stuck checker. Deck turns this on.",
    parameters: z.object({ action: z.enum(["on", "off", "status"]) }),
    async execute({ action }) {
      if (action === "on" || action === "off") {
        await settings.experimental_set({ supervisionEnabled: action === "on" });
        return `Supervision ${action}`;
      }
      const current = await settings.get();
      const meta = asRecord(await bb.storage.kv.get<unknown>("watch-meta"));
      return `supervision: ${current.supervisionEnabled === true ? "on" : "off"} (events for done/fail, stuck every ${current.supervisionIntervalMin}m after ${current.supervisionStuckMin}m)\nlast stuck pass: ${typeof meta["lastPassAt"] === "number" ? new Date(meta["lastPassAt"]).toISOString() : "never"}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_fm",
    description:
      "Run a real firstmate bin/fm-<script>.sh with FM_BACKEND=bb (policy scripts, not a TypeScript port). Requires init --real.",
    parameters: z.object({
      script: z.string().min(1).max(80).describe("Stem of bin/fm-<script>.sh, e.g. spawn, peek, send, watch, bearings-snapshot"),
      args: z.array(z.string()).max(40).optional(),
      timeoutSec: z.number().int().min(15).max(1800).optional(),
    }),
    async execute({ script, args, timeoutSec }, ctx) {
      const current = await settings.get();
      if (current.fmHome === "") return toolError("No firstmate home. Run bb firstmate init --real.");
      try {
        const hostId = await resolveHostId(undefined, ctx);
        const result = await runFmScript({
          script,
          args: args ?? [],
          hostId,
          fmHome: current.fmHome,
          parentThreadId: ctxString(ctx, "threadId"),
          timeoutMs: fmTimeoutMs(normalizeFmScript(script), timeoutSec),
          signal: asRecord(ctx)["signal"] as AbortSignal | undefined,
        });
        const text = result.output === "" ? `(exit ${result.exitCode ?? "?"})` : result.output;
        return result.exitCode === 0 ? text : toolError(text);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "fm failed");
      }
    },
  });

  bb.agents.configure((context) => {
    const meta = asRecord(context.pluginMetadata);
    if (metaFlag(meta, "crew")) {
      return {
        tools: [],
        skills: [],
        instructions:
          "You are a firstmate crewmate. Do not dispatch other crews. Finish this one task, then report DONE, BLOCKED, or FAILED.",
      };
    }
    const marked = metaFlag(meta, "captain");
    return {
      tools: [...CAPTAIN_TOOLS],
      skills: marked ? [...CAPTAIN_SKILLS] : ["firstmate"],
      instructions: marked
        ? "You are the first mate. The user is the captain. Never do crew work in this thread — dispatch with firstmate_dispatch. Parent permission is a ceiling."
        : "Firstmate crews are available. Run /captain or firstmate_deck to take the deck.",
    };
  });

  bb.rpc.register(rpcContract, {
    async fleet() {
      return (await bearingsSnapshot()).rpc;
    },
  });

  bb.ui.registerMentionProvider({
    id: "crew",
    label: "Crews",
    triggers: ["@"],
    async search({ query }) {
      const crews = (await listCrews()).slice(0, 20);
      const q = query.toLowerCase();
      return crews
        .filter((c) => q === "" || c.id.includes(q) || c.task.toLowerCase().includes(q))
        .slice(0, 8)
        .map((c) => ({ id: c.id, title: c.id, subtitle: truncate(c.task, 60) }));
    },
    async resolve(itemId) {
      const crew = await findCrew(itemId);
      if (crew === undefined) throw new Error(`No crew ${itemId}`);
      const status = await crewStatus(crew);
      return { context: `Crew ${crew.id} [${status}] ${crew.shape} thread ${crew.threadId}: ${crew.task}` };
    },
  });

  const nudgeRowSchema = z.object({
    generation: z.string(),
    count: z.number(),
    lastAt: z.number(),
    exhausted: z.boolean(),
  });
  const nudgeStateSchema = z.record(z.string(), nudgeRowSchema);
  type NudgeRow = z.infer<typeof nudgeRowSchema>;
  const nudgeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearNudgeTimer(crewId: string): void {
    const timer = nudgeTimers.get(crewId);
    if (timer === undefined) return;
    clearTimeout(timer);
    nudgeTimers.delete(crewId);
  }

  function nudgeLimits(current: Awaited<ReturnType<typeof settings.get>>): {
    enabled: boolean;
    max: number;
    cooldownMs: number;
  } {
    const maxRaw = current.nudgeMaxPerCrew;
    const coolRaw = current.nudgeCooldownSeconds;
    const max = Number.isFinite(maxRaw) ? Math.max(0, Math.trunc(maxRaw)) : 3;
    const seconds = Number.isFinite(coolRaw) ? Math.max(0, Math.trunc(coolRaw)) : 60;
    return { enabled: current.nudgeEnabled === true, max, cooldownMs: seconds * 1000 };
  }

  async function readNudgeState(): Promise<Record<string, NudgeRow>> {
    const parsed = nudgeStateSchema.safeParse(await bb.storage.kv.get<unknown>(NUDGE_KEY));
    return parsed.success ? parsed.data : {};
  }

  function taskGeneration(crew: Crew): string {
    return crew.createdAt !== "" ? crew.createdAt : crew.threadId;
  }

  async function turnWasStopped(thread: {
    id: string;
    status: string;
    runtime?: { displayStatus?: string };
  }): Promise<boolean> {
    if (thread.status === "stopping" || thread.runtime?.displayStatus === "stopping") return true;
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId: thread.id,
        order: "desc",
        limit: "1",
        types: ["system/thread/interrupted"],
      });
      const reason = asRecord(asRecord(rows[0])["data"])["reason"];
      return reason === "manual-stop" || reason === "host-daemon-restarted";
    } catch {
      return false;
    }
  }

  async function applyProtocolNudge(crew: Crew): Promise<"off" | "nudged" | "cooling" | "exhausted" | "spent"> {
    const current = await settings.get();
    const limits = nudgeLimits(current);
    if (!limits.enabled) return "off";
    const generation = taskGeneration(crew);
    const state = await readNudgeState();
    const prev = state[crew.id];
    const row: NudgeRow =
      prev === undefined || prev.generation !== generation
        ? { generation, count: 0, lastAt: 0, exhausted: false }
        : { ...prev };
    if (row.exhausted) return "spent";
    if (row.count >= limits.max) {
      row.exhausted = true;
      state[crew.id] = row;
      await bb.storage.kv.set(NUDGE_KEY, state);
      await notifyCaptain(
        crew,
        "needs-decision",
        `NEEDS DECISION: crew ${crew.id} idled without DONE:/BLOCKED:/FAILED: after ${limits.max} protocol nudges`,
      );
      return "exhausted";
    }
    const now = Date.now();
    if (row.lastAt > 0 && now - row.lastAt < limits.cooldownMs) {
      const wait = limits.cooldownMs - (now - row.lastAt);
      const existing = nudgeTimers.get(crew.id);
      if (existing !== undefined) clearTimeout(existing);
      const timer = setTimeout(() => {
        nudgeTimers.delete(crew.id);
        void runDeferredNudge(crew.id);
      }, wait);
      (timer as unknown as { unref?: () => void }).unref?.();
      nudgeTimers.set(crew.id, timer);
      return "cooling";
    }
    row.count += 1;
    row.lastAt = now;
    state[crew.id] = row;
    await bb.storage.kv.set(NUDGE_KEY, state);
    clearNudgeTimer(crew.id);
    try {
      await tellCrew(crew, protocolNudgeText(row.count, limits.max), false);
    } catch (error) {
      bb.log.warn(
        `protocol nudge failed for crew ${crew.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return "nudged";
  }

  async function runDeferredNudge(crewId: string): Promise<void> {
    const crew = await findCrew(crewId);
    if (crew === undefined) return;
    try {
      const thread = await bb.sdk.threads.get({ threadId: crew.threadId });
      if (await turnWasStopped(thread)) return;
      if (thread.status === "active" || thread.status === "starting") return;
    } catch {
      return;
    }
    const output = await crewOutput(crew);
    if (hasStatusProtocol(output)) return;
    await applyProtocolNudge(crew);
  }

  bb.events.on("thread.created", async ({ thread }) => {
    if (!isCaptainSpawn(thread)) return;
    await settleDeck(thread.id);
  });
  bb.events.on("thread.active", async ({ thread }) => {
    if (!isCaptainSpawn(thread)) return;
    await settleDeck(thread.id);
  });
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const crew = await findCrewByThread(thread.id);
    if (crew === undefined) return;
    const stopped = await turnWasStopped(thread);
    if (!stopped && !hasStatusProtocol(lastAssistantText)) {
      const outcome = await applyProtocolNudge(crew);
      if (outcome !== "off") return;
    }
    const current = await settings.get();
    if (current.supervisionEnabled !== true) return;
    await notifyCaptain(crew, "idle", lastAssistantText);
  });
  bb.events.on("thread.failed", async ({ thread, error }) => {
    const current = await settings.get();
    if (current.supervisionEnabled !== true) return;
    const crew = await findCrewByThread(thread.id);
    if (crew === undefined) return;
    await notifyCaptain(crew, "error", error);
  });
  bb.events.on("interaction.pending", async ({ thread }) => {
    const current = await settings.get();
    if (current.supervisionEnabled !== true) return;
    const crew = await findCrewByThread(thread.id);
    if (crew === undefined) return;
    await notifyCaptain(crew, "interaction", "crew is waiting on an approval or credential");
  });
  bb.events.on("turn.failed", async ({ threadId, requestId, errorInfo }) => {
    const current = await settings.get();
    if (current.supervisionEnabled !== true) return;
    const crew = await findCrewByThread(threadId);
    if (crew === undefined) return;
    const detail = errorInfo === null ? `turn ${requestId} failed` : `turn ${requestId} failed: ${JSON.stringify(errorInfo).slice(0, 300)}`;
    await notifyCaptain(crew, "error", detail);
  });

  bb.cli.register({
    name: "firstmate",
    summary: "Run firstmate-style crews: dispatch crewmate threads, track them, bring back results",
    commands: [
      { name: "guide", summary: "Setup guide for firstmate inside BB", usage: "bb firstmate guide [--json]" },
      { name: "init", summary: "Native deck setup (add --real to clone firstmate and overlay the BB backend)", usage: "bb firstmate init [--real] [--json]" },
      { name: "fm", summary: "Run a real firstmate bin/ script with FM_BACKEND=bb", usage: "bb firstmate fm [--timeout s] <script> [args...]" },
      { name: "deck", summary: "Mark this thread captain + session digest", usage: "bb firstmate deck [--json]" },
      { name: "session", summary: "Session digest: memory + bearings + afk", usage: "bb firstmate session [--json]" },
      { name: "dispatch", summary: "Dispatch crewmate child threads", usage: 'bb firstmate dispatch --project <id> -- "<task>"' },
      { name: "crews", summary: "List recorded crews with live status", usage: "bb firstmate crews [--json]" },
      { name: "crew", summary: "Show one crew with last output", usage: "bb firstmate crew <crew-id> [--json]" },
      { name: "watch", summary: "Wait for crews via bb thread wait", usage: "bb firstmate watch [crew-id ...] [--timeout <sec>] [--json]" },
      { name: "tell", summary: "Steer a running crew", usage: 'bb firstmate tell <crew-id> -- "<message>"' },
      { name: "interrupt", summary: "Steer a hard stop without teardown", usage: "bb firstmate interrupt <crew-id>" },
      { name: "stop", summary: "Stop a crew thread", usage: "bb firstmate stop <crew-id>" },
      { name: "retry", summary: "Re-submit a failed turn", usage: "bb firstmate retry <crew-id>" },
      { name: "bearings", summary: "Fleet digest", usage: "bb firstmate bearings [--json]" },
      { name: "deliver", summary: "Outcome + committed/uncommitted diff + PR", usage: "bb firstmate deliver <crew-id>" },
      { name: "merge", summary: "Merge PR or local-only ff-only land", usage: "bb firstmate merge <crew-id> [--yes]" },
      { name: "promote", summary: "Scout → new ship carrying the report", usage: "bb firstmate promote <crew-id>" },
      { name: "queue", summary: "Backlog with deps/time gates", usage: 'bb firstmate queue add --project <id> -- "<title>"' },
      { name: "decide", summary: "Durable decisions", usage: 'bb firstmate decide ask -- "<question>"' },
      { name: "posture", summary: "Per-project delivery mode + yolo", usage: "bb firstmate posture set --project <id> [--mode m]" },
      { name: "memory", summary: "Captain prefs + learnings", usage: "bb firstmate memory show" },
      { name: "afk", summary: "Away posture", usage: "bb firstmate afk on|off|status" },
      { name: "quiet", summary: "Batch routine pings while present", usage: "bb firstmate quiet on|off|status" },
      { name: "secondmate", summary: "Register a domain captain thread", usage: "bb firstmate secondmate list|register|drop" },
      { name: "supervision", summary: "Event pings + stuck checker", usage: "bb firstmate supervision on|off|status" },
      { name: "forget", summary: "Drop a crew record", usage: "bb firstmate forget <crew-id> [--stop] [--force]" },
    ],
    async run(argv, ctx) {
      if (argv[0] === "fm") {
        const json = argv.includes("--json");
        const fail = (message: string) => ({ exitCode: 1, stderr: message });
        const signal = asRecord(ctx)["signal"] as AbortSignal | undefined;
        try {
          const current = await settings.get();
          const fmHome = flagFromArgv(argv, "home") ?? (current.fmHome !== "" ? current.fmHome : undefined);
          if (fmHome === undefined) return fail("No firstmate home. Run: bb firstmate init --real");
          const parsed = parseFmArgv(argv.slice(1));
          if (parsed.script === undefined) return fail("Usage: bb firstmate fm [--timeout s] <script> [args...]\nExample: bb firstmate fm spawn -- --mode direct-PR -- ship \"fix login\"");
          const hostId = await resolveHostId(flagFromArgv(argv, "machine"), ctx);
          const ctxRecord = asRecord(ctx);
          const result = await runFmScript({
            script: parsed.script,
            args: parsed.args,
            hostId,
            fmHome,
            projectId: flagFromArgv(argv, "project"),
            parentThreadId: typeof ctxRecord["threadId"] === "string" ? ctxRecord["threadId"] : undefined,
            timeoutMs: fmTimeoutMs(normalizeFmScript(parsed.script), parsed.timeoutSec),
            signal,
          });
          const body = json
            ? JSON.stringify({ script: result.scriptPath, exitCode: result.exitCode, output: result.output })
            : result.output;
          return { exitCode: result.exitCode ?? 1, stdout: result.exitCode === 0 ? body : "", stderr: result.exitCode === 0 ? "" : body };
        } catch (error) {
          return fail(error instanceof Error ? error.message : "fm failed");
        }
      }
      const { flags, positional } = parseArgs(argv);
      const json = flags.has("json");
      const signal = asRecord(ctx)["signal"] as AbortSignal | undefined;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      const [command, ...rest] = positional;
      const current = await settings.get();
      const ctxRecord = asRecord(ctx);
      const ctxProject = typeof ctxRecord["projectId"] === "string" ? ctxRecord["projectId"] : undefined;
      const ctxThread = typeof ctxRecord["threadId"] === "string" ? ctxRecord["threadId"] : undefined;

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
          case "guide": {
            const repo = current.firstmateRepo !== "" ? current.firstmateRepo : "https://github.com/kunchenguid/firstmate";
            return reply({ guide: guideText(repo) }, guideText(repo));
          }
          case "deck": {
            if (ctxThread === undefined) return fail("No thread: run this from a BB thread.");
            await markDeck(ctxThread);
            const digest = await sessionDigest();
            return reply({ captain: true, threadId: ctxThread, digest }, `Captain, on deck.\n${digest}`);
          }
          case "session": {
            const digest = await sessionDigest();
            return reply({ digest }, digest);
          }
          case "init": {
            if (!flags.has("real")) {
              if (ctxThread !== undefined) await markDeck(ctxThread);
              else await settings.experimental_set({ supervisionEnabled: true });
              const repo = current.firstmateRepo !== "" ? current.firstmateRepo : "https://github.com/kunchenguid/firstmate";
              const text = [
                "Native firstmate is ready. This thread is the captain (if run from a thread).",
                guideText(repo),
              ].join("\n");
              return reply({ native: true, threadId: ctxThread ?? null }, text);
            }
            const repo = current.firstmateRepo !== "" ? current.firstmateRepo : "https://github.com/kunchenguid/firstmate";
            const name = flagStr(flags, "name") ?? "firstmate";
            const timeoutMs = Math.min(600, Math.max(30, Number(flagStr(flags, "timeout") ?? "180"))) * 1000;
            const hostId = await resolveHostId(flagStr(flags, "machine"), ctx);
            const home = (await runOnHost(hostId, `printf '%s' "$HOME"`, 30000, signal)).output.trim();
            if (home === "") throw new Error("Could not resolve $HOME on host.");
            const path = flagStr(flags, "path") ?? `${home}/firstmate`;
            const tools = await runOnHost(
              hostId,
              "command -v git; command -v gh; command -v bb; command -v python3; gh auth status 2>&1 | head -n 3",
              30000,
              signal,
            );
            if (!tools.output.includes("git")) throw new Error(`git missing on host. Tools:\n${tools.output}`);
            const clone = await runOnHost(
              hostId,
              `[ -d ${shQuote(`${path}/.git`)} ] && echo FM_EXISTS || git clone ${shQuote(repo)} ${shQuote(path)}`,
              timeoutMs,
              signal,
            );
            if (clone.exitCode !== 0) throw new Error(`Clone failed:\n${truncate(clone.output, 1000)}`);
            const existed = clone.output.includes("FM_EXISTS");
            let projectId: string;
            try {
              const created = await bb.sdk.projects.create({ name, source: { type: "local_path", hostId, path } });
              projectId = asRecord(created)["id"] as string;
            } catch {
              const projects = await bb.sdk.projects.list();
              const rows: unknown[] = Array.isArray(projects) ? projects : [];
              const match = rows.find((p) => asRecord(p)["name"] === name);
              const id = match === undefined ? undefined : asRecord(match)["id"];
              if (typeof id !== "string") throw new Error(`Project create failed and no project named ${name} found.`);
              projectId = id;
            }
            const overlayOut = await installBbBackend(hostId, path, projectId, timeoutMs, signal);
            try {
              await settings.experimental_set({ fmHome: path });
            } catch {
              // persist best-effort
            }
            const summary = [
              `host: ${hostId}`,
              `path: ${path} (${existed ? "existed" : "cloned"})`,
              `project: ${projectId}`,
              `backend: bb (overlay installed; config/backend=bb)`,
              `fm: bb firstmate fm spawn -- --mode direct-PR -- ship "<task>"`,
              `overlay:\n${truncate(overlayOut, 800)}`,
              `tools:\n${truncate(tools.output, 500)}`,
            ].join("\n");
            return reply({ hostId, path, existed, projectId, backend: "bb", tools: tools.output, overlay: overlayOut }, summary);
          }
          case "dispatch": {
            const tasks =
              flagAll(flags, "task").length > 0
                ? flagAll(flags, "task")
                : [rest.join(" ").trim()].filter((t) => t !== "");
            if (tasks.length === 0) return fail(`Empty task.\n${usage}`);
            if (tasks.length > MAX_FANOUT) return fail(`Too many tasks (max ${MAX_FANOUT}).`);
            const projectId = flagStr(flags, "project") ?? ctxProject;
            if (projectId === undefined) return fail("No project: pass --project <id> (see bb project list).");
            const shape = toShape(flagStr(flags, "shape"));
            const wt = resolveWorktree({
              shape,
              sharedEnv: flags.has("shared-env"),
              worktreeFlag: flags.has("worktree"),
            });
            const registry = await postureOf(projectId);
            const mode = toMode(flagStr(flags, "mode"), registry.mode);
            const titleFlag = flagStr(flags, "title");
            const sendAtRaw = flagStr(flags, "send-at");
            const sendAt = sendAtRaw === undefined ? undefined : Number(sendAtRaw);
            if (sendAt !== undefined && !Number.isFinite(sendAt)) return fail("Bad --send-at (epoch ms).");
            const dispatched = [];
            for (let i = 0; i < tasks.length; i++) {
              const crew = await dispatchCrew({
                task: tasks[i] as string,
                projectId,
                parentThreadId: ctxThread,
                title: titleFlag === undefined ? undefined : tasks.length === 1 ? titleFlag : `${titleFlag} #${i + 1}`,
                providerId: flagStr(flags, "provider") ?? (current.defaultProvider !== "" ? current.defaultProvider : undefined),
                model: flagStr(flags, "model"),
                permissionMode: toPermissionMode(flagStr(flags, "permission-mode") ?? current.defaultPermissionMode),
                worktree: wt.worktree,
                visible: !flags.has("hidden"),
                shape,
                mode,
                sendAt,
              });
              dispatched.push({ ...crew, status: await crewStatus(crew) });
            }
            const hints: string[] = [];
            if (wt.sharedOverride) {
              hints.push("WARN: ship crew on shared env (--shared-env). Prefer the default isolated worktree.");
            }
            if (shape === "ship" && tasks.some((t) => looksReadOnly(t))) {
              hints.push("Hint: task looks read-only — consider --shape scout.");
            }
            if (current.fmHome.trim() !== "") {
              hints.push(
                `fm: bb firstmate fm peek -- ${dispatched.map((c) => c.id).join(" ")}`,
              );
            }
            return reply(
              dispatched,
              [
                ...dispatched.map(
                  (c) =>
                    `Dispatched ${c.shape} crew ${c.id} as thread ${c.threadId} [${c.status}] (${c.worktree ? "worktree" : "shared-env"}, ${c.posture})\nTrack: bb firstmate crew ${c.id}`,
                ),
                ...hints,
              ].join("\n"),
            );
          }
          case "crews": {
            const crews = (await listCrews()).slice(0, 20);
            const rows = await Promise.all(crews.map(async (crew) => ({ ...crew, status: await crewStatus(crew) })));
            return reply(rows, rows.length === 0 ? "No crews." : rows.map((row) => formatCrew(row, row.status)).join("\n"));
          }
          case "crew": {
            const id = rest[0];
            if (id === undefined || rest.length !== 1) return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}. Run "bb firstmate crews".`);
            const status = await crewStatus(crew);
            const output = await crewOutput(crew);
            const outcome = parseOutcome(output);
            return reply(
              { ...crew, status, outcome, output },
              [formatCrew(crew, status), outcome === null ? "" : `outcome: ${outcome}`, output === null ? "(no output yet)" : "", output ?? ""]
                .filter((line) => line !== "")
                .join("\n"),
            );
          }
          case "watch": {
            const ids = rest.length > 0 ? rest : null;
            const timeoutMs = Math.min(1800, Math.max(10, Number(flagStr(flags, "timeout") ?? "600"))) * 1000;
            const all = await listCrews();
            const targets = (ids === null ? all : all.filter((c) => ids.includes(c.id))).slice(0, MAX_WATCH_CREWS);
            if (targets.length === 0) return fail("No matching crews.");
            if (ids !== null) {
              const missing = ids.filter((id) => !targets.some((c) => c.id === id));
              if (missing.length > 0) return fail(`No crew ${missing[0]}. Run "bb firstmate crews".`);
            }
            const rows = await Promise.all(
              targets.map(async (crew) => {
                const status = await waitOne(crew, timeoutMs, signal);
                const output = status === "idle" || status === "error" ? await crewOutput(crew, 800) : null;
                return { ...crew, status, outcome: parseOutcome(output), output };
              }),
            );
            const timedOut = rows.filter((r) => r.status === "timeout").map((r) => r.id);
            const text = rows
              .map((row) => {
                const head = formatCrew(row, row.status);
                if (row.outcome !== null) return `${head}\n  ${row.outcome}`;
                if (row.output === null) {
                  return row.status === "timeout" ? `${head}\n  (still running, timed out)` : head;
                }
                return `${head}\n  ${truncate(row.output.replace(/\n/g, " "), 300)}`;
              })
              .join("\n");
            return reply({ crews: rows, timedOut }, timedOut.length > 0 ? `${text}\nTimed out: ${timedOut.join(", ")}` : text);
          }
          case "tell":
          case "interrupt": {
            const id = rest[0];
            const message =
              command === "interrupt"
                ? "INTERRUPT: stop the current action. Await new orders. Do not teardown or discard work."
                : (flagStr(flags, "message") ?? rest.slice(1).join(" ").trim());
            if (id === undefined || message === "") return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}. Run "bb firstmate crews".`);
            const text = await tellCrew(crew, message, command === "interrupt");
            return reply({ told: true, id, interrupt: command === "interrupt" }, text);
          }
          case "stop": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}.`);
            if (isSecondmateRoute(crew)) return fail(`Crew ${id} is a secondmate route — do not stop the domain captain.`);
            if (await isCaptainThread(crew.threadId)) return fail("Refusing to stop the captain thread.");
            await bb.sdk.threads.stop({ threadId: crew.threadId });
            return reply({ stopped: true, id }, `Stopped crew ${id}`);
          }
          case "retry": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}.`);
            await bb.sdk.threads.retry({
              threadId: crew.threadId,
              reason: flagStr(flags, "reason") ?? `firstmate retry crew ${id}`,
            });
            return reply({ retried: true, id }, `Retried crew ${id}`);
          }
          case "bearings": {
            const snap = await bearingsSnapshot();
            return reply(snap.json, snap.text);
          }
          case "deliver": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}.`);
            const d = await deliverLines(crew);
            return reply(d.json, d.text);
          }
          case "merge": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}.`);
            const text = await mergeCrew(crew, flags.has("yes"));
            return reply({ merged: true, id }, text);
          }
          case "promote": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const scout = await findCrew(id);
            if (scout === undefined) return fail(`No crew ${id}.`);
            if (scout.shape !== "scout") return fail(`Crew ${id} is ${scout.shape}, not scout.`);
            const report = (await crewOutput(scout, 2000)) ?? "(no scout report)";
            const registry = await postureOf(scout.projectId);
            const ship = await dispatchCrew({
              task: `Captain's intent: implement the scout's recommended path.\n\nScout report (crew ${scout.id}):\n${report}`,
              projectId: scout.projectId,
              parentThreadId: ctxThread ?? scout.parentThreadId ?? undefined,
              title: `Ship from scout ${scout.id}`,
              providerId: current.defaultProvider !== "" ? current.defaultProvider : undefined,
              permissionMode: toPermissionMode(current.defaultPermissionMode),
              worktree: true,
              visible: !flags.has("hidden"),
              shape: "ship",
              mode: toMode(flagStr(flags, "mode"), registry.mode),
            });
            await recordDone({
              task: scout.task.slice(0, 200),
              shape: "scout",
              crewId: scout.id,
              outcome: `promoted → ship ${ship.id}`,
              pr: "",
            });
            return reply({ scout: scout.id, ship: ship.id }, `Promoted scout ${scout.id} → ship ${ship.id}`);
          }
          case "supervision": {
            const sub = rest[0] ?? "status";
            if (sub === "on" || sub === "off") {
              await settings.experimental_set({ supervisionEnabled: sub === "on" });
              return reply(
                { supervision: sub },
                `Supervision ${sub}${sub === "on" ? " (done/fail via thread events; stuck checker still polls output)" : ""}`,
              );
            }
            const meta = asRecord(await bb.storage.kv.get<unknown>("watch-meta"));
            const tracked = Object.keys(asRecord(await bb.storage.kv.get<unknown>("watch"))).length;
            const lastPass = meta["lastPassAt"];
            const info = {
              enabled: current.supervisionEnabled,
              intervalMin: current.supervisionIntervalMin,
              stuckMin: current.supervisionStuckMin,
              lastPassAt: typeof lastPass === "number" ? new Date(lastPass).toISOString() : null,
              lastChecked: meta["checked"] ?? null,
              lastNotified: meta["notified"] ?? null,
              tracked,
            };
            return reply(
              info,
              [
                `supervision: ${info.enabled === true ? "on" : "off"} (events for done/fail, stuck every ${info.intervalMin}m after ${info.stuckMin}m)`,
                `last stuck pass: ${info.lastPassAt ?? "never"} checked=${info.lastChecked ?? "?"} notified=${info.lastNotified ?? "?"} tracked=${tracked}`,
              ].join("\n"),
            );
          }
          case "afk": {
            const sub = rest[0] ?? "status";
            if (sub === "on") {
              const words = flagStr(flags, "words") ?? rest.slice(1).join(" ").trim();
              await writeAfk({
                on: true,
                words,
                since: new Date().toISOString(),
                held: (await readAfk())?.held ?? [],
              });
              await settings.experimental_set({ supervisionEnabled: true });
              return reply({ afk: true, words }, "AFK on. Words recorded, not executed as authority.");
            }
            if (sub === "off") {
              const prev = await readAfk();
              await writeAfk({ on: false, words: "", since: new Date().toISOString(), held: [] });
              const snap = await bearingsSnapshot();
              const held = prev?.held ?? [];
              const text = [
                "== return brief ==",
                snap.text,
                held.length === 0 ? "Nothing held." : `Held while away:\n${held.join("\n---\n")}`,
              ].join("\n");
              return reply({ afk: false, held, bearings: snap.json }, text);
            }
            const afk = await readAfk();
            return reply(afk, `afk: ${afk?.on === true ? "on" : "off"} held=${afk?.held.length ?? 0}`);
          }
          case "quiet": {
            const sub = rest[0] ?? "status";
            if (sub === "on" || sub === "off") {
              await bb.storage.kv.set(QUIET_KEY, sub === "on");
              return reply({ quiet: sub === "on" }, `Quiet ${sub}`);
            }
            const q = await isQuiet();
            return reply({ quiet: q }, `quiet: ${q ? "on" : "off"}`);
          }
          case "secondmate": {
            const sub = rest[0] ?? "list";
            const items = await readSecondmates();
            if (sub === "list") {
              if (items.length === 0) return reply([], "No secondmates.");
              return reply(items, items.map((m) => `${m.projectId} → ${m.threadId}${m.scope !== "" ? ` (${m.scope})` : ""}`).join("\n"));
            }
            if (sub === "register") {
              const projectId = flagStr(flags, "project") ?? ctxProject;
              const threadId = flagStr(flags, "thread") ?? ctxThread;
              if (projectId === undefined || threadId === undefined) {
                return fail("Need --project and --thread (or run from that thread).");
              }
              const next = items.filter((m) => m.projectId !== projectId);
              const row: Secondmate = {
                projectId,
                threadId,
                scope: flagStr(flags, "scope") ?? "",
                createdAt: new Date().toISOString(),
              };
              next.push(row);
              await writeSecondmates(next);
              return reply(row, `Secondmate ${projectId} → ${threadId}`);
            }
            if (sub === "drop") {
              const projectId = rest[1] ?? flagStr(flags, "project");
              if (projectId === undefined) return fail("Need project id.");
              await writeSecondmates(items.filter((m) => m.projectId !== projectId));
              return reply({ dropped: projectId }, `Dropped secondmate ${projectId}`);
            }
            return fail(usage);
          }
          case "queue": {
            const sub = rest[0] ?? "list";
            const items = await readQueue();
            if (sub === "add") {
              const title = rest.slice(1).join(" ").trim();
              if (title === "") return fail(usage);
              const projectId = flagStr(flags, "project") ?? ctxProject;
              if (projectId === undefined) return fail("No project: pass --project <id>.");
              const item: QueueItem = {
                id: randomUUID().slice(0, 8),
                title: title.slice(0, 500),
                detail: (flagStr(flags, "detail") ?? "").slice(0, MAX_TASK),
                projectId,
                shape: toShape(flagStr(flags, "shape")),
                mode: flagStr(flags, "mode") ?? "",
                blockedBy: flagAll(flags, "after"),
                waitUntil: flagStr(flags, "wait-until") ?? null,
                status: "queued",
                crewId: null,
                createdAt: new Date().toISOString(),
              };
              await writeQueue([item, ...items]);
              return reply(item, `Queued ${item.id} [${item.shape}] :: ${truncate(item.title, 80)}`);
            }
            if (sub === "list") {
              if (items.length === 0) return reply([], "Queue empty.");
              const now = Date.now();
              const lines = items.map((q) => {
                const gate = q.status === "queued" ? queueGate(q, items, now) : null;
                return `${q.id} [${q.status}] ${q.shape} :: ${truncate(q.title, 70)}${gate !== null ? ` — ${gate}` : ""}${q.crewId !== null ? ` (crew ${q.crewId})` : ""}`;
              });
              return reply(items, lines.join("\n"));
            }
            if (sub === "next") {
              const now = Date.now();
              const open = items.filter((q) => q.status === "queued" && queueGate(q, items, now) === null);
              if (open.length === 0) return reply([], "Nothing dispatchable.");
              const first = [...open].reverse()[0] as QueueItem;
              return reply(first, `${first.id} [${first.shape}] ${first.projectId} :: ${first.title}\nDispatch: bb firstmate queue dispatch ${first.id}`);
            }
            if (sub === "dispatch") {
              const qid = rest[1];
              const item = items.find((q) => q.id === qid);
              if (qid === undefined || item === undefined) return fail(`No queued item ${qid ?? ""}.`);
              const gate = queueGate(item, items, Date.now());
              if (gate !== null) return fail(`Item ${qid} gated: ${gate}.`);
              const registry = await postureOf(item.projectId);
              const brief = item.detail !== "" ? `${item.title}\n\n${item.detail}` : item.title;
              const crew = await dispatchCrew({
                task: brief,
                projectId: item.projectId,
                parentThreadId: ctxThread,
                title: `Crew: ${truncate(item.title, 60)}`,
                providerId: flagStr(flags, "provider") ?? (current.defaultProvider !== "" ? current.defaultProvider : undefined),
                model: flagStr(flags, "model"),
                permissionMode: toPermissionMode(flagStr(flags, "permission-mode") ?? current.defaultPermissionMode),
                worktree: resolveWorktree({ shape: item.shape, sharedEnv: flags.has("shared-env"), worktreeFlag: flags.has("worktree") }).worktree,
                visible: !flags.has("hidden"),
                shape: item.shape,
                mode: toMode(item.mode !== "" ? item.mode : undefined, registry.mode),
              });
              item.status = "dispatched";
              item.crewId = crew.id;
              await writeQueue(items);
              return reply({ ...crew, status: await crewStatus(crew), queueId: qid }, `Dispatched queue ${qid} as ${crew.shape} crew ${crew.id}`);
            }
            if (sub === "drop" || sub === "done") {
              const qid = rest[1];
              const item = items.find((q) => q.id === qid);
              if (qid === undefined || item === undefined) return fail(`No queued item ${qid ?? ""}.`);
              item.status = sub === "drop" ? "dropped" : "done";
              await writeQueue(items);
              return reply({ id: qid, status: item.status }, `Queue ${qid} ${item.status}`);
            }
            return fail(usage);
          }
          case "decide": {
            const sub = rest[0] ?? "list";
            const all = await readDecisions();
            if (sub === "ask") {
              const question = rest.slice(1).join(" ").trim();
              if (question === "") return fail(usage);
              const d: Decision = {
                id: randomUUID().slice(0, 8),
                question: question.slice(0, 500),
                options: flagAll(flags, "option").slice(0, 10),
                context: flagStr(flags, "context") ?? "",
                crewId: flagStr(flags, "crew") ?? null,
                status: "open",
                deferredUntil: null,
                answer: "",
                createdAt: new Date().toISOString(),
              };
              await writeDecisions([d, ...all]);
              return reply(
                d,
                `Decision ${d.id}: ${truncate(question, 100)}${d.options.length > 0 ? `\nOptions: ${d.options.join(" / ")}` : ""}\nAsk the captain with AskUserQuestion, then: bb firstmate decide answer ${d.id} -- "<answer>"`,
              );
            }
            if (sub === "list") {
              if (all.length === 0) return reply([], "No decisions.");
              const now = Date.now();
              const fmt = (d: Decision) =>
                `${d.id} [${d.status}] :: ${truncate(d.question, 80)}${d.options.length > 0 ? ` (${d.options.join(" / ")})` : ""}`;
              return reply(all, ["== Due ==", ...all.filter((d) => decisionDue(d, now)).map(fmt), "== Waiting ==", ...all.filter((d) => !decisionDue(d, now) && d.status !== "answered").map(fmt)].join("\n"));
            }
            if (sub === "answer") {
              const did = rest[1];
              const answer = (flagStr(flags, "message") ?? rest.slice(2).join(" ")).trim();
              const d = all.find((x) => x.id === did);
              if (did === undefined || d === undefined) return fail(`No decision ${did ?? ""}.`);
              if (answer === "") return fail(usage);
              d.status = "answered";
              d.answer = answer.slice(0, 500);
              await writeDecisions(all);
              let told = "";
              if (d.crewId !== null) {
                const crew = await findCrew(d.crewId);
                if (crew !== undefined) {
                  await bb.sdk.threads.send({
                    threadId: crew.threadId,
                    mode: "steer",
                    input: [{ type: "text", text: `Captain's decision: ${answer.slice(0, MAX_TASK)}`, mentions: [] }],
                  });
                  told = ` (told crew ${d.crewId})`;
                }
              }
              return reply({ answered: true, id: did }, `Answered ${did}${told}`);
            }
            if (sub === "defer") {
              const did = rest[1];
              const d = all.find((x) => x.id === did);
              if (did === undefined || d === undefined) return fail(`No decision ${did ?? ""}.`);
              d.status = "deferred";
              d.deferredUntil = flagStr(flags, "until") ?? null;
              await writeDecisions(all);
              return reply({ deferred: true, id: did }, `Deferred ${did}`);
            }
            if (sub === "drop") {
              const did = rest[1];
              if (did === undefined) return fail(usage);
              await writeDecisions(all.filter((x) => x.id !== did));
              return reply({ dropped: true, id: did }, `Dropped decision ${did}`);
            }
            return fail(usage);
          }
          case "posture": {
            const sub = rest[0];
            if (sub === "set") {
              const projectId = flagStr(flags, "project") ?? ctxProject;
              if (projectId === undefined) return fail("No project: pass --project <id>.");
              const all = await readPostures();
              const cur = all[projectId] ?? { mode: "direct-PR" as DeliveryMode, yolo: false };
              const mode = toMode(flagStr(flags, "mode"), cur.mode);
              const yoloRaw = flagStr(flags, "yolo");
              const yolo = yoloRaw === undefined ? cur.yolo : yoloRaw === "on" || yoloRaw === "true";
              all[projectId] = { mode, yolo };
              await bb.storage.kv.set(POSTURES_KEY, all);
              return reply({ projectId, mode, yolo }, `Posture ${projectId}: ${mode}${yolo ? "+yolo" : ""}`);
            }
            const all = await readPostures();
            const projectId = flagStr(flags, "project") ?? ctxProject ?? null;
            if (projectId !== null) {
              const p = all[projectId] ?? { mode: "direct-PR" as DeliveryMode, yolo: false };
              return reply({ projectId, ...p }, `Posture ${projectId}: ${p.mode}${p.yolo ? "+yolo" : ""}`);
            }
            const keys = Object.keys(all);
            if (keys.length === 0) return reply({}, "No postures set (default everywhere: direct-PR, yolo off).");
            return reply(all, keys.map((k) => `${k}: ${all[k]?.mode}${all[k]?.yolo ? "+yolo" : ""}`).join("\n"));
          }
          case "memory": {
            const sub = rest[0] ?? "show";
            if (sub === "show") {
              const cap = await bb.storage.kv.get<unknown>(MEM_CAPTAIN_KEY);
              const learn = await bb.storage.kv.get<unknown>(MEM_LEARNINGS_KEY);
              const capText = typeof cap === "string" ? cap : "";
              const learnText = typeof learn === "string" ? learn : "";
              return reply(
                { captain: capText, learnings: learnText },
                `== captain ==\n${capText !== "" ? capText : "(empty)"}\n== learnings ==\n${learnText !== "" ? learnText : "(empty)"}`,
              );
            }
            if (sub === "set-captain") {
              const text = rest.slice(1).join(" ").trim();
              if (text === "") return fail(usage);
              await bb.storage.kv.set(MEM_CAPTAIN_KEY, text.slice(0, 4000));
              return reply({ set: true }, "Captain preferences saved.");
            }
            if (sub === "add-learning") {
              const text = rest.slice(1).join(" ").trim();
              if (text === "") return fail(usage);
              const prev = await bb.storage.kv.get<unknown>(MEM_LEARNINGS_KEY);
              const line = `- ${new Date().toISOString().slice(0, 10)}: ${text}`;
              const next = `${typeof prev === "string" && prev !== "" ? `${prev}\n` : ""}${line}`.slice(-4000);
              await bb.storage.kv.set(MEM_LEARNINGS_KEY, next);
              return reply({ added: true }, "Learning stored.");
            }
            if (sub === "drop-learning") {
              const n = Number(rest[1]);
              const prev = await bb.storage.kv.get<unknown>(MEM_LEARNINGS_KEY);
              const lines = typeof prev === "string" ? prev.split("\n").filter((l) => l !== "") : [];
              if (!Number.isInteger(n) || n < 1 || n > lines.length) return fail(`No learning #${rest[1] ?? ""} (1-${lines.length}).`);
              lines.splice(n - 1, 1);
              await bb.storage.kv.set(MEM_LEARNINGS_KEY, lines.join("\n"));
              return reply({ dropped: true }, `Dropped learning #${n}.`);
            }
            if (sub === "clear") {
              const which = rest[1];
              if (which !== "captain" && which !== "learnings") return fail(usage);
              await bb.storage.kv.set(which === "captain" ? MEM_CAPTAIN_KEY : MEM_LEARNINGS_KEY, "");
              return reply({ cleared: true }, `Cleared ${which}.`);
            }
            return fail(usage);
          }
          case "forget": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const text = await forgetCrew(id, flags.has("stop"), flags.has("force"));
            return reply({ forgotten: true, id }, text);
          }
          default:
            return fail(usage);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : "failed");
      }
    },
  });

  bb.background.service("crew-watch", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          const s = await settings.get();
          if (s.supervisionEnabled === true) await stuckPass();
        } catch (error) {
          bb.log.warn(error instanceof Error ? `supervise: ${error.message}` : "supervise failed");
        }
        const s = await settings.get().catch(() => null);
        const mins = s === null ? 5 : Math.min(60, Math.max(1, Number(s.supervisionIntervalMin) || 5));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, mins * 60000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  bb.onDispose(() => {
    for (const timer of nudgeTimers.values()) clearTimeout(timer);
    nudgeTimers.clear();
    bb.log.info("disposed");
  });
}
