/**
 * CDK context and configuration validation (R9.10, R9.11, R19.3, R19.4, R20.2, R20.3, R27.2, R27.3).
 *
 * Pure module: no AWS calls and no CDK imports. The app passes in the context values it read
 * with `node.tryGetContext` and `process.env`, and gets back one validated object. Any missing
 * or invalid value throws a `ConfigError` that names the context key, so synthesis fails before
 * any resource is created.
 */
import { ConfigError, loadConfig, type CloudConfig, type ConfigSource } from "../lambda/_shared/config.js";

/** Context keys the owner must provide in the git-ignored `cdk.context.json`. */
export const REQUIRED_CONTEXT_KEYS = ["notificationEmail", "budgetAmountUsd", "budgetEmail"] as const;

/** Longest e-mail address accepted (R20.2). */
export const MAX_EMAIL_LENGTH = 254;

export interface CloudContext {
  /** Receives stranger notifications through the SNS e-mail subscription (R9.10). */
  notificationEmail: string;
  /** Monthly budget in USD, greater than 0 (R20.2). */
  budgetAmountUsd: number;
  /** Receives the budget alerts (R20.2). */
  budgetEmail: string;
  /** Tunable settings: defaults, overridden by context and then by environment (R27.2). */
  config: CloudConfig;
}

function isMissing(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
}

/**
 * Accepts an address with exactly one `@`, a non-empty local part and domain, no whitespace and
 * at most 254 characters. It does not try to implement the full RFC 5322 grammar.
 */
export function readEmail(key: string, raw: unknown): string {
  if (isMissing(raw)) throw new ConfigError(key, raw, "required context value is missing or empty");
  if (typeof raw !== "string") throw new ConfigError(key, raw, "must be a string");
  const value = raw.trim();
  if (value.length > MAX_EMAIL_LENGTH) {
    throw new ConfigError(key, "<too long>", `must be at most ${MAX_EMAIL_LENGTH} characters`);
  }
  const parts = value.split("@");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "" || /\s/.test(value)) {
    // The address itself is never echoed: it is personal data.
    throw new ConfigError(key, "<hidden>", "must be an e-mail address with exactly one @");
  }
  return value;
}

/** A number greater than 0. Numeric strings are accepted because `cdk -c key=value` gives strings. */
export function readBudgetAmount(key: string, raw: unknown): number {
  if (isMissing(raw)) throw new ConfigError(key, raw, "required context value is missing or empty");
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string") n = Number(raw.trim());
  else throw new ConfigError(key, raw, "must be a number");
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(key, raw, "must be a number greater than 0");
  return n;
}

/**
 * Validates the whole context. Throws `ConfigError` for the first problem; the message names
 * the key. Required keys are checked before the tunables.
 *
 * @param context CDK context values as one object (for example from `node.tryGetContext`).
 * @param env Environment variables that override tunables, normally `process.env`.
 */
export function loadContext(context: ConfigSource, env: ConfigSource = {}): CloudContext {
  const notificationEmail = readEmail("notificationEmail", context["notificationEmail"]);
  const budgetAmountUsd = readBudgetAmount("budgetAmountUsd", context["budgetAmountUsd"]);
  const budgetEmail = readEmail("budgetEmail", context["budgetEmail"]);
  const config = loadConfig(env, context);
  return { notificationEmail, budgetAmountUsd, budgetEmail, config };
}
