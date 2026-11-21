import type { SimConfig } from "./types";

/** Hard limits: the camera ribbon and servo leads run through the neck (hardware rules). */
export const HARD_PAN_LIMIT = 60;
export const HARD_TILT_LIMIT = 30;
export const MAX_GLIDE_STEP_DEG = 2;
export const MIN_GLIDE_INTERVAL_MS = 30;

export const DEFAULT_CONFIG: SimConfig = {
  panLimit: 30,
  tiltLimit: 20,
  // D8: slow motion, 20 deg/s. Device rule: step <= 2, interval >= 30.
  glideStepDeg: 1,
  glideIntervalMs: 50,
  nodDeg: 8,
  lanternWakeLevel: 0.8,
  lanternFadeInMs: 1500,
  lanternFadeOutMs: 2000,
  wakingTimeoutS: 3,
  verdictTimeoutS: 8,
  glideTimeoutS: 3,
  stareS: 2,
  audioTimeoutS: 12,
  // D7: the smallest value the device accepts with its defaults (3 + 2); device default is 20.
  cooldownS: 5,
  scanPanPositionsDeg: [-15, 15, 0],
  scanAttemptsMax: 3,
  cameraHfovDeg: 54,
  cameraVfovDeg: 41.8,
  familyConfidenceMin: 0.8,
  strangerConfidenceMin: 0.8,
  dedupWindowSize: 256,
  deviceId: "warashi-sim",
  conversationEnabled: false,
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Returns a full config. Every value of the wrong type or breaking a safety rule is replaced by
 * its default, so a bad config can never move the head beyond the real limits.
 */
export function validateConfig(partial: Partial<SimConfig> = {}): SimConfig {
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG };
  const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  const input = (partial ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(defaults)) {
    const value = input[key];
    const def = defaults[key];
    if (value === undefined) continue;
    if (typeof def === "number") {
      if (isFiniteNumber(value)) merged[key] = value;
    } else if (typeof def === "string") {
      if (typeof value === "string" && value.length > 0) merged[key] = value;
    } else if (typeof def === "boolean") {
      if (typeof value === "boolean") merged[key] = value;
    } else if (Array.isArray(def)) {
      if (Array.isArray(value) && value.length > 0 && value.every(isFiniteNumber)) {
        merged[key] = [...value];
      }
    }
  }
  const cfg = merged as unknown as SimConfig;
  cfg.scanPanPositionsDeg = [...cfg.scanPanPositionsDeg];

  if (!(cfg.panLimit >= 0 && cfg.panLimit <= HARD_PAN_LIMIT)) cfg.panLimit = DEFAULT_CONFIG.panLimit;
  if (!(cfg.tiltLimit >= 0 && cfg.tiltLimit <= HARD_TILT_LIMIT)) {
    cfg.tiltLimit = DEFAULT_CONFIG.tiltLimit;
  }
  if (!(cfg.glideStepDeg > 0 && cfg.glideStepDeg <= MAX_GLIDE_STEP_DEG)) {
    cfg.glideStepDeg = DEFAULT_CONFIG.glideStepDeg;
  }
  if (cfg.glideIntervalMs < MIN_GLIDE_INTERVAL_MS) {
    cfg.glideIntervalMs = DEFAULT_CONFIG.glideIntervalMs;
  }
  // The cooldown must outlast the longest glide plus the lantern fade-out. If the rule is
  // broken, all three values return to their defaults together: replacing only cooldownS can
  // still leave it below the sum (for example glideTimeoutS = 3.000000000000001), and the
  // defaults are known to satisfy the rule.
  if (cfg.cooldownS < cfg.glideTimeoutS + cfg.lanternFadeOutMs / 1000) {
    cfg.glideTimeoutS = DEFAULT_CONFIG.glideTimeoutS;
    cfg.lanternFadeOutMs = DEFAULT_CONFIG.lanternFadeOutMs;
    cfg.cooldownS = DEFAULT_CONFIG.cooldownS;
  }
  return cfg;
}
