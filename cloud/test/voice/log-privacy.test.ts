/**
 * Log privacy of the four voice handlers (task 12.4, requirements 14.1 and 14.5).
 *
 * Every handler runs with a fixture that holds a token, audio Base64, a display name, a transcript
 * line, a family label and a pre-signed URL, on the normal path and on failing paths (store,
 * bus and runner errors whose messages carry the same secrets). The captured log lines must
 * contain none of them, and no full session id.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashToken } from "../../lambda/voice-authorizer/authorizer-core.js";
import { apiEvent, clearEnv, holder, resetHolder, setEnv } from "./handler-harness.js";

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
const SECRET_PART = "s3cretS3cretS3cretS3cretS3cretS3cretS3cretS3c".slice(0, 43);
const TOKEN = `${SID}.${SECRET_PART}`;
const AUDIO = "UklGRiQAAABXQVZF".repeat(20); // 320 characters of Base64
const NAME = "Haruko-Tanaka-Display";
const TRANSCRIPT = "transcript-line-about-grandma-birthday";
const LABEL = "grandma-label-mika";
const URL = "https://bucket.example.invalid/snap.jpg?X-Amz-Signature=abcdef0123456789&X-Amz-Credential=AKIDEXAMPLE";
const SECRETS = [SECRET_PART, AUDIO, NAME, TRANSCRIPT, LABEL, "X-Amz-Signature=abcdef0123456789", "AKIDEXAMPLE"];
const LEAKY_MESSAGE = `failed: ${TOKEN} ${AUDIO} ${NAME} ${TRANSCRIPT} ${LABEL} ${URL}`;

/** Fields that a careless handler might copy into a log line. */
const FIXTURE_FIELDS = {
  token: TOKEN,
  clientToken: TOKEN,
  pcm: AUDIO,
  audio: AUDIO,
  displayName: NAME,
  text: TRANSCRIPT,
  transcript: TRANSCRIPT,
  label: LABEL,
  url: URL,
  mp3Url: URL,
};

let logLines: string[] = [];
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  resetHolder();
  vi.resetModules();
  logLines = [];
  // Anything printed outside the safe logger is captured as well.
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
  }
});

afterEach(() => {
  for (const s of consoleSpies.splice(0)) s.mockRestore();
  clearEnv();
});

async function load<T>(path: string, extra: Record<string, string | undefined> = {}): Promise<T> {
  setEnv(extra);
  const mod = (await import(path)) as { handler: T };
  return mod.handler;
}

function expectClean(): void {
  const all = logLines.join("\n");
  for (const secret of SECRETS) expect(all).not.toContain(secret);
  expect(all).not.toContain(SID); // only the first 8 characters of a session id may appear
  expect(all).not.toContain(hashToken(TOKEN));
}

describe("voice handler logs never hold tokens, audio, names, transcripts, labels or URLs", () => {
  it("voice-start: success, validation, cap and failure paths", async () => {
    const handler = await load<(e: unknown) => Promise<{ statusCode: number; body?: string }>>(
      "../../lambda/voice-start/index.js",
    );
    const body = { deviceId: DEVICE, client: "browser", target: "virtual", ...FIXTURE_FIELDS };
    const ok = await handler(apiEvent({ route: "POST /conversations", body }));
    expect(ok.statusCode).toBe(201);
    const started = JSON.parse(ok.body ?? "{}");
    await handler(apiEvent({ route: "GET /conversations/{sessionId}", sessionId: started.sessionId }));
    await handler(apiEvent({ route: "DELETE /conversations/{sessionId}", sessionId: started.sessionId }));
    await handler(apiEvent({ route: "POST /conversations", rawBody: `{"bad": "${LEAKY_MESSAGE}` }));

    // Failing paths: the invoker, the bus and the store throw errors whose messages are leaky.
    holder.invoker.fail = true;
    vi.spyOn(holder.invoker, "invoke").mockRejectedValue(new Error(LEAKY_MESSAGE));
    await handler(apiEvent({ route: "POST /conversations", body: { ...body, target: "real" } }));
    holder.invoker.fail = false;
    vi.spyOn(holder.bus, "publish").mockRejectedValue(new Error(LEAKY_MESSAGE));
    await handler(apiEvent({ route: "POST /conversations", body: { ...body, client: "device", target: "real" } }));
    vi.spyOn(holder.store, "getSession").mockRejectedValue(new Error(LEAKY_MESSAGE));
    const failed = await handler(apiEvent({ route: "GET /conversations/{sessionId}", sessionId: started.sessionId }));
    expect(failed.statusCode).toBe(500);
    expect(failed.body ?? "").not.toContain(NAME);

    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toContain(started.clientToken);
    expectClean();
  });

  it("voice-grant: grant, drops and a failing store", async () => {
    const handler = await load<(e: unknown) => Promise<unknown>>("../../lambda/voice-grant/index.js");
    const encounterId = "c1d2e3f4-0000-4000-8000-000000000001";
    const envelope = (type: string, data: unknown, over: Record<string, unknown> = {}) => ({
      v: 1,
      id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
      ts: new Date().toISOString(),
      deviceId: DEVICE,
      encounterId,
      type,
      data,
      topicDeviceId: DEVICE,
      ...FIXTURE_FIELDS,
      ...over,
    });
    holder.store.seedVerdict(encounterId, "family", Date.now());
    await handler(envelope("conversation.requested", { reason: "family_verdict", ...FIXTURE_FIELDS }));
    await handler(envelope("conversation.ended", { sessionId: TOKEN, reason: "user" }));
    await handler(envelope("conversation.ended", { sessionId: SID, reason: "user", ...FIXTURE_FIELDS }));
    await handler(envelope("conversation.requested", {}, { deviceId: "warashi-99" }));
    await handler(envelope("conversation.requested", { reason: "nope" }, { topicDeviceId: undefined }));
    await handler({ ...FIXTURE_FIELDS });
    await handler(null);

    vi.spyOn(holder.store, "encounterVerdict").mockRejectedValue(new Error(LEAKY_MESSAGE));
    await expect(handler(envelope("conversation.requested", { reason: "family_verdict" }))).rejects.toThrow();

    expect(logLines.length).toBeGreaterThan(0);
    expectClean();
  });

  it("voice-authorizer: denied, allowed and failing paths", async () => {
    const handler = await load<(e: unknown) => Promise<{ isAuthorized: boolean }>>(
      "../../lambda/voice-authorizer/index.js",
    );
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
    const request = (token: unknown, leaf = "text") => ({
      authorizationToken: token,
      requestContext: { operation: "EVENT_SUBSCRIBE", channelNamespaceName: "voice", channel: `/voice/${SID}/${leaf}` },
      ...FIXTURE_FIELDS,
    });
    expect((await handler(request(TOKEN))).isAuthorized).toBe(true);
    expect((await handler(request(`${SID}.${"x".repeat(43)}`))).isAuthorized).toBe(false);
    expect((await handler(request(LEAKY_MESSAGE))).isAuthorized).toBe(false);
    expect((await handler(request(TOKEN, `*${NAME}`))).isAuthorized).toBe(false);
    vi.spyOn(holder.store, "getSession").mockRejectedValue(new Error(LEAKY_MESSAGE));
    expect((await handler(request(TOKEN))).isAuthorized).toBe(false);

    expect(logLines.length).toBeGreaterThan(0);
    expectClean();
  });

  it("voice-session: runs, rejects bad payloads and survives failing runner and store", async () => {
    const handler = await load<(e: unknown) => Promise<void>>("../../lambda/voice-session/index.js");
    const payload = {
      sessionId: SID,
      deviceId: DEVICE,
      client: "browser",
      target: "virtual",
      ownerSub: "sub-family",
      maxSeconds: 180,
      silenceSeconds: 15,
      ...FIXTURE_FIELDS,
    };
    await handler(payload);
    await handler({ ...payload, sessionId: TOKEN });
    await handler({ ...FIXTURE_FIELDS });

    holder.runSession.mockRejectedValueOnce(new Error(LEAKY_MESSAGE));
    await handler(payload);
    vi.spyOn(holder.store, "getSession").mockRejectedValue(new Error(LEAKY_MESSAGE));
    await handler(payload);

    const events = logLines.map((l) => JSON.parse(l).event);
    expect(events).toEqual(
      expect.arrayContaining([
        "voice_session_begin",
        "voice_session_end",
        "voice_session_rejected",
        "voice_session_failed",
        "voice_session_health_failed",
      ]),
    );
    expectClean();
  });
});
