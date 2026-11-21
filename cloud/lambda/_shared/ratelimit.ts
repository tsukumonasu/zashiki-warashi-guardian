/**
 * Rate limiter for `POST /simulate` (cloud-judgement, requirements 15.10 to 15.13).
 *
 * The pure parts (bucket arithmetic, key builders, Retry-After) are separate from the guard,
 * which talks to a counter store through the counter part of `StateStore` (ports.ts).
 */

import type { StateStore } from "./ports.js";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const HOUR_TTL_S = 7_200; // 2 hours, so a counter outlives its bucket
export const DAY_TTL_S = 172_800; // 2 days
export const MIN_RETRY_AFTER_S = 1;
export const MAX_RETRY_AFTER_S = 86_400;

/** Index of the fixed window that contains `nowMs`. A new window starts counting at zero. */
export function bucketOf(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs);
}

/** True when the count reached by an increment is still inside the limit. */
export function withinLimit(countAfterIncrement: number, limit: number): boolean {
  return countAfterIncrement <= limit;
}

/** Per-user hourly simulation counter key. */
export function simHourKey(userSub: string, hourBucket: number): string {
  return `RATE#sim#${userSub}#${hourBucket}`;
}

/** Per-user hourly generate counter key. */
export function genHourKey(userSub: string, hourBucket: number): string {
  return `RATE#gen#${userSub}#${hourBucket}`;
}

/** Global daily simulation counter key. */
export function simDayKey(dayBucket: number): string {
  return `RATE#simday#${dayBucket}`;
}

/**
 * Whole seconds until the bucket that contains `nowMs` ends, clamped to 1..86,400
 * (the `Retry-After` range of docs/schema.md).
 */
export function retryAfterSeconds(nowMs: number, windowMs: number): number {
  const bucketEndMs = (bucketOf(nowMs, windowMs) + 1) * windowMs;
  const seconds = Math.ceil((bucketEndMs - nowMs) / 1000);
  if (!Number.isFinite(seconds)) return MAX_RETRY_AFTER_S;
  return Math.min(MAX_RETRY_AFTER_S, Math.max(MIN_RETRY_AFTER_S, seconds));
}

/** The part of `StateStore` the guard needs. */
export type CounterPort = Pick<StateStore, "incrementCounter" | "releaseCounter">;

export interface RateLimits {
  simPerHour: number;
  genPerHour: number;
  simPerDay: number;
}

export type GuardResult = { allowed: true } | { allowed: false; retryAfterS: number };

/**
 * Increment the per-user hourly, the global daily and (when `wantsGenerate`) the per-user
 * generate counters. The first rejection stops the sequence, and the counters that were already
 * incremented for this request are released, so a rejected request leaves no counter changed.
 * Retry-After refers to the bucket of the rejecting counter.
 */
export async function guardSimulate(
  userSub: string,
  wantsGenerate: boolean,
  limits: RateLimits,
  nowMs: number,
  state: CounterPort,
): Promise<GuardResult> {
  const hour = bucketOf(nowMs, HOUR_MS);
  const day = bucketOf(nowMs, DAY_MS);
  const steps: { key: string; limit: number; ttlS: number; windowMs: number }[] = [
    { key: simHourKey(userSub, hour), limit: limits.simPerHour, ttlS: HOUR_TTL_S, windowMs: HOUR_MS },
    { key: simDayKey(day), limit: limits.simPerDay, ttlS: DAY_TTL_S, windowMs: DAY_MS },
  ];
  if (wantsGenerate) {
    steps.push({
      key: genHourKey(userSub, hour),
      limit: limits.genPerHour,
      ttlS: HOUR_TTL_S,
      windowMs: HOUR_MS,
    });
  }

  const incremented: string[] = [];
  for (const step of steps) {
    let allowed = false;
    try {
      const result = await state.incrementCounter(step.key, step.limit, step.ttlS);
      allowed = result.allowed && withinLimit(result.count, step.limit);
      // A counter that counted but was over the limit still needs to be undone.
      if (result.allowed) incremented.push(step.key);
    } catch (err) {
      await releaseAll(incremented, state);
      throw err;
    }
    if (!allowed) {
      await releaseAll(incremented, state);
      return { allowed: false, retryAfterS: retryAfterSeconds(nowMs, step.windowMs) };
    }
  }
  return { allowed: true };
}

async function releaseAll(keys: string[], state: CounterPort): Promise<void> {
  for (const key of keys) {
    await state.releaseCounter(key);
  }
}
