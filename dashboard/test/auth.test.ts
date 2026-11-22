// Unit tests for src/lib/auth.ts and src/lib/settings.ts (task 11.6).
// Validates: Requirements 9.5, 11.1, 11.7
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, EXPIRY_MARGIN_MS, REFRESH_KEY } from "../src/lib/auth";
import { loadSettings, validateSettings } from "../src/lib/settings";

const PASSWORD = "pw-secret-123";
const TOKEN = "access-token-abc";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function okBody(expiresIn = 3600): unknown {
  return {
    AuthenticationResult: {
      AccessToken: TOKEN,
      RefreshToken: "refresh-xyz",
      IdToken: "id-xyz",
      ExpiresIn: expiresIn,
    },
  };
}

function setup(response: () => Promise<Response>) {
  let now = 1_000_000;
  const fetchMock = vi.fn(response);
  const session = createSession({
    region: "us-east-1",
    userPoolClientId: "client123",
    fetch: fetchMock as unknown as typeof fetch,
    now: () => now,
  });
  return {
    session,
    fetchMock,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("auth session", () => {
  const spies: Array<{ mockRestore(): void }> = [];

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it("sends the documented InitiateAuth request", async () => {
    const { session, fetchMock } = setup(async () => jsonResponse(okBody()));
    await session.signIn("demo", PASSWORD);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "client123",
      AuthParameters: { USERNAME: "demo", PASSWORD },
    });
  });

  it("keeps the token in memory only and never logs", async () => {
    const setItemLocal = vi.spyOn(Storage.prototype, "setItem");
    const cookie = vi.spyOn(document, "cookie", "set");
    const pushState = vi.spyOn(history, "pushState");
    const replaceState = vi.spyOn(history, "replaceState");
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    spies.push(setItemLocal, cookie, pushState, replaceState, ...consoleSpies);

    const { session } = setup(async () => jsonResponse(okBody()));
    const result = await session.signIn("demo", PASSWORD);
    expect(result).toEqual({ ok: true });
    expect(session.token()).toBe(TOKEN);
    session.signOut();

    expect(setItemLocal).not.toHaveBeenCalled(); // covers localStorage and sessionStorage
    expect(cookie).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
  });

  it("does not expose the refresh or ID token or the password", async () => {
    const { session } = setup(async () => jsonResponse(okBody()));
    await session.signIn("demo", PASSWORD);
    const dump = JSON.stringify(session) + String(session.token());
    expect(dump).not.toContain("refresh-xyz");
    expect(dump).not.toContain("id-xyz");
    expect(dump).not.toContain(PASSWORD);
  });

  it("maps a ChallengeName response to needs_setup without a token", async () => {
    const { session } = setup(async () =>
      jsonResponse({ ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "s" }),
    );
    expect(await session.signIn("demo", PASSWORD)).toEqual({ ok: false, error: "needs_setup" });
    expect(session.token()).toBeNull();
    expect(session.expiresAt()).toBeNull();
  });

  it("maps rejection to failed and a network error to offline", async () => {
    const bad = setup(async () => jsonResponse({ __type: "NotAuthorizedException" }, 400));
    expect(await bad.session.signIn("demo", "x")).toEqual({ ok: false, error: "failed" });
    const down = setup(async () => {
      throw new TypeError("network");
    });
    expect(await down.session.signIn("demo", "x")).toEqual({ ok: false, error: "offline" });
  });

  it("treats a token within 60 s of expiry as expired and notifies", async () => {
    const { session, advance } = setup(async () => jsonResponse(okBody(3600)));
    const listener = vi.fn();
    session.subscribe(listener);
    await session.signIn("demo", PASSWORD);
    expect(listener).toHaveBeenCalledTimes(1);

    advance(3600_000 - EXPIRY_MARGIN_MS - 1);
    expect(session.token()).toBe(TOKEN);
    advance(1);
    expect(session.token()).toBeNull();
    expect(session.expiresAt()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("signOut clears the session, notifies once and honours unsubscribe", async () => {
    const { session } = setup(async () => jsonResponse(okBody()));
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    await session.signIn("demo", PASSWORD);
    session.signOut();
    expect(session.token()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    session.signOut(); // already signed out: no notification
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    await session.signIn("demo", PASSWORD);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("settings", () => {
  const valid = {
    apiUrl: "https://api.example.invalid/prod/",
    region: "us-east-1",
    userPoolId: "us-east-1_AbC123",
    userPoolClientId: "client123",
    illustrationBase: "/illustrations",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid config and trims the trailing slash of apiUrl", () => {
    const result = validateSettings(valid);
    expect(result).toEqual({
      status: "ok",
      settings: { ...valid, apiUrl: "https://api.example.invalid/prod" },
    });
  });

  it.each(["apiUrl", "region", "userPoolId", "userPoolClientId", "illustrationBase"])(
    "reports unavailable when %s is missing",
    (key) => {
      const copy: Record<string, unknown> = { ...valid };
      delete copy[key];
      expect(validateSettings(copy).status).toBe("unavailable");
    },
  );

  it("rejects non-https apiUrl, bad region, bad pool id and non-objects", () => {
    expect(validateSettings({ ...valid, apiUrl: "http://x.invalid" }).status).toBe("unavailable");
    expect(validateSettings({ ...valid, region: "mars" }).status).toBe("unavailable");
    expect(validateSettings({ ...valid, userPoolId: "nope" }).status).toBe("unavailable");
    expect(validateSettings({ ...valid, illustrationBase: "//evil.invalid" }).status).toBe(
      "unavailable",
    );
    expect(validateSettings(null).status).toBe("unavailable");
    expect(validateSettings([]).status).toBe("unavailable");
  });

  it("loadSettings returns unavailable on HTTP errors, bad JSON and network errors", async () => {
    const notFound = vi.fn(async () => new Response("", { status: 404 }));
    expect((await loadSettings(notFound as unknown as typeof fetch)).status).toBe("unavailable");
    const badJson = vi.fn(async () => new Response("{not json", { status: 200 }));
    expect((await loadSettings(badJson as unknown as typeof fetch)).status).toBe("unavailable");
    const boom = vi.fn(async () => {
      throw new Error("down");
    });
    expect((await loadSettings(boom as unknown as typeof fetch)).status).toBe("unavailable");
  });

  it("loadSettings returns ok for a valid response", async () => {
    const f = vi.fn(async () => jsonResponse(valid));
    const result = await loadSettings(f as unknown as typeof fetch);
    expect(result.status).toBe("ok");
    expect(f).toHaveBeenCalledWith("/config.json", expect.anything());
  });
});

describe("auth session persistence", () => {
  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      map,
    };
  }
  function make(storage: ReturnType<typeof memoryStorage>, responses: Array<() => Promise<Response>>) {
    const fetchMock = vi.fn(() => (responses.shift() ?? (() => Promise.reject(new Error("none"))))());
    return {
      fetchMock,
      session: createSession({
        region: "us-east-1",
        userPoolClientId: "client123",
        fetch: fetchMock as unknown as typeof fetch,
        now: () => 1_000_000,
        storage,
      }),
    };
  }

  it("keeps the refresh token so a reload can restore the session", async () => {
    const storage = memoryStorage();
    const first = make(storage, [async () => jsonResponse(okBody())]);
    await first.session.signIn("demo", PASSWORD);
    expect(storage.map.get(REFRESH_KEY)).toBe("refresh-xyz");

    const second = make(storage, [
      async () => jsonResponse({ AuthenticationResult: { AccessToken: "t2", ExpiresIn: 3600 } }),
    ]);
    expect(await second.session.restore()).toBe("restored");
    expect(second.session.token()).toBe("t2");
    const body = JSON.parse((second.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: "client123",
      AuthParameters: { REFRESH_TOKEN: "refresh-xyz" },
    });
    // A refresh response carries no new refresh token: the stored one stays.
    expect(storage.map.get(REFRESH_KEY)).toBe("refresh-xyz");
  });

  it("deletes a refused refresh token, but keeps it when offline", async () => {
    const storage = memoryStorage();
    storage.map.set(REFRESH_KEY, "old");
    const offline = make(storage, [() => Promise.reject(new Error("net"))]);
    expect(await offline.session.restore()).toBe("offline");
    expect(storage.map.get(REFRESH_KEY)).toBe("old");

    const refused = make(storage, [async () => jsonResponse({ __type: "NotAuthorizedException" }, 400)]);
    expect(await refused.session.restore()).toBe("none");
    expect(storage.map.has(REFRESH_KEY)).toBe(false);
  });

  it("sign-out deletes the stored refresh token", async () => {
    const storage = memoryStorage();
    const { session } = make(storage, [async () => jsonResponse(okBody())]);
    await session.signIn("demo", PASSWORD);
    session.signOut();
    expect(storage.map.has(REFRESH_KEY)).toBe(false);
  });
});
