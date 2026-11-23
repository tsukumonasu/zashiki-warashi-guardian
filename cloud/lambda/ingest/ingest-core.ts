/**
 * Ingest core (cloud-judgement design, "Ingest"; Requirements 3, 4.3 to 4.5, 8.2, 10, 11.4, 12).
 *
 * Pure over ports: no AWS imports. Time comes from `deps.nowMs`, so the handler (task 17.2)
 * passes the clock and tests pass a fixed value. The handler receives the IoT rule output, which
 * is the device envelope plus `topicDeviceId` (`topic(2)`).
 *
 * Order of work for one message:
 *   1. sender identity check (R3.1 to R3.3), before anything else;
 *   2. decode against the contract (unknown types and bad messages store nothing, R10.6);
 *   3. claim `MSG#<id>` (R4.3 to R4.5);
 *   4. store: status handling (R12) or the encounter log (R10). An `error.reported` with a
 *      `refId` is also recorded as `CMD#<refId>`, with or without an encounter, so the dashboard
 *      can tell that the doll refused that command (remote-feedback F2).
 *
 * A failed claim or write throws, so the message can be redelivered (R4.5, R10.10).
 */

import { decodeEnvelope } from "../_shared/messages.js";
import type { Envelope } from "../_shared/messages.js";
import type {
  CommandResultStore,
  EncounterMeta,
  Repository,
  StateStore,
  StatusReportData,
} from "../_shared/ports.js";
import { log } from "../_shared/safelog.js";
import type { EncounterReaction } from "../_shared/types.js";

/** Claim lifetime for `MSG#<id>` (R4.3). */
export const MESSAGE_CLAIM_TTL_S = 86_400;
/** Retention of encounter items (R11.4). */
export const ENCOUNTER_TTL_DAYS = 30;
/** Retention of `CMD#<id>` refusals: the dashboard asks only seconds after sending (F2). */
export const COMMAND_RESULT_TTL_S = 86_400;

export type IngestDeps = {
  repo: Repository;
  state: StateStore;
  /** Optional: without it, refusals are not recorded (F2). */
  results?: CommandResultStore;
  /** Arrival time in epoch milliseconds. */
  nowMs: () => number;
};

export type IngestOutcome =
  | "mismatch" // R3: deviceId differs from the topic
  | "malformed" // does not decode
  | "ignored" // unknown type or unsupported version
  | "duplicate" // message id already claimed or event already stored
  | "no_encounter" // event with a null encounterId (R10.5)
  | "status_stored"
  | "offline_marked"
  | "event_stored";

export type IngestResult = { outcome: IngestOutcome };

/** A claim or a table write failed. The handler rethrows it so the message is redelivered. */
export class IngestWriteError extends Error {
  readonly type: string;
  readonly messageId: string;
  constructor(type: string, messageId: string, cause: unknown) {
    super(`ingest write failed for ${type} ${messageId}`);
    this.name = "IngestWriteError";
    this.type = type;
    this.messageId = messageId;
    this.cause = cause;
  }
}

/** Device event types of docs/schema.md that belong to an encounter log. */
const ENCOUNTER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "presence.detected",
  "snapshot.captured",
  "state.changed",
  "reaction.performed",
  "encounter.ended",
  "error.reported",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The message id for log entries, or `null` when it is not readable (R3.3). */
function readableId(event: unknown): string | null {
  if (isRecord(event) && typeof event["id"] === "string") return event["id"];
  return null;
}

/**
 * Exact, case-sensitive comparison of `deviceId` with `topicDeviceId` (R3.1). A missing,
 * non-string or empty `deviceId`, or a missing topic id, counts as a mismatch (R3.3).
 */
function senderMatchesTopic(event: unknown): boolean {
  if (!isRecord(event)) return false;
  const deviceId = event["deviceId"];
  const topicDeviceId = event["topicDeviceId"];
  if (typeof deviceId !== "string" || deviceId.length === 0) return false;
  if (typeof topicDeviceId !== "string" || topicDeviceId.length === 0) return false;
  return deviceId === topicDeviceId;
}

/** Remove `jpegBase64` and mark the image as present (R10.2, R11.7). */
function toStoredEnvelope(envelope: Envelope): Envelope {
  if (envelope.type !== "snapshot.captured") return envelope;
  const data = { ...(envelope.data as Record<string, unknown>) };
  delete data["jpegBase64"];
  data["hasImage"] = true;
  return { ...envelope, data };
}

function newMeta(envelope: Envelope, encounterId: string): EncounterMeta {
  return {
    encounterId,
    deviceId: envelope.deviceId,
    startedAt: envelope.ts,
    endedAt: null,
    state: null,
    verdict: null,
    confidence: null,
    reaction: null,
    notified: false,
    snapshotKey: null,
    errorCount: 0,
  };
}

/** Meta fields carried by the event (R10.3), or `null` when the event changes none. */
function metaPatchFor(envelope: Envelope): Partial<EncounterMeta> | null {
  const data = envelope.data as Record<string, unknown>;
  switch (envelope.type) {
    case "state.changed":
      return { state: data["to"] as string };
    case "reaction.performed":
      return {
        reaction: {
          kind: data["kind"],
          lineId: data["lineId"],
          offline: data["offline"],
        } as EncounterReaction,
      };
    case "encounter.ended":
      return { endedAt: envelope.ts };
    default:
      return null;
  }
}

async function storeEncounterEvent(
  envelope: Envelope,
  encounterId: string,
  deps: IngestDeps,
): Promise<IngestResult> {
  const { repo } = deps;
  const ttlS = ENCOUNTER_TTL_DAYS * 86_400;

  // R10.9: an event id that is already stored is not stored again. Only a redelivery after a
  // failed write reaches this point (the claim stops every other duplicate). The append may have
  // succeeded while the meta update failed, so the same idempotent patch is applied once more.
  const stored = await repo.listEvents(encounterId);
  if (stored.some((event) => event.id === envelope.id)) {
    const repeat = metaPatchFor(envelope);
    if (repeat !== null) await repo.updateEncounter(encounterId, repeat);
    return { outcome: "duplicate" };
  }

  // R10.8: the first event of an encounter creates the meta item. The ttl counts from now.
  await repo.createEncounterIfAbsent(newMeta(envelope, encounterId), ttlS);
  await repo.appendEvent(encounterId, toStoredEnvelope(envelope), ttlS);

  const patch = metaPatchFor(envelope);
  if (patch !== null) await repo.updateEncounter(encounterId, patch);
  return { outcome: "event_stored" };
}

/** Record `CMD#<refId>` for an `error.reported` that names the command it refused (F2). */
async function recordRejection(envelope: Envelope, deps: IngestDeps): Promise<void> {
  if (envelope.type !== "error.reported" || deps.results === undefined) return;
  const data = envelope.data as Record<string, unknown>;
  const refId = data["refId"];
  const code = data["code"];
  if (typeof refId !== "string" || typeof code !== "string") return;
  await deps.results.putRejection({
    id: refId,
    deviceId: envelope.deviceId,
    code,
    ttl: Math.floor(deps.nowMs() / 1000) + COMMAND_RESULT_TTL_S,
  });
}

async function storeStatus(envelope: Envelope, deps: IngestDeps): Promise<IngestResult> {
  // R12.1, R12.2: only the arrival time orders status. The message `ts` is never used.
  const receivedAtMs = deps.nowMs();
  if (envelope.type === "status.offline") {
    await deps.repo.markOffline(envelope.deviceId, receivedAtMs);
    return { outcome: "offline_marked" };
  }
  await deps.repo.putStatusReport(
    envelope.deviceId,
    envelope.data as StatusReportData,
    receivedAtMs,
  );
  return { outcome: "status_stored" };
}

/**
 * Handle one message from the ingest IoT rules.
 *
 * Returns an outcome for every message that is dropped on purpose. Throws `IngestWriteError`
 * when the claim or a write fails (R4.5, R10.10).
 */
export async function handleIngest(event: unknown, deps: IngestDeps): Promise<IngestResult> {
  // R3: the identity check comes first. The log entry has the id and the topic id only (R3.2).
  if (!senderMatchesTopic(event)) {
    const topicDeviceId = isRecord(event) ? event["topicDeviceId"] : null;
    log("security_mismatch", {
      id: readableId(event),
      topicDeviceId: typeof topicDeviceId === "string" ? topicDeviceId : null,
    });
    return { outcome: "mismatch" };
  }

  // The rule output carries `topicDeviceId` next to the envelope; decode keeps defined fields only.
  const decoded = decodeEnvelope(JSON.stringify(event));
  if (decoded.kind === "malformed") {
    log("ingest_malformed", { id: readableId(event), reason: decoded.reason });
    return { outcome: "malformed" };
  }
  if (decoded.kind === "ignored") {
    const type = (event as Record<string, unknown>)["type"];
    log("ingest_ignored", {
      id: readableId(event),
      reason: decoded.reason,
      type: typeof type === "string" ? type : null,
    });
    return { outcome: "ignored" };
  }

  // Commands never come in through the ingest rules. Do not log them as device events.
  const envelope = decoded.message;
  const isStatus = envelope.type === "status.report" || envelope.type === "status.offline";
  const isEvent = ENCOUNTER_EVENT_TYPES.has(envelope.type);
  if (!isStatus && !isEvent) {
    log("ingest_ignored", { id: envelope.id, reason: "not_ingested", type: envelope.type });
    return { outcome: "ignored" };
  }

  const claimKey = `MSG#${envelope.id}`;
  let claimed: boolean;
  try {
    // R4.3, R4.4: the claim comes before any item is stored.
    claimed = await deps.state.claim(claimKey, MESSAGE_CLAIM_TTL_S);
  } catch (error) {
    log("ingest_write_failed", { type: envelope.type, id: envelope.id });
    throw new IngestWriteError(envelope.type, envelope.id, error);
  }
  if (!claimed) return { outcome: "duplicate" };

  try {
    if (isStatus) return await storeStatus(envelope, deps);
    await recordRejection(envelope, deps);

    // R10.5: no encounter, nothing stored. Only the type is logged.
    if (envelope.encounterId === null) {
      log("ingest_no_encounter", { type: envelope.type });
      return { outcome: "no_encounter" };
    }
    return await storeEncounterEvent(envelope, envelope.encounterId, deps);
  } catch (error) {
    log("ingest_write_failed", { type: envelope.type, id: envelope.id });
    // R4.5, R10.10: give the claim back so the redelivery can complete. If the release itself
    // fails, the claim expires after MESSAGE_CLAIM_TTL_S; the original error is still reported.
    try {
      await deps.state.releaseClaim(claimKey);
    } catch {
      log("ingest_release_failed", { type: envelope.type, id: envelope.id });
    }
    throw new IngestWriteError(envelope.type, envelope.id, error);
  }
}
