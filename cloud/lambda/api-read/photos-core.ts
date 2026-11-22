/**
 * Pure core of `GET /photos/{requestId}` (remote-actions R5, `docs/schema.md`, "HTTP API").
 *
 * Family only. `pending` until the judge indexed the doll's photo, then `ready` with a 5-minute
 * pre-signed URL from the internal `snapshot-signer` (the only role that reads `snapshots/*`).
 * An unknown, expired or foreign id stays `pending`, so the answer reveals nothing. No AWS
 * imports. Time is injected.
 */
import type { Role } from "../_shared/authz.js";
import { ApiError } from "../_shared/http.js";
import type { PhotoReader } from "../_shared/ports.js";
import { isLive } from "../_shared/ttl.js";
import { SNAPSHOT_URL_TTL_S, type SnapshotUrlSigner } from "./api-read-core.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export interface PhotoRead {
  role: Role;
  pathParameters: Readonly<Record<string, string>>;
}

export interface PhotoReadDeps {
  photos: PhotoReader;
  signer: SnapshotUrlSigner;
  nowMs: number;
}

export type PhotoStatus = { status: "pending" } | { status: "ready"; url: string; expiresAt: string };

export async function handleGetPhoto(request: PhotoRead, deps: PhotoReadDeps): Promise<PhotoStatus> {
  if (request.role !== "family") throw new ApiError("forbidden", "Not allowed.");
  const requestId = request.pathParameters["requestId"];
  if (requestId === undefined || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new ApiError("validation_failed", "requestId is not valid.");
  }
  const photo = await deps.photos.getPhoto(requestId);
  if (photo === null || !isLive({ ttl: photo.ttl }, Math.floor(deps.nowMs / 1000))) {
    return { status: "pending" };
  }
  let url: string | null = null;
  try {
    url = await deps.signer.sign(photo.snapshotKey, SNAPSHOT_URL_TTL_S);
  } catch {
    url = null;
  }
  // A signing problem hides the picture for now; the dashboard asks again.
  if (url === null) return { status: "pending" };
  return { status: "ready", url, expiresAt: new Date(deps.nowMs + SNAPSHOT_URL_TTL_S * 1000).toISOString() };
}
