// Pure helpers of the latency harness (task 24.1, R6.7). No AWS, no clock.

/** Targets of R6.7 in milliseconds: p95 of the cloud round trip per path. */
export const TARGET_P95_MS = { family: 3000, stranger: 4000 } as const;

/** Nearest-rank percentile (p in 0..100) of a non-empty list. Throws for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError("percentile of an empty list");
  if (!(p >= 0 && p <= 100)) throw new RangeError("p must be within 0..100");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export interface PathSummary {
  path: "family" | "stranger";
  rounds: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  targetP95Ms: number;
  withinTarget: boolean;
}

export function summarize(path: "family" | "stranger", samplesMs: readonly number[]): PathSummary {
  const p95 = percentile(samplesMs, 95);
  return {
    path,
    rounds: samplesMs.length,
    p50Ms: percentile(samplesMs, 50),
    p95Ms: p95,
    maxMs: Math.max(...samplesMs),
    targetP95Ms: TARGET_P95_MS[path],
    withinTarget: p95 <= TARGET_P95_MS[path],
  };
}

/**
 * Shape of a JWT `cognito:groups` claim as found in the token payload itself. This is the token
 * side only; the form that reaches the Lambda is read from the API access log (owner step).
 */
export function describeGroupsClaim(value: unknown): string {
  if (value === undefined) return "absent";
  if (Array.isArray(value)) return `array of ${value.length} ${value.every((g) => typeof g === "string") ? "strings" : "mixed values"}`;
  return typeof value;
}

/** Decodes the payload of a JWT without verifying it (only to inspect claim shapes locally). */
export function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("not a JWT");
  const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("bad JWT payload");
  return parsed as Record<string, unknown>;
}
