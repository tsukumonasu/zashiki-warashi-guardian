/**
 * Daily caps and lock keys of voice sessions (requirements R3, R15.2; design "DynamoDB items").
 *
 * Pure apart from the `VoiceStore` calls. No clock reads: the caller passes `nowMs`.
 * A start increments the counters of the scopes that apply in the fixed order user, device,
 * global. When a later counter refuses, the earlier ones are released, so a rejected start leaves
 * every counter unchanged (the pattern of `cloud-judgement` R15.13).
 */

import type { VoiceConfig } from "./config.js";
import type { VoiceStore } from "./ports.js";

const DAY_MS = 86_400_000;
/** Counter items expire after two days (R14.3). */
export const COUNTER_TTL_S = 2 * 86_400;

/** UTC day number since the epoch. Every cap counts from zero when this value changes. */
export function dayBucket(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS);
}

/** True while the count after an increment is still inside the cap (`count <= cap`). */
export function withinCap(countAfterIncrement: number, cap: number): boolean {
  return countAfterIncrement <= cap;
}

/** Whole seconds from `nowMs` to the next UTC midnight, always from 1 to 86,400. */
export function retryAfterSeconds(nowMs: number): number {
  const nextMidnight = (dayBucket(nowMs) + 1) * DAY_MS;
  const seconds = Math.ceil((nextMidnight - nowMs) / 1000);
  return Math.min(86_400, Math.max(1, seconds));
}

export type CapScope = "user" | "device" | "global";

/** Counter key `RATE#voice#<scope>#<day>`; `scope` is `user#<sub>`, `device` or `global`. */
export function counterKey(scope: string, day: number): string {
  return `RATE#voice#${scope}#${day}`;
}

export function userScope(ownerSub: string): string {
  return `user#${ownerSub}`;
}

export const DEVICE_SCOPE = "device";
export const GLOBAL_SCOPE = "global";

/** Lock key: `device#<id>` when the real doll is used, `sim#<ownerSub>` for a virtual doll. */
export function lockKey(target: "real" | "virtual", deviceId: string, ownerSub: string | null): string {
  if (target === "real") return `device#${deviceId}`;
  return `sim#${ownerSub ?? ""}`;
}

export interface CapRequest {
  /** `null` for a doll-started session: no user scope applies. */
  readonly ownerSub: string | null;
  readonly role: "family" | "reviewer" | "device";
  /** True when the session uses the real doll (device scope applies). */
  readonly usesRealDoll: boolean;
}

export type CapResult =
  | { ok: true }
  | { ok: false; scope: CapScope; retryAfterS: number };

interface ScopeCap {
  readonly kind: CapScope;
  readonly scope: string;
  readonly cap: number;
}

/** The scopes that apply to a request, in the fixed increment order. */
export function applicableScopes(req: CapRequest, config: VoiceConfig): ScopeCap[] {
  const scopes: ScopeCap[] = [];
  if (req.ownerSub !== null && req.role !== "device") {
    const cap = req.role === "reviewer" ? config.perUserPerDay.reviewer : config.perUserPerDay.family;
    scopes.push({ kind: "user", scope: userScope(req.ownerSub), cap });
  }
  if (req.usesRealDoll) scopes.push({ kind: "device", scope: DEVICE_SCOPE, cap: config.deviceStartsPerDay });
  scopes.push({ kind: "global", scope: GLOBAL_SCOPE, cap: config.globalPerDay });
  return scopes;
}

/**
 * Counts one start against every applicable cap. On a refusal, releases the counters this call
 * already incremented and returns the refusing scope with the `Retry-After` seconds. If the store
 * throws, the earlier increments are released as well and the error is rethrown.
 */
export async function incrementCaps(
  store: VoiceStore,
  req: CapRequest,
  config: VoiceConfig,
  nowMs: number,
): Promise<CapResult> {
  const day = dayBucket(nowMs);
  const done: string[] = [];
  const undo = async (): Promise<void> => {
    for (const key of done.reverse()) await store.releaseCounter(key);
  };
  for (const { kind, scope, cap } of applicableScopes(req, config)) {
    const key = counterKey(scope, day);
    let result: { allowed: boolean; count: number };
    try {
      result = await store.incrementCounter(key, cap, COUNTER_TTL_S);
    } catch (err) {
      await undo();
      throw err;
    }
    // A refusal does not change the counter. An allowed increment that is still over the cap
    // (a store that disagrees with `cap`) is undone together with the earlier ones.
    if (result.allowed) done.push(key);
    if (!result.allowed || !withinCap(result.count, cap)) {
      await undo();
      return { ok: false, scope: kind, retryAfterS: retryAfterSeconds(nowMs) };
    }
  }
  return { ok: true };
}
