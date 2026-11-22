/**
 * Pure core of the `api-read` Lambda: `GET /me`, `/samples`, `/encounters`, `/encounters/{id}`
 * and `/device/status` (`docs/schema.md`, "HTTP API").
 *
 * No AWS imports and no S3 dependency: storage sits behind `Repository`, and snapshot URLs come
 * from the injected `SnapshotUrlSigner`, which is asked for `family` requests only. Time is
 * injected. Routes throw `ApiError`; the thin handler turns it into a response.
 *
 * Requirements: 11.5, 11.8, 12.4 to 12.6, 13.12 to 13.16, 14.1, 14.4, 14.6, 14.8.
 */

import type { Role } from "../_shared/authz.js";
import type { CloudConfig } from "../_shared/config.js";
import { ApiError } from "../_shared/http.js";
import type { Envelope } from "../_shared/messages.js";
import type { EncounterMeta, Repository, SampleLabel, StatusReportData } from "../_shared/ports.js";
import { redactEncounter } from "../_shared/redact.js";
import { filterLive, type TtlItem } from "../_shared/ttl.js";
import type { EncounterRecord, EncounterSnapshot } from "../_shared/types.js";

/** Lifetime of a pre-signed snapshot URL, in seconds (R14.6). */
export const SNAPSHOT_URL_TTL_S = 300;

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 50;

/** Used when a request names no device. One doll is deployed. */
export const DEFAULT_DEVICE_ID = "warashi-01";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENCOUNTER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/;

/**
 * Signs a snapshot URL. The adapter invokes the internal `snapshot-signer` function. The core
 * calls it only for the `family` role and never for `reviewer` (R14.4, R14.10).
 * Resolves `null` when no URL is available.
 */
export interface SnapshotUrlSigner {
  sign(snapshotKey: string, ttlS: number): Promise<string | null>;
}

/** The authenticated caller. `role` comes from the verified token claims only. */
export interface ReadRequest {
  role: Role;
  query: Readonly<Record<string, string>>;
  pathParameters: Readonly<Record<string, string>>;
}

export interface ReadDeps {
  repository: Repository;
  signer: SnapshotUrlSigner;
  config: Pick<
    CloudConfig,
    | "reviewerRealEncounters"
    | "statusIntervalS"
    | "reviewerSimulatePerHour"
    | "reviewerGeneratePerHour"
    | "familySimulatePerHour"
    | "familyGeneratePerHour"
  >;
  /** Version of the face-registration consent notice, shown by `GET /me`. */
  consentNoticeVersion: string;
  /** Device whose encounters `GET /encounters` lists. Defaults to `DEFAULT_DEVICE_ID`. */
  deviceId?: string;
  /** Current time, epoch milliseconds. */
  nowMs: number;
}

export interface MeResponse {
  role: Role;
  consentNoticeVersion: string;
  limits: { simulatePerHour: number; generatePerHour: number };
  /** Voice availability (S18). Added by the `api-read` handler, which reads the voice counters. */
  voice?: { enabled: boolean; maxSeconds: number; remainingToday: number };
}

export interface SamplesResponse {
  samples: { sampleId: string; label: SampleLabel }[];
}

export interface EncountersResponse {
  items: EncounterRecord[];
  nextCursor: string | null;
}

export interface DeviceStatusResponse {
  deviceId: string;
  online: boolean;
  lastSeenAt: string | null;
  status: StatusReportData | null;
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/** `GET /me` (R13.12). */
export function handleMe(request: ReadRequest, deps: ReadDeps): MeResponse {
  const { config } = deps;
  const limits =
    request.role === "reviewer"
      ? { simulatePerHour: config.reviewerSimulatePerHour, generatePerHour: config.reviewerGeneratePerHour }
      : { simulatePerHour: config.familySimulatePerHour, generatePerHour: config.familyGeneratePerHour };
  return { role: request.role, consentNoticeVersion: deps.consentNoticeVersion, limits };
}

/** `GET /samples` (R13.13): id and expected label only. */
export async function handleSamples(_request: ReadRequest, deps: ReadDeps): Promise<SamplesResponse> {
  const manifest = await deps.repository.getSampleManifest();
  return { samples: manifest.map((entry) => ({ sampleId: entry.id, label: entry.label })) };
}

/** `GET /encounters` (R13.14, R13.15, R14.8). */
export async function handleListEncounters(request: ReadRequest, deps: ReadDeps): Promise<EncountersResponse> {
  const limit = parseLimit(request.query["limit"]);
  const cursor = parseCursor(request.query["cursor"]);

  // `hidden` returns an empty list to the reviewer without reading anything (R14.8).
  if (hidesRealEncounters(request.role, deps)) {
    return { items: [], nextCursor: null };
  }

  let page;
  try {
    page = await deps.repository.listEncounters(deps.deviceId ?? DEFAULT_DEVICE_ID, limit, cursor, deps.nowMs);
  } catch (error) {
    if (isInvalidCursor(error)) throw new ApiError("validation_failed", "The cursor is not valid.");
    throw error;
  }

  // Hide expired items even if DynamoDB has not deleted them yet (R11.8).
  const live = filterLive(page.items as (EncounterMeta & TtlItem)[], Math.floor(deps.nowMs / 1000));
  const items = await Promise.all(live.map((meta) => buildRecord(meta, [], request.role, deps)));
  return { items, nextCursor: page.nextCursor };
}

/** `GET /encounters/{id}` (R13.16, R14.8). */
export async function handleGetEncounter(request: ReadRequest, deps: ReadDeps): Promise<EncounterRecord> {
  const id = request.pathParameters["id"];
  if (id === undefined || !ENCOUNTER_ID_PATTERN.test(id) || hidesRealEncounters(request.role, deps)) {
    throw notFound();
  }
  const meta = await deps.repository.getEncounter(id, deps.nowMs);
  if (meta === null || filterLive([meta as EncounterMeta & TtlItem], Math.floor(deps.nowMs / 1000)).length === 0) {
    throw notFound();
  }
  const events = await deps.repository.listEvents(id);
  return buildRecord(meta, events, request.role, deps);
}

/** `GET /device/status` (R12.4 to R12.6). */
export async function handleDeviceStatus(request: ReadRequest, deps: ReadDeps): Promise<DeviceStatusResponse> {
  const raw = request.query["deviceId"];
  if (raw !== undefined && !DEVICE_ID_PATTERN.test(raw)) {
    throw new ApiError("validation_failed", "deviceId is not valid.");
  }
  const deviceId = raw ?? deps.deviceId ?? DEFAULT_DEVICE_ID;
  const record = await deps.repository.getDeviceStatus(deviceId);

  if (record === null || record.status === null || record.lastReportAtMs === null) {
    return { deviceId, online: false, lastSeenAt: null, status: null };
  }
  return {
    deviceId,
    online: isOnline(record.lastReportAtMs, record.lastOfflineAtMs, deps.nowMs, deps.config.statusIntervalS),
    lastSeenAt: new Date(record.lastReportAtMs).toISOString(),
    status: record.status,
  };
}

/**
 * Online rule (R12.4): the last report is not older than the last offline mark, and it arrived
 * at most 3 x `statusIntervalS` seconds ago. Uses arrival times only, never message `ts`.
 */
export function isOnline(
  lastReportAtMs: number,
  lastOfflineAtMs: number | null,
  nowMs: number,
  statusIntervalS: number,
): boolean {
  if (lastOfflineAtMs !== null && lastReportAtMs < lastOfflineAtMs) return false;
  return nowMs - lastReportAtMs <= 3 * statusIntervalS * 1000;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function notFound(): ApiError {
  return new ApiError("not_found", "Encounter not found.");
}

function hidesRealEncounters(role: Role, deps: ReadDeps): boolean {
  // Any value other than "redacted" hides: an invalid setting returns nothing (R14.9).
  return role === "reviewer" && deps.config.reviewerRealEncounters !== "redacted";
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  if (!/^\d{1,3}$/.test(raw)) throw new ApiError("validation_failed", "limit must be an integer from 1 to 50.");
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ApiError("validation_failed", "limit must be an integer from 1 to 50.");
  }
  return limit;
}

function parseCursor(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (!CURSOR_PATTERN.test(raw)) throw new ApiError("validation_failed", "The cursor is not valid.");
  return raw;
}

function isInvalidCursor(error: unknown): boolean {
  return error instanceof Error && error.name === "InvalidCursorError";
}

/**
 * Builds the role-specific record. The reviewer never reaches the signer and never sees the
 * snapshot key (R14.4); the family gets a signed URL or `null` when none is available (R14.6).
 */
async function buildRecord(
  meta: EncounterMeta,
  events: Envelope[],
  role: Role,
  deps: ReadDeps,
): Promise<EncounterRecord> {
  const base: EncounterRecord = {
    encounterId: meta.encounterId,
    deviceId: meta.deviceId,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    state: meta.state,
    verdict: meta.verdict,
    confidence: meta.confidence,
    reaction: meta.reaction,
    notified: meta.notified,
    snapshot: null,
    illustration: null,
    events,
  };
  if (role === "reviewer") return redactEncounter(base, "reviewer");
  return { ...redactEncounter(base, "family"), snapshot: await signSnapshot(meta.snapshotKey, deps) };
}

async function signSnapshot(snapshotKey: string | null, deps: ReadDeps): Promise<EncounterSnapshot | null> {
  if (snapshotKey === null) return null;
  let url: string | null;
  try {
    url = await deps.signer.sign(snapshotKey, SNAPSHOT_URL_TTL_S);
  } catch {
    // A signing failure hides the picture; it must not hide the encounter.
    return null;
  }
  if (url === null) return null;
  return { url, expiresAt: new Date(deps.nowMs + SNAPSHOT_URL_TTL_S * 1000).toISOString() };
}
