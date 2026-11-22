/**
 * Handler tests of the four voice Lambdas (task 12.4).
 *
 * The handlers keep their clients at module scope, so the adapter modules are mocked with
 * factories that read the fakes from `holder` and each test imports the handler fresh. The cores
 * are the real ones. Covers requirements 4.3, 6.12, 14.1 and 14.5.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashToken } from "../../lambda/voice-authorizer/authorizer-core.js";
import { apiEvent, clearEnv, header, holder, resetHolder, setEnv } from "./handler-harness.js";

vi.mock("../../lambda/voice-session/adapters/voice-dynamo.js", async () => {
  const { holder: h } = await import("./handler-harness.js");
  return {
    createVoiceStore: () => h.store,
    createHealthStore: () => h.health,
    createReadCounter: () => async (key: string) => h.store.counterValue(key),
    createDeviceOnline: () => async () => h.online,
  };
});
vi.mock("../../lambda/voice-session/adapters/iot-doll-bus.js", async () => {
  const { holder: h } = await import("./handler-harness.js");
  return { createDollBus: () => h.bus };
});
vi.mock("../../lambda/voice-session/adapters/lambda-invoker.js", async () => {
  const { holder: h } = await import("./handler-harness.js");
  return { createSessionInvoker: () => h.invoker };
});
vi.mock("../../lambda/voice-session/adapters/sonic.js", () => ({ createSonicClient: () => ({}) }));
vi.mock("../../lambda/voice-session/adapters/appsync-events.js", () => ({ createAppSyncChannel: () => ({}) }));
vi.mock("../../lambda/voice-session/session-runner.js", async () => {
  const { holder: h } = await import("./handler-harness.js");
  return { runSession: (...args: unknown[]) => h.runSession(...args) };
});

const DEVICE = "warashi-01";
const SID = "00000000-0000-4000-8000-0000000000aa";
const TOKEN = `${SID}.${"c".repeat(43)}`;

let logLines: string[] = [];

beforeEach(() => {
  resetHolder();
  vi.resetModules();
  logLines = [];
});

afterEach(() => {
  clearEnv();
});

/** Points the safe logger of the freshly reset module registry at `logLines`. Call before importing a handler. */
async function captureLogs(): Promise<void> {
  const { setLogSink } = await import("../../lambda/_shared/safelog.js");
  setLogSink((line) => {
    logLines.push(line);
  });
}

type Res = { statusCode: number; headers?: Record<string, unknown>; body?: string };
// Test helper: response bodies are inspected with free-form property paths.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Res): any => JSON.parse(res.body ?? "null");

// ---------------------------------------------------------------------------------------------
// voice-start
// ---------------------------------------------------------------------------------------------

async function loadStart(extra: Record<string, string | undefined> = {}) {
  setEnv(extra);
  await captureLogs();
  const mod = await import("../../lambda/voice-start/index.js");
  return mod.handler as (e: unknown) => Promise<Res>;
}

const post = (body: unknown, over: Record<string, unknown> = {}) =>
  apiEvent({ route: "POST /conversations", body, ...over });

describe("voice-start handler", () => {
  it("refuses an invalid setting or a missing variable at load", async () => {
    await expect(loadStart({ WARASHI_CHUNK_MS: "5" })).rejects.toThrow(/chunkMs/);
    vi.resetModules();
    await expect(loadStart({ WARASHI_VOICE_SESSION_FUNCTION_NAME: undefined })).rejects.toThrow(
      /WARASHI_VOICE_SESSION_FUNCTION_NAME/,
    );
    vi.resetModules();
    await expect(loadStart({ WARASHI_VOICE_HTTP_HOST: "" })).rejects.toThrow(/WARASHI_VOICE_HTTP_HOST/);
  });

  it("starts a browser session: 201, token in the body, CORS header, invoker called", async () => {
    const handler = await loadStart();
    const res = await handler(post({ deviceId: DEVICE, client: "browser", target: "virtual" }));
    expect(res.statusCode).toBe(201);
    expect(header(res.headers, "access-control-allow-origin")).toBe("https://dash.example.invalid");
    const body = json(res);
    expect(body.clientToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(body.hosts).toEqual({ http: "http.example.invalid", realtime: "rt.example.invalid" });
    expect(holder.invoker.payloads).toHaveLength(1);
    expect(holder.store.putSessionCalls[0]!.clientTokenHash).toBe(hashToken(body.clientToken));
    // The token is returned but never logged.
    expect(logLines.join("\n")).not.toContain(body.clientToken);
  });

  it("starts the doll: 202 and a conversation.start command on the bus", async () => {
    const handler = await loadStart();
    const res = await handler(post({ deviceId: DEVICE, client: "device", target: "real" }));
    expect(res.statusCode).toBe(202);
    expect(json(res).deviceOnline).toBe(true);
    expect(holder.bus.published[0]!.envelope.type).toBe("conversation.start");
  });

  it("maps a user cap to 429 with a whole-second Retry-After and CORS", async () => {
    const handler = await loadStart({ WARASHI_PER_USER_PER_DAY_FAMILY: "0" });
    const res = await handler(post({ deviceId: DEVICE, client: "browser", target: "virtual" }));
    expect(res.statusCode).toBe(429);
    expect(json(res).error.code).toBe("rate_limited");
    const retry = Number(header(res.headers, "retry-after"));
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(86_400);
    expect(header(res.headers, "access-control-allow-origin")).toBe("https://dash.example.invalid");
  });

  it("maps the kill switch to 503 voice_unavailable", async () => {
    const handler = await loadStart({ WARASHI_VOICE_ENABLED: "false" });
    const res = await handler(post({ deviceId: DEVICE, client: "browser", target: "virtual" }));
    expect(res.statusCode).toBe(503);
    expect(json(res).error.code).toBe("voice_unavailable");
  });

  it("maps a busy doll to 409 session_active", async () => {
    const handler = await loadStart();
    const body = { deviceId: DEVICE, client: "device", target: "real" };
    expect((await handler(post(body))).statusCode).toBe(202);
    const res = await handler(post(body));
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe("session_active");
  });

  it("maps a failed invoke to 503 and leaves nothing behind", async () => {
    const handler = await loadStart();
    holder.invoker.fail = true;
    const res = await handler(post({ deviceId: DEVICE, client: "browser", target: "real" }));
    expect(res.statusCode).toBe(503);
    expect(json(res).error.code).toBe("voice_unavailable");
    holder.invoker.fail = false;
    expect((await handler(post({ deviceId: DEVICE, client: "browser", target: "real" }))).statusCode).toBe(201);
  });

  it("answers 400 for bad JSON, 401 without a subject and 403 for a reviewer on the real doll", async () => {
    const handler = await loadStart();
    expect((await handler(post(undefined, { rawBody: "{nope" }))).statusCode).toBe(400);
    expect((await handler(post({ deviceId: DEVICE, client: "browser", target: "virtual" }, { sub: null }))).statusCode).toBe(401);
    const res = await handler(
      post({ deviceId: DEVICE, client: "browser", target: "real" }, { groups: ["reviewer"], sub: "rev" }),
    );
    expect(res.statusCode).toBe(403);
  });

  it("sends no CORS header to a foreign origin", async () => {
    const handler = await loadStart();
    const res = await handler(
      post({ deviceId: DEVICE, client: "browser", target: "virtual" }, { origin: "https://evil.example.invalid" }),
    );
    expect(res.statusCode).toBe(201);
    expect(header(res.headers, "access-control-allow-origin")).toBeUndefined();
  });

  it("serves GET and DELETE to the owner and 404 to a stranger", async () => {
    const handler = await loadStart({ WARASHI_REVIEWER_VOICE_ENABLED: "true" });
    const started = json(await handler(post({ deviceId: DEVICE, client: "browser", target: "virtual" })));
    const sessionId = started.sessionId as string;

    const got = await handler(apiEvent({ route: "GET /conversations/{sessionId}", sessionId }));
    expect(got.statusCode).toBe(200);
    expect(json(got)).toEqual({ sessionId, phase: "starting", endReason: null });

    const foreign = await handler(
      apiEvent({ route: "GET /conversations/{sessionId}", sessionId, sub: "rev", groups: ["reviewer"] }),
    );
    expect(foreign.statusCode).toBe(404);

    const del = await handler(apiEvent({ route: "DELETE /conversations/{sessionId}", sessionId }));
    expect(del.statusCode).toBe(204);
    expect(del.body ?? "").toBe("");
  });
});

// ---------------------------------------------------------------------------------------------
// voice-grant
// ---------------------------------------------------------------------------------------------

const ENCOUNTER = "c1d2e3f4-0000-4000-8000-000000000001";

function requestedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
    ts: new Date().toISOString(),
    deviceId: DEVICE,
    encounterId: ENCOUNTER,
    type: "conversation.requested",
    data: { reason: "family_verdict" },
    topicDeviceId: DEVICE,
    ...over,
  };
}

async function loadGrant(extra: Record<string, string | undefined> = {}) {
  setEnv(extra);
  await captureLogs();
  const mod = await import("../../lambda/voice-grant/index.js");
  return mod.handler as (e: unknown) => Promise<{ kind: string; reason?: string }>;
}

describe("voice-grant handler", () => {
  it("refuses an invalid setting or a missing function name at load", async () => {
    await expect(loadGrant({ WARASHI_GRANT_WINDOW_SECONDS: "1" })).rejects.toThrow(/grantWindowSeconds/);
    vi.resetModules();
    await expect(loadGrant({ WARASHI_VOICE_SESSION_FUNCTION_NAME: undefined })).rejects.toThrow(
      /WARASHI_VOICE_SESSION_FUNCTION_NAME/,
    );
  });

  it("grants after a fresh family verdict and strips topicDeviceId from the envelope", async () => {
    const handler = await loadGrant();
    holder.store.seedVerdict(ENCOUNTER, "family", Date.now() - 1000);
    const out = await handler(requestedEvent());
    expect(out.kind).toBe("granted");
    expect(holder.bus.published).toHaveLength(1);
    expect(holder.invoker.payloads).toHaveLength(1);
  });

  it.each([
    ["missing", {}],
    ["empty", { topicDeviceId: "" }],
    ["not a string", { topicDeviceId: 7 }],
  ])("drops an event with a %s topicDeviceId", async (_name, over) => {
    const handler = await loadGrant();
    holder.store.seedVerdict(ENCOUNTER, "family", Date.now());
    const event = requestedEvent(over);
    if (_name === "missing") delete event["topicDeviceId"];
    expect(await handler(event)).toEqual({ kind: "dropped", reason: "topic_device_mismatch" });
    expect(holder.bus.published).toHaveLength(0);
    expect(holder.store.putSessionCalls).toHaveLength(0);
  });

  it("drops a non-object event", async () => {
    const handler = await loadGrant();
    for (const bad of [null, "text", 5, []]) {
      expect(await handler(bad)).toEqual({ kind: "dropped", reason: "malformed" });
    }
  });

  it("drops a topic that disagrees with the envelope", async () => {
    const handler = await loadGrant();
    holder.store.seedVerdict(ENCOUNTER, "family", Date.now());
    expect(await handler(requestedEvent({ topicDeviceId: "warashi-99" }))).toEqual({
      kind: "dropped",
      reason: "topic_device_mismatch",
    });
  });

  it("throws on a store failure so IoT can retry", async () => {
    const handler = await loadGrant();
    vi.spyOn(holder.store, "encounterVerdict").mockRejectedValue(new Error("ddb down"));
    await expect(handler(requestedEvent())).rejects.toThrow("ddb down");
  });
});

// ---------------------------------------------------------------------------------------------
// voice-authorizer
// ---------------------------------------------------------------------------------------------

async function loadAuthorizer() {
  setEnv();
  await captureLogs();
  const mod = await import("../../lambda/voice-authorizer/index.js");
  return mod.handler as (e: unknown) => Promise<{ isAuthorized: boolean; ttlOverride?: number }>;
}

const authRequest = (token: unknown, operation = "EVENT_SUBSCRIBE", leaf = "text") => ({
  authorizationToken: token,
  requestContext: { operation, channelNamespaceName: "voice", channel: `/voice/${SID}/${leaf}` },
});

describe("voice-authorizer handler", () => {
  async function seed(): Promise<void> {
    const now = Date.now();
    await holder.store.putSession({
      sessionId: SID,
      deviceId: DEVICE,
      client: "browser",
      target: "virtual",
      ownerSub: "sub-family",
      role: "family",
      phase: "live",
      startedAt: now,
      expiresAt: now + 60_000,
      clientTokenHash: hashToken(TOKEN),
      observerTokenHash: null,
      endReason: null,
      endedAt: null,
      endRequested: false,
    });
  }

  it("authorizes a valid token on its channel", async () => {
    const handler = await loadAuthorizer();
    await seed();
    expect((await handler(authRequest(TOKEN))).isAuthorized).toBe(true);
    expect((await handler(authRequest(TOKEN, "EVENT_PUBLISH", "in"))).isAuthorized).toBe(true);
    expect((await handler(authRequest(TOKEN, "EVENT_PUBLISH", "out"))).isAuthorized).toBe(false);
  });

  it("fails closed when the store throws, and logs only the error name", async () => {
    const handler = await loadAuthorizer();
    vi.spyOn(holder.store, "getSession").mockRejectedValue(
      Object.assign(new Error(`failure with ${TOKEN}`), { name: "ProvisionedThroughputExceededException" }),
    );
    expect(await handler(authRequest(TOKEN))).toEqual({ isAuthorized: false, ttlOverride: 0 });
    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0]!)).toEqual({
      event: "voice_authorizer_failed",
      error: "ProvisionedThroughputExceededException",
    });
    expect(logLines[0]).not.toContain(TOKEN);
  });

  it.each([null, undefined, "x", 42, { requestContext: 5 }, { authorizationToken: {}, requestContext: null }])(
    "denies garbage input %#",
    async (input) => {
      const handler = await loadAuthorizer();
      const out = await handler(input);
      expect(out.isAuthorized).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// voice-session
// ---------------------------------------------------------------------------------------------

async function loadSession(extra: Record<string, string | undefined> = {}) {
  setEnv(extra);
  await captureLogs();
  const mod = await import("../../lambda/voice-session/index.js");
  return mod.handler as (e: unknown) => Promise<void>;
}

const payload = (over: Record<string, unknown> = {}) => ({
  sessionId: SID,
  deviceId: DEVICE,
  client: "browser",
  target: "virtual",
  ownerSub: "sub-family",
  maxSeconds: 180,
  silenceSeconds: 15,
  ...over,
});

describe("voice-session handler", () => {
  it("refuses an invalid setting or a missing host at load", async () => {
    await expect(loadSession({ WARASHI_REORDER_WINDOW: "99" })).rejects.toThrow(/reorderWindow/);
    vi.resetModules();
    await expect(loadSession({ WARASHI_VOICE_REALTIME_HOST: undefined })).rejects.toThrow(
      /WARASHI_VOICE_REALTIME_HOST/,
    );
    vi.resetModules();
    await expect(loadSession({ AWS_REGION: undefined })).rejects.toThrow(/AWS_REGION/);
  });

  it("runs the session for a valid payload (null owner allowed)", async () => {
    const handler = await loadSession();
    await handler(payload());
    await handler(payload({ client: "device", target: "real", ownerSub: null }));
    expect(holder.runSession).toHaveBeenCalledTimes(2);
    expect(holder.runSession.mock.calls[0]![0]).toEqual(payload());
  });

  it("gives each session of a warm container its own channel", async () => {
    // `runSession` closes its channel at the end; a shared one would reject every later publish.
    const handler = await loadSession();
    await handler(payload());
    await handler(payload());
    const [first, second] = holder.runSession.mock.calls.map((c) => (c[1] as { channel: unknown }).channel);
    expect(first).toBeDefined();
    expect(second).not.toBe(first);
  });

  it.each([
    ["null", null],
    ["string", "x"],
    ["short session id", payload({ sessionId: "abc" })],
    ["uppercase session id", payload({ sessionId: SID.toUpperCase() })],
    ["bad device id", payload({ deviceId: "a b" })],
    ["bad client", payload({ client: "tv" })],
    ["bad target", payload({ target: "moon" })],
    ["numeric owner", payload({ ownerSub: 5 }) ],
    ["missing owner", (() => { const p: Record<string, unknown> = payload(); delete p["ownerSub"]; return p; })()],
    ["string maxSeconds", payload({ maxSeconds: "180" })],
    ["missing silenceSeconds", payload({ silenceSeconds: undefined })],
  ])("rejects a payload with %s without running", async (_name, input) => {
    const handler = await loadSession();
    await handler(input);
    expect(holder.runSession).not.toHaveBeenCalled();
    expect(logLines.map((l) => JSON.parse(l).event)).toContain("voice_session_rejected");
  });

  it("feeds the health flag from the stored end reason after a run", async () => {
    const handler = await loadSession();
    await handler(payload());
    // No session record exists, so the reason is `error` and the streak starts.
    expect(holder.health.state?.streak).toBe(1);
    expect(logLines.map((l) => JSON.parse(l).event)).toEqual(["voice_session_begin", "voice_session_end"]);
  });

  it("swallows a runSession failure and logs the error name with a shortened id", async () => {
    const handler = await loadSession();
    holder.runSession.mockRejectedValue(Object.assign(new Error("secret detail"), { name: "BoomError" }));
    await expect(handler(payload())).resolves.toBeUndefined();
    const failed = logLines.map((l) => JSON.parse(l)).find((l) => l.event === "voice_session_failed");
    expect(failed).toEqual({ event: "voice_session_failed", error: "BoomError", session: SID.slice(0, 8) });
    expect(holder.health.state).toBeNull();
    expect(logLines.join("\n")).not.toContain(SID);
  });

  it("swallows a health failure after the run", async () => {
    const handler = await loadSession();
    vi.spyOn(holder.store, "getSession").mockRejectedValue(new Error("x"));
    await expect(handler(payload())).resolves.toBeUndefined();
    expect(logLines.map((l) => JSON.parse(l).event)).toContain("voice_session_health_failed");
  });
});
