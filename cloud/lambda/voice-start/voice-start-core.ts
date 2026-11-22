/**
 * Pure core of the `voice-start` Lambda (requirements R1, R3, R4.1, R4.2, R4.9, R9.9, R15.2).
 *
 * Handles `POST /conversations`, `GET /conversations/{sessionId}`,
 * `DELETE /conversations/{sessionId}` and the `voice` block of `GET /me`.
 *
 * No AWS imports and no clock reads: every effect goes through a port and the caller passes the
 * time. The functions never throw for bad input; they return an `HttpResult`. A failed start
 * leaves no counter, lock or live session behind. Logs never contain a token, a token hash or a
 * body. Tokens leave this module only in the `201` body (browser client), in the `202` body
 * (observer token) and inside the `conversation.start` command on the doll's own topic.
 *
 * The response type is local because `_shared/http.ts` does not know `session_active` and
 * `voice_unavailable` yet; the thin handler adds CORS headers.
 */

import type { Role } from "../_shared/authz.js";
import { makeCommand } from "../_shared/messages.js";
import { log } from "../_shared/safelog.js";
import {
  applicableScopes,
  counterKey,
  dayBucket,
  incrementCaps,
  lockKey,
  retryAfterSeconds,
  userScope,
  GLOBAL_SCOPE,
} from "../_shared/voice/caps.js";
import type { VoiceConfig } from "../_shared/voice/config.js";
import { logVoice } from "../_shared/voice/log.js";
import type { DollBus, SessionRecord, VoiceStore } from "../_shared/voice/ports.js";
import { hashToken } from "../voice-authorizer/authorizer-core.js";
import type { SessionInvoker } from "../voice-grant/voice-grant-core.js";

/** Extra time a session record outlives its limits, for the connect wait and the cleanup. */
const RECORD_SLACK_MS = 10_000;

/** One hour, the window and the pause of the health flag (R9.9). */
const HEALTH_WINDOW_MS = 3_600_000;
/** Failed sessions in a row that set the flag. */
const HEALTH_FAILURES = 3;

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID_RE = /^[0-9a-f-]{36}$/;

export type VoiceErrorCode =
  | "forbidden"
  | "validation_failed"
  | "not_found"
  | "rate_limited"
  | "session_active"
  | "voice_unavailable"
  | "internal";

const ERROR_STATUS: Record<VoiceErrorCode, number> = {
  validation_failed: 400,
  forbidden: 403,
  not_found: 404,
  session_active: 409,
  rate_limited: 429,
  internal: 500,
  voice_unavailable: 503,
};

/** A response before the handler adds CORS headers. `Retry-After` is set for `429` only. */
export interface HttpResult {
  readonly status: number;
  /** `null` for `204`. */
  readonly body: unknown;
  readonly retryAfterS?: number;
}

function fail(code: VoiceErrorCode, message: string, retryAfterS?: number): HttpResult {
  const body = { error: { code, message } };
  return retryAfterS === undefined
    ? { status: ERROR_STATUS[code], body }
    : { status: ERROR_STATUS[code], body, retryAfterS };
}

/** The verified caller: `sub` and the role from the token claims. */
export interface Caller {
  readonly sub: string;
  readonly role: Role;
}

// ---------------------------------------------------------------------------------------------
// Health flag (R9.9)
// ---------------------------------------------------------------------------------------------

/** The `VOICE#HEALTH` item. */
export interface HealthState {
  /** Sessions in a row that ended with `language` or `error`. */
  readonly streak: number;
  /** Time the first of those sessions ended. */
  readonly firstAtMs: number;
  /** Starts fail until this time. 0 when the flag is not set. */
  readonly unhealthyUntilMs: number;
}

export const HEALTHY: HealthState = { streak: 0, firstAtMs: 0, unhealthyUntilMs: 0 };

export interface HealthStore {
  read(): Promise<HealthState | null>;
  write(state: HealthState): Promise<void>;
}

/** True while the flag is set. */
export function isUnhealthy(state: HealthState | null, nowMs: number): boolean {
  return state !== null && nowMs < state.unhealthyUntilMs;
}

/**
 * The next health state after a session ended. Three `language` or `error` ends in a row within
 * one hour set the flag for one hour; any other end resets the streak.
 */
export function nextHealth(state: HealthState | null, endReason: string, nowMs: number): HealthState {
  const prev = state ?? HEALTHY;
  if (endReason !== "language" && endReason !== "error") {
    return { ...HEALTHY, unhealthyUntilMs: prev.unhealthyUntilMs };
  }
  const fresh = prev.streak > 0 && nowMs - prev.firstAtMs <= HEALTH_WINDOW_MS;
  const streak = fresh ? prev.streak + 1 : 1;
  const firstAtMs = fresh ? prev.firstAtMs : nowMs;
  if (streak >= HEALTH_FAILURES) {
    return { streak: 0, firstAtMs: 0, unhealthyUntilMs: nowMs + HEALTH_WINDOW_MS };
  }
  return { streak, firstAtMs, unhealthyUntilMs: prev.unhealthyUntilMs };
}

/** Records one ended session in the health flag. Best effort for the caller: it may throw. */
export async function recordSessionEnd(health: HealthStore, endReason: string, nowMs: number): Promise<void> {
  await health.write(nextHealth(await health.read(), endReason, nowMs));
}

// ---------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------

export interface StartDeps {
  readonly store: VoiceStore;
  readonly bus: DollBus;
  readonly invoker: SessionInvoker;
  readonly health: HealthStore;
  readonly cfg: VoiceConfig;
  /** Reads today's count of a counter key; 0 when it does not exist. */
  readonly readCounter: (key: string) => Promise<number>;
  /** True when the doll's last status says it is online. */
  readonly deviceOnline: (deviceId: string, nowMs: number) => Promise<boolean>;
  /** AppSync Events hosts, from the stack outputs. */
  readonly hosts: { readonly http: string; readonly realtime: string };
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** A fresh UUID. */
  readonly newId: () => string;
  /** 32 random bytes as Base64URL (43 characters). */
  readonly newSecret: () => string;
}

const channelsFor = (sessionId: string) => ({
  in: `/voice/${sessionId}/in`,
  out: `/voice/${sessionId}/out`,
  text: `/voice/${sessionId}/text`,
});

// ---------------------------------------------------------------------------------------------
// POST /conversations
// ---------------------------------------------------------------------------------------------

interface StartBody {
  readonly deviceId: string;
  readonly client: "browser" | "device";
  readonly target: "real" | "virtual";
}

function parseStartBody(body: unknown): StartBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const { deviceId, client, target } = b;
  if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) return null;
  if (client !== "browser" && client !== "device") return null;
  if (target !== "real" && target !== "virtual") return null;
  // R1.3: a doll audio client needs the real doll.
  if (client === "device" && target === "virtual") return null;
  return { deviceId, client, target };
}

/** Runs one cleanup step and swallows its error so the next step still runs. */
async function settle(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch {
    /* cleanup is best effort */
  }
}

/**
 * `POST /conversations`. `body` is the parsed JSON body (the handler already enforced the size
 * limit).
 */
export async function startConversation(caller: Caller, body: unknown, deps: StartDeps): Promise<HttpResult> {
  const { store, cfg } = deps;
  const nowMs = deps.now();

  const parsed = parseStartBody(body);
  if (parsed === null) return fail("validation_failed", "Invalid conversation request.");
  const { deviceId, client, target } = parsed;

  // Role rules (R1.4 to R1.6). A reviewer never reaches the real doll or the doll's audio client.
  if (caller.role === "reviewer") {
    if (!cfg.reviewerVoiceEnabled || target === "real" || client === "device") {
      return fail("forbidden", "Not allowed.");
    }
  }

  const enabledResult = await checkAvailable(deps, nowMs);
  if (enabledResult !== null) return enabledResult;

  const usesRealDoll = target === "real";
  const capReq = { ownerSub: caller.sub, role: caller.role, usesRealDoll } as const;
  const caps = await incrementCaps(store, capReq, cfg, nowMs);
  if (!caps.ok) {
    log("voice_start_rejected", { reason: "cap_reached", scope: caps.scope });
    return fail("rate_limited", "Daily voice limit reached.", caps.retryAfterS);
  }
  const releaseCaps = async (): Promise<void> => {
    for (const { scope } of applicableScopes(capReq, cfg).reverse()) {
      await store.releaseCounter(counterKey(scope, dayBucket(nowMs)));
    }
  };

  const sessionId = deps.newId();
  const key = lockKey(target, deviceId, caller.sub);
  const expiresAt = nowMs + (cfg.noClientSeconds + cfg.maxSeconds) * 1000 + RECORD_SLACK_MS;
  let lockHeld = false;
  try {
    lockHeld = await store.acquireLock(key, sessionId, nowMs, expiresAt);
    if (!lockHeld) {
      await releaseCaps();
      logVoice("voice_start_rejected", sessionId, { reason: "lock_busy" });
      return fail("session_active", "A session is already running.");
    }

    // The doll's token goes only to the doll; the dashboard of a doll session gets an observer
    // token (R4.1, R4.2).
    const clientToken = `${sessionId}.${deps.newSecret()}`;
    const observerToken = client === "device" ? `${sessionId}.${deps.newSecret()}` : null;
    const record: SessionRecord = {
      sessionId,
      deviceId,
      client,
      target,
      ownerSub: caller.sub,
      role: caller.role,
      phase: "starting",
      startedAt: nowMs,
      expiresAt,
      clientTokenHash: hashToken(clientToken),
      observerTokenHash: observerToken === null ? null : hashToken(observerToken),
      endReason: null,
      endedAt: null,
      endRequested: false,
    };
    await store.putSession(record);
    await deps.invoker.invoke({
      sessionId,
      deviceId,
      client,
      target,
      ownerSub: caller.sub,
      maxSeconds: cfg.maxSeconds,
      silenceSeconds: cfg.silenceSeconds,
    });

    const common = { sessionId, hosts: deps.hosts, channels: channelsFor(sessionId) };
    if (client === "browser") {
      logVoice("voice_start_ok", sessionId, { client, target, role: caller.role });
      return {
        status: 201,
        body: {
          ...common,
          clientToken,
          maxSeconds: cfg.maxSeconds,
          silenceSeconds: cfg.silenceSeconds,
          expiresAt: new Date(expiresAt).toISOString(),
        },
      };
    }

    // The token leaves only inside this command, on the doll's own topic.
    await deps.bus.publish(
      deviceId,
      makeCommand(
        "conversation.start",
        {
          sessionId,
          token: clientToken,
          maxSeconds: cfg.maxSeconds,
          silenceSeconds: cfg.silenceSeconds,
          source: "manual",
        },
        { id: deps.newId(), now: new Date(nowMs), deviceId, encounterId: null },
      ),
    );
    const online = await settleValue(() => deps.deviceOnline(deviceId, nowMs), false);
    logVoice("voice_start_ok", sessionId, { client, target, role: caller.role });
    return { status: 202, body: { ...common, observerToken, deviceOnline: online } };
  } catch (err) {
    // Roll back so a failed start does not use up the day's cap or block the doll.
    logVoice("voice_start_failed", sessionId, { error: err instanceof Error ? err.name : "unknown" });
    await settle(async () => {
      if (lockHeld) await store.releaseLock(key, sessionId);
    });
    await settle(releaseCaps);
    await settle(async () => {
      const rec = await store.getSession(sessionId);
      if (rec !== null) {
        await store.putSession({ ...rec, phase: "ended", endReason: "error", endedAt: deps.now(), endRequested: true });
      }
    });
    await settle(() => recordSessionEnd(deps.health, "error", deps.now()));
    return fail("voice_unavailable", "Voice is unavailable.");
  }
}

async function settleValue<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

/** `503 voice_unavailable` for the kill switch and the health flag; otherwise `null`. */
async function checkAvailable(deps: Pick<StartDeps, "cfg" | "health">, nowMs: number): Promise<HttpResult | null> {
  if (!deps.cfg.voiceEnabled) return fail("voice_unavailable", "Voice is unavailable.");
  let state: HealthState | null;
  try {
    state = await deps.health.read();
  } catch {
    // An unreadable flag must not block the family; the caps still apply.
    state = null;
  }
  if (isUnhealthy(state, nowMs)) return fail("voice_unavailable", "Voice is unavailable.");
  return null;
}

// ---------------------------------------------------------------------------------------------
// GET and DELETE /conversations/{sessionId}
// ---------------------------------------------------------------------------------------------

const NOT_FOUND = (): HttpResult => fail("not_found", "Session not found.");

/**
 * Loads a session for its owner. An unknown id, a malformed id and a session of another owner
 * all give `null`, so the response never reveals whether the session exists (R1.12).
 */
async function ownedSession(caller: Caller, sessionId: string, store: VoiceStore): Promise<SessionRecord | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const rec = await store.getSession(sessionId);
  if (rec === null || rec.ownerSub === null || rec.ownerSub !== caller.sub) return null;
  return rec;
}

/** `GET /conversations/{sessionId}`. */
export async function getConversation(caller: Caller, sessionId: string, deps: StartDeps): Promise<HttpResult> {
  const rec = await ownedSession(caller, sessionId, deps.store);
  if (rec === null) return NOT_FOUND();
  return { status: 200, body: { sessionId: rec.sessionId, phase: rec.phase, endReason: rec.endReason } };
}

/**
 * `DELETE /conversations/{sessionId}`. Asks the running `voice-session` to end with the reason
 * `user` (the first reason wins) and releases the lock. Safe to call twice.
 */
export async function deleteConversation(caller: Caller, sessionId: string, deps: StartDeps): Promise<HttpResult> {
  const { store } = deps;
  const rec = await ownedSession(caller, sessionId, store);
  if (rec === null) return NOT_FOUND();
  if (rec.phase !== "ended") {
    await store.putSession({ ...rec, endRequested: true, endReason: rec.endReason ?? "user" });
  }
  await store.releaseLock(lockKey(rec.target, rec.deviceId, rec.ownerSub), rec.sessionId);
  logVoice("voice_start_deleted", rec.sessionId, {});
  return { status: 204, body: null };
}

// ---------------------------------------------------------------------------------------------
// GET /me, voice block
// ---------------------------------------------------------------------------------------------

export interface MeVoice {
  readonly enabled: boolean;
  readonly maxSeconds: number;
  /** Starts left today for this caller; an integer of at least 0. */
  readonly remainingToday: number;
}

/**
 * The `voice` block of `GET /me` (R1.11). `enabled` is false for the kill switch, the health flag
 * and a reviewer while `reviewerVoiceEnabled` is off. `remainingToday` is the smallest room left
 * over the user cap and the global cap. A failing read gives 0, which disables the button safely.
 */
export async function meVoice(
  caller: Caller,
  deps: Pick<StartDeps, "cfg" | "health" | "readCounter" | "now">,
): Promise<MeVoice> {
  const { cfg } = deps;
  const nowMs = deps.now();
  const roleAllowed = caller.role !== "reviewer" || cfg.reviewerVoiceEnabled;
  const blocked = (await checkAvailable(deps, nowMs)) !== null;
  const enabled = cfg.voiceEnabled && roleAllowed && !blocked;

  let remainingToday = 0;
  try {
    const day = dayBucket(nowMs);
    const userCap = caller.role === "reviewer" ? cfg.perUserPerDay.reviewer : cfg.perUserPerDay.family;
    const [userUsed, globalUsed] = await Promise.all([
      deps.readCounter(counterKey(userScope(caller.sub), day)),
      deps.readCounter(counterKey(GLOBAL_SCOPE, day)),
    ]);
    remainingToday = Math.max(0, Math.min(userCap - userUsed, cfg.globalPerDay - globalUsed));
  } catch {
    remainingToday = 0;
  }
  return { enabled, maxSeconds: cfg.maxSeconds, remainingToday: Math.floor(remainingToday) };
}

/** Seconds to the next UTC midnight; re-exported for the handler's `Retry-After` header. */
export { retryAfterSeconds };
