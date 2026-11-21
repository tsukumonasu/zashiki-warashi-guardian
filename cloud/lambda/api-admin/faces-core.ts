/**
 * Pure core of the face-registration routes of `api-admin`: `GET /faces`, `POST /faces/upload`,
 * `POST /faces` and `DELETE /faces/{memberId}` (`docs/schema.md`, "HTTP API").
 *
 * No AWS imports. Rekognition sits behind `FaceSearch`, member records behind `Repository`, and
 * the S3 staging prefix behind the `FaceStaging` interface below. Time and ids are injected.
 * Routes throw `ApiError`; the thin handler turns it into a response. The core never logs, so a
 * face id can never appear next to a name. Responses never contain a face id or a staging URL
 * beyond the pre-signed POST the caller asked for.
 *
 * Requirements: 8.6, 17.1 to 17.16.
 */

import type { Role } from "../_shared/authz.js";
import { ApiError } from "../_shared/http.js";
import type { FaceSearch, FamilyMember, Repository } from "../_shared/ports.js";

/** Lifetime of the pre-signed upload, in seconds (R17.3). */
export const UPLOAD_TTL_S = 300;
/** Largest accepted staged photo, in bytes (R17.3). */
export const MAX_PHOTO_BYTES = 5_000_000;
export const MIN_PHOTO_BYTES = 1;
export const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png"] as const;
/** S3 prefix of staged photos (R17.3). */
export const STAGING_PREFIX = "faces-staging/";

export const MIN_NAME_CHARS = 1;
export const MAX_NAME_CHARS = 40;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `faces-staging/` plus a safe object name: no `.` and no `/`, so no traversal. */
const STAGING_KEY_PATTERN = /^faces-staging\/[A-Za-z0-9_-]{1,128}$/;

/** A pre-signed POST for the staging prefix. */
export interface StagingUpload {
  url: string;
  fields: Record<string, string>;
}

/**
 * The S3 staging prefix. The adapter signs a POST policy with `content-length-range`
 * `[minBytes, maxBytes]`, a `Content-Type` condition and the given lifetime.
 */
export interface FaceStaging {
  createUpload(options: {
    key: string;
    contentTypes: readonly string[];
    minBytes: number;
    maxBytes: number;
    ttlS: number;
  }): Promise<StagingUpload>;
  /** The staged bytes, or `null` when the object does not exist. */
  read(key: string): Promise<Uint8Array | null>;
  /** Delete the staged object. Deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

export interface FacesRequest {
  /** From the verified token claims only. */
  role: Role;
  /** Stable id of the signed-in user (the `sub` claim). Stored as `createdBy`. */
  userId: string;
  /** Parsed JSON body (`{}` when the request has none). */
  body: Readonly<Record<string, unknown>>;
  pathParameters: Readonly<Record<string, string>>;
}

export interface FacesDeps {
  repository: Pick<Repository, "listMembers" | "getMember" | "putMember" | "deleteMember">;
  faces: Pick<FaceSearch, "indexFaces" | "deleteFaces">;
  staging: FaceStaging;
  /** Rekognition collection of the household (`warashi-household`). */
  collectionId: string;
  /** Version of the consent notice the dashboard shows (`GET /me`). */
  consentNoticeVersion: string;
  /** Current time, epoch milliseconds. */
  nowMs: number;
  /** Returns a new random UUID. */
  newId: () => string;
}

export interface MemberSummary {
  memberId: string;
  displayName: string;
  createdAt: string;
  consentVersion: string;
  faceCount: number;
}

export interface ListFacesResponse {
  members: MemberSummary[];
}

export interface UploadResponse {
  url: string;
  fields: Record<string, string>;
  stagingKey: string;
  expiresInS: typeof UPLOAD_TTL_S;
}

export interface RegisterFaceResponse {
  memberId: string;
  faceCount: number;
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/** `GET /faces` (R17.12): no face ids, an empty list when there is no member. */
export async function handleListFaces(request: FacesRequest, deps: FacesDeps): Promise<ListFacesResponse> {
  requireFamily(request);
  const members = await deps.repository.listMembers();
  const sorted = [...members].sort(
    (a, b) => a.consentAt.localeCompare(b.consentAt) || a.memberId.localeCompare(b.memberId),
  );
  return {
    members: sorted.map((m) => ({
      memberId: m.memberId,
      displayName: m.displayName,
      createdAt: m.consentAt,
      consentVersion: m.consentVersion,
      faceCount: m.faceIds.length,
    })),
  };
}

/** `POST /faces/upload` (R17.3): a pre-signed POST for JPEG or PNG of 1 to 5,000,000 bytes. */
export async function handleFaceUpload(request: FacesRequest, deps: FacesDeps): Promise<UploadResponse> {
  requireFamily(request);
  const stagingKey = `${STAGING_PREFIX}${deps.newId()}`;
  const upload = await deps.staging.createUpload({
    key: stagingKey,
    contentTypes: ALLOWED_CONTENT_TYPES,
    minBytes: MIN_PHOTO_BYTES,
    maxBytes: MAX_PHOTO_BYTES,
    ttlS: UPLOAD_TTL_S,
  });
  return { url: upload.url, fields: upload.fields, stagingKey, expiresInS: UPLOAD_TTL_S };
}

/**
 * `POST /faces` (R17.4 to R17.11). The staged object is deleted in every outcome (R17.8), as long
 * as the key names an object under the staging prefix.
 */
export async function handleRegisterFace(request: FacesRequest, deps: FacesDeps): Promise<RegisterFaceResponse> {
  requireFamily(request);
  const stagingKey = validStagingKey(request.body["stagingKey"]);
  try {
    return await registerFace(request, deps, stagingKey);
  } finally {
    if (stagingKey !== null) await deleteStaged(deps, stagingKey);
  }
}

/** `DELETE /faces/{memberId}` (R17.13 to R17.15). The route answers `204` on success. */
export async function handleDeleteFace(request: FacesRequest, deps: FacesDeps): Promise<void> {
  requireFamily(request);
  const memberId = request.pathParameters["memberId"];
  if (memberId === undefined || !UUID_PATTERN.test(memberId)) throw memberNotFound();
  const member = await deps.repository.getMember(memberId);
  if (member === null) throw memberNotFound();

  // Vectors first. When this fails the record stays, so a repeat finds the member again (R17.15).
  try {
    await deps.faces.deleteFaces(deps.collectionId, member.faceIds);
  } catch {
    throw internal();
  }
  const deleted = await deps.repository.deleteMember(memberId);
  if (!deleted) throw memberNotFound();
}

// ---------------------------------------------------------------------------------------------
// Registration steps
// ---------------------------------------------------------------------------------------------

async function registerFace(
  request: FacesRequest,
  deps: FacesDeps,
  stagingKey: string | null,
): Promise<RegisterFaceResponse> {
  const { body } = request;
  if (stagingKey === null) throw new ApiError("validation_failed", "stagingKey is not valid.");

  const memberIdRaw = body["memberId"];
  if (memberIdRaw !== undefined && memberIdRaw !== null && (typeof memberIdRaw !== "string" || !UUID_PATTERN.test(memberIdRaw))) {
    throw new ApiError("validation_failed", "memberId must be a UUID or null.");
  }
  const existingId = typeof memberIdRaw === "string" ? memberIdRaw : null;

  checkConsent(body["consent"], deps.consentNoticeVersion);
  const displayName = checkName(body["displayName"]);

  const existing = existingId === null ? null : await deps.repository.getMember(existingId);
  if (existingId !== null && existing === null) throw memberNotFound();

  const photo = await readStaged(deps, stagingKey);

  // `ExternalImageId` is the opaque member id, never a name (R17.6).
  const memberId = existing?.memberId ?? deps.newId();
  let faceIds: string[];
  try {
    faceIds = await deps.faces.indexFaces(photo, deps.collectionId, memberId);
  } catch {
    throw internal();
  }

  if (faceIds.length !== 1) {
    await removeIndexed(deps, faceIds);
    throw new ApiError("face_count_invalid", "The photo must contain exactly one face.");
  }

  const member: FamilyMember =
    existing === null
      ? {
          memberId,
          displayName,
          faceIds,
          consentVersion: deps.consentNoticeVersion,
          consentAt: new Date(deps.nowMs).toISOString(),
          createdBy: request.userId,
        }
      : // Adding a photo keeps the name and the original consent record (R17.9).
        { ...existing, faceIds: [...existing.faceIds, ...faceIds] };

  try {
    await deps.repository.putMember(member);
  } catch {
    await removeIndexed(deps, faceIds);
    throw internal();
  }
  return { memberId, faceCount: member.faceIds.length };
}

function checkConsent(raw: unknown, noticeVersion: string): void {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("validation_failed", "consent must be an object.");
  }
  const consent = raw as Record<string, unknown>;
  if (consent["accepted"] !== true || consent["noticeVersion"] !== noticeVersion) {
    throw new ApiError("consent_required", "The consent notice must be accepted.");
  }
}

function checkName(raw: unknown): string {
  if (typeof raw !== "string") throw new ApiError("validation_failed", "displayName must be a string.");
  const length = Array.from(raw).length;
  if (length < MIN_NAME_CHARS || length > MAX_NAME_CHARS) {
    throw new ApiError("validation_failed", "displayName must be 1 to 40 characters.");
  }
  return raw;
}

async function readStaged(deps: FacesDeps, key: string): Promise<Uint8Array> {
  let photo: Uint8Array | null;
  try {
    photo = await deps.staging.read(key);
  } catch {
    throw internal();
  }
  if (photo === null || photo.length < MIN_PHOTO_BYTES || photo.length > MAX_PHOTO_BYTES) {
    throw new ApiError("validation_failed", "No valid staged photo was found.");
  }
  return photo;
}

/** Deletes faces this request indexed. A failure is an internal error, never silent (R17.7). */
async function removeIndexed(deps: FacesDeps, faceIds: readonly string[]): Promise<void> {
  if (faceIds.length === 0) return;
  try {
    await deps.faces.deleteFaces(deps.collectionId, faceIds);
  } catch {
    throw internal();
  }
}

/** Best effort: a failed cleanup must not replace the outcome of the request (S3 lifecycle expires it). */
async function deleteStaged(deps: FacesDeps, key: string): Promise<void> {
  try {
    await deps.staging.delete(key);
  } catch {
    // Intentionally ignored; the staging prefix has a lifecycle expiry.
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function requireFamily(request: FacesRequest): void {
  if (request.role !== "family") throw new ApiError("forbidden", "Not allowed.");
}

/** The key when it names one object under the staging prefix, else `null`. */
function validStagingKey(raw: unknown): string | null {
  return typeof raw === "string" && STAGING_KEY_PATTERN.test(raw) ? raw : null;
}

function memberNotFound(): ApiError {
  return new ApiError("not_found", "Member not found.");
}

function internal(): ApiError {
  return new ApiError("internal", "Internal error.");
}
