/**
 * Pure core of `POST /commands` in the `api-admin` Lambda (`docs/schema.md`, "HTTP API").
 *
 * Validates a family member's command for the real doll, clamps numbers, builds the envelope
 * with `makeCommand` and publishes it once through the `DeviceBus`. No AWS imports. Time and
 * ids are injected. The route table (authz) already denies the reviewer; the role is checked
 * again here so a wiring mistake cannot publish.
 *
 * Requirements: 16.1 to 16.11.
 */

import type { Role } from "../_shared/authz.js";
import type { CloudConfig } from "../_shared/config.js";
import { ApiError } from "../_shared/http.js";
import type { VoiceLine } from "../_shared/lines.js";
import { makeCommand, type CommandData } from "../_shared/messages.js";
import type { DeviceBus, Repository } from "../_shared/ports.js";
import { isOnline } from "../api-read/api-read-core.js";

export const GAZE_PAN_LIMIT_DEG = 60;
export const GAZE_TILT_LIMIT_DEG = 30;
export const LANTERN_FADE_MAX_MS = 10_000;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The command types the dashboard may send. */
export const ADMIN_COMMAND_TYPES = ["speak", "gaze", "lantern", "mode.set"] as const;
export type AdminCommandType = (typeof ADMIN_COMMAND_TYPES)[number];

export interface CommandRequest {
  role: Role;
  /** Parsed JSON body (see `parseJsonBody`). */
  body: Record<string, unknown>;
}

export interface CommandDeps {
  bus: DeviceBus;
  repository: Pick<Repository, "getDeviceStatus">;
  config: Pick<CloudConfig, "statusIntervalS">;
  /** The line catalog; `speak` accepts only ids from it. */
  lines: readonly VoiceLine[];
  /** Fresh UUID for the envelope. */
  newId: () => string;
  nowMs: number;
}

export interface CommandResponse {
  id: string;
  deviceOnline: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(message: string): ApiError {
  return new ApiError("validation_failed", message);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(data: Record<string, unknown>, field: string): number {
  const value = data[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw bad(`${field} must be a finite number.`);
  }
  return value;
}

/** Validates and clamps `command`; returns the typed command, or throws `validation_failed`. */
function parseCommand(
  command: unknown,
  lines: readonly VoiceLine[],
): { type: "speak"; data: CommandData["speak"] }
  | { type: "gaze"; data: CommandData["gaze"] }
  | { type: "lantern"; data: CommandData["lantern"] }
  | { type: "mode.set"; data: CommandData["mode.set"] } {
  if (!isRecord(command)) throw bad("command must be an object.");
  const type = command["type"];
  if (typeof type !== "string" || !(ADMIN_COMMAND_TYPES as readonly string[]).includes(type)) {
    throw bad("command.type is not supported.");
  }
  const data = command["data"];
  if (!isRecord(data)) throw bad("command.data must be an object.");

  switch (type as AdminCommandType) {
    case "speak": {
      if (data["audioUrl"] !== undefined && data["audioUrl"] !== null) {
        throw bad("audioUrl is not accepted.");
      }
      const lineId = data["lineId"];
      if (typeof lineId !== "string") throw bad("lineId is required.");
      const line = lines.find((candidate) => candidate.id === lineId);
      if (line === undefined) throw bad("lineId is not in the line catalog.");
      return { type: "speak", data: { lineId: line.id, audioUrl: null, ja: line.ja, en: line.en } };
    }
    case "gaze":
      return {
        type: "gaze",
        data: {
          panDeg: clamp(finiteNumber(data, "panDeg"), -GAZE_PAN_LIMIT_DEG, GAZE_PAN_LIMIT_DEG),
          tiltDeg: clamp(finiteNumber(data, "tiltDeg"), -GAZE_TILT_LIMIT_DEG, GAZE_TILT_LIMIT_DEG),
        },
      };
    case "lantern":
      return {
        type: "lantern",
        data: {
          level: clamp(finiteNumber(data, "level"), 0, 1),
          fadeMs: Math.round(clamp(finiteNumber(data, "fadeMs"), 0, LANTERN_FADE_MAX_MS)),
        },
      };
    case "mode.set": {
      const mode = data["mode"];
      if (mode !== "guard" && mode !== "sleep" && mode !== "remote") {
        throw bad("mode must be guard, sleep or remote.");
      }
      return { type: "mode.set", data: { mode } };
    }
  }
}

/**
 * `POST /commands` (R16.1 to R16.10). Publishes exactly once, never retries and never stores
 * the command. A publish failure gives `500 internal` with a generic message.
 */
export async function handlePostCommand(
  request: CommandRequest,
  deps: CommandDeps,
): Promise<CommandResponse> {
  if (request.role !== "family") throw new ApiError("forbidden", "Not allowed.");

  const deviceId = request.body["deviceId"];
  if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw bad("deviceId must be 1 to 64 characters of A-Z, a-z, 0-9, _ or -.");
  }
  const command = parseCommand(request.body["command"], deps.lines);

  const id = deps.newId();
  const envelope = makeCommand(command.type, command.data as never, {
    id,
    now: new Date(deps.nowMs),
    deviceId,
    encounterId: null,
  });

  const deviceOnline = await readOnline(deviceId, deps);
  try {
    await deps.bus.publish(deviceId, envelope);
  } catch {
    throw new ApiError("internal", "Could not send the command.");
  }
  return { id, deviceOnline };
}

/** A failed status read counts as offline: the command is still published (R16.9). */
async function readOnline(deviceId: string, deps: CommandDeps): Promise<boolean> {
  try {
    const record = await deps.repository.getDeviceStatus(deviceId);
    if (record === null || record.status === null || record.lastReportAtMs === null) return false;
    return isOnline(record.lastReportAtMs, record.lastOfflineAtMs, deps.nowMs, deps.config.statusIntervalS);
  } catch {
    return false;
  }
}
