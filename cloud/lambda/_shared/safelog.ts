/**
 * Safe logger used by every handler.
 *
 * Why: logs live in CloudWatch for a long time. They must never hold image
 * bytes, base64 image text, pre-signed URLs, display names or face ids. The
 * logger masks such values before they reach the sink, so a handler cannot
 * leak them by accident. Ids and counts pass through unchanged.
 *
 * Pure apart from the injectable sink (default: `console.log`).
 */

export const REDACTED = "[redacted]";

/** Keys whose values are never logged, compared case-insensitively. */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "displayname",
  "jpegbase64",
  "faceids",
  "faceid",
]);

/** Query parameters that mark a pre-signed URL. */
const SIGNATURE_PARAM =
  /[?&](x-amz-signature|x-amz-credential|x-amz-security-token|x-amz-algorithm|signature|awsaccesskeyid|policy|sig|token)=/i;

/** Base64 of a JPEG ("/9j/"), PNG ("iVBORw0KGgo"), or a data URL. */
const IMAGE_BASE64_PREFIX = /^(?:\/9j\/|iVBORw0KGgo|data:image\/)/;
const LONG_BASE64 = /^[A-Za-z0-9+/_-]{200,}={0,2}$/;

const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 500;

export type LogSink = (line: string) => void;
export type LogFields = Readonly<Record<string, unknown>>;

let sink: LogSink = (line) => {
  console.log(line);
};

/** Replaces the output sink and returns the previous one (for tests). */
export function setLogSink(next: LogSink): LogSink {
  const previous = sink;
  sink = next;
  return previous;
}

function isBinary(value: unknown): boolean {
  return (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function maskString(value: string): string {
  if (SIGNATURE_PARAM.test(value)) {
    return REDACTED;
  }
  if (IMAGE_BASE64_PREFIX.test(value) || LONG_BASE64.test(value)) {
    return REDACTED;
  }
  if (value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
  }
  return value;
}

/** Returns a copy of `value` that is safe to serialize. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return maskString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (isBinary(value)) {
    return REDACTED;
  }
  if (value instanceof Error) {
    return { name: value.name, message: maskString(value.message) };
  }
  if (typeof value !== "object") {
    return REDACTED;
  }
  if (depth >= MAX_DEPTH) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase())
      ? REDACTED
      : sanitize(inner, depth + 1);
  }
  return out;
}

/** Writes one JSON line: `event` plus the sanitized fields. */
export function log(event: string, fields: LogFields = {}): void {
  const safeFields = sanitize(fields) as Record<string, unknown>;
  let line: string;
  try {
    line = JSON.stringify({ ...safeFields, event: maskString(event) });
  } catch {
    line = JSON.stringify({ event: maskString(event), note: "unserializable" });
  }
  sink(line);
}
