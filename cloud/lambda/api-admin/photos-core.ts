/**
 * Pure core of `POST /photos` (remote-actions R4, `docs/schema.md`, "HTTP API").
 *
 * Asks the doll for one photo: validates the family caller, counts the request against an
 * hourly limit and publishes `snapshot.request` with `purpose: "photo"` once. Nothing is stored
 * here; the picture arrives later as `snapshot.captured` and the judge indexes it. No AWS
 * imports. Time and ids are injected.
 */
import type { Role } from "../_shared/authz.js";
import type { CloudConfig } from "../_shared/config.js";
import { ApiError } from "../_shared/http.js";
import { makeCommand } from "../_shared/messages.js";
import type { DeviceBus, Repository, StateStore } from "../_shared/ports.js";
import { guardRemote } from "../_shared/ratelimit.js";
import { isOnline } from "../api-read/api-read-core.js";

/** Photos one user may ask for per hour. The camera and the battery are small. */
export const PHOTOS_PER_HOUR = 30;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface PhotoRequest {
  role: Role;
  userSub: string;
  body: Record<string, unknown>;
}

export interface PhotoDeps {
  bus: DeviceBus;
  repository: Pick<Repository, "getDeviceStatus">;
  state: Pick<StateStore, "incrementCounter">;
  config: Pick<CloudConfig, "statusIntervalS">;
  newId: () => string;
  nowMs: number;
}

export interface PhotoResponse {
  requestId: string;
  deviceOnline: boolean;
}

/** `deviceId` check shared by the remote routes. */
export function readDeviceId(body: Record<string, unknown>): string {
  const deviceId = body["deviceId"];
  if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new ApiError("validation_failed", "deviceId must be 1 to 64 characters of A-Z, a-z, 0-9, _ or -.");
  }
  return deviceId;
}

/** A failed status read counts as offline: the request is still published. */
export async function readOnline(
  deviceId: string,
  deps: Pick<PhotoDeps, "repository" | "config" | "nowMs">,
): Promise<boolean> {
  try {
    const record = await deps.repository.getDeviceStatus(deviceId);
    if (record === null || record.status === null || record.lastReportAtMs === null) return false;
    return isOnline(record.lastReportAtMs, record.lastOfflineAtMs, deps.nowMs, deps.config.statusIntervalS);
  } catch {
    return false;
  }
}

export async function handlePostPhoto(request: PhotoRequest, deps: PhotoDeps): Promise<PhotoResponse> {
  if (request.role !== "family") throw new ApiError("forbidden", "Not allowed.");
  const deviceId = readDeviceId(request.body);
  const guard = await guardRemote("photo", request.userSub, PHOTOS_PER_HOUR, deps.nowMs, deps.state);
  if (!guard.allowed) {
    throw new ApiError("rate_limited", "Too many photos. Try again later.", guard.retryAfterS);
  }
  const requestId = deps.newId();
  const envelope = makeCommand(
    "snapshot.request",
    { requestId, purpose: "photo" },
    { id: deps.newId(), now: new Date(deps.nowMs), deviceId, encounterId: null },
  );
  const deviceOnline = await readOnline(deviceId, deps);
  try {
    await deps.bus.publish(deviceId, envelope);
  } catch {
    throw new ApiError("internal", "Could not send the request.");
  }
  return { requestId, deviceOnline };
}
