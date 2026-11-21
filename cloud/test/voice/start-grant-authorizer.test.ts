/**
 * Unit tests for the voice start, grant and authorizer cores (task 11.4).
 *
 * Uses `FakeVoiceStore` and `FakeDollBus`; no AWS. Covers requirements 1.3, 1.4, 1.5, 1.8, 1.10,
 * 1.12, 2.3, 2.5, 2.6, 4.4, 4.5, 4.6, 4.7 and 4.11.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLogSink } from "../../lambda/_shared/safelog.js";
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "../../lambda/_shared/voice/config.js";
import { counterKey, dayBucket, lockKey, GLOBAL_SCOPE, DEVICE_SCOPE, userScope } from "../../lambda/_shared/voice/caps.js";
import type { SessionRecord } from "../../lambda/_shared/voice/ports.js";
import {
  AUTH_TTL_SECONDS,
  TOKEN_REGEX,
  authorize,
  hashToken,
  type AuthorizerRequest,
} from "../../lambda/voice-authorizer/authorizer-core.js";
import { handleVoiceEvent, type GrantDeps, type SessionInvoker } from "../../lambda/voice-grant/voice-grant-core.js";
import {
  deleteConversation,
  getConversation,
  meVoice,
  startConversation,
  type Caller,
  type HealthState,
  type HealthStore,
  type HttpResult,
  type StartDeps,
} from "../../lambda/voice-start/voice-start-core.js";
import { FakeDollBus } from "./fake-stream.js";
import { FakeVoiceStore } from "./voice-store-fake.js";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY = dayBucket(NOW);
const DEVICE = "warashi-01";
const FAMILY: Caller = { sub: "sub-family", role: "family" };
const REVIEWER: Caller = { sub: "sub-reviewer", role: "reviewer" };

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

let logLines: string[] = [];
let restoreSink: ((line: string) => void) | null = null;

beforeEach(() => {
  logLines = [];
  restoreSink = setLogSink((line) => {
    logLines.push(line);
  });
});

afterEach(() => {
  if (restoreSink !== null) setLogSink(restoreSink);
});

const cfgWith = (over: Partial<VoiceConfig> = {}): VoiceConfig => ({
  ...DEFAULT_VOICE_CONFIG,
  voiceEnabled: true,
  blockedWords: [],
  ...over,
});

class MemoryHealth implements HealthStore {
  state: HealthState | null = null;
  async read(): Promise<HealthState | null> {
    return this.state;
  }
  async write(state: HealthState): Promise<void> {
    this.state = state;
  }
}

class FakeInvoker implements SessionInvoker {
  readonly payloads: unknown[] = [];
  fail = false;
  async invoke(payload: unknown): Promise<void> {
    if (this.fail) throw new Error("invoke failed");
    this.payloads.push(payload);
  }
}

interface Harness {
  store: FakeVoiceStore;
  bus: FakeDollBus;
  invoker: FakeInvoker;
  health: MemoryHealth;
  deps: StartDeps;
  grantDeps: GrantDeps;
  secrets: string[];
}

function harness(cfg: VoiceConfig = cfgWith(), online = true): Harness {
  const store = new FakeVoiceStore(NOW);
  const bus = new FakeDollBus();
  const invoker = new FakeInvoker();
  const health = new MemoryHealth();
  const secrets: string[] = [];
  let n = 0;
  const newId = (): string => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
  const newSecret = (): string => {
    n += 1;
    const s = `secret${n}`.padEnd(43, "x");
    secrets.push(s);
    return s;
  };
  const deps: StartDeps = {
    store,
    bus,
    invoker,
    health,
    cfg,
    readCounter: async (key) => store.counterValue(key),
    deviceOnline: async () => online,
    hosts: { http: "http.example.invalid", realtime: "rt.example.invalid" },
    now: () => NOW,
    newId,
    newSecret,
  };
  const grantDeps: GrantDeps = { store, bus, invoker, cfg, now: () => NOW, newId, newSecret, hashToken };
  return { store, bus, invoker, health, deps, grantDeps, secrets };
}

// Test helper: response bodies are inspected with free-form property paths.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: HttpResult): Record<string, any> => res.body as Record<string, any>;
const errCode = (res: HttpResult): string => body(res).error.code;

const start = (h: Harness, caller: Caller, client: string, target: string, deviceId = DEVICE) =>
  startConversation(caller, { deviceId, client, target }, h.deps);

/** Every counter that a start may touch, for "unchanged" checks. */
function counters(h: Harness, sub: string): number[] {
  return [
    h.store.counterValue(counterKey(userScope(sub), DAY)),
    h.store.counterValue(counterKey(DEVICE_SCOPE, DAY)),
    h.store.counterValue(counterKey(GLOBAL_SCOPE, DAY)),
  ];
}

// ---------------------------------------------------------------------------------------------
// POST /conversations
// ---------------------------------------------------------------------------------------------

describe("startConversation: role matrix", () => {
  it.each([
    ["family", "browser", "virtual", 201],
    ["family", "browser", "real", 201],
    ["family", "device", "real", 202],
  ] as const)("%s %s/%s gives %i", async (role, client, target, status) => {
    const h = harness();
    const res = await start(h, { sub: "s", role }, client, target);
    expect(res.status).toBe(status);
  });

  it("rejects a doll client on the virtual doll as a validation error (R1.3)", async () => {
    const h = harness();
    const res = await start(h, FAMILY, "device", "virtual");
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe("validation_failed");
    expect(counters(h, FAMILY.sub)).toEqual([0, 0, 0]);
  });

  it("lets a reviewer start a browser session on the virtual doll when enabled (R1.5)", async () => {
    const h = harness(cfgWith({ reviewerVoiceEnabled: true }));
    const res = await start(h, REVIEWER, "browser", "virtual");
    expect(res.status).toBe(201);
  });

  it.each([
    ["browser", "real"],
    ["device", "real"],
  ] as const)("forbids a reviewer %s/%s even when enabled (R1.4)", async (client, target) => {
    const h = harness(cfgWith({ reviewerVoiceEnabled: true }));
    const res = await start(h, REVIEWER, client, target);
    expect(res.status).toBe(403);
    expect(errCode(res)).toBe("forbidden");
    expect(counters(h, REVIEWER.sub)).toEqual([0, 0, 0]);
    expect(h.bus.published).toHaveLength(0);
  });

  it("forbids a reviewer on the virtual doll while reviewerVoiceEnabled is off (R1.4)", async () => {
    const h = harness();
    const res = await start(h, REVIEWER, "browser", "virtual");
    expect(res.status).toBe(403);
    expect(body(res)).toEqual({ error: { code: "forbidden", message: "Not allowed." } });
  });
});

describe("startConversation: validation", () => {
  it.each([
    ["null body", null],
    ["array body", []],
    ["missing deviceId", { client: "browser", target: "virtual" }],
    ["bad deviceId characters", { deviceId: "a b", client: "browser", target: "virtual" }],
    ["deviceId too long", { deviceId: "a".repeat(65), client: "browser", target: "virtual" }],
    ["unknown client", { deviceId: DEVICE, client: "tv", target: "virtual" }],
    ["unknown target", { deviceId: DEVICE, client: "browser", target: "moon" }],
  ])("gives 400 validation_failed for %s and changes nothing", async (_name, input) => {
    const h = harness();
    const res = await startConversation(FAMILY, input, h.deps);
    expect(res.status).toBe(400);
    expect(errCode(res)).toBe("validation_failed");
    expect(counters(h, FAMILY.sub)).toEqual([0, 0, 0]);
    expect(h.store.putSessionCalls).toHaveLength(0);
  });
});

describe("startConversation: availability", () => {
  it("gives 503 voice_unavailable when the kill switch is off", async () => {
    const h = harness(cfgWith({ voiceEnabled: false }));
    const res = await start(h, FAMILY, "browser", "virtual");
    expect(res.status).toBe(503);
    expect(body(res)).toEqual({ error: { code: "voice_unavailable", message: "Voice is unavailable." } });
    expect(counters(h, FAMILY.sub)).toEqual([0, 0, 0]);
  });

  it("gives 503 while the health flag is set", async () => {
    const h = harness();
    h.health.state = { streak: 0, firstAtMs: 0, unhealthyUntilMs: NOW + 1000 };
    expect((await start(h, FAMILY, "browser", "virtual")).status).toBe(503);
    h.health.state = { streak: 0, firstAtMs: 0, unhealthyUntilMs: NOW };
    expect((await start(h, FAMILY, "browser", "virtual")).status).toBe(201);
  });
});

describe("startConversation: caps and lock", () => {
  it("gives 429 with Retry-After to the next UTC midnight once the user cap is used", async () => {
    const h = harness(cfgWith({ perUserPerDay: { family: 1, reviewer: 2 } }));
    expect((await start(h, FAMILY, "browser", "virtual")).status).toBe(201);
    // Free the virtual-doll lock so only the cap can refuse.
    await h.store.releaseLock(lockKey("virtual", DEVICE, FAMILY.sub), `00000000-0000-4000-8000-000000000001`);
    const res = await start(h, FAMILY, "browser", "virtual");
    expect(res.status).toBe(429);
    expect(errCode(res)).toBe("rate_limited");
    expect(res.retryAfterS).toBe(12 * 3600);
    expect(counters(h, FAMILY.sub)[0]).toBe(1);
  });

  it("releases the earlier counters when a later cap refuses (R3)", async () => {
    const h = harness(cfgWith({ deviceStartsPerDay: 0 }));
    const res = await start(h, FAMILY, "browser", "real");
    expect(res.status).toBe(429);
    expect(counters(h, FAMILY.sub)).toEqual([0, 0, 0]);
    expect(h.store.lockOwner(lockKey("real", DEVICE, null))).toBeNull();

    const h2 = harness(cfgWith({ globalPerDay: 0 }));
    expect((await start(h2, FAMILY, "browser", "virtual")).status).toBe(429);
    expect(counters(h2, FAMILY.sub)).toEqual([0, 0, 0]);
  });

  it("gives 409 session_active on a lock conflict and releases the counters of the loser", async () => {
    const h = harness();
    expect((await start(h, FAMILY, "device", "real")).status).toBe(202);
    const before = counters(h, FAMILY.sub);
    const res = await start(h, FAMILY, "browser", "real");
    expect(res.status).toBe(409);
    expect(body(res)).toEqual({ error: { code: "session_active", message: "A session is already running." } });
    expect(counters(h, FAMILY.sub)).toEqual(before);
    expect(h.store.putSessionCalls).toHaveLength(1);
  });

  it("gives each owner their own virtual-doll lock", async () => {
    const h = harness(cfgWith({ reviewerVoiceEnabled: true }));
    expect((await start(h, FAMILY, "browser", "virtual")).status).toBe(201);
    expect((await start(h, REVIEWER, "browser", "virtual")).status).toBe(201);
    expect((await start(h, FAMILY, "browser", "virtual")).status).toBe(409);
  });
});

describe("startConversation: success bodies and tokens", () => {
  it("returns the client token for a browser session and stores only hashes", async () => {
    const h = harness();
    const res = await start(h, FAMILY, "browser", "virtual");
    const b = body(res);
    expect(res.status).toBe(201);
    expect(b.clientToken).toMatch(TOKEN_REGEX);
    expect(b.clientToken.startsWith(`${b.sessionId}.`)).toBe(true);
    expect(b.channels).toEqual({
      in: `/voice/${b.sessionId}/in`,
      out: `/voice/${b.sessionId}/out`,
      text: `/voice/${b.sessionId}/text`,
    });
    expect(b.hosts).toEqual({ http: "http.example.invalid", realtime: "rt.example.invalid" });
    expect(b.maxSeconds).toBe(180);
    expect(b.silenceSeconds).toBe(15);
    expect(b.observerToken).toBeUndefined();
    expect(new Date(b.expiresAt).getTime()).toBeGreaterThan(NOW);

    const stored = h.store.putSessionCalls[0];
    expect(stored.clientTokenHash).toBe(hashToken(b.clientToken));
    expect(stored.observerTokenHash).toBeNull();
    expect(stored.phase).toBe("starting");
    expect(JSON.stringify(stored)).not.toContain(b.clientToken);
    expect(h.bus.published).toHaveLength(0);
    expect(h.invoker.payloads).toHaveLength(1);
  });

  it("gives a doll session an observer token and sends the doll token only in the command", async () => {
    const h = harness();
    const res = await start(h, FAMILY, "device", "real");
    const b = body(res);
    expect(res.status).toBe(202);
    expect(b.clientToken).toBeUndefined();
    expect(b.observerToken).toMatch(TOKEN_REGEX);
    expect(b.deviceOnline).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(h.secrets[0]);

    expect(h.bus.published).toHaveLength(1);
    const pub = h.bus.published[0];
    expect(pub.topic).toBe(`warashi/${DEVICE}/commands`);
    expect(pub.envelope.type).toBe("conversation.start");
    const data = pub.envelope.data as Record<string, unknown>;
    expect(data.source).toBe("manual");
    expect(data.sessionId).toBe(b.sessionId);
    expect(data.token).toMatch(TOKEN_REGEX);
    expect(data.token).not.toBe(b.observerToken);

    const stored = h.store.putSessionCalls[0];
    expect(stored.clientTokenHash).toBe(hashToken(data.token as string));
    expect(stored.observerTokenHash).toBe(hashToken(b.observerToken));
  });

  it("reports deviceOnline false and still succeeds when the status read fails", async () => {
    const h = harness();
    const failing: StartDeps = { ...h.deps, deviceOnline: async () => { throw new Error("x"); } };
    const res = await startConversation(FAMILY, { deviceId: DEVICE, client: "device", target: "real" }, failing);
    expect(res.status).toBe(202);
    expect(body(res).deviceOnline).toBe(false);
  });
});

describe("startConversation: failed start leaves nothing behind", () => {
  it("rolls back lock, counters and session when the invoke fails", async () => {
    const h = harness();
    h.invoker.fail = true;
    const res = await start(h, FAMILY, "browser", "real");
    expect(res.status).toBe(503);
    expect(errCode(res)).toBe("voice_unavailable");
    expect(counters(h, FAMILY.sub)).toEqual([0, 0, 0]);
    expect(h.store.lockOwner(lockKey("real", DEVICE, null))).toBeNull();
    const sessionId = h.store.putSessionCalls[0].sessionId;
    const rec = await h.store.getSession(sessionId);
    expect(rec?.phase).toBe("ended");
    expect(rec?.endReason).toBe("error");
    expect(h.health.state?.streak).toBe(1);
  });

  it("rolls back when the command publish fails", async () => {
    const h = harness();
    h.bus.failPublishes = 1;
    const res = await start(h, FAMILY, "device", "real");
    expect(res.status).toBe(503);
    expect(counters(h, FAMILY.sub)).toEqual([0, 0, 0]);
    expect(h.store.lockOwner(lockKey("real", DEVICE, null))).toBeNull();
    // The doll can be started again right away.
    expect((await start(h, FAMILY, "device", "real")).status).toBe(202);
  });
});

// ---------------------------------------------------------------------------------------------
// GET and DELETE
// ---------------------------------------------------------------------------------------------

describe("get and delete conversation", () => {
  it("shows the owner the phase and end reason", async () => {
    const h = harness();
    const { sessionId } = body(await start(h, FAMILY, "browser", "virtual"));
    const res = await getConversation(FAMILY, sessionId, h.deps);
    expect(res).toEqual({ status: 200, body: { sessionId, phase: "starting", endReason: null } });
  });

  it("gives the same 404 for an unknown, malformed and foreign session (R1.12)", async () => {
    const h = harness(cfgWith({ reviewerVoiceEnabled: true }));
    const { sessionId } = body(await start(h, FAMILY, "browser", "virtual"));
    const unknown = await getConversation(FAMILY, "11111111-1111-4111-8111-111111111111", h.deps);
    const malformed = await getConversation(FAMILY, "nope", h.deps);
    const foreign = await getConversation(REVIEWER, sessionId, h.deps);
    for (const res of [unknown, malformed, foreign]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found", message: "Session not found." } });
    }
  });

  it("lets the owner delete: 204, end requested with reason user, lock released, safe twice", async () => {
    const h = harness();
    const { sessionId } = body(await start(h, FAMILY, "browser", "virtual"));
    const key = lockKey("virtual", DEVICE, FAMILY.sub);
    expect(h.store.lockOwner(key)).toBe(sessionId);

    const res = await deleteConversation(FAMILY, sessionId, h.deps);
    expect(res).toEqual({ status: 204, body: null });
    const rec = await h.store.getSession(sessionId);
    expect(rec?.endRequested).toBe(true);
    expect(rec?.endReason).toBe("user");
    expect(h.store.lockOwner(key)).toBeNull();

    expect((await deleteConversation(FAMILY, sessionId, h.deps)).status).toBe(204);
  });

  it("does not change a foreign session on delete and answers the same 404", async () => {
    const h = harness(cfgWith({ reviewerVoiceEnabled: true }));
    const { sessionId } = body(await start(h, FAMILY, "browser", "virtual"));
    const res = await deleteConversation(REVIEWER, sessionId, h.deps);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found", message: "Session not found." } });
    const rec = await h.store.getSession(sessionId);
    expect(rec?.endRequested).toBe(false);
    expect(h.store.lockOwner(lockKey("virtual", DEVICE, FAMILY.sub))).toBe(sessionId);
  });

  it("keeps the first end reason when the session already has one", async () => {
    const h = harness();
    const { sessionId } = body(await start(h, FAMILY, "browser", "virtual"));
    const rec = (await h.store.getSession(sessionId)) as SessionRecord;
    await h.store.putSession({ ...rec, endReason: "silence" });
    await deleteConversation(FAMILY, sessionId, h.deps);
    expect((await h.store.getSession(sessionId))?.endReason).toBe("silence");
  });
});

describe("meVoice", () => {
  it("reports enabled and the room left under the smallest cap", async () => {
    const h = harness(cfgWith({ perUserPerDay: { family: 3, reviewer: 2 }, globalPerDay: 40 }));
    await start(h, FAMILY, "browser", "virtual");
    expect(await meVoice(FAMILY, h.deps)).toEqual({ enabled: true, maxSeconds: 180, remainingToday: 2 });
  });

  it("disables a reviewer while reviewerVoiceEnabled is off", async () => {
    const h = harness();
    const me = await meVoice(REVIEWER, h.deps);
    expect(me.enabled).toBe(false);
  });

  it("is disabled by the kill switch", async () => {
    const h = harness(cfgWith({ voiceEnabled: false }));
    expect((await meVoice(FAMILY, h.deps)).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Grant
// ---------------------------------------------------------------------------------------------

const ENCOUNTER = "c1d2e3f4-0000-4000-8000-000000000001";

function event(type: string, data: unknown, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
    ts: "2026-11-20T12:00:00.000Z",
    deviceId: DEVICE,
    encounterId: ENCOUNTER,
    type,
    data,
    ...over,
  });
}

const requested = (over: Record<string, unknown> = {}): string =>
  event("conversation.requested", { reason: "family_verdict" }, over);

describe("handleVoiceEvent: conversation.requested", () => {
  it("grants on a fresh family verdict and sends conversation.start with family_verdict", async () => {
    const h = harness();
    h.store.seedVerdict(ENCOUNTER, "family", NOW - 5000);
    const out = await handleVoiceEvent(DEVICE, requested(), h.grantDeps);
    expect(out.kind).toBe("granted");
    expect(h.bus.published).toHaveLength(1);
    const pub = h.bus.published[0];
    expect(pub.topic).toBe(`warashi/${DEVICE}/commands`);
    expect(pub.envelope.encounterId).toBe(ENCOUNTER);
    const data = pub.envelope.data as Record<string, unknown>;
    expect(data.source).toBe("family_verdict");
    expect(data.token).toMatch(TOKEN_REGEX);

    const stored = h.store.putSessionCalls[0];
    expect(stored.client).toBe("device");
    expect(stored.ownerSub).toBeNull();
    expect(stored.clientTokenHash).toBe(hashToken(data.token as string));
    expect(h.store.lockOwner(lockKey("real", DEVICE, null))).toBe(stored.sessionId);
    expect(h.store.counterValue(counterKey(DEVICE_SCOPE, DAY))).toBe(1);
    expect(h.store.counterValue(counterKey(GLOBAL_SCOPE, DAY))).toBe(1);
  });

  it("grants a verdict exactly at the window edge and drops one a millisecond older", async () => {
    const h = harness();
    h.store.seedVerdict(ENCOUNTER, "family", NOW - 60_000);
    expect((await handleVoiceEvent(DEVICE, requested(), h.grantDeps)).kind).toBe("granted");

    const h2 = harness();
    h2.store.seedVerdict(ENCOUNTER, "family", NOW - 60_001);
    expect(await handleVoiceEvent(DEVICE, requested(), h2.grantDeps)).toEqual({
      kind: "dropped",
      reason: "no_family_verdict",
    });
    expect(h2.bus.published).toHaveLength(0);
    expect(h2.store.putSessionCalls).toHaveLength(0);
    expect(counters(h2, "x")).toEqual([0, 0, 0]);
  });

  it.each([
    ["missing", null],
    ["stranger", "stranger"],
    ["uncertain", "uncertain"],
    ["no_face", "no_face"],
  ] as const)("drops a %s verdict without command or session", async (_name, verdict) => {
    const h = harness();
    if (verdict !== null) h.store.seedVerdict(ENCOUNTER, verdict, NOW - 1000);
    expect(await handleVoiceEvent(DEVICE, requested(), h.grantDeps)).toEqual({
      kind: "dropped",
      reason: "no_family_verdict",
    });
    expect(h.bus.published).toHaveLength(0);
    expect(h.store.putSessionCalls).toHaveLength(0);
  });

  it("drops when the encounter id is null or the kill switch is off", async () => {
    const h = harness();
    h.store.seedVerdict(ENCOUNTER, "family", NOW);
    expect(await handleVoiceEvent(DEVICE, requested({ encounterId: null }), h.grantDeps)).toEqual({
      kind: "dropped",
      reason: "no_encounter",
    });
    const off = harness(cfgWith({ voiceEnabled: false }));
    off.store.seedVerdict(ENCOUNTER, "family", NOW);
    expect(await handleVoiceEvent(DEVICE, requested(), off.grantDeps)).toEqual({
      kind: "dropped",
      reason: "voice_disabled",
    });
  });

  it("drops a cap refusal and a busy lock without leaving counters behind", async () => {
    const capped = harness(cfgWith({ deviceStartsPerDay: 0 }));
    capped.store.seedVerdict(ENCOUNTER, "family", NOW);
    expect(await handleVoiceEvent(DEVICE, requested(), capped.grantDeps)).toEqual({
      kind: "dropped",
      reason: "cap_reached",
    });
    expect(counters(capped, "x")).toEqual([0, 0, 0]);

    const busy = harness();
    busy.store.seedVerdict(ENCOUNTER, "family", NOW);
    expect((await handleVoiceEvent(DEVICE, requested(), busy.grantDeps)).kind).toBe("granted");
    expect(await handleVoiceEvent(DEVICE, requested(), busy.grantDeps)).toEqual({
      kind: "dropped",
      reason: "lock_busy",
    });
    expect(busy.store.counterValue(counterKey(GLOBAL_SCOPE, DAY))).toBe(1);
  });

  it("rolls back when the command publish fails", async () => {
    const h = harness();
    h.store.seedVerdict(ENCOUNTER, "family", NOW);
    h.bus.failPublishes = 1;
    expect(await handleVoiceEvent(DEVICE, requested(), h.grantDeps)).toEqual({
      kind: "dropped",
      reason: "start_failed",
    });
    expect(counters(h, "x")).toEqual([0, 0, 0]);
    expect(h.store.lockOwner(lockKey("real", DEVICE, null))).toBeNull();
  });

  it("drops malformed input and other event types", async () => {
    const h = harness();
    expect(await handleVoiceEvent(DEVICE, "not json", h.grantDeps)).toEqual({ kind: "dropped", reason: "malformed" });
    expect(await handleVoiceEvent(DEVICE, event("presence.detected", { source: "pir" }), h.grantDeps)).toEqual({
      kind: "dropped",
      reason: "wrong_type",
    });
  });

  it("drops a topic mismatch and logs ids only, never the payload (R2.5)", async () => {
    const h = harness();
    h.store.seedVerdict(ENCOUNTER, "family", NOW);
    const marker = "payloadmarker-123";
    const raw = event("conversation.ended", { sessionId: marker, reason: "user" }, { deviceId: "warashi-99" });
    const out = await handleVoiceEvent(DEVICE, raw, h.grantDeps);
    expect(out).toEqual({ kind: "dropped", reason: "topic_device_mismatch" });
    expect(h.bus.published).toHaveLength(0);
    expect(h.store.putSessionCalls).toHaveLength(0);

    expect(logLines).toHaveLength(1);
    const line = JSON.parse(logLines[0]);
    expect(line).toMatchObject({
      event: "voice_grant_dropped",
      reason: "topic_device_mismatch",
      envelopeId: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
      topicDeviceId: DEVICE,
      deviceId: "warashi-99",
    });
    expect(logLines[0]).not.toContain(marker);
    expect(Object.keys(line).sort()).toEqual(
      ["deviceId", "envelopeId", "event", "reason", "topicDeviceId"].sort(),
    );
  });
});

describe("handleVoiceEvent: conversation.ended", () => {
  async function granted(h: Harness): Promise<string> {
    h.store.seedVerdict(ENCOUNTER, "family", NOW);
    const out = await handleVoiceEvent(DEVICE, requested(), h.grantDeps);
    if (out.kind !== "granted") throw new Error("setup failed");
    return out.sessionId;
  }

  it("asks the session to end and releases the lock", async () => {
    const h = harness();
    const sessionId = await granted(h);
    const out = await handleVoiceEvent(DEVICE, event("conversation.ended", { sessionId, reason: "silence" }), h.grantDeps);
    expect(out).toEqual({ kind: "ended", sessionId });
    const rec = await h.store.getSession(sessionId);
    expect(rec?.endRequested).toBe(true);
    expect(rec?.endReason).toBe("silence");
    expect(h.store.lockOwner(lockKey("real", DEVICE, null))).toBeNull();
  });

  it("drops an unknown session and a session of another doll", async () => {
    const h = harness();
    const sessionId = await granted(h);
    const unknown = event("conversation.ended", { sessionId: "nope-1", reason: "user" });
    expect(await handleVoiceEvent(DEVICE, unknown, h.grantDeps)).toEqual({ kind: "dropped", reason: "unknown_session" });

    const other = event("conversation.ended", { sessionId, reason: "user" }, { deviceId: "warashi-02" });
    expect(await handleVoiceEvent("warashi-02", other, h.grantDeps)).toEqual({
      kind: "dropped",
      reason: "unknown_session",
    });
    expect(h.store.lockOwner(lockKey("real", DEVICE, null))).toBe(sessionId);
  });
});

// ---------------------------------------------------------------------------------------------
// Authorizer
// ---------------------------------------------------------------------------------------------

const SID = "00000000-0000-4000-8000-0000000000aa";
const CLIENT_TOKEN = `${SID}.${"c".repeat(43)}`;
const OBSERVER_TOKEN = `${SID}.${"o".repeat(43)}`;
const OTHER_SID = "00000000-0000-4000-8000-0000000000bb";

function authRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: SID,
    deviceId: DEVICE,
    client: "device",
    target: "real",
    ownerSub: "sub-family",
    role: "family",
    phase: "live",
    startedAt: NOW,
    expiresAt: NOW + 60_000,
    clientTokenHash: hashToken(CLIENT_TOKEN),
    observerTokenHash: hashToken(OBSERVER_TOKEN),
    endReason: null,
    endedAt: null,
    endRequested: false,
    ...over,
  };
}

async function auth(
  token: string | null | undefined,
  operation: string | undefined,
  channel: string | undefined,
  rec: SessionRecord | null = authRecord(),
  nowMs = NOW,
  namespace: string | undefined = "voice",
) {
  const store = new FakeVoiceStore(NOW);
  if (rec !== null) await store.putSession(rec);
  const request: AuthorizerRequest = {
    authorizationToken: token,
    requestContext: { operation, channelNamespaceName: namespace, channel },
  };
  return authorize(request, store, nowMs);
}

describe("authorize: token, operation and channel matrix", () => {
  const ch = (leaf: string, sid = SID): string => `/voice/${sid}/${leaf}`;

  const cases: Array<[string, string, string, "client" | "observer", boolean]> = [];
  for (const kind of ["client", "observer"] as const) {
    for (const leaf of ["in", "out", "text"]) {
      cases.push([kind, "EVENT_PUBLISH", leaf, kind, kind === "client" && leaf === "in"]);
      cases.push([kind, "EVENT_SUBSCRIBE", leaf, kind, kind === "client" ? leaf !== "in" : leaf === "text"]);
    }
  }

  it.each(cases)("%s token, %s on %s -> %s allowed=%s", async (_k, op, leaf, kind, allowed) => {
    const token = kind === "client" ? CLIENT_TOKEN : OBSERVER_TOKEN;
    const res = await auth(token, op, ch(leaf));
    expect(res.isAuthorized).toBe(allowed);
    expect(res.ttlOverride).toBe(allowed ? AUTH_TTL_SECONDS : 0);
  });

  it("accepts EVENT_CONNECT for either token without a channel", async () => {
    expect((await auth(CLIENT_TOKEN, "EVENT_CONNECT", undefined)).isAuthorized).toBe(true);
    expect((await auth(OBSERVER_TOKEN, "EVENT_CONNECT", undefined)).isAuthorized).toBe(true);
  });

  it("accepts a channel written without the leading slash", async () => {
    expect((await auth(CLIENT_TOKEN, "EVENT_PUBLISH", `voice/${SID}/in`)).isAuthorized).toBe(true);
  });

  it.each([
    ["wildcard session", "/voice/*/text"],
    ["wildcard leaf", `/voice/${SID}/*`],
    ["double wildcard", "/voice/**"],
    ["other session", ch("text", OTHER_SID)],
    ["unknown leaf", ch("admin")],
    ["extra segment", `/voice/${SID}/text/x`],
    ["missing leaf", `/voice/${SID}`],
    ["other namespace", `/other/${SID}/text`],
  ])("denies %s", async (_name, channel) => {
    expect((await auth(CLIENT_TOKEN, "EVENT_SUBSCRIBE", channel)).isAuthorized).toBe(false);
  });

  it("denies a wrong channel namespace name and a missing channel", async () => {
    expect((await auth(CLIENT_TOKEN, "EVENT_SUBSCRIBE", ch("text"), authRecord(), NOW, "other")).isAuthorized).toBe(false);
    expect((await auth(CLIENT_TOKEN, "EVENT_SUBSCRIBE", undefined)).isAuthorized).toBe(false);
  });

  it("denies an unknown operation", async () => {
    expect((await auth(CLIENT_TOKEN, "EVENT_DELETE", ch("in"))).isAuthorized).toBe(false);
    expect((await auth(CLIENT_TOKEN, undefined, ch("in"))).isAuthorized).toBe(false);
  });
});

describe("authorize: token validity, phase and expiry", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["no dot", "x".repeat(80)],
    ["short secret", `${SID}.abc`],
    ["bad secret chars", `${SID}.${"+".repeat(43)}`],
    ["uppercase session id", `${SID.toUpperCase()}.${"c".repeat(43)}`],
    ["trailing newline", `${CLIENT_TOKEN}\n`],
  ])("denies a malformed token: %s", async (_name, token) => {
    expect((await auth(token, "EVENT_CONNECT", undefined)).isAuthorized).toBe(false);
  });

  it("denies a wrong secret, an unknown session and a token of another session", async () => {
    expect((await auth(`${SID}.${"d".repeat(43)}`, "EVENT_CONNECT", undefined)).isAuthorized).toBe(false);
    expect((await auth(CLIENT_TOKEN, "EVENT_CONNECT", undefined, null)).isAuthorized).toBe(false);
    // Valid secret, but pointed at a record whose id differs from the token's session id.
    const foreign = `${OTHER_SID}.${"c".repeat(43)}`;
    expect((await auth(foreign, "EVENT_CONNECT", undefined)).isAuthorized).toBe(false);
  });

  it("denies the observer token when the doll session has none", async () => {
    const rec = authRecord({ observerTokenHash: null });
    expect((await auth(OBSERVER_TOKEN, "EVENT_SUBSCRIBE", `/voice/${SID}/text`, rec)).isAuthorized).toBe(false);
  });

  it.each([
    ["starting", true],
    ["live", true],
    ["ending", false],
    ["ended", false],
  ] as const)("phase %s -> allowed=%s", async (phase, allowed) => {
    const res = await auth(CLIENT_TOKEN, "EVENT_PUBLISH", `/voice/${SID}/in`, authRecord({ phase }));
    expect(res.isAuthorized).toBe(allowed);
  });

  it("denies at and after expiresAt and allows one millisecond before", async () => {
    const rec = authRecord({ expiresAt: NOW + 1000 });
    const at = (ms: number) => auth(CLIENT_TOKEN, "EVENT_CONNECT", undefined, rec, ms);
    expect((await at(NOW + 999)).isAuthorized).toBe(true);
    expect((await at(NOW + 1000)).isAuthorized).toBe(false);
    expect((await at(NOW + 5000)).isAuthorized).toBe(false);
  });

  it("propagates a store failure so the handler can fail closed", async () => {
    const store = {
      getSession: async (): Promise<SessionRecord | null> => {
        throw new Error("db down");
      },
    };
    await expect(
      authorize({ authorizationToken: CLIENT_TOKEN, requestContext: { operation: "EVENT_CONNECT" } }, store, NOW),
    ).rejects.toThrow("db down");
  });
});

// ---------------------------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------------------------

describe("logs never hold token material", () => {
  it("keeps tokens, secrets, hashes and full session ids out of every start and grant log line", async () => {
    const h = harness(cfgWith({ reviewerVoiceEnabled: true, perUserPerDay: { family: 1, reviewer: 2 } }));
    const ids: string[] = [];
    const tokens: string[] = [];

    const a = body(await start(h, FAMILY, "device", "real"));
    ids.push(a.sessionId);
    tokens.push(a.observerToken);
    await start(h, FAMILY, "browser", "real"); // lock or cap refusal
    const b = body(await start(h, REVIEWER, "browser", "virtual"));
    ids.push(b.sessionId);
    tokens.push(b.clientToken);
    h.invoker.fail = true;
    await start(h, { sub: "other", role: "family" }, "browser", "virtual"); // failed start
    h.invoker.fail = false;
    await deleteConversation(FAMILY, a.sessionId, h.deps);

    const g = harness();
    g.store.seedVerdict(ENCOUNTER, "family", NOW);
    const out = await handleVoiceEvent(DEVICE, requested(), g.grantDeps);
    if (out.kind === "granted") ids.push(out.sessionId);
    await handleVoiceEvent(DEVICE, requested(), g.grantDeps);
    if (out.kind === "granted") {
      await handleVoiceEvent(DEVICE, event("conversation.ended", { sessionId: out.sessionId, reason: "user" }), g.grantDeps);
    }

    expect(logLines.length).toBeGreaterThan(0);
    const hashes = h.store.putSessionCalls
      .concat(g.store.putSessionCalls)
      .flatMap((r) => [r.clientTokenHash, r.observerTokenHash])
      .filter((x): x is string => x !== null);
    const forbidden = [...ids, ...tokens, ...h.secrets, ...g.secrets, ...hashes];
    const all = logLines.join("\n");
    for (const secret of forbidden) {
      expect(all).not.toContain(secret);
    }
  });
});
