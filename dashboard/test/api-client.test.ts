/**
 * Unit tests for src/lib/api.ts (dashboard-simulation task 11.4).
 * Validates: Requirements 10.6, 12.8, 19.4, 19.8
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS, createApiClient, type ApiClientDeps } from "../src/lib/api";

interface FakeRes {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

function res(status: number, body: unknown, headers: Record<string, string> = {}): FakeRes {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[n] ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError("no body");
      return body;
    },
  };
}

interface Harness {
  deps: ApiClientDeps;
  fetchMock: ReturnType<typeof vi.fn>;
  timers: { fn: () => void; ms: number; cancelled: boolean }[];
}

function harness(fetchImpl: (url: string, init: RequestInit) => Promise<unknown>, token: string | null = "tok"): Harness {
  const timers: Harness["timers"] = [];
  const fetchMock = vi.fn(fetchImpl);
  const deps: ApiClientDeps = {
    baseUrl: "https://api.example.invalid/",
    getToken: () => token,
    fetch: fetchMock as unknown as typeof fetch,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  };
  return { deps, fetchMock, timers };
}

const ME = { role: "family", consentNoticeVersion: "v1", limits: { simulatePerHour: 5, generatePerHour: 2 } };

afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("aborts after the 10 s timer fires and returns timeout", async () => {
    const h = harness(
      (_u, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const p = createApiClient(h.deps).me();
    await Promise.resolve();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(REQUEST_TIMEOUT_MS);
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
    h.timers[0]!.fn();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("timeout");
    expect(h.timers[0]!.cancelled).toBe(true);
  });

  it("returns network when fetch rejects without a timeout", async () => {
    const h = harness(async () => {
      throw new TypeError("offline");
    });
    const r = await createApiClient(h.deps).me();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("network");
  });

  it("sends the bearer token, joins the base URL and cancels the timer on success", async () => {
    const h = harness(async () => res(200, ME));
    const r = await createApiClient(h.deps).me();
    expect(r).toEqual({ ok: true, value: ME });
    const [url, init] = h.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.invalid/me");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(h.timers[0]!.cancelled).toBe(true);
  });

  it("parses a server error body into code and message", async () => {
    const h = harness(async () => res(409, { error: { code: "consent_required", message: "Accept the notice." } }));
    const r = await createApiClient(h.deps).me();
    expect(r).toEqual({ ok: false, error: { code: "consent_required", message: "Accept the notice." } });
  });

  it("truncates long messages to 200 characters", async () => {
    const h = harness(async () => res(400, { error: { code: "validation_failed", message: "x".repeat(500) } }));
    const r = await createApiClient(h.deps).me();
    if (r.ok) throw new Error("expected failure");
    expect(r.error.message).toHaveLength(200);
  });

  it("maps an unknown or local-only server code to internal", async () => {
    for (const code of ["weird", "timeout", "network"]) {
      const h = harness(async () => res(500, { error: { code, message: "m" } }));
      const r = await createApiClient(h.deps).me();
      if (r.ok) throw new Error("expected failure");
      expect(r.error.code).toBe("internal");
    }
  });

  it("returns internal for a non-JSON error body", async () => {
    const h = harness(async () => res(502, undefined));
    const r = await createApiClient(h.deps).me();
    if (r.ok) throw new Error("expected failure");
    expect(r.error.code).toBe("internal");
  });

  it("parses and clamps Retry-After on 429", async () => {
    const cases: [string | undefined, number][] = [
      ["30", 30],
      ["0", 1],
      ["999999", 86_400],
      [undefined, 60],
      ["soon", 60],
      ["1.5", 60],
    ];
    for (const [header, expected] of cases) {
      const h = harness(async () =>
        res(429, { error: { code: "rate_limited", message: "slow" } }, header === undefined ? {} : { "Retry-After": header }),
      );
      const r = await createApiClient(h.deps).simulate("a", false);
      if (r.ok) throw new Error("expected failure");
      expect(r.error.code).toBe("rate_limited");
      expect(r.error.retryAfterS).toBe(expected);
    }
  });

  it("does not add retryAfterS to other errors", async () => {
    const h = harness(async () => res(403, { error: { code: "forbidden", message: "no" } }));
    const r = await createApiClient(h.deps).me();
    if (r.ok) throw new Error("expected failure");
    expect(r.error).not.toHaveProperty("retryAfterS");
  });

  it("treats 204 on faceDelete as success with null and does not read the body", async () => {
    const json = vi.fn();
    const h = harness(async () => ({ ok: true, status: 204, headers: { get: () => null }, json }));
    const r = await createApiClient(h.deps).faceDelete("a/b");
    expect(r).toEqual({ ok: true, value: null });
    const [url, init] = h.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.invalid/faces/a%2Fb");
    expect(init.method).toBe("DELETE");
    expect(json).not.toHaveBeenCalled();
  });

  it("returns unauthorized without a request when there is no token", async () => {
    for (const token of [null, ""]) {
      const h = harness(async () => res(200, ME), token);
      const r = await createApiClient(h.deps).me();
      if (r.ok) throw new Error("expected failure");
      expect(r.error.code).toBe("unauthorized");
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.timers).toHaveLength(0);
    }
  });

  it("turns a body that fails the guard into internal", async () => {
    const bad: unknown[] = [null, [], "x", {}, { ...ME, role: "admin" }, { ...ME, limits: { simulatePerHour: 1.5, generatePerHour: 2 } }];
    for (const body of bad) {
      const h = harness(async () => res(200, body));
      const r = await createApiClient(h.deps).me();
      if (r.ok) throw new Error("expected failure");
      expect(r.error.code).toBe("internal");
    }
  });

  it("turns an unreadable success body into internal", async () => {
    const h = harness(async () => res(200, undefined));
    const r = await createApiClient(h.deps).samples();
    if (r.ok) throw new Error("expected failure");
    expect(r.error.code).toBe("internal");
  });

  it("rejects a sample with an unknown label", async () => {
    const h = harness(async () => res(200, { samples: [{ sampleId: "a", label: "ghost" }] }));
    const r = await createApiClient(h.deps).samples();
    if (r.ok) throw new Error("expected failure");
    expect(r.error.code).toBe("internal");
  });

  it("passes limit and an encoded cursor for Show older", async () => {
    const h = harness(async () => res(200, { items: [], nextCursor: null }));
    const api = createApiClient(h.deps);
    await api.encounters(20);
    await api.encounters(20, "a b&c=");
    expect((h.fetchMock.mock.calls[0] as [string])[0]).toBe("https://api.example.invalid/encounters?limit=20");
    expect((h.fetchMock.mock.calls[1] as [string])[0]).toBe(
      "https://api.example.invalid/encounters?limit=20&cursor=a%20b%26c%3D",
    );
  });

  it("sends a JSON body with Content-Type on POST routes", async () => {
    const h = harness(async () => res(200, { id: "i", deviceOnline: false }));
    const r = await createApiClient(h.deps).command("warashi-01", { type: "mode.set", data: { mode: "sleep" } } as never);
    expect(r.ok).toBe(true);
    const [, init] = h.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      deviceId: "warashi-01",
      command: { type: "mode.set", data: { mode: "sleep" } },
    });
  });

  it("never throws and never touches console, and errors hide the token", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const failures: (() => Promise<unknown>)[] = [
      async () => {
        throw new Error("secret-token boom");
      },
      async () => res(500, { error: { code: "internal", message: "bad" } }),
      async () => res(200, { nope: true }),
      async () => res(200, undefined),
    ];
    for (const f of failures) {
      const h = harness(f, "secret-token");
      const api = createApiClient(h.deps);
      const results = await Promise.all([api.me(), api.faces(), api.faceDelete("x"), api.faceUpload()]);
      for (const r of results) {
        if (!r.ok) expect(JSON.stringify(r.error)).not.toContain("secret-token");
      }
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("remote actions", () => {
  const call = (h: Harness): [string, RequestInit] => h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];

  it("POST /photos sends the device id and checks the answer", async () => {
    const h = harness(async () => res(202, { requestId: "req-1", deviceOnline: true }));
    const r = await createApiClient(h.deps).photoRequest("warashi-01");
    expect(r).toEqual({ ok: true, value: { requestId: "req-1", deviceOnline: true } });
    const [url, init] = call(h);
    expect(url).toBe("https://api.example.invalid/photos");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ deviceId: "warashi-01" });
  });

  it("GET /photos/{id} accepts pending and ready, and refuses anything else", async () => {
    const pending = harness(async () => res(200, { status: "pending" }));
    expect(await createApiClient(pending.deps).photo("req 1")).toEqual({ ok: true, value: { status: "pending" } });
    expect(call(pending)[0]).toBe("https://api.example.invalid/photos/req%201");

    const ready = harness(async () => res(200, { status: "ready", url: "https://x.invalid/p", expiresAt: "t" }));
    expect((await createApiClient(ready.deps).photo("r")).ok).toBe(true);

    for (const body of [{ status: "ready" }, { status: "done" }, {}, null]) {
      const bad = harness(async () => res(200, body));
      expect((await createApiClient(bad.deps).photo("r")).ok, JSON.stringify(body)).toBe(false);
    }
  });

  it("POST /say sends the text and maps a refusal", async () => {
    const h = harness(async () => res(202, { id: "cmd-1", deviceOnline: false }));
    const r = await createApiClient(h.deps).say("warashi-01", "こんにちは");
    expect(r).toEqual({ ok: true, value: { id: "cmd-1", deviceOnline: false } });
    expect(JSON.parse(call(h)[1].body as string)).toEqual({ deviceId: "warashi-01", text: "こんにちは" });

    const refused = harness(async () => res(400, { error: { code: "validation_failed", message: "no" } }));
    const bad = await createApiClient(refused.deps).say("warashi-01", "ころす");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("validation_failed");
  });

  it("does not call the API when signed out", async () => {
    const h = harness(async () => res(200, {}), null);
    const r = await createApiClient(h.deps).say("warashi-01", "x");
    expect(r.ok).toBe(false);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});
