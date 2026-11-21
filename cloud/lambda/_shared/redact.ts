/**
 * Redaction of encounter records by role (Requirement 14, `docs/schema.md` "Encounter record").
 * Pure: no AWS imports, no I/O, never mutates its input.
 *
 * `reviewer` is a guest in the household: no snapshot, no face box, no member data, no S3 key and
 * no image reference of any kind at any depth. An illustration replaces the picture.
 */

import type { Role } from "./authz.js";
import type { EncounterRecord, Illustration } from "./types.js";

/**
 * Keys removed at every depth below the top level for `reviewer`. They name image references,
 * face data, member data and storage keys. The top-level `snapshot` is kept as `null` (14.1).
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "hasImage",
  "jpegBase64",
  "face",
  "faceId",
  "faceIds",
  "memberId",
  "displayName",
  "faceCount",
  "snapshot",
  "snapshotUrl",
  "snapshotKey",
  "imageUrl",
  "imageKey",
  "s3Key",
  "stagingKey",
  "bucket",
]);

/** Illustration for a verdict. A null or unknown verdict gives `silhouette-uncertain` (14.1). */
export function illustrationFor(verdict: unknown): Illustration {
  switch (verdict) {
    case "family":
      return "silhouette-family";
    case "stranger":
      return "silhouette-stranger";
    case "no_face":
      return "silhouette-none";
    default:
      return "silhouette-uncertain";
  }
}

/** Deep copy of `value` without forbidden keys. Array order and length are preserved. */
function stripForbidden(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripForbidden);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!FORBIDDEN_KEYS.has(key)) {
        out[key] = stripForbidden(inner);
      }
    }
    return out;
  }
  return value;
}

/**
 * Role-specific view of an encounter record.
 *
 * - `family`: the record as given. The caller adds the signed `snapshot` URL (14.6).
 * - `reviewer`: `snapshot` null, `illustration` from the verdict, forbidden keys removed at every
 *   depth, all other fields, event order and event count unchanged. Idempotent (14.7).
 */
export function redactEncounter(record: EncounterRecord, role: Role): EncounterRecord {
  if (role === "family") {
    return record;
  }
  const stripped = stripForbidden(record) as EncounterRecord;
  return {
    ...stripped,
    snapshot: null,
    illustration: illustrationFor(record.verdict),
  };
}
