/**
 * `voice-session` Lambda entry point. Started asynchronously by `voice-start` and `voice-grant`
 * with a `SessionPayload`; runs one voice conversation to its end through `runSession`.
 *
 * Environment variables (set by the CDK stack, never secrets):
 *   WARASHI_TABLE_NAME            single table (read by the adapters)
 *   WARASHI_VOICE_HTTP_HOST       AppSync Events HTTP host
 *   WARASHI_VOICE_REALTIME_HOST   AppSync Events real-time host
 *   AWS_REGION                    Region of the Events API (set by Lambda)
 *   IOT_DATA_ENDPOINT             read by the IoT bus adapter
 *   WARASHI_VOICE_REGION          optional Region of the Nova Sonic model
 *   WARASHI_*                     tunable settings, see `_shared/voice/config.ts`
 *
 * Logs carry at most the first 8 characters of a session id and never audio, text or a token
 * (`logVoice`). Clients are created once per container.
 */

import { randomUUID } from "node:crypto";

import { log } from "../_shared/safelog.js";
import { loadVoiceConfig } from "../_shared/voice/config.js";
import { logVoice } from "../_shared/voice/log.js";
import { recordSessionEnd, type HealthStore } from "../voice-start/voice-start-core.js";
import { createAppSyncChannel } from "./adapters/appsync-events.js";
import { createDollBus } from "./adapters/iot-doll-bus.js";
import { createSonicClient } from "./adapters/sonic.js";
import { createHealthStore, createVoiceStore } from "./adapters/voice-dynamo.js";
import { runSession, type SessionDeps, type SessionPayload } from "./session-runner.js";

const SESSION_ID_RE = /^[0-9a-f-]{36}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const channelOptions = {
  httpHost: requiredEnv("WARASHI_VOICE_HTTP_HOST"),
  realtimeHost: requiredEnv("WARASHI_VOICE_REALTIME_HOST"),
  region: requiredEnv("AWS_REGION"),
};

/**
 * Everything except the channel lives for the container. The channel is created per session:
 * `runSession` closes it at the end, and a closed channel rejects every publish, so a shared one
 * would break the next session that a warm container runs.
 */
function buildDeps(): Omit<SessionDeps, "channel"> {
  return {
    cfg: loadVoiceConfig(process.env),
    sonic: createSonicClient(),
    store: createVoiceStore(),
    bus: createDollBus(),
    now: Date.now,
    newId: randomUUID,
  };
}

// Module scope: invalid configuration or a missing variable fails the cold start.
const deps = buildDeps();
const store = deps.store;
const health: HealthStore = createHealthStore();

/** Accepts only a payload with the expected shape; the invoker is trusted but the check is cheap. */
function parsePayload(event: unknown): SessionPayload | null {
  if (typeof event !== "object" || event === null) return null;
  const e = event as Record<string, unknown>;
  const { sessionId, deviceId, client, target, ownerSub, maxSeconds, silenceSeconds } = e;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;
  if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) return null;
  if (client !== "device" && client !== "browser") return null;
  if (target !== "real" && target !== "virtual") return null;
  if (ownerSub !== null && typeof ownerSub !== "string") return null;
  if (typeof maxSeconds !== "number" || typeof silenceSeconds !== "number") return null;
  return { sessionId, deviceId, client, target, ownerSub, maxSeconds, silenceSeconds };
}

export async function handler(event: unknown): Promise<void> {
  const payload = parsePayload(event);
  if (payload === null) {
    log("voice_session_rejected", { reason: "malformed_payload" });
    return;
  }
  logVoice("voice_session_begin", payload.sessionId, { client: payload.client, target: payload.target });
  try {
    await runSession(payload, { ...deps, channel: createAppSyncChannel(channelOptions) });
  } catch (err) {
    // `runSession` cleans up before it rethrows; here only the error name is logged.
    logVoice("voice_session_failed", payload.sessionId, { error: err instanceof Error ? err.name : "unknown" });
    return;
  }
  // Feed the health flag (R9.9). Best effort: the session is already over.
  try {
    const rec = await store.getSession(payload.sessionId);
    await recordSessionEnd(health, rec?.endReason ?? "error", Date.now());
    logVoice("voice_session_end", payload.sessionId, { reason: rec?.endReason ?? null });
  } catch (err) {
    logVoice("voice_session_health_failed", payload.sessionId, { error: err instanceof Error ? err.name : "unknown" });
  }
}
