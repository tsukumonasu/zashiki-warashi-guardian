/**
 * Pure core of the internal `snapshot-signer` Lambda (A5, reviewer read isolation).
 *
 * `api-read` has no S3 permission. It invokes this function only after the role is `family`.
 * This function holds `s3:GetObject` on `snapshots/*` and still re-checks everything it is told:
 * it refuses the role `reviewer` (or any other role), keys outside `snapshots/`, path-traversal
 * keys and lifetimes beyond 300 seconds. There is no HTTP route; only `api-read` may invoke it.
 *
 * No AWS imports: signing sits behind `SnapshotSigningPort`. The key is never logged or put in a
 * response message.
 *
 * Requirements: 11.6, 14.4, 14.6, 14.10, 14.11.
 */

/** Lifetime of a pre-signed snapshot URL, in seconds (R11.6, R14.6). */
export const SIGNER_MAX_TTL_S = 300;

export const SIGNER_KEY_PREFIX = "snapshots/";

const MAX_KEY_LENGTH = 1024;

/** The one thing the core needs from S3. `SnapshotStore.signGet` satisfies it. */
export interface SnapshotSigningPort {
  signGet(key: string, ttlS: number): Promise<string>;
}

/** The invoke payload. Fields are `unknown` because the payload is not trusted. */
export interface SignRequest {
  role?: unknown;
  snapshotKey?: unknown;
  ttlS?: unknown;
}

export type SignRefusal = "forbidden" | "invalid_request";

export type SignResponse =
  | { ok: true; url: string }
  | { ok: false; code: SignRefusal };

/** True for a plain key under `snapshots/`: no empty, `.` or `..` segment, no control or `\`. */
export function isSnapshotKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length > MAX_KEY_LENGTH) return false;
  if (!key.startsWith(SIGNER_KEY_PREFIX)) return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f\\]/.test(key)) return false;
  const segments = key.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

function isValidTtl(ttlS: unknown): ttlS is number {
  return typeof ttlS === "number" && Number.isInteger(ttlS) && ttlS >= 1 && ttlS <= SIGNER_MAX_TTL_S;
}

/**
 * Signs one snapshot URL. The role check comes first so a reviewer request never reaches the
 * key or the signing port (R14.4, R14.10). A signing failure throws; the caller (`api-read`)
 * hides the picture and keeps the encounter.
 */
export async function handleSign(request: unknown, port: SnapshotSigningPort): Promise<SignResponse> {
  const body: SignRequest =
    typeof request === "object" && request !== null ? (request as SignRequest) : {};

  if (body.role !== "family") return { ok: false, code: "forbidden" };
  if (!isSnapshotKey(body.snapshotKey)) return { ok: false, code: "invalid_request" };
  if (!isValidTtl(body.ttlS)) return { ok: false, code: "invalid_request" };

  const url = await port.signGet(body.snapshotKey, body.ttlS);
  return { ok: true, url };
}
