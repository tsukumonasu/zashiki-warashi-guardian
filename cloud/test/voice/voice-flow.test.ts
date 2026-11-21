/**
 * Voice flow tests (task 20.1, hardware-free part): the pure cores wired together with the
 * in-memory fakes, from start through the session to the end.
 *
 * `voice-start` and `voice-grant` write to one `FakeVoiceStore` and hand the session payload to a
 * recording invoker; the test then runs `runSession` with that payload on the same store, a
 * `FakeSonic`, a `FakeVoiceChannel` and a `FakeDollBus`. No AWS, no network, no real clock waits
 * beyond a few milliseconds.
 */
import { describe, expect, it } from "vitest";

import { lockKey } from "../../lambda/_shared/voice/caps.js";
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "../../lambda/_shared/voice/config.js";
import { hashToken } from "../../lambda/voice-authorizer/authorizer-core.js";
import { handleVoiceEvent, type GrantDeps } from "../../lambda/voice-grant/voice-grant-core.js";
import { runSession, type SessionPayload } from "../../lambda/voice-session/session-runner.js";
import {
  deleteConversation,
  getConversation,
  startConversation,
  type Caller,
  type StartDeps,
} from "../../lambda/voice-start/voice-start-core.js";
import { FakeDollBus, FakeSonic, FakeVoiceChannel } from "./fake-stream.js";
import { MemoryHealth, RecordingInvoker } from "./handler-harness.js";
import { FakeVoiceStore } from "./voice-store-fake.js";

const DEVICE = "warashi-01";
const ENCOUNTER = "c1d2e3f4-0000-4000-8000-000000000001";
const FAMILY: Caller = { sub: "sub-family", role: "family" };
const CFG: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, voiceEnabled: true, recheckSeconds: 0 };
const TOKEN_RE = /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;

let counter = 0;
const newId = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const newSecret = (): string => "A".repeat(43);

function world() {
  const store = new FakeVoiceStore(Date.now());
  const bus = new FakeDollBus();
  const invoker = new RecordingInvoker();
  const channel = new FakeVoiceChannel();
  const health = new MemoryHealth();
  const start: StartDeps = {
    store,
    bus,
    invoker,
    health,
    cfg: CFG,
    readCounter: async () => 0,
    deviceOnline: async () => true,
    hosts: { http: "http.example.invalid", realtime: "rt.example.invalid" },
    now: () => Date.now(),
    newId,
    newSecret,
  };
  const grant: GrantDeps = { store, bus, invoker, cfg: CFG, now: () => Date.now(), newId, newSecret, hashToken };
  return { store, bus, invoker, channel, health, start, grant };
}
type World = ReturnType<typeof world>;

/** Runs the session the cores asked for, on the same fakes, until the test ends it. */
function launch(w: World, sonic: FakeSonic): { done: Promise<void>; payload: SessionPayload } {
  const payload = w.invoker.payloads.at(-1) as SessionPayload;
  const done = runSession(payload, {
    cfg: CFG,
    sonic,
    channel: w.channel,
    store: w.store,
    bus: w.bus,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    sleep: () => new Promise((r) => setTimeout(r, 2)),
    tickMs: 5,
  });
  return { done, payload };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const ends = (w: World, sid: string) => w.channel.frames(sid, "text").filter((f) => f["t"] === "end");

function eventJson(
  type: "conversation.requested" | "conversation.ended",
  data: object,
  encounterId: string | null,
  deviceId = DEVICE,
): string {
  return JSON.stringify({ v: 1, id: newId(), ts: new Date().toISOString(), deviceId, encounterId, type, data });
}

describe("browser start -> session -> end", () => {
  it("runs a virtual session end to end and leaves nothing behind", async () => {
    const w = world();
    const res = await startConversation(FAMILY, { deviceId: DEVICE, client: "browser", target: "virtual" }, w.start);
    expect(res.status).toBe(201);
    const body = res.body as { sessionId: string; clientToken: string };
    expect(body.clientToken).toMatch(TOKEN_RE);
    expect(w.invoker.payloads).toHaveLength(1);

    const sonic = FakeSonic.fromFixture("sonic-session-ok", { endAfterScript: false });
    w.channel.injectIn(body.sessionId, { t: "hello", client: "browser", v: 1 });
    const { done } = launch(w, sonic);
    await waitFor(() => w.channel.frames(body.sessionId, "text").some((f) => f["state"] === "live"), "live");
    w.channel.injectIn(body.sessionId, { t: "bye", reason: "user" });
    await done;

    expect(ends(w, body.sessionId)).toEqual([{ t: "end", reason: "user" }]);
    expect(w.store.lockOwner(lockKey("virtual", DEVICE, FAMILY.sub))).toBeNull();
    expect(w.bus.published).toHaveLength(0); // a virtual doll never reaches the real one
    const got = await getConversation(FAMILY, body.sessionId, w.start);
    expect(got.body).toEqual({ sessionId: body.sessionId, phase: "ended", endReason: "user" });
    // The lock is free again, so the next start works.
    const again = await startConversation(FAMILY, { deviceId: DEVICE, client: "browser", target: "virtual" }, w.start);
    expect(again.status).toBe(201);
  });

  it("refuses a second start while the first session holds the lock, and DELETE frees it", async () => {
    const w = world();
    const first = await startConversation(FAMILY, { deviceId: DEVICE, client: "browser", target: "virtual" }, w.start);
    const sid = (first.body as { sessionId: string }).sessionId;
    const busy = await startConversation(FAMILY, { deviceId: DEVICE, client: "browser", target: "virtual" }, w.start);
    expect(busy.status).toBe(409);
    expect(w.invoker.payloads).toHaveLength(1);

    expect((await deleteConversation(FAMILY, sid, w.start)).status).toBe(204);
    const next = await startConversation(FAMILY, { deviceId: DEVICE, client: "browser", target: "virtual" }, w.start);
    expect(next.status).toBe(201);
  });
});

describe("doll-side grant path", () => {
  it("grants after a fresh family verdict, runs the session and ends on the doll's bye", async () => {
    const w = world();
    w.store.seedVerdict(ENCOUNTER, "family", Date.now() - 1000);
    const out = await handleVoiceEvent(DEVICE, eventJson("conversation.requested", { reason: "family_verdict" }, ENCOUNTER), w.grant);
    expect(out.kind).toBe("granted");
    const sid = (out as { sessionId: string }).sessionId;

    // The doll gets its token on its own topic only.
    const start = w.bus.published.find((p) => p.envelope.type === "conversation.start");
    expect(start?.topic).toBe(`warashi/${DEVICE}/commands`);
    const data = start?.envelope.data as { token: string; source: string; sessionId: string };
    expect(data.source).toBe("family_verdict");
    expect(data.token).toMatch(TOKEN_RE);
    const record = await w.store.getSession(sid);
    expect(record?.clientTokenHash).toBe(hashToken(data.token));

    w.channel.injectIn(sid, { t: "hello", client: "device", v: 1 });
    const { done } = launch(w, FakeSonic.fromFixture("sonic-session-ok", { endAfterScript: false }));
    await waitFor(() => w.channel.frames(sid, "text").some((f) => f["state"] === "live"), "live");
    w.channel.injectIn(sid, { t: "bye", reason: "silence" });
    await done;

    expect(ends(w, sid)).toEqual([{ t: "end", reason: "silence" }]);
    expect(w.bus.types()).toEqual(["conversation.start", "conversation.end"]);
    expect(w.store.lockOwner(lockKey("real", DEVICE, null))).toBeNull();

    // The doll's own conversation.ended arrives afterwards: harmless and idempotent.
    const late = await handleVoiceEvent(DEVICE, eventJson("conversation.ended", { sessionId: sid, reason: "silence" }, ENCOUNTER), w.grant);
    expect(late).toEqual({ kind: "ended", sessionId: sid });
    expect((await w.store.getSession(sid))?.phase).toBe("ended");
  });

  it.each([
    ["no stored verdict", null],
    ["a stranger verdict", "stranger" as const],
  ])("starts nothing with %s", async (_name, verdict) => {
    const w = world();
    if (verdict !== null) w.store.seedVerdict(ENCOUNTER, verdict, Date.now());
    const out = await handleVoiceEvent(DEVICE, eventJson("conversation.requested", { reason: "family_verdict" }, ENCOUNTER), w.grant);
    expect(out).toEqual({ kind: "dropped", reason: "no_family_verdict" });
    expect(w.invoker.payloads).toHaveLength(0);
    expect(w.bus.published).toHaveLength(0);
  });
});

describe("stranger look ends the session", () => {
  it("a stranger snapshot verdict ends a doll session with reason stranger", async () => {
    const w = world();
    w.store.seedVerdict(ENCOUNTER, "family", Date.now());
    const out = await handleVoiceEvent(DEVICE, eventJson("conversation.requested", { reason: "family_verdict" }, ENCOUNTER), w.grant);
    const sid = (out as { sessionId: string }).sessionId;

    const sonic = new FakeSonic({ endAfterScript: false });
    w.channel.injectIn(sid, { t: "hello", client: "device", v: 1 });
    const { done } = launch(w, sonic);
    await waitFor(() => w.channel.frames(sid, "text").some((f) => f["state"] === "live"), "live");

    sonic.stream.push({ kind: "toolUse", toolUseId: "tu-look", name: "look", inputJson: "{}" });
    await waitFor(() => w.bus.types().includes("snapshot.request"), "the snapshot request");
    const request = w.bus.published.find((p) => p.envelope.type === "snapshot.request");
    const requestId = (request?.envelope.data as { requestId: string }).requestId;
    // The doll's snapshot goes through the judge Lambda, which stores the look.
    w.store.seedLook(requestId, { verdict: "stranger", at: Date.now() });
    await done;

    expect(ends(w, sid)).toEqual([{ t: "end", reason: "stranger" }]);
    expect(sonic.stream.unansweredToolUses()).toEqual([]);
    expect(w.bus.types()).toContain("conversation.end");
    expect(w.store.lockOwner(lockKey("real", DEVICE, null))).toBeNull();
  });
});

describe("the doll ends the session", () => {
  it("conversation.ended frees the lock at once and the session still closes cleanly", async () => {
    const w = world();
    w.store.seedVerdict(ENCOUNTER, "family", Date.now());
    const out = await handleVoiceEvent(DEVICE, eventJson("conversation.requested", { reason: "family_verdict" }, ENCOUNTER), w.grant);
    const sid = (out as { sessionId: string }).sessionId;
    w.channel.injectIn(sid, { t: "hello", client: "device", v: 1 });
    const sonic = FakeSonic.fromFixture("sonic-session-ok", { endAfterScript: false });
    const { done } = launch(w, sonic);
    await waitFor(() => w.channel.frames(sid, "text").some((f) => f["state"] === "live"), "live");

    const ended = await handleVoiceEvent(DEVICE, eventJson("conversation.ended", { sessionId: sid, reason: "user" }, ENCOUNTER), w.grant);
    expect(ended.kind).toBe("ended");
    expect(w.store.lockOwner(lockKey("real", DEVICE, null))).toBeNull();
    expect((await w.store.getSession(sid))?.endRequested).toBe(true);

    // The doll's audio client then says goodbye on the channel, as it does after leaving.
    w.channel.injectIn(sid, { t: "bye", reason: "user" });
    await done;
    expect(ends(w, sid)).toHaveLength(1);
    expect(sonic.stream.closed).toBe(true);
    expect((await w.store.getSession(sid))?.phase).toBe("ended");
  });

  it("ignores a conversation.ended from another doll", async () => {
    const w = world();
    w.store.seedVerdict(ENCOUNTER, "family", Date.now());
    const out = await handleVoiceEvent(DEVICE, eventJson("conversation.requested", { reason: "family_verdict" }, ENCOUNTER), w.grant);
    const sid = (out as { sessionId: string }).sessionId;
    const foreign = eventJson("conversation.ended", { sessionId: sid, reason: "user" }, null, "warashi-02");
    const res = await handleVoiceEvent("warashi-02", foreign, w.grant);
    expect(res).toEqual({ kind: "dropped", reason: "unknown_session" });
    expect(w.store.lockOwner(lockKey("real", DEVICE, null))).toBe(sid);
  });
});
