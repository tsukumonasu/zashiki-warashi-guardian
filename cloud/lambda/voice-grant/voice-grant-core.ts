/**
 * Pure core of the `voice-grant` Lambda (requirements R2.2 to R2.6, R3.1, R4.9).
 *
 * Handles two doll events delivered by an IoT rule:
 * - `conversation.requested`: grants a voice session only when the cloud's own record shows a
 *   `family` verdict for the encounter within `grantWindowSeconds`. Then caps, lock, session
 *   record, async start of `voice-session` and the `conversation.start` command.
 * - `conversation.ended`: asks the cloud session to end and releases the doll's lock.
 *
 * No AWS imports and no clock reads: every effect goes through a port, and the caller passes the
 * time. The function never throws for bad input; a failed grant leaves no counter, lock or
 * session behind. Logs never contain a token, a token hash or a payload.
 */

import { decodeEnvelope, makeCommand, type Envelope } from "../_shared/messages.js";
import { log } from "../_shared/safelog.js";
import { applicableScopes, counterKey, dayBucket, incrementCaps, lockKey } from "../_shared/voice/caps.js";
import type { VoiceConfig } from "../_shared/voice/config.js";
import { logVoice } from "../_shared/voice/log.js";
import type { DollBus, SessionRecord, VoiceStore } from "../_shared/voice/ports.js";
import type { SessionPayload } from "../voice-session/session-runner.js";

/** Extra time a session record outlives `maxSeconds`, for the connect wait and the cleanup. */
const RECORD_SLACK_MS = 10_000;

/** Starts `voice-session` asynchronously (Lambda `InvocationType: Event`). */
export interface SessionInvoker {
  invoke(payload: SessionPayload): Promise<void>;
}

export interface GrantDeps {
  readonly store: VoiceStore;
  readonly bus: DollBus;
  readonly invoker: SessionInvoker;
  readonly cfg: VoiceConfig;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** A fresh UUID. */
  readonly newId: () => string;
  /** 32 random bytes as Base64URL (43 characters). */
  readonly newSecret: () => string;
  /** SHA-256 of a token, hex encoded. */
  readonly hashToken: (token: string) => string;
}

export type GrantOutcome =
  | { kind: "granted"; sessionId: string }
  | { kind: "ended"; sessionId: string }
  | {
      kind: "dropped";
      reason:
        | "malformed"
        | "wrong_type"
        | "topic_device_mismatch"
        | "voice_disabled"
        | "no_encounter"
        | "no_family_verdict"
        | "cap_reached"
        | "lock_busy"
        | "start_failed"
        | "unknown_session";
    };

const dropped = (reason: Extract<GrantOutcome, { kind: "dropped" }>["reason"]): GrantOutcome => ({
  kind: "dropped",
  reason,
});

/**
 * Handles one event from `warashi/<topicDeviceId>/events`.
 *
 * @param topicDeviceId the `<id>` segment of the topic the event arrived on.
 * @param raw the message payload.
 */
export async function handleVoiceEvent(
  topicDeviceId: string,
  raw: Uint8Array | string,
  deps: GrantDeps,
): Promise<GrantOutcome> {
  const decoded = decodeEnvelope(raw);
  if (decoded.kind !== "valid") {
    log("voice_grant_dropped", { reason: "malformed" });
    return dropped("malformed");
  }
  const envelope = decoded.message;
  if (envelope.deviceId !== topicDeviceId) {
    // Only ids are logged: the payload could hold anything the sender chose.
    log("voice_grant_dropped", {
      reason: "topic_device_mismatch",
      envelopeId: envelope.id,
      topicDeviceId,
      deviceId: envelope.deviceId,
    });
    return dropped("topic_device_mismatch");
  }
  if (envelope.type === "conversation.requested") return grant(envelope, deps);
  if (envelope.type === "conversation.ended") return end(envelope, deps);
  return dropped("wrong_type");
}

async function grant(envelope: Envelope, deps: GrantDeps): Promise<GrantOutcome> {
  const { store, cfg } = deps;
  const deviceId = envelope.deviceId;
  const nowMs = deps.now();

  if (!cfg.voiceEnabled) {
    log("voice_grant_dropped", { reason: "voice_disabled", envelopeId: envelope.id });
    return dropped("voice_disabled");
  }
  if (envelope.encounterId === null) {
    log("voice_grant_dropped", { reason: "no_encounter", envelopeId: envelope.id });
    return dropped("no_encounter");
  }

  // The doll's own claim is not enough: the cloud must hold a fresh family verdict (R2.3).
  const stored = await store.encounterVerdict(envelope.encounterId);
  const age = stored === null ? Infinity : nowMs - stored.atMs;
  if (stored === null || stored.verdict !== "family" || age > cfg.grantWindowSeconds * 1000) {
    log("voice_grant_dropped", { reason: "no_family_verdict", envelopeId: envelope.id });
    return dropped("no_family_verdict");
  }

  const capReq = { ownerSub: null, role: "device", usesRealDoll: true } as const;
  const caps = await incrementCaps(store, capReq, cfg, nowMs);
  if (!caps.ok) {
    log("voice_grant_dropped", { reason: "cap_reached", scope: caps.scope, envelopeId: envelope.id });
    return dropped("cap_reached");
  }
  const releaseCaps = async (): Promise<void> => {
    for (const { scope } of applicableScopes(capReq, cfg).reverse()) {
      await store.releaseCounter(counterKey(scope, dayBucket(nowMs)));
    }
  };

  const sessionId = deps.newId();
  const key = lockKey("real", deviceId, null);
  const expiresAt = nowMs + (cfg.noClientSeconds + cfg.maxSeconds) * 1000 + RECORD_SLACK_MS;
  let lockHeld = false;
  try {
    lockHeld = await store.acquireLock(key, sessionId, nowMs, expiresAt);
    if (!lockHeld) {
      await releaseCaps();
      logVoice("voice_grant_dropped", sessionId, { reason: "lock_busy", envelopeId: envelope.id });
      return dropped("lock_busy");
    }

    const token = `${sessionId}.${deps.newSecret()}`;
    const record: SessionRecord = {
      sessionId,
      deviceId,
      client: "device",
      target: "real",
      ownerSub: null,
      role: "device",
      phase: "starting",
      startedAt: nowMs,
      expiresAt,
      clientTokenHash: deps.hashToken(token),
      observerTokenHash: null,
      endReason: null,
      endedAt: null,
      endRequested: false,
    };
    await store.putSession(record);
    await deps.invoker.invoke({
      sessionId,
      deviceId,
      client: "device",
      target: "real",
      ownerSub: null,
      maxSeconds: cfg.maxSeconds,
      silenceSeconds: cfg.silenceSeconds,
    });
    // The token leaves only inside this command, on the doll's own topic.
    await deps.bus.publish(
      deviceId,
      makeCommand(
        "conversation.start",
        {
          sessionId,
          token,
          maxSeconds: cfg.maxSeconds,
          silenceSeconds: cfg.silenceSeconds,
          source: "family_verdict",
        },
        { id: deps.newId(), now: new Date(nowMs), deviceId, encounterId: envelope.encounterId },
      ),
    );
    logVoice("voice_grant_started", sessionId, { envelopeId: envelope.id });
    return { kind: "granted", sessionId };
  } catch (err) {
    // Roll back so a failed start does not use up the day's cap or block the doll.
    logVoice("voice_grant_failed", sessionId, { error: err instanceof Error ? err.name : "unknown" });
    await settle(async () => {
      if (lockHeld) await store.releaseLock(key, sessionId);
    });
    await settle(releaseCaps);
    await settle(async () => {
      const rec = await store.getSession(sessionId);
      if (rec !== null) {
        await store.putSession({ ...rec, phase: "ended", endReason: "error", endedAt: deps.now() });
      }
    });
    return dropped("start_failed");
  }
}

/** Runs one cleanup step and swallows its error so the next step still runs. */
async function settle(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch {
    /* cleanup is best effort */
  }
}

async function end(envelope: Envelope, deps: GrantDeps): Promise<GrantOutcome> {
  const data = envelope.data as { sessionId: string; reason: SessionRecord["endReason"] };
  const { store } = deps;
  const rec = await store.getSession(data.sessionId);
  // Another doll's session id must not release this doll's lock or end that session.
  if (rec === null || rec.deviceId !== envelope.deviceId) {
    logVoice("voice_grant_dropped", data.sessionId, { reason: "unknown_session", envelopeId: envelope.id });
    return dropped("unknown_session");
  }
  if (rec.phase !== "ended") {
    // The running `voice-session` owns the shutdown; this only asks it to stop (first reason wins).
    await store.putSession({
      ...rec,
      endRequested: true,
      endReason: rec.endReason ?? data.reason,
    });
  }
  await store.releaseLock(lockKey(rec.target, rec.deviceId, rec.ownerSub), rec.sessionId);
  logVoice("voice_grant_ended", rec.sessionId, { reason: data.reason });
  return { kind: "ended", sessionId: rec.sessionId };
}
