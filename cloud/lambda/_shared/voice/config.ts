/**
 * Voice-conversation settings: defaults, overrides and validation (design table "Cloud settings").
 *
 * Pure module, no AWS imports. Same override order as `../config.ts`, highest first:
 * environment variable `WARASHI_<UPPER_SNAKE>`, CDK context key (the setting name), default.
 *
 * Three settings are clamped on read instead of rejected (R6.14): `maxSeconds` (30..420),
 * `silenceSeconds` and `noClientSeconds` (5..60). Every other out-of-range value throws a
 * `ConfigError` that names the setting and the value.
 */

import { ConfigError, envName, type ConfigSource } from "../config.js";

export interface VoiceGazeLimits {
  panDeg: number; // 0..60
  tiltDeg: number; // 0..30
}

export interface PerUserPerDay {
  family: number;
  reviewer: number; // 0..2 (R15.2)
}

export interface VoiceConfig {
  voiceEnabled: boolean;
  voiceModelId: string;
  voiceId: string;
  maxSeconds: number;
  silenceSeconds: number;
  noClientSeconds: number;
  recheckSeconds: number;
  lookTimeoutSeconds: number;
  maxLooksPerSession: number;
  maxToolCalls: number;
  maxGazeCommands: number;
  gazeMinIntervalMs: number;
  voiceGazeLimits: VoiceGazeLimits;
  chunkMs: number;
  reorderWindow: number;
  grantWindowSeconds: number;
  perUserPerDay: PerUserPerDay;
  deviceStartsPerDay: number;
  globalPerDay: number;
  maxConcurrent: number;
  reviewerVoiceEnabled: boolean;
  blockedWords: string[];
}

// OPEN DECISION (R15.1): reviewers get no voice access until the owner turns it on.
const DEFAULT_REVIEWER_VOICE_ENABLED = false;
// OPEN DECISION (R15.2): a reviewer may start at most 2 sessions per UTC day.
const REVIEWER_PER_DAY_DEFAULT = 2;
const REVIEWER_PER_DAY_MAX = 2;
// OPEN DECISION (R15.6): voice and model stay open until the listening test.
const DEFAULT_VOICE_ID = "tiffany";
const DEFAULT_VOICE_MODEL_ID = "amazon.nova-2-5-sonic";

/** Hard ceilings for tool-driven head moves, from the hardware rules (pan 60, tilt 30). */
const GAZE_PAN_MAX = 60;
const GAZE_TILT_MAX = 30;

export const DEFAULT_VOICE_CONFIG: Readonly<VoiceConfig> = Object.freeze({
  voiceEnabled: false,
  voiceModelId: DEFAULT_VOICE_MODEL_ID,
  voiceId: DEFAULT_VOICE_ID,
  maxSeconds: 180,
  silenceSeconds: 15,
  noClientSeconds: 15,
  recheckSeconds: 30,
  lookTimeoutSeconds: 8,
  maxLooksPerSession: 3,
  maxToolCalls: 20,
  maxGazeCommands: 12,
  gazeMinIntervalMs: 1000,
  voiceGazeLimits: Object.freeze({ panDeg: 30, tiltDeg: 20 }),
  chunkMs: 100,
  reorderWindow: 3,
  grantWindowSeconds: 60,
  perUserPerDay: Object.freeze({ family: 10, reviewer: REVIEWER_PER_DAY_DEFAULT }),
  deviceStartsPerDay: 20,
  globalPerDay: 40,
  maxConcurrent: 3,
  reviewerVoiceEnabled: DEFAULT_REVIEWER_VOICE_ENABLED,
  blockedWords: Object.freeze([]) as unknown as string[],
});

interface Range {
  min: number;
  max: number;
  integer?: boolean;
}

/** Settings that are clamped to their range on read (R6.14). */
const CLAMPED = {
  maxSeconds: { min: 30, max: 420 },
  silenceSeconds: { min: 5, max: 60 },
  noClientSeconds: { min: 5, max: 60 },
} as const satisfies Record<string, Range>;

/** Settings that are rejected when out of range. */
const REJECTED = {
  lookTimeoutSeconds: { min: 2, max: 15, integer: true },
  maxLooksPerSession: { min: 0, max: 10, integer: true },
  maxToolCalls: { min: 1, max: 100, integer: true },
  maxGazeCommands: { min: 0, max: 60, integer: true },
  gazeMinIntervalMs: { min: 200, max: 10_000, integer: true },
  chunkMs: { min: 60, max: 200, integer: true },
  reorderWindow: { min: 1, max: 8, integer: true },
  grantWindowSeconds: { min: 10, max: 300, integer: true },
  deviceStartsPerDay: { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
  globalPerDay: { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
  maxConcurrent: { min: 1, max: 10, integer: true },
} as const satisfies Record<string, Range>;

/** First non-empty value wins: environment, then context. */
function pick(setting: string, env: ConfigSource, context: ConfigSource): unknown {
  for (const raw of [env[envName(setting)], context[setting]]) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "string" && raw.trim() === "") continue;
    return raw;
  }
  return undefined;
}

function toNumber(setting: string, raw: unknown): number {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string") n = Number(raw.trim());
  else throw new ConfigError(setting, raw, "not a number");
  if (!Number.isFinite(n)) throw new ConfigError(setting, raw, "not a finite number");
  return n;
}

/** Reads a number with its range check. Returns `fallback` when no source sets it. */
function readRanged(
  setting: string,
  range: Range,
  fallback: number,
  env: ConfigSource,
  context: ConfigSource,
): number {
  const raw = pick(setting, env, context);
  if (raw === undefined) return fallback;
  const n = toNumber(setting, raw);
  if (range.integer && !Number.isInteger(n)) throw new ConfigError(setting, raw, "must be an integer");
  if (n < range.min || n > range.max) {
    const upper = range.max === Number.MAX_SAFE_INTEGER ? "" : ` to ${range.max}`;
    throw new ConfigError(setting, raw, upper ? `must be from ${range.min}${upper}` : `must be at least ${range.min}`);
  }
  return n;
}

function readClamped(
  setting: keyof typeof CLAMPED,
  fallback: number,
  env: ConfigSource,
  context: ConfigSource,
): number {
  const raw = pick(setting, env, context);
  if (raw === undefined) return fallback;
  const n = toNumber(setting, raw);
  const { min, max } = CLAMPED[setting];
  return Math.min(max, Math.max(min, n));
}

function readBoolean(setting: string, fallback: boolean, env: ConfigSource, context: ConfigSource): boolean {
  const raw = pick(setting, env, context);
  if (raw === undefined) return fallback;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  throw new ConfigError(setting, raw, 'must be "true" or "false"');
}

function readNonEmptyString(setting: string, fallback: string, env: ConfigSource, context: ConfigSource): string {
  const raw = pick(setting, env, context);
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || raw.trim() === "") throw new ConfigError(setting, raw, "must be a non-empty string");
  return raw.trim();
}

/** `recheckSeconds` is 0 (off) or 10 to 120. */
function readRecheck(env: ConfigSource, context: ConfigSource): number {
  const setting = "recheckSeconds";
  const raw = pick(setting, env, context);
  if (raw === undefined) return DEFAULT_VOICE_CONFIG.recheckSeconds;
  const n = toNumber(setting, raw);
  if (!Number.isInteger(n)) throw new ConfigError(setting, raw, "must be an integer");
  if (n !== 0 && (n < 10 || n > 120)) throw new ConfigError(setting, raw, "must be 0 or from 10 to 120");
  return n;
}

/** A comma-separated string (environment) or an array of strings (context). Empty entries are dropped. */
function readBlockedWords(env: ConfigSource, context: ConfigSource): string[] {
  const setting = "blockedWords";
  const raw = pick(setting, env, context);
  if (raw === undefined) return [];
  let items: unknown[];
  if (typeof raw === "string") items = raw.split(",");
  else if (Array.isArray(raw)) items = raw;
  else throw new ConfigError(setting, raw, "must be a list of words");
  const words: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") throw new ConfigError(setting, item, "every word must be a string");
    const word = item.trim();
    if (word !== "") words.push(word);
  }
  return words;
}

/**
 * Builds the validated voice configuration. Throws `ConfigError` for the first invalid setting.
 *
 * @param env normally `process.env`.
 * @param context CDK context values merged into one object.
 */
export function loadVoiceConfig(env: ConfigSource = {}, context: ConfigSource = {}): VoiceConfig {
  const d = DEFAULT_VOICE_CONFIG;
  const rejected = {} as Record<keyof typeof REJECTED, number>;
  for (const setting of Object.keys(REJECTED) as (keyof typeof REJECTED)[]) {
    rejected[setting] = readRanged(setting, REJECTED[setting], d[setting], env, context);
  }
  return {
    voiceEnabled: readBoolean("voiceEnabled", d.voiceEnabled, env, context),
    voiceModelId: readNonEmptyString("voiceModelId", d.voiceModelId, env, context),
    voiceId: readNonEmptyString("voiceId", d.voiceId, env, context),
    maxSeconds: readClamped("maxSeconds", d.maxSeconds, env, context),
    silenceSeconds: readClamped("silenceSeconds", d.silenceSeconds, env, context),
    noClientSeconds: readClamped("noClientSeconds", d.noClientSeconds, env, context),
    recheckSeconds: readRecheck(env, context),
    ...rejected,
    voiceGazeLimits: {
      panDeg: readRanged(
        "voiceGazePanDeg",
        { min: 0, max: GAZE_PAN_MAX },
        d.voiceGazeLimits.panDeg,
        env,
        context,
      ),
      tiltDeg: readRanged(
        "voiceGazeTiltDeg",
        { min: 0, max: GAZE_TILT_MAX },
        d.voiceGazeLimits.tiltDeg,
        env,
        context,
      ),
    },
    perUserPerDay: {
      family: readRanged(
        "perUserPerDayFamily",
        { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
        d.perUserPerDay.family,
        env,
        context,
      ),
      reviewer: readRanged(
        "perUserPerDayReviewer",
        { min: 0, max: REVIEWER_PER_DAY_MAX, integer: true },
        d.perUserPerDay.reviewer,
        env,
        context,
      ),
    },
    reviewerVoiceEnabled: readBoolean("reviewerVoiceEnabled", d.reviewerVoiceEnabled, env, context),
    blockedWords: readBlockedWords(env, context),
  };
}

export { ConfigError };
