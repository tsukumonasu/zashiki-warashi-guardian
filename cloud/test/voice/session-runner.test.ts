/**
 * Unit tests of `runSession` with the in-memory fakes: happy path, tools and looks, barge-in,
 * every end reason, Bedrock and stream failures, malformed frames and cleanup.
 */
import { describe, expect, it } from "vitest";
import { lockKey } from "../../lambda/_shared/voice/caps.js";
import { DEFAULT_VOICE_CONFIG } from "../../lambda/_shared/voice/config.js";
import type { VoiceConfig } from "../../lambda/_shared/voice/config.js";
import type { SessionRecord, SonicEvent } from "../../lambda/_shared/voice/ports.js";
import { runSession, type SessionPayload } from "../../lambda/voice-session/session-runner.js";
import { FakeDollBus, FakeSonic, FakeVoiceChannel } from "./fake-stream.js";
import { FakeVoiceStore } from "./voice-store-fake.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "warashi-01";

const payload: SessionPayload = {
  sessionId: SESSION_ID,
  deviceId: DEVICE_ID,
  client: "browser",
  target: "real",
  ownerSub: "owner-1",
  maxSeconds: 180,
  silenceSeconds: 15,
};

const record: SessionRecord = {
  sessionId: SESSION_ID,
  deviceId: DEVICE_ID,
  client: "browser",
  target: "real",
  ownerSub: "owner-1",
  role: "family",
  phase: "live",
  startedAt: 0,
  expiresAt: 10_000_000,
  clientTokenHash: "hash",
  observerTokenHash: null,
  endReason: null,
  endedAt: null,
  endRequested: false,
};

async function setup() {
  const store = new FakeVoiceStore(0);
  const key = lockKey(payload.target, DEVICE_ID, payload.ownerSub);
  await store.acquireLock(key, SESSION_ID, 0, 10_000_000);
  await store.putSession(record);
  return { store, key, channel: new FakeVoiceChannel(), bus: new FakeDollBus() };
}

describe("runSession", () => {
  it("happy path: ends once, releases the lock, records the session and closes the stream", async () => {
    const { store, key, channel, bus } = await setup();
    const sonic = FakeSonic.fromFixture("sonic-session-ok");
    channel.injectIn(SESSION_ID, { t: "hello", client: "browser", v: 1 });
    channel.injectIn(SESSION_ID, { t: "bye", reason: "user" });

    await runSession(payload, {
      cfg: DEFAULT_VOICE_CONFIG,
      sonic,
      channel,
      store,
      bus,
      now: () => 1_000_000,
      newId: () => crypto.randomUUID(),
      sleep: async () => {},
      tickMs: 5,
    });

    const ends = channel.frames(SESSION_ID, "text").filter((f) => f["t"] === "end");
    expect(ends).toHaveLength(1);
    expect(store.lockOwner(key)).toBeNull();
    const saved = await store.getSession(SESSION_ID);
    expect(saved?.phase).toBe("ended");
    expect(saved?.endReason).toBe(ends[0]?.["reason"]);
    expect(sonic.stream.closed).toBe(true);
    expect(channel.closed).toBe(true);
  });

  it("no client: ends with no_client without opening Sonic", async () => {
    const { store, key, channel, bus } = await setup();
    const sonic = FakeSonic.fromFixture("sonic-session-ok");
    let t = 0;

    await runSession(payload, {
      cfg: { ...DEFAULT_VOICE_CONFIG, noClientSeconds: 5 },
      sonic,
      channel,
      store,
      bus,
      // Each reading advances 1 s, so the 5 s deadline passes after a few ticks.
      now: () => (t += 1000),
      newId: () => crypto.randomUUID(),
      sleep: async () => {},
      tickMs: 5,
    });

    const ends = channel.frames(SESSION_ID, "text").filter((f) => f["t"] === "end");
    expect(ends).toEqual([{ t: "end", reason: "no_client" }]);
    expect(store.lockOwner(key, 0)).toBeNull();
    expect((await store.getSession(SESSION_ID))?.endReason).toBe("no_client");
    expect(sonic.streams).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Tools and look (task 10.3, second pass)
// ---------------------------------------------------------------------------------------------

const LOOK_TOOL_USE_ID = "tool-use-0003";
const ALL_TOOL_USE_IDS = ["tool-use-0001", "tool-use-0002", LOOK_TOOL_USE_ID];

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Runs the `sonic-session-tools` fixture on an open stream. `answerLook` decides how the look is
 * answered once the doll has been asked: `"family"` answers through the channel they would use in
 * production (a `look.result` frame for a virtual doll, the store for a real one), `null` never
 * answers, so the look times out on the fake clock. The test ends the session with `bye` after the
 * look's `toolResult` has been sent.
 */
async function runToolsSession(target: "real" | "virtual", answerLook: "family" | null) {
  const p: SessionPayload = { ...payload, target };
  const store = new FakeVoiceStore(0);
  await store.acquireLock(lockKey(target, DEVICE_ID, p.ownerSub), SESSION_ID, 0, 10_000_000);
  await store.putSession({ ...record, target });
  const channel = new FakeVoiceChannel();
  const bus = new FakeDollBus();
  const sonic = FakeSonic.fromFixture("sonic-session-tools", { endAfterScript: false });

  let clock = 1_000_000;
  let answered = false;
  const requestIdAsked = (): string | null => {
    const envelopes =
      target === "virtual"
        ? channel
            .frames(SESSION_ID, "out")
            .filter((f) => f["t"] === "command")
            .map((f) => f["envelope"] as { type: string; data: { requestId?: string } })
        : bus.published.map((x) => x.envelope as unknown as { type: string; data: { requestId?: string } });
    return envelopes.find((e) => e.type === "snapshot.request")?.data.requestId ?? null;
  };
  // The look polls through `sleep`: this is where the doll or the browser "answers" and time moves.
  const sleep = async (ms: number): Promise<void> => {
    clock += ms;
    await new Promise((resolve) => setTimeout(resolve, 1));
    const requestId = requestIdAsked();
    if (answerLook === null || answered || requestId === null) return;
    answered = true;
    if (target === "virtual") {
      channel.injectIn(SESSION_ID, { t: "look.result", requestId, verdict: answerLook });
    } else {
      store.seedLook(requestId, { verdict: answerLook, at: clock });
    }
  };

  channel.injectIn(SESSION_ID, { t: "hello", client: "browser", v: 1 });
  const done = runSession(p, {
    cfg: DEFAULT_VOICE_CONFIG,
    sonic,
    channel,
    store,
    bus,
    now: () => clock,
    newId: () => crypto.randomUUID(),
    sleep,
    tickMs: 5,
  });
  await waitFor(() => sonic.streams.length > 0, "the stream to open");
  await waitFor(() => sonic.stream.toolResultsFor(LOOK_TOOL_USE_ID).length > 0, "the look result");
  channel.injectIn(SESSION_ID, { t: "bye", reason: "user" });
  await done;
  return { sonic, channel, bus };
}

function lookWho(sonic: FakeSonic): unknown {
  const [content] = sonic.stream.toolResultsFor(LOOK_TOOL_USE_ID);
  return (JSON.parse(content ?? "{}") as { who?: string }).who;
}

describe("runSession tools and look", () => {
  it("real doll: tools go to the doll bus, the look is answered through the store", async () => {
    const { sonic, channel, bus } = await runToolsSession("real", "family");

    expect([...bus.types()].sort()).toEqual(["gaze", "lantern", "snapshot.request"]);
    expect(bus.published.every((p) => p.topic === `warashi/${DEVICE_ID}/commands` && p.qos === 1)).toBe(true);
    const gaze = bus.published.find((p) => p.envelope.type === "gaze")?.envelope.data as { panDeg: number };
    expect(gaze.panDeg).toBeLessThan(0); // "left"
    expect(channel.frames(SESSION_ID, "out").filter((f) => f["t"] === "command")).toEqual([]);
    expect(sonic.stream.unansweredToolUses()).toEqual([]);
    for (const id of ALL_TOOL_USE_IDS) expect(sonic.stream.toolResultsFor(id)).toHaveLength(1);
    expect(lookWho(sonic)).toBe("family");
  });

  it("virtual doll: tools become command frames, the look is answered by a look.result frame", async () => {
    const { sonic, channel, bus } = await runToolsSession("virtual", "family");

    expect(bus.published).toHaveLength(0);
    const commands = channel
      .frames(SESSION_ID, "out")
      .filter((f) => f["t"] === "command")
      .map((f) => (f["envelope"] as { type: string }).type);
    expect([...commands].sort()).toEqual(["gaze", "lantern", "snapshot.request"]);
    expect(sonic.stream.unansweredToolUses()).toEqual([]);
    for (const id of ALL_TOOL_USE_IDS) expect(sonic.stream.toolResultsFor(id)).toHaveLength(1);
    expect(lookWho(sonic)).toBe("family");
  });

  it.each(["real", "virtual"] as const)("%s doll: an unanswered look times out as 'unsure'", async (target) => {
    const { sonic } = await runToolsSession(target, null);

    expect(sonic.stream.unansweredToolUses()).toEqual([]);
    expect(sonic.stream.toolResultsFor(LOOK_TOOL_USE_ID)).toHaveLength(1);
    expect(lookWho(sonic)).toBe("unsure");
  });
});

// ---------------------------------------------------------------------------------------------
// End reasons, barge-in, failures and cleanup (task 10.3, third pass)
// ---------------------------------------------------------------------------------------------

interface HarnessOptions {
  payload?: Partial<SessionPayload>;
  cfg?: Partial<VoiceConfig>;
  sonic?: FakeSonic;
  /** Wait for the `live` state frame before returning. Default `true`. */
  live?: boolean;
}

/** A running session on an open, empty Sonic stream. The test drives it through the fakes. */
async function startSession(options: HarnessOptions = {}) {
  const p: SessionPayload = { ...payload, ...options.payload };
  const store = new FakeVoiceStore(0);
  const key = lockKey(p.target, DEVICE_ID, p.ownerSub);
  await store.acquireLock(key, SESSION_ID, 0, 10_000_000);
  await store.putSession({ ...record, client: p.client, target: p.target });
  const channel = new FakeVoiceChannel();
  const bus = new FakeDollBus();
  const sonic = options.sonic ?? new FakeSonic({ endAfterScript: false });
  const h = { clock: 1_000_000, nowThrowsOnce: false };

  channel.injectIn(SESSION_ID, { t: "hello", client: p.client, v: 1 });
  const done = runSession(p, {
    cfg: { ...DEFAULT_VOICE_CONFIG, recheckSeconds: 0, ...options.cfg },
    sonic,
    channel,
    store,
    bus,
    now: () => {
      if (h.nowThrowsOnce) {
        h.nowThrowsOnce = false;
        throw new Error("clock failed");
      }
      return h.clock;
    },
    newId: () => crypto.randomUUID(),
    // A real (short) wait keeps the look polling from starving the event loop.
    sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
    tickMs: 5,
  });
  if (options.live ?? true) {
    await waitFor(() => channel.frames(SESSION_ID, "text").some((f) => f["state"] === "live"), "the live state");
  }
  const ends = () => channel.frames(SESSION_ID, "text").filter((f) => f["t"] === "end");
  return { p, store, key, channel, bus, sonic, h, done, ends };
}

const assistantText = (text: string): SonicEvent => ({
  kind: "text",
  contentId: "c-assistant",
  role: "ASSISTANT",
  stage: "FINAL",
  text,
});

const audioEvent = (): SonicEvent => ({ kind: "audio", contentId: "c-audio", pcmBase64: "AAA=" });

describe("runSession barge-in", () => {
  it("publishes an interrupt frame when Sonic reports barge-in", async () => {
    const s = await startSession();
    s.sonic.stream.push(audioEvent());
    s.sonic.stream.push({ kind: "interrupted" });
    await waitFor(() => s.channel.frameTypes(SESSION_ID, "out").includes("interrupt"), "the interrupt frame");
    s.channel.injectIn(SESSION_ID, { t: "bye", reason: "user" });
    await s.done;

    expect(s.channel.frameTypes(SESSION_ID, "out")).toEqual(["audio", "interrupt"]);
    expect(s.ends()).toEqual([{ t: "end", reason: "user" }]);
  });

  it("a lost interrupt publish does not stop the session", async () => {
    const s = await startSession();
    s.channel.failPublishes = 1;
    s.sonic.stream.push({ kind: "interrupted" });
    s.sonic.stream.push(audioEvent());
    await waitFor(() => s.channel.frameTypes(SESSION_ID, "out").includes("audio"), "audio after the lost interrupt");
    s.channel.injectIn(SESSION_ID, { t: "bye", reason: "user" });
    await s.done;

    expect(s.channel.frameTypes(SESSION_ID, "out")).toEqual(["audio"]);
    expect(s.ends()).toEqual([{ t: "end", reason: "user" }]);
  });
});

describe("runSession end reasons", () => {
  it("silence: no activity for silenceSeconds", async () => {
    const s = await startSession();
    s.h.clock += 16_000;
    await s.done;
    expect(s.ends()).toEqual([{ t: "end", reason: "silence" }]);
  });

  it("limit: the session is open for maxSeconds", async () => {
    const s = await startSession({ payload: { maxSeconds: 30 } });
    s.h.clock += 31_000;
    await s.done;
    expect(s.ends()).toEqual([{ t: "end", reason: "limit" }]);
  });

  it.each(["user", "silence", "limit", "error"] as const)("client bye %s ends with that reason", async (reason) => {
    const s = await startSession();
    s.channel.injectIn(SESSION_ID, { t: "bye", reason });
    await s.done;
    expect(s.ends()).toEqual([{ t: "end", reason }]);
  });

  it("stranger: a stranger look verdict ends the session after the tool result", async () => {
    const s = await startSession({ payload: { target: "virtual" } });
    s.sonic.stream.push({ kind: "toolUse", toolUseId: "tu-look", name: "look", inputJson: "{}" });
    await waitFor(() => s.channel.frames(SESSION_ID, "out").some((f) => f["t"] === "command"), "the look command");
    const envelope = s.channel.frames(SESSION_ID, "out")[0]?.["envelope"] as { data: { requestId: string } };
    s.channel.injectIn(SESSION_ID, { t: "look.result", requestId: envelope.data.requestId, verdict: "stranger" });
    await s.done;

    expect(s.ends()).toEqual([{ t: "end", reason: "stranger" }]);
    expect(s.sonic.stream.toolResultsFor("tu-look")).toHaveLength(1);
    expect(s.sonic.stream.unansweredToolUses()).toEqual([]);
  });

  it("unsafe_output: a blocked word interrupts and ends, and is not shown as a transcript", async () => {
    const s = await startSession({ cfg: { blockedWords: ["forbidden"] } });
    s.sonic.stream.push(assistantText("これは forbidden です"));
    await s.done;

    expect(s.ends()).toEqual([{ t: "end", reason: "unsafe_output" }]);
    expect(s.channel.frameTypes(SESSION_ID, "out")).toContain("interrupt");
    expect(s.channel.frames(SESSION_ID, "text").filter((f) => f["t"] === "transcript")).toEqual([]);
  });

  it("language: repeated non-Japanese assistant turns end the session", async () => {
    const s = await startSession();
    for (let i = 0; i < 10; i += 1) s.sonic.stream.push(assistantText("Hello there my friend"));
    await s.done;
    expect(s.ends()).toEqual([{ t: "end", reason: "language" }]);
  });
});

describe("runSession failures", () => {
  it("Bedrock open failure ends with error before any audio", async () => {
    const sonic = new FakeSonic({ openError: new Error("bedrock down") });
    const s = await startSession({ sonic, live: false });
    await s.done;

    expect(s.ends()).toEqual([{ t: "end", reason: "error" }]);
    expect(sonic.streams).toHaveLength(0);
    expect(s.channel.frames(SESSION_ID, "out")).toEqual([]);
    expect(s.store.lockOwner(s.key, 0)).toBeNull();
  });

  it("a send failure ends with error and still closes the stream", async () => {
    const s = await startSession();
    s.sonic.stream.sendError = new Error("send failed");
    s.channel.injectIn(SESSION_ID, { t: "audio", seq: 0, pcm: "AAA=" });
    await s.done;

    expect(s.ends()).toEqual([{ t: "end", reason: "error" }]);
    expect(s.sonic.stream.closed).toBe(true);
  });

  it("a stream that fails partway ends with error", async () => {
    const s = await startSession();
    s.sonic.stream.push(audioEvent());
    s.sonic.stream.fail(new Error("stream broke"));
    await s.done;

    expect(s.ends()).toEqual([{ t: "end", reason: "error" }]);
    expect(s.store.lockOwner(s.key, 0)).toBeNull();
    expect(s.sonic.stream.closed).toBe(true);
  });

  it("a tool for the doll that cannot be delivered still gets a toolResult", async () => {
    const s = await startSession();
    s.bus.failPublishes = 1;
    s.sonic.stream.push({ kind: "toolUse", toolUseId: "tu-gaze", name: "turn_head", inputJson: '{"direction":"left"}' });
    await waitFor(() => s.sonic.stream.toolResultsFor("tu-gaze").length > 0, "the tool result");

    expect(s.sonic.stream.toolResultsFor("tu-gaze")[0]).toContain("doll_unavailable");
    s.channel.injectIn(SESSION_ID, { t: "bye", reason: "user" });
    await s.done;
    expect(s.sonic.stream.unansweredToolUses()).toEqual([]);
    expect(s.ends()).toEqual([{ t: "end", reason: "user" }]);
  });

  it("an unknown tool gets an error toolResult and the session goes on", async () => {
    const s = await startSession();
    s.sonic.stream.push({ kind: "toolUse", toolUseId: "tu-bad", name: "launch_rocket", inputJson: "{}" });
    await waitFor(() => s.sonic.stream.toolResultsFor("tu-bad").length > 0, "the tool result");

    expect(s.sonic.stream.toolResultsFor("tu-bad")[0]).toContain("unknown_tool");
    expect(s.bus.published).toHaveLength(0);
    s.channel.injectIn(SESSION_ID, { t: "bye", reason: "user" });
    await s.done;
    expect(s.ends()).toEqual([{ t: "end", reason: "user" }]);
  });

  it("a look in flight at session end is answered once and a late result is dropped", async () => {
    const s = await startSession({ payload: { target: "virtual" } });
    s.sonic.stream.push({ kind: "toolUse", toolUseId: "tu-look", name: "look", inputJson: "{}" });
    await waitFor(() => s.channel.frames(SESSION_ID, "out").some((f) => f["t"] === "command"), "the look command");
    const envelope = s.channel.frames(SESSION_ID, "out")[0]?.["envelope"] as { data: { requestId: string } };
    // The stranger verdict arrives after the bye, so it must not change the end reason.
    s.channel.injectIn(SESSION_ID, { t: "bye", reason: "user" });
    s.channel.injectIn(SESSION_ID, { t: "look.result", requestId: envelope.data.requestId, verdict: "stranger" });
    await s.done;

    expect(s.ends()).toEqual([{ t: "end", reason: "user" }]);
    expect(s.sonic.stream.toolResultsFor("tu-look")).toHaveLength(1);
    expect(s.sonic.stream.toolResultsFor("tu-look")[0]).toContain("session_ending");
    expect(s.sonic.stream.unansweredToolUses()).toEqual([]);
  });
});

describe("runSession frames", () => {
  it("50 malformed frames end the session with error", async () => {
    const s = await startSession();
    for (let i = 0; i < 50; i += 1) s.channel.injectMalformed(SESSION_ID);
    await s.done;
    expect(s.ends()).toEqual([{ t: "end", reason: "error" }]);
  });

  it("49 malformed frames do not end the session", async () => {
    const s = await startSession();
    for (let i = 0; i < 49; i += 1) s.channel.injectMalformed(SESSION_ID);
    s.channel.injectIn(SESSION_ID, { t: "bye", reason: "user" });
    await s.done;
    expect(s.ends()).toEqual([{ t: "end", reason: "user" }]);
  });

  it("duplicate and out-of-order audio reaches Sonic once, in sequence order", async () => {
    const s = await startSession();
    const pcm = ["AAA=", "AQA=", "AgA="];
    const frames = pcm.map((p, seq) => ({ t: "audio", seq, pcm: p }));
    s.channel.injectInOrder(SESSION_ID, frames, [0, 2, 1, 1, 0]);
    const audioSent = () =>
      s.sonic.stream.sent
        .map((e) => (JSON.parse(e) as { event: { audioInput?: { content: string } } }).event.audioInput?.content)
        .filter((c): c is string => c !== undefined && c !== "AAABAAIAAwA=");
    await waitFor(() => audioSent().length >= 3, "three audio chunks");
    s.channel.injectIn(SESSION_ID, { t: "bye", reason: "user" });
    await s.done;

    expect(audioSent()).toEqual(pcm);
  });
});

describe("runSession hello (docs/schema.md, S21)", () => {
  it("treats the first audio frame as hello when the hello was lost, then streams later audio", async () => {
    const { store, channel, bus } = await setup();
    const sonic = new FakeSonic({ endAfterScript: false });
    // No hello: it was published before the session subscribed. The client streams audio anyway.
    channel.injectIn(SESSION_ID, { t: "audio", seq: 0, pcm: "AAA=" });
    const done = runSession(payload, {
      cfg: { ...DEFAULT_VOICE_CONFIG, recheckSeconds: 0 },
      sonic,
      channel,
      store,
      bus,
      now: () => 1_000_000,
      newId: () => crypto.randomUUID(),
      sleep: async () => {},
      tickMs: 5,
    });
    await waitFor(() => sonic.openedModelIds.length === 1, "the Sonic stream to open");
    await waitFor(
      () => channel.frames(SESSION_ID, "text").some((f) => f["t"] === "state" && f["state"] === "live"),
      "the live state",
    );
    channel.injectIn(SESSION_ID, { t: "audio", seq: 1, pcm: "AQA=" });
    const audioSent = () =>
      sonic.streams[0]!.sent
        .map((e) => (JSON.parse(e) as { event: { audioInput?: { content: string } } }).event.audioInput?.content)
        .filter((c): c is string => c !== undefined);
    await waitFor(() => audioSent().includes("AQA="), "the second audio chunk");
    channel.injectIn(SESSION_ID, { t: "bye", reason: "user" });
    await done;

    // The frame that stood in for hello is dropped: the stream was not open when it arrived.
    expect(audioSent()).not.toContain("AAA=");
    const ends = channel.frames(SESSION_ID, "text").filter((f) => f["t"] === "end");
    expect(ends).toEqual([{ t: "end", reason: "user" }]);
  });
});

describe("runSession doll notification and cleanup", () => {
  it("client device: conversation.end reaches the doll bus", async () => {
    const s = await startSession({ payload: { client: "device", target: "real", ownerSub: null } });
    s.channel.injectIn(SESSION_ID, { t: "bye", reason: "user" });
    await s.done;

    const ended = s.bus.published.filter((x) => x.envelope.type === "conversation.end");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.envelope.data).toEqual({ sessionId: SESSION_ID, reason: "user" });
    expect(ended[0]?.topic).toBe(`warashi/${DEVICE_ID}/commands`);
  });

  it("an exception in the loop still ends once with error and cleans up", async () => {
    const s = await startSession();
    s.h.nowThrowsOnce = true;
    await s.done;

    expect(s.ends()).toEqual([{ t: "end", reason: "error" }]);
    expect(s.store.lockOwner(s.key, 0)).toBeNull();
    expect((await s.store.getSession(SESSION_ID))?.phase).toBe("ended");
    expect(s.sonic.stream.closed).toBe(true);
    expect(s.channel.closed).toBe(true);
  });

  it("a failing lock release does not stop the session record from being written", async () => {
    const s = await startSession();
    s.store.releaseLock = async () => {
      throw new Error("dynamo down");
    };
    s.channel.injectIn(SESSION_ID, { t: "bye", reason: "user" });
    await s.done;

    expect(s.ends()).toEqual([{ t: "end", reason: "user" }]);
    expect((await s.store.getSession(SESSION_ID))?.endReason).toBe("user");
    expect(s.channel.closed).toBe(true);
  });
});
