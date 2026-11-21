/**
 * Tool dispatcher of a voice session (design, "Tool dispatch").
 *
 * Pure and total: `toolToCommand` never throws. It maps a tool name and the model's JSON input to
 * either a command envelope (the existing `gaze` / `lantern` commands, or `snapshot.request`) or
 * an error result for the model. Head angles are clamped to `cfg.voiceGazeLimits`, and also to the
 * hardware ceilings (pan 60, tilt 30), so a bad config can never widen the range.
 *
 * Time, ids and the session counters come in through `ToolContext`; nothing here reads a clock.
 * A result for the model holds only `ok`, the clamped angles, `who` or an error code. It never
 * holds a name, an id, a confidence or a face box.
 */

import { makeCommand, type Envelope } from "../messages.js";
import type { LookVerdict } from "./frames.js";
import type { VoiceConfig } from "./config.js";

export type ToolName = "turn_head" | "set_lantern" | "look";

/** Session state the dispatcher needs. The session runner owns and updates it. */
export interface ToolContext {
  /** Current time in epoch milliseconds. */
  readonly nowMs: number;
  /** Tool calls handled so far in this session. */
  readonly toolCalls: number;
  /** Non-silent `look` calls so far. */
  readonly looks: number;
  /** Head commands sent so far. */
  readonly gazeCommands: number;
  /** Time of the last head command, or `null` when none was sent. */
  readonly lastGazeAtMs: number | null;
  /** False when the doll is asleep, offline or unknown. */
  readonly dollReachable: boolean;
  /** Target doll of the commands. */
  readonly deviceId: string;
  /** Returns a fresh UUID; used for envelope ids and the `look` request id. */
  readonly newId: () => string;
}

export type ToolOutcome =
  | { kind: "command"; envelopes: readonly Envelope[]; result: object } // result goes to the model
  | { kind: "look"; requestId: string; envelope: Envelope }
  | { kind: "error"; result: { ok: false; error: string } };

export interface ToolSpec {
  toolSpec: {
    name: ToolName;
    description: string;
    inputSchema: { json: object };
  };
}

export type LookWho = "family" | "stranger" | "nobody" | "unsure";

/** Hardware ceilings (hardware.md): the config loader enforces the same values. */
const HARD_PAN_DEG = 60;
const HARD_TILT_DEG = 30;
const DEFAULT_FADE_MS = 1200;
const MAX_FADE_MS = 10_000;

/** Absolute angles from the calibrated center (pan, tilt). Negative pan is the doll's left. */
const DIRECTION_TABLE: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  left: [-20, 0],
  right: [20, 0],
  up: [0, 12],
  down: [0, -8],
  center: [0, 0],
});

export const TOOL_SPECS: readonly ToolSpec[] = Object.freeze([
  {
    toolSpec: {
      name: "turn_head",
      description:
        "Turn the doll's head toward a direction, or to exact angles in degrees from the center. " +
        "Use it when the person asks you to look somewhere, or when it fits the moment.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            direction: { type: "string", enum: ["left", "right", "up", "down", "center"] },
            pan_deg: { type: "number", description: "Degrees from the center. Positive is the doll's right." },
            tilt_deg: { type: "number", description: "Degrees from the center. Positive looks up." },
          },
        },
      },
    },
  },
  {
    toolSpec: {
      name: "set_lantern",
      description: "Set the lantern brightness from 0 (off) to 1 (full).",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            level: { type: "number", minimum: 0, maximum: 1 },
            fade_ms: { type: "integer", minimum: 0, maximum: 10000 },
          },
          required: ["level"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "look",
      description:
        "Look through the doll's eyes and learn who is in front of it. " +
        "Returns family, stranger, nobody or unsure. Use it only when asked who is there.",
      inputSchema: { json: { type: "object", properties: {} } },
    },
  },
]);

function error(code: string): ToolOutcome {
  return { kind: "error", result: { ok: false, error: code } };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** A usable limit: finite, at least 0, never above the hardware ceiling. */
function limit(value: number, ceiling: number): number {
  return Number.isFinite(value) ? clamp(value, 0, ceiling) : 0;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Normalizes `-0` to `0` so results compare and serialize cleanly. */
function noNegZero(n: number): number {
  return n === 0 ? 0 : n;
}

function parseInput(inputJson: string): { ok: true; value: unknown } | { ok: false } {
  if (typeof inputJson !== "string") return { ok: false };
  // Some models send an empty string for a tool without arguments.
  const text = inputJson.trim() === "" ? "{}" : inputJson;
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Maps one tool call to a command or an error result. Total: never throws.
 *
 * Check order: JSON, `too_many_calls`, tool name, `doll_unavailable`, then the per-tool limits and
 * arguments. The caller counts the call (`toolCalls`, `looks`, `gazeCommands`, `lastGazeAtMs`)
 * only when the outcome is not an error.
 */
export function toolToCommand(name: string, inputJson: string, ctx: ToolContext, cfg: VoiceConfig): ToolOutcome {
  try {
    const parsed = parseInput(inputJson);
    if (!parsed.ok) return error("bad_arguments");
    if (ctx.toolCalls >= cfg.maxToolCalls) return error("too_many_calls");
    if (name !== "turn_head" && name !== "set_lantern" && name !== "look") return error("unknown_tool");
    // All three tools act on the doll, so none can run while it is asleep or offline.
    if (!ctx.dollReachable) return error("doll_unavailable");
    const args = asRecord(parsed.value);
    const envCtx = () => ({ id: ctx.newId(), now: new Date(ctx.nowMs), deviceId: ctx.deviceId, encounterId: null });

    switch (name) {
      case "turn_head": {
        if (ctx.gazeCommands >= cfg.maxGazeCommands) return error("too_many_moves");
        if (ctx.lastGazeAtMs !== null && ctx.nowMs - ctx.lastGazeAtMs < cfg.gazeMinIntervalMs) {
          return error("too_fast");
        }
        if (args === undefined) return error("bad_arguments");
        let pan: number;
        let tilt: number;
        const direction = args.direction;
        if (typeof direction === "string" && Object.hasOwn(DIRECTION_TABLE, direction)) {
          [pan, tilt] = DIRECTION_TABLE[direction] as readonly [number, number];
        } else {
          const p = finiteNumber(args.pan_deg);
          const t = finiteNumber(args.tilt_deg);
          if (p === undefined && t === undefined) return error("bad_arguments");
          pan = p ?? 0;
          tilt = t ?? 0;
        }
        const panLimit = limit(cfg.voiceGazeLimits.panDeg, HARD_PAN_DEG);
        const tiltLimit = limit(cfg.voiceGazeLimits.tiltDeg, HARD_TILT_DEG);
        const panDeg = noNegZero(clamp(pan, -panLimit, panLimit));
        const tiltDeg = noNegZero(clamp(tilt, -tiltLimit, tiltLimit));
        const envelope = makeCommand("gaze", { panDeg, tiltDeg }, envCtx());
        return { kind: "command", envelopes: [envelope], result: { ok: true, pan: panDeg, tilt: tiltDeg } };
      }
      case "set_lantern": {
        if (args === undefined) return error("bad_arguments");
        const level = finiteNumber(args.level);
        if (level === undefined) return error("bad_arguments");
        const fade = finiteNumber(args.fade_ms) ?? DEFAULT_FADE_MS;
        const data = {
          level: noNegZero(clamp(level, 0, 1)),
          fadeMs: noNegZero(clamp(Math.round(fade), 0, MAX_FADE_MS)),
        };
        const envelope = makeCommand("lantern", data, envCtx());
        return { kind: "command", envelopes: [envelope], result: { ok: true } };
      }
      case "look": {
        if (ctx.looks >= cfg.maxLooksPerSession) return error("too_many_looks");
        const requestId = ctx.newId();
        const envelope = makeCommand("snapshot.request", { requestId }, envCtx());
        return { kind: "look", requestId, envelope };
      }
    }
  } catch {
    // Total by contract: an unexpected failure (for example an invalid clock) is an error result.
    return error("internal");
  }
}

/** What the model learns from a `look`: never a confidence, a face box, a name or an id. */
export function lookResultForModel(v: LookVerdict | "timeout"): { who: LookWho } {
  switch (v) {
    case "family":
      return { who: "family" };
    case "stranger":
      return { who: "stranger" };
    case "no_face":
      return { who: "nobody" };
    default:
      return { who: "unsure" };
  }
}

export interface ToolResultEntry {
  readonly toolUseId: string;
  readonly result: object;
}

/**
 * Builds exactly one result per distinct `toolUse` id, in first-seen order. An id without a
 * recorded result (error, rejection, session ending) gets `{ ok: false, error: fallbackError }`,
 * so the model is never left waiting (design V12).
 */
export function toolResultsFor(
  toolUseIds: readonly string[],
  results: ReadonlyMap<string, object>,
  fallbackError = "not_available",
): ToolResultEntry[] {
  const seen = new Set<string>();
  const out: ToolResultEntry[] = [];
  for (const id of toolUseIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ toolUseId: id, result: results.get(id) ?? { ok: false, error: fallbackError } });
  }
  return out;
}
