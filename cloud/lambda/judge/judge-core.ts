/**
 * Judge core: turns one `snapshot.captured` event into a `judgement.result` (cloud-judgement
 * design, "Judge handler" and "Notification debounce").
 *
 * Pure over ports: no AWS imports. Time, randomness, ids and sleeping are injected, so the
 * tests run with fakes and a fake clock. The Lambda handler only builds `JudgeDeps` and calls
 * `handleSnapshot`.
 *
 * Order of work, and why:
 *   1. Sender check, decode, JPEG checks: a bad message causes no side effect.
 *   2. Claim `SNAP#<snapshotId>` before any search, so a redelivery does nothing (R4.1, R4.2).
 *   3. Store the JPEG and search the face in parallel; the store is off the critical path.
 *   4. Decide, publish with a 2 s limit, and only then write the table (R6.4, R6.6).
 *   5. Notify once for a stranger. A notification problem never undoes the published verdict.
 *
 * Logs name ids, reasons and verdicts only. Never image data, face ids, similarities of
 * discarded matches, names or URLs (R8.5, R8.6).
 */

import type { CloudConfig } from "../_shared/config.js";
import { decodeEnvelope, makeCommand } from "../_shared/messages.js";
import type { Envelope } from "../_shared/messages.js";
import { buildStrangerNotification, shouldNotify } from "../_shared/notify.js";
import type {
  DeviceBus,
  FaceSearch,
  Notifier,
  PhotoStore,
  Repository,
  SnapshotStore,
  StateStore,
} from "../_shared/ports.js";
import { log } from "../_shared/safelog.js";
import {
  classifySearchError,
  decideVerdict,
  isStrangerCandidate,
} from "../_shared/verdict.js";
import type {
  AdapterFailure,
  FaceQuality,
  Judgement,
  SearchOutcome,
  Verdict,
} from "../_shared/verdict.js";

/** Largest JPEG the Judge accepts after base64 decoding (R2.4). */
export const MAX_JPEG_BYTES = 100_000;
const MIN_JPEG_BYTES = 3;
/** Claim lifetime of `SNAP#<snapshotId>` (R4.1). */
export const CLAIM_TTL_S = 86_400;
/** Publish limit (R6.6). */
export const PUBLISH_TIMEOUT_MS = 2_000;
/** A throttled search is retried only while less than this has elapsed (R5.10). */
export const THROTTLE_RETRY_LIMIT_MS = 1_500;
const RETRY_DELAY_MIN_MS = 50;
const RETRY_DELAY_SPAN_MS = 200; // 50 to 250 ms
/** Item lifetime in days (R11.4). */
const ITEM_TTL_DAYS = 30;
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The IoT rule output: the device envelope as JSON fields plus `topicDeviceId` (the `<id>`
 * segment of the topic, added by the rule SQL).
 */
export type SnapshotEvent = Readonly<Record<string, unknown>> & { topicDeviceId?: unknown };

/** Lifetime of a `LOOK#<requestId>` item: 10 minutes (voice-conversation design, data models). */
export const LOOK_TTL_S = 600;

/**
 * Where a voice session finds the verdict of a look (`LOOK#<requestId>` / `RESULT`). Kept local
 * to the judge so the shared ports stay unchanged.
 */
export interface LookStore {
  putLook(requestId: string, verdict: Verdict, atMs: number, ttlS: number): Promise<void>;
}

export interface JudgeDeps {
  /** Optional: without it, a `requestId` is ignored. */
  looks?: LookStore;
  /** Optional: without it, a remote photo is ignored (remote-actions R4). */
  photos?: PhotoStore;
  faces: FaceSearch;
  snapshots: SnapshotStore;
  bus: DeviceBus;
  notifier: Notifier;
  state: StateStore;
  repository: Repository;
  config: CloudConfig;
  /** Rekognition collection of the household. */
  collectionId: string;
  deviceLabel: (deviceId: string) => string;
  dashboardUrl: string;
  /** Epoch milliseconds. */
  now: () => number;
  /** A number in [0, 1). */
  random: () => number;
  /** A new UUID for the command envelope. */
  newId: () => string;
  /** Resolves after `ms` milliseconds. */
  sleep: (ms: number) => Promise<void>;
}

export type JudgeResult =
  | { outcome: "ignored"; reason: string }
  | { outcome: "duplicate" }
  | { outcome: "photo"; stored: boolean }
  | {
      outcome: "judged";
      verdict: Verdict;
      published: boolean;
      stored: boolean;
      notified: boolean;
    };

// ---------------------------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------------------------

/** Decodes strict base64 and checks size and the JPEG signature. Returns a reason on failure. */
export function decodeJpeg(text: string): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  // Reject before decoding: 100,000 bytes are at most 133,336 base64 characters.
  if (text.length > Math.ceil(MAX_JPEG_BYTES / 3) * 4) return { ok: false, reason: "jpeg_too_large" };
  if (!BASE64_PATTERN.test(text)) return { ok: false, reason: "invalid_base64" };
  const bytes = new Uint8Array(Buffer.from(text, "base64"));
  if (bytes.length > MAX_JPEG_BYTES) return { ok: false, reason: "jpeg_too_large" };
  if (bytes.length < MIN_JPEG_BYTES) return { ok: false, reason: "jpeg_too_small" };
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return { ok: false, reason: "bad_jpeg_signature" };
  }
  return { ok: true, bytes };
}

/** `snapshots/<deviceId>/<yyyymmdd>/<snapshotId>.jpg`, the date is the UTC date of `ts` (R2.7). */
export function snapshotKeyFor(deviceId: string, ts: string, snapshotId: string, nowMs: number): string {
  const parsed = Date.parse(ts);
  const date = new Date(Number.isFinite(parsed) ? parsed : nowMs);
  const yyyymmdd = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `snapshots/${deviceId}/${yyyymmdd}/${snapshotId}.jpg`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

// ---------------------------------------------------------------------------------------------
// Search with the throttle rule and the DetectFaces follow-ups
// ---------------------------------------------------------------------------------------------

type SearchStep = { kind: "bad_param" } | SearchOutcome | AdapterFailure;

async function searchOnce(jpeg: Uint8Array, deps: JudgeDeps, startedMs: number): Promise<SearchStep> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await deps.faces.search(jpeg, deps.collectionId, deps.config.searchFloor);
    } catch (error) {
      const kind = classifySearchError(errorName(error));
      if (kind === "no_face_or_bad_param") return { kind: "bad_param" };
      const canRetry =
        kind === "throttled" && attempt === 0 && deps.now() - startedMs < THROTTLE_RETRY_LIMIT_MS;
      if (!canRetry) {
        log("search_failed", { errorName: errorName(error), throttled: kind === "throttled" });
        return { kind: "failure", stage: "search" };
      }
      await deps.sleep(RETRY_DELAY_MIN_MS + Math.floor(deps.random() * RETRY_DELAY_SPAN_MS));
    }
  }
  return { kind: "failure", stage: "search" };
}

/** Runs the search and, where the design asks for it, `DetectFaces`. Never throws. */
async function findOutcome(
  jpeg: Uint8Array,
  deps: JudgeDeps,
  startedMs: number,
): Promise<{ outcome: SearchOutcome | AdapterFailure; quality: FaceQuality }> {
  const step = await searchOnce(jpeg, deps, startedMs);

  if (step.kind === "bad_param") {
    // InvalidParameterException means "no face" or a bad request: DetectFaces tells which (R5.7).
    try {
      const detected = await deps.faces.detect(jpeg);
      if (detected.faces === 0) return { outcome: { kind: "no_face" }, quality: null };
    } catch (error) {
      log("detect_failed", { errorName: errorName(error) });
    }
    return { outcome: { kind: "failure", stage: "detect" }, quality: null };
  }

  if (step.kind === "face" && isStrangerCandidate(step, deps.config)) {
    try {
      const detected = await deps.faces.detect(jpeg);
      return { outcome: step, quality: detected.quality };
    } catch (error) {
      log("detect_failed", { errorName: errorName(error) });
      return { outcome: step, quality: null }; // missing quality makes the verdict uncertain
    }
  }
  return { outcome: step, quality: null };
}

// ---------------------------------------------------------------------------------------------
// Publish, record, notify
// ---------------------------------------------------------------------------------------------

type Timed = "ok" | "timeout";

async function publishWithLimit(
  deps: JudgeDeps,
  deviceId: string,
  command: Envelope,
  snapshotId: string,
): Promise<boolean> {
  try {
    const result = await Promise.race<Timed>([
      deps.bus.publish(deviceId, command).then((): Timed => "ok"),
      deps.sleep(PUBLISH_TIMEOUT_MS).then((): Timed => "timeout"),
    ]);
    if (result === "ok") return true;
    log("publish_failed", { snapshotId, reason: "timeout" });
  } catch (error) {
    log("publish_failed", { snapshotId, errorName: errorName(error) });
  }
  return false;
}

async function recordVerdict(
  deps: JudgeDeps,
  decoded: Envelope,
  snapshotId: string,
  judgement: Judgement,
  snapshotKey: string | null,
  command: Envelope | null,
): Promise<boolean> {
  const encounterId = decoded.encounterId;
  if (encounterId === null) {
    log("record_skipped", { snapshotId, reason: "no_encounter" });
    return false;
  }
  const ttlS = ITEM_TTL_DAYS * 86_400;
  try {
    // The ingest function may not have created the meta item yet.
    await deps.repository.createEncounterIfAbsent(
      {
        encounterId,
        deviceId: decoded.deviceId,
        startedAt: decoded.ts,
        endedAt: null,
        state: null,
        verdict: null,
        confidence: null,
        reaction: null,
        notified: false,
        snapshotKey: null,
        errorCount: 0,
      },
      ttlS,
    );
    await deps.repository.updateEncounter(encounterId, {
      verdict: judgement.verdict,
      confidence: judgement.confidence,
      snapshotKey,
    });
    if (command !== null) await deps.repository.appendEvent(encounterId, command, ttlS);
    return true;
  } catch (error) {
    log("record_failed", { snapshotId, errorName: errorName(error) });
    return false;
  }
}

/**
 * One stranger notification per encounter and per window (R9.1). The slot is claimed in one
 * transaction before sending and released only after a reported send failure (R9.8).
 */
export async function notifyOnce(
  deps: JudgeDeps,
  msg: { deviceId: string; encounterId: string | null },
): Promise<boolean> {
  const { deviceId, encounterId } = msg;
  if (encounterId === null) {
    log("notify_skipped", { reason: "no_encounter" });
    return false;
  }
  try {
    const nowMs = deps.now();
    const last = await deps.state.lastNotifiedAtMs(deviceId);
    const encounter = await deps.repository.getEncounter(encounterId, nowMs);
    const decision = shouldNotify({
      verdict: "stranger",
      encounterAlreadyNotified: encounter?.notified === true,
      lastNotifiedAtMs: last,
      nowMs,
      windowMs: deps.config.notifyWindowMs,
    });
    if (!decision.notify) {
      log("notify_skipped", { reason: decision.reason });
      return false;
    }
    const owns = await deps.state.claimNotifySlot(
      deviceId,
      encounterId,
      nowMs,
      deps.config.notifyWindowMs,
    );
    if (!owns) {
      log("notify_skipped", { reason: "slot_taken" });
      return false;
    }
    const message = buildStrangerNotification({
      deviceLabel: deps.deviceLabel(deviceId),
      atIso: new Date(nowMs).toISOString(),
      dashboardUrl: deps.dashboardUrl,
    });
    try {
      await deps.notifier.send(message);
    } catch (error) {
      log("notify_failed", { encounterId, errorName: errorName(error) });
      try {
        await deps.state.releaseNotifySlot(deviceId, encounterId);
      } catch (releaseError) {
        log("notify_release_failed", { encounterId, errorName: errorName(releaseError) });
      }
      return false;
    }
    return true;
  } catch (error) {
    log("notify_error", { encounterId, errorName: errorName(error) });
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Remote photo
// ---------------------------------------------------------------------------------------------
/**
 * Stores the picture and leaves an index item for `GET /photos/{requestId}`. No face search, no
 * `judgement.result`, no notification: the family asked for a picture, it is not a visitor.
 * The index item is written only after the object is stored, so `ready` always has a picture.
 */
async function storePhoto(
  message: Envelope,
  jpeg: Uint8Array,
  key: string,
  requestId: string,
  deps: JudgeDeps,
): Promise<JudgeResult> {
  try {
    await deps.snapshots.put(key, jpeg);
  } catch (error) {
    log("photo_store_failed", { requestId, errorName: errorName(error) });
    return { outcome: "photo", stored: false };
  }
  const nowMs = deps.now();
  try {
    await deps.photos?.putPhoto({
      requestId,
      deviceId: message.deviceId,
      snapshotKey: key,
      atMs: nowMs,
      ttl: Math.floor(nowMs / 1000) + deps.config.snapshotExpiryDays * 86_400,
    });
  } catch (error) {
    log("photo_index_failed", { requestId, errorName: errorName(error) });
    return { outcome: "photo", stored: false };
  }
  // The encounter of the photo also keeps the picture, so the family sees it in the timeline.
  const encounterId = message.encounterId;
  if (encounterId !== null) {
    try {
      const ttlS = ITEM_TTL_DAYS * 86_400;
      await deps.repository.createEncounterIfAbsent(
        {
          encounterId,
          deviceId: message.deviceId,
          startedAt: message.ts,
          endedAt: null,
          state: null,
          verdict: null,
          confidence: null,
          reaction: null,
          notified: false,
          snapshotKey: null,
          errorCount: 0,
        },
        ttlS,
      );
      await deps.repository.updateEncounter(encounterId, { snapshotKey: key });
    } catch (error) {
      log("photo_record_failed", { requestId, errorName: errorName(error) });
    }
  }
  log("photo_stored", { requestId });
  return { outcome: "photo", stored: true };
}
// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export async function handleSnapshot(event: SnapshotEvent, deps: JudgeDeps): Promise<JudgeResult> {
  const { topicDeviceId, ...rest } = event;
  const rawId = typeof rest["id"] === "string" ? rest["id"] : null;

  // Sender check before anything else (R3.1 to R3.3). The claimed deviceId is never logged.
  const claimed = rest["deviceId"];
  if (
    typeof topicDeviceId !== "string" ||
    typeof claimed !== "string" ||
    claimed === "" ||
    claimed !== topicDeviceId
  ) {
    log("security_mismatch", { id: rawId, topicDeviceId: typeof topicDeviceId === "string" ? topicDeviceId : null });
    return { outcome: "ignored", reason: "security_mismatch" };
  }

  const decoded = decodeEnvelope(JSON.stringify(rest));
  if (decoded.kind !== "valid") {
    const reason = decoded.kind === "ignored" ? decoded.reason : "malformed";
    log("snapshot_ignored", { id: rawId, reason });
    return { outcome: "ignored", reason };
  }
  const message = decoded.message;
  if (message.type !== "snapshot.captured") {
    log("snapshot_ignored", { id: message.id, reason: "not_snapshot" });
    return { outcome: "ignored", reason: "not_snapshot" };
  }

  const data = message.data as { snapshotId: string; jpegBase64: string };
  const jpeg = decodeJpeg(data.jpegBase64);
  if (!jpeg.ok) {
    log("snapshot_ignored", { id: message.id, reason: jpeg.reason });
    return { outcome: "ignored", reason: jpeg.reason };
  }
  const snapshotId = data.snapshotId;
  // A remote photo is stored and indexed, never judged (remote-actions R1, R4).
  const extra = message.data as { purpose?: string | null; requestId?: string | null };
  let photoRequestId: string | null = null;
  if (extra.purpose === "photo") {
    if (typeof extra.requestId !== "string" || deps.photos === undefined) {
      log("snapshot_ignored", { id: message.id, reason: "photo_without_request" });
      return { outcome: "ignored", reason: "photo_without_request" };
    }
    photoRequestId = extra.requestId;
  }
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    // The id becomes part of an S3 key and of the claim key, so odd characters are refused.
    log("snapshot_ignored", { id: message.id, reason: "bad_snapshot_id" });
    return { outcome: "ignored", reason: "bad_snapshot_id" };
  }

  // Claim before any search. A failing claim write propagates so the message can be redelivered.
  const first = await deps.state.claim(`SNAP#${snapshotId}`, CLAIM_TTL_S);
  if (!first) {
    log("snapshot_duplicate", { snapshotId });
    return { outcome: "duplicate" };
  }

  const startedMs = deps.now();
  const key = snapshotKeyFor(message.deviceId, message.ts, snapshotId, startedMs);
  if (photoRequestId !== null) {
    return storePhoto(message, jpeg.bytes, key, photoRequestId, deps);
  }
  const storeTask = deps.snapshots.put(key, jpeg.bytes).then(
    () => true,
    (error: unknown) => {
      log("snapshot_store_failed", { snapshotId, errorName: errorName(error) });
      return false;
    },
  );

  const { outcome, quality } = await findOutcome(jpeg.bytes, deps, startedMs);
  const judgement = decideVerdict(outcome, quality, deps.config);
  log("verdict", { snapshotId, verdict: judgement.verdict, reason: judgement.reason });

  // No `speak` here: the doll plays its own cached line (R6.5).
  let command: Envelope | null = null;
  let published = false;
  try {
    command = makeCommand(
      "judgement.result",
      {
        snapshotId,
        verdict: judgement.verdict,
        confidence: judgement.confidence,
        face: judgement.face,
      },
      {
        id: deps.newId(),
        now: new Date(deps.now()),
        deviceId: message.deviceId,
        encounterId: message.encounterId,
      },
    );
    published = await publishWithLimit(deps, message.deviceId, command, snapshotId);
  } catch (error) {
    log("publish_failed", { snapshotId, errorName: errorName(error) });
  }

  // A snapshot that answers a `snapshot.request` also leaves its verdict for the voice session.
  // A failure here never changes the verdict, the record or the notification.
  const requestId = (message.data as { requestId?: string | null }).requestId;
  if (typeof requestId === "string" && deps.looks !== undefined) {
    try {
      await deps.looks.putLook(requestId, judgement.verdict, deps.now(), LOOK_TTL_S);
    } catch (error) {
      log("look_write_failed", { snapshotId, errorName: errorName(error) });
    }
  }

  const stored = await storeTask;
  await recordVerdict(deps, message, snapshotId, judgement, stored ? key : null, command);

  let notified = false;
  if (judgement.verdict === "stranger") {
    notified = await notifyOnce(deps, message);
  }
  return { outcome: "judged", verdict: judgement.verdict, published, stored, notified };
}
