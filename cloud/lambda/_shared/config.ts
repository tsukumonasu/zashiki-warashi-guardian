/**
 * Tunable cloud settings: defaults, overrides and validation (R27.1 to R27.3).
 *
 * Pure module. The environment and the CDK context are passed in, so the same code runs at
 * synth time (CDK context plus process env) and at Lambda start-up (environment only).
 *
 * Override order, highest first: environment variable, CDK context, default (R27.2).
 * Environment variable names are `WARASHI_` plus the setting name in UPPER_SNAKE_CASE
 * (for example `WARASHI_SEARCH_FLOOR`). CDK context keys are the setting names themselves.
 */

export type ReviewerRealEncounters = "redacted" | "hidden";

export interface CloudConfig {
  // Verdict thresholds (design, verdict.ts `VerdictConfig`).
  searchFloor: number; // FaceMatchThreshold sent to Rekognition, 0..100
  familyMin: number; // best similarity at or above this is family, 0..100
  strangerMax: number; // best similarity below this may be stranger, 0..100
  faceConfidenceMin: number; // 0..100
  minFaceWidth: number; // fraction of image width, 0..1
  minSharpness: number; // 0..255
  minBrightness: number; // 0..255
  maxYawDeg: number; // 0..90
  acceptMin: number; // device accept threshold mirror, 0..1
  // Notification, retention and visibility.
  notifyWindowMs: number; // integer 0..86,400,000
  snapshotExpiryDays: number; // integer 1..7
  reviewerRealEncounters: ReviewerRealEncounters;
  // Device status (R12.4).
  statusIntervalS: number; // integer 1..3600; online window is 3 x this value
  // Rate limits of POST /simulate (R15.11), integers of at least 1.
  reviewerSimulatePerHour: number;
  reviewerGeneratePerHour: number;
  familySimulatePerHour: number;
  familyGeneratePerHour: number;
  globalSimulatePerDay: number;
}

export type ConfigSource = Readonly<Record<string, unknown>>;

export const DEFAULT_CONFIG: Readonly<CloudConfig> = Object.freeze({
  searchFloor: 50,
  familyMin: 90,
  strangerMax: 70,
  faceConfidenceMin: 90,
  minFaceWidth: 0.08,
  minSharpness: 30,
  minBrightness: 25,
  maxYawDeg: 40,
  acceptMin: 0.8,
  notifyWindowMs: 600_000,
  snapshotExpiryDays: 3,
  reviewerRealEncounters: "redacted",
  statusIntervalS: 60,
  reviewerSimulatePerHour: 20,
  reviewerGeneratePerHour: 3,
  familySimulatePerHour: 100,
  // R15.11 gives no family generation default; this value is a conservative choice.
  familyGeneratePerHour: 20,
  globalSimulatePerDay: 300,
});

/** Thrown for any invalid setting. The message names the setting and the invalid value. */
export class ConfigError extends Error {
  readonly setting: string;
  readonly value: unknown;
  constructor(setting: string, value: unknown, detail: string) {
    super(`Invalid configuration: ${setting} = ${describe(value)} (${detail})`);
    this.name = "ConfigError";
    this.setting = setting;
    this.value = value;
  }
}

type NumberRule = { min: number; max: number; integer: boolean };

const NUMBER_RULES: Record<Exclude<keyof CloudConfig, "reviewerRealEncounters">, NumberRule> = {
  searchFloor: { min: 0, max: 100, integer: false },
  familyMin: { min: 0, max: 100, integer: false },
  strangerMax: { min: 0, max: 100, integer: false },
  faceConfidenceMin: { min: 0, max: 100, integer: false },
  minFaceWidth: { min: 0, max: 1, integer: false },
  minSharpness: { min: 0, max: 255, integer: false },
  minBrightness: { min: 0, max: 255, integer: false },
  maxYawDeg: { min: 0, max: 90, integer: false },
  acceptMin: { min: 0, max: 1, integer: false },
  notifyWindowMs: { min: 0, max: 86_400_000, integer: true },
  snapshotExpiryDays: { min: 1, max: 7, integer: true },
  statusIntervalS: { min: 1, max: 3600, integer: true },
  reviewerSimulatePerHour: { min: 1, max: 1_000_000, integer: true },
  reviewerGeneratePerHour: { min: 1, max: 1_000_000, integer: true },
  familySimulatePerHour: { min: 1, max: 1_000_000, integer: true },
  familyGeneratePerHour: { min: 1, max: 1_000_000, integer: true },
  globalSimulatePerDay: { min: 1, max: 1_000_000, integer: true },
};

/** `searchFloor` becomes `WARASHI_SEARCH_FLOOR`. */
export function envName(setting: string): string {
  return "WARASHI_" + setting.replace(/([A-Z])/g, "_$1").toUpperCase();
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 60 ? value.slice(0, 60) + "..." : value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return String(value);
  }
  return `<${typeof value}>`;
}

/** First source that holds a non-empty value wins: environment, then context. */
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

function readNumber(
  setting: keyof typeof NUMBER_RULES,
  env: ConfigSource,
  context: ConfigSource,
): number {
  const raw = pick(setting, env, context);
  if (raw === undefined) return DEFAULT_CONFIG[setting];
  const rule = NUMBER_RULES[setting];
  const n = toNumber(setting, raw);
  if (rule.integer && !Number.isInteger(n)) throw new ConfigError(setting, raw, "must be an integer");
  if (n < rule.min || n > rule.max) {
    throw new ConfigError(setting, raw, `must be from ${rule.min} to ${rule.max}`);
  }
  return n;
}

function readReviewerMode(env: ConfigSource, context: ConfigSource): ReviewerRealEncounters {
  const raw = pick("reviewerRealEncounters", env, context);
  if (raw === undefined) return DEFAULT_CONFIG.reviewerRealEncounters;
  if (raw === "redacted" || raw === "hidden") return raw;
  throw new ConfigError("reviewerRealEncounters", raw, 'must be "redacted" or "hidden"');
}

/**
 * Builds the validated configuration. Throws `ConfigError` for the first invalid setting.
 *
 * @param env CDK-independent environment, normally `process.env`.
 * @param context CDK context values (`node.tryGetContext`) merged into one object.
 */
export function loadConfig(env: ConfigSource = {}, context: ConfigSource = {}): CloudConfig {
  const numbers = {} as Record<keyof typeof NUMBER_RULES, number>;
  for (const setting of Object.keys(NUMBER_RULES) as (keyof typeof NUMBER_RULES)[]) {
    numbers[setting] = readNumber(setting, env, context);
  }
  const config: CloudConfig = {
    ...numbers,
    reviewerRealEncounters: readReviewerMode(env, context),
  };
  checkOrdering(config);
  return config;
}

/** searchFloor <= strangerMax <= familyMin <= 100 (R5.16, R27.3). */
export function checkOrdering(c: Pick<CloudConfig, "searchFloor" | "strangerMax" | "familyMin">): void {
  if (c.strangerMax > c.familyMin) {
    throw new ConfigError("strangerMax", c.strangerMax, `must not exceed familyMin (${c.familyMin})`);
  }
  if (c.searchFloor > c.strangerMax) {
    throw new ConfigError("searchFloor", c.searchFloor, `must not exceed strangerMax (${c.strangerMax})`);
  }
}
