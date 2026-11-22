/**
 * Ports (cloud-judgement design, "Ports used by handlers").
 *
 * Every AWS service and every table access sits behind one of these interfaces, so the pure
 * cores and the thin handlers never touch an SDK, and tests use fakes (task 11.2). Types only:
 * no runtime code and no AWS imports.
 */

import type { Category } from "./lines.js";
import type { Envelope } from "./messages.js";
import type { EncounterReaction, Verdict } from "./types.js";
import type { FaceBox, FaceQuality, SearchOutcome } from "./verdict.js";

// ---------------------------------------------------------------------------------------------
// AWS service ports
// ---------------------------------------------------------------------------------------------

export interface FaceSearch {
  /**
   * Search the largest face of `image` in the collection. "No face" is a normal outcome
   * (`{ kind: "no_face" }`). Other failures reject, and the caller maps them to a failure verdict.
   */
  search(image: Uint8Array, collectionId: string, floor: number): Promise<SearchOutcome>;
  /** Count faces and report the quality of the largest one. */
  detect(image: Uint8Array): Promise<{ faces: number; quality: FaceQuality; box: FaceBox | null }>;
  /**
   * Add every face of `image` to the collection with `externalImageId` (the opaque member id,
   * never a name). Resolves the new face ids, one per indexed face; empty when none was indexed.
   */
  indexFaces(image: Uint8Array, collectionId: string, externalImageId: string): Promise<string[]>;
  /**
   * Delete faces from the collection. An empty list does nothing. Rejects when any face could not
   * be deleted, so a caller never keeps going on a partial delete.
   */
  deleteFaces(collectionId: string, faceIds: readonly string[]): Promise<void>;
}

export interface SnapshotStore {
  /** `contentType` defaults to `image/jpeg`; the audio store passes `audio/wav`. */
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  /** Pre-signed GET URL. Never log it in full. */
  signGet(key: string, ttlS: number): Promise<string>;
}

/** A remote photo that reached the cloud (`PHOTO#<requestId>`, remote-actions R5). */
export interface PhotoRecord {
  requestId: string;
  deviceId: string;
  /** S3 key under `snapshots/`, so the photo expires with the other snapshots. */
  snapshotKey: string;
  atMs: number;
  /** DynamoDB TTL, epoch seconds. */
  ttl: number;
}
/** Where the judge leaves a remote photo. */
export interface PhotoStore {
  putPhoto(photo: PhotoRecord): Promise<void>;
}
/** Where `GET /photos/{requestId}` finds it. Resolves `null` for an unknown id. */
export interface PhotoReader {
  getPhoto(requestId: string): Promise<PhotoRecord | null>;
}
export interface DeviceBus {
  /** Publish with QoS 1 to `warashi/<deviceId>/commands`. */
  publish(deviceId: string, envelope: Envelope): Promise<void>;
}

export interface Notifier {
  send(message: { subject: string; body: string }): Promise<void>;
}

export interface SpeechSynth {
  /** A short generated line, or `null` when none is available. */
  line(situation: Category, hint: string | null): Promise<string | null>;
  mp3(text: string): Promise<Uint8Array>;
  /** 16 kHz mono 16-bit PCM wrapped as WAV. */
  wav16k(text: string): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------------------------
// Conditional state: claims, notify slot, counters
// ---------------------------------------------------------------------------------------------

export interface StateStore {
  /** Conditional put of `key`. True only for the first caller within `ttlS`. */
  claim(key: string, ttlS: number): Promise<boolean>;
  /**
   * Give back a claim this caller made, so a redelivered message can be claimed again (R4.5,
   * R10.10). Does nothing when the claim is absent or belongs to another claim.
   */
  releaseClaim(key: string): Promise<void>;
  /**
   * One transaction: succeed when no notification was sent for this encounter and the last one
   * is older than `windowMs`. True when this caller owns the slot.
   */
  claimNotifySlot(
    deviceId: string,
    encounterId: string,
    nowMs: number,
    windowMs: number,
  ): Promise<boolean>;
  /** Give the slot back after a failed send, so a later snapshot may notify. */
  releaseNotifySlot(deviceId: string, encounterId: string): Promise<void>;
  /** Time of the last notification for the device, or `null`. */
  lastNotifiedAtMs(deviceId: string): Promise<number | null>;
  /**
   * One conditional `ADD count 1` (`attribute_not_exists(count) OR count < :limit`).
   * A failed condition returns `allowed: false` and does not change the counter.
   */
  incrementCounter(
    key: string,
    limit: number,
    ttlS: number,
  ): Promise<{ allowed: boolean; count: number }>;
  /**
   * Undo one successful `incrementCounter` (`ADD count -1`, never below 0). Lets `guardSimulate`
   * leave every counter unchanged when a later counter of the same request rejects (R15.13).
   */
  releaseCounter(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Repository: encounters, events, members, device status, samples
// ---------------------------------------------------------------------------------------------

/** Encounter meta item as stored (no snapshot URL, no illustration, no events). */
export type EncounterMeta = {
  encounterId: string;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
  state: string | null;
  verdict: Verdict | null;
  confidence: number | null;
  reaction: EncounterReaction | null;
  notified: boolean;
  /** S3 key of the snapshot, or `null` when none was stored. */
  snapshotKey: string | null;
  errorCount: number;
};

/** Fields an update may change. Identity fields (`encounterId`, `deviceId`, `startedAt`) are fixed. */
export type EncounterPatch = Partial<
  Omit<EncounterMeta, "encounterId" | "deviceId" | "startedAt">
>;

export type EncounterPage = { items: EncounterMeta[]; nextCursor: string | null };

/** Data of a `status.report`, as in docs/schema.md. */
export type StatusReportData = {
  state: string;
  mode: "guard" | "sleep";
  panDeg: number;
  tiltDeg: number;
  lantern: number;
  cameraActive: boolean;
  micActive: boolean;
  motionEnabled: boolean;
  uptimeSec: number;
  agentVersion: string;
};

/** Latest device status item. `status` is `null` until a report arrived. */
export type DeviceStatusRecord = {
  deviceId: string;
  status: StatusReportData | null;
  /** Arrival time of the last `status.report`, or `null`. */
  lastReportAtMs: number | null;
  /** Arrival time of the last `status.offline`, or `null`. Never the will's own `ts`. */
  lastOfflineAtMs: number | null;
};

/** A registered family member. Face ids stay inside the cloud and never reach an API response. */
export type FamilyMember = {
  memberId: string;
  displayName: string;
  faceIds: string[];
  consentVersion: string;
  consentAt: string;
  createdBy: string;
};

export type SampleLabel = "family" | "stranger" | "no_face" | "uncertain";
export type SampleEntry = { id: string; label: SampleLabel };

export interface Repository {
  // Encounters
  /** Create the meta item unless it exists. True when this call created it. */
  createEncounterIfAbsent(meta: EncounterMeta, ttlS: number): Promise<boolean>;
  getEncounter(encounterId: string, nowMs: number): Promise<EncounterMeta | null>;
  /** Apply a patch to an existing encounter. Resolves `false` when it does not exist. */
  updateEncounter(encounterId: string, patch: EncounterPatch): Promise<boolean>;
  /** Newest first, items past their expiry excluded. `cursor` is opaque and issued by this port. */
  listEncounters(
    deviceId: string,
    limit: number,
    cursor: string | null,
    nowMs: number,
  ): Promise<EncounterPage>;

  // Events (stored envelopes already have `jpegBase64` removed and `hasImage: true`)
  appendEvent(encounterId: string, envelope: Envelope, ttlS: number): Promise<void>;
  /** In time order. */
  listEvents(encounterId: string): Promise<Envelope[]>;

  // Device status
  getDeviceStatus(deviceId: string): Promise<DeviceStatusRecord | null>;
  putStatusReport(deviceId: string, data: StatusReportData, receivedAtMs: number): Promise<void>;
  markOffline(deviceId: string, receivedAtMs: number): Promise<void>;

  // Family members
  listMembers(): Promise<FamilyMember[]>;
  getMember(memberId: string): Promise<FamilyMember | null>;
  putMember(member: FamilyMember): Promise<void>;
  /** Resolves `false` when the member does not exist. */
  deleteMember(memberId: string): Promise<boolean>;

  // Sample manifest (`samples/manifest.json`) and sample images
  getSampleManifest(): Promise<SampleEntry[]>;
  /** Image bytes of a sample, or `null` when the id is not in the manifest. */
  getSampleImage(sampleId: string): Promise<Uint8Array | null>;
}
