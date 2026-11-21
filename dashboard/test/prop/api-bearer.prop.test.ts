// Feature: dashboard-simulation, Property 24: Every API call carries the bearer token
// **Validates: Requirements 11.3**
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createApiClient, type ApiClient } from "../../src/lib/api";

interface Seen {
  url: string;
  headers: Record<string, string>;
}

/** Fake fetch: records each request and answers with a 500 so no body guard is involved. */
function makeFetch(seen: Seen[]): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return {
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => ({ error: { code: "internal", message: "x" } }),
    } as unknown as Response;
  }) as typeof fetch;
}

function makeClient(token: string | null, seen: Seen[]): ApiClient {
  return createApiClient({
    baseUrl: "https://api.example.invalid",
    getToken: () => token,
    fetch: makeFetch(seen),
    setTimer: () => () => {},
  });
}

type Call = (c: ApiClient) => Promise<{ ok: boolean; error?: { code: string } }>;

const argsArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 20 }),
  limit: fc.integer({ min: 1, max: 50 }),
  cursor: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  generate: fc.boolean(),
});

function routes(a: {
  id: string;
  limit: number;
  cursor: string | undefined;
  generate: boolean;
}): Call[] {
  return [
    (c) => c.me(),
    (c) => c.samples(),
    (c) => c.encounters(a.limit, a.cursor),
    (c) => c.encounter(a.id),
    (c) => c.deviceStatus(a.id),
    (c) => c.simulate(a.id, a.generate),
    (c) => c.command(a.id, { type: "mode.set", data: { mode: "guard" } }),
    (c) => c.faces(),
    (c) => c.faceUpload(),
    (c) =>
      c.faceRegister({
        stagingKey: a.id,
        displayName: "x",
        memberId: null,
        consent: { noticeVersion: "v1", accepted: true },
      }),
    (c) => c.faceDelete(a.id),
  ];
}

describe("Property 24: every API call carries the bearer token", () => {
  it("sends Authorization: Bearer <token> on every route", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 200 }), argsArb, async (token, args) => {
        const list = routes(args);
        for (const call of list) {
          const seen: Seen[] = [];
          await call(makeClient(token, seen));
          expect(seen).toHaveLength(1);
          expect(seen[0]?.headers.Authorization).toBe(`Bearer ${token}`);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("returns unauthorized and sends no request when there is no token", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<string | null>(null, ""), argsArb, async (token, args) => {
        for (const call of routes(args)) {
          const seen: Seen[] = [];
          const result = await call(makeClient(token, seen));
          expect(seen).toHaveLength(0);
          expect(result.ok).toBe(false);
          expect(result.error?.code).toBe("unauthorized");
        }
      }),
      { numRuns: 100 },
    );
  });
});
