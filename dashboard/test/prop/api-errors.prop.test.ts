// Feature: dashboard-simulation, Property 23: API error codes map to a known code
// **Validates: Requirements 19.7**
import fc from "fast-check";
import { describe, it, expect } from "vitest";
import {
  createApiClient,
  mapErrorCode,
  parseRetryAfter,
  MAX_RETRY_AFTER_S,
  MIN_RETRY_AFTER_S,
  DEFAULT_RETRY_AFTER_S,
} from "../../src/lib/api";

const RUNS = { numRuns: 200 };

const SERVER_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "validation_failed",
  "consent_required",
  "face_count_invalid",
  "rate_limited",
  "internal",
  "session_active",
  "voice_unavailable",
] as const;
const ALL_CODES: readonly string[] = [...SERVER_CODES, "timeout", "network"];
const isServerCode = (v: unknown): boolean =>
  typeof v === "string" && (SERVER_CODES as readonly string[]).includes(v);

/** Any value, biased towards strings close to real codes (case, whitespace, local-only codes). */
const arbAnyValue = fc.oneof(
  fc.anything(),
  fc.string(),
  fc.constantFrom("timeout", "network", "Internal", " not_found", "rate_limited ", ""),
  fc.constantFrom(...SERVER_CODES).map((c) => c.toUpperCase()),
  fc.constantFrom(...SERVER_CODES),
);

function clientWithResponse(body: unknown, retryAfter: string | null) {
  const fetchFake = (async () => ({
    ok: false,
    status: 429,
    json: async () => body,
    headers: { get: (name: string) => (name === "Retry-After" ? retryAfter : null) },
  })) as unknown as typeof fetch;
  return createApiClient({
    baseUrl: "https://api.example.invalid",
    getToken: () => "token",
    fetch: fetchFake,
    setTimer: () => () => undefined,
  });
}

describe("Property 23: API error codes map to a known code", () => {
  it("always returns one of the twelve ApiErrorCode values", () => {
    fc.assert(
      fc.property(arbAnyValue, (v) => {
        expect(ALL_CODES).toContain(mapErrorCode(v));
      }),
      RUNS,
    );
  });

  it("preserves each of the ten server codes", () => {
    for (const code of SERVER_CODES) expect(mapErrorCode(code)).toBe(code);
  });

  it("maps every other value, including timeout and network, to internal", () => {
    fc.assert(
      fc.property(arbAnyValue, (v) => {
        expect(mapErrorCode(v)).toBe(isServerCode(v) ? v : "internal");
      }),
      RUNS,
    );
  });

  it("parses an error body: known code is kept, anything else becomes internal", async () => {
    await fc.assert(
      fc.asyncProperty(arbAnyValue, async (code) => {
        const res = await clientWithResponse({ error: { code, message: "x" } }, null).me();
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe(isServerCode(code) ? code : "internal");
      }),
      RUNS,
    );
  });

  it("clamps Retry-After to 1..86400 and falls back to 60 when it is not an integer", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (n) => {
        expect(parseRetryAfter(String(n))).toBe(Math.min(MAX_RETRY_AFTER_S, Math.max(MIN_RETRY_AFTER_S, n)));
      }),
      RUNS,
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string().filter((s) => !/^\s*\d+\s*$/.test(s)),
          fc.constant(null),
        ),
        (h) => {
          expect(parseRetryAfter(h)).toBe(DEFAULT_RETRY_AFTER_S);
        },
      ),
      RUNS,
    );
  });

  it("puts a clamped retryAfterS on a rate_limited error and on no other error", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SERVER_CODES),
        fc.oneof(fc.integer({ min: 0, max: 10_000_000 }).map(String), fc.string(), fc.constant(null)),
        async (code, header) => {
          const res = await clientWithResponse({ error: { code, message: "x" } }, header).me();
          expect(res.ok).toBe(false);
          if (res.ok) return;
          if (code === "rate_limited") {
            expect(res.error.retryAfterS).toBeGreaterThanOrEqual(MIN_RETRY_AFTER_S);
            expect(res.error.retryAfterS).toBeLessThanOrEqual(MAX_RETRY_AFTER_S);
          } else {
            expect(res.error.retryAfterS).toBeUndefined();
          }
        },
      ),
      RUNS,
    );
  });
});
