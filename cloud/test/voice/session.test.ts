import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "../../lambda/_shared/voice/config.js";
import {
  CLEANUP_GRACE_MS,
  initialSession,
  stepSession,
  type EndReason,
  type SessionEvent,
  type SessionState,
} from "../../lambda/_shared/voice/session.js";

const cfg: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, blockedWords: ["forbidden"] };
const FINISH_TYPES = ["publishEnd", "notifyDevice", "releaseLock", "recordSession"];

function step(s: SessionState, e: SessionEvent, now: number, c: VoiceConfig = cfg) {
  return stepSession(s, e, now, c);
}

/** A session in `live`, opened at 1000 ms. */
function live(c: VoiceConfig = cfg): SessionState {
  let s = initialSession(0);
  s = step(s, { t: "hello" }, 500, c).state;
  return step(s, { t: "streamOpened" }, 1000, c).state;
}

function ending(reason: EndReason = "user"): SessionState {
  return step(live(), { t: "endRequest", reason }, 2000).state;
}

describe("stepSession: starting to live", () => {
  it("opens the stream on the first hello only", () => {
    const first = step(initialSession(0), { t: "hello" }, 100);
    expect(first.effects).toEqual([{ type: "openStream" }]);
    expect(step(first.state, { t: "hello" }, 200).effects).toEqual([]);
  });

  it("enters live on streamOpened and publishes the state", () => {
    const r = step(step(initialSession(0), { t: "hello" }, 100).state, { t: "streamOpened" }, 300);
    expect(r.state.phase).toBe("live");
    expect(r.state.openedAtMs).toBe(300);
    expect(r.effects).toEqual([{ type: "publishState", state: "live" }]);
  });
});

describe("stepSession: end reasons", () => {
  const reasons: EndReason[] = ["user", "manual", "stranger", "offline", "error", "silence", "limit", "language"];

  it.each(reasons)("endRequest(%s) from starting enters ending with that reason", (reason) => {
    const r = step(initialSession(0), { t: "endRequest", reason }, 50);
    expect(r.state.phase).toBe("ending");
    expect(r.state.endReason).toBe(reason);
    expect(r.effects).toEqual([{ type: "publishState", state: "ending" }, { type: "closeStream" }]);
  });

  it.each(reasons)("endRequest(%s) from live enters ending with that reason", (reason) => {
    const r = step(live(), { t: "endRequest", reason }, 2000);
    expect(r.state.phase).toBe("ending");
    expect(r.state.endReason).toBe(reason);
    expect(r.state.endingSinceMs).toBe(2000);
  });

  it("a second end request keeps the first reason and emits nothing", () => {
    const s = ending("user");
    const r = step(s, { t: "endRequest", reason: "manual" }, 2100);
    expect(r.state).toBe(s);
    expect(r.state.endReason).toBe("user");
    expect(r.effects).toEqual([]);
  });

  it("no_client when no hello arrives within noClientSeconds", () => {
    const s = initialSession(0);
    expect(step(s, { t: "tick" }, cfg.noClientSeconds * 1000 - 1).state.phase).toBe("starting");
    const r = step(s, { t: "tick" }, cfg.noClientSeconds * 1000);
    expect(r.state.phase).toBe("ending");
    expect(r.state.endReason).toBe("no_client");
  });

  it("error when hello was seen but the stream never opened in time", () => {
    const s = step(initialSession(0), { t: "hello" }, 100).state;
    const r = step(s, { t: "tick" }, cfg.noClientSeconds * 1000);
    expect(r.state.endReason).toBe("error");
  });

  it("limit when maxSeconds pass after the stream opened", () => {
    const c = { ...cfg, silenceSeconds: 100_000 }; // keep silence out of the way
    const s = live(c);
    expect(step(s, { t: "tick" }, 1000 + c.maxSeconds * 1000 - 1, c).state.phase).toBe("live");
    expect(step(s, { t: "tick" }, 1000 + c.maxSeconds * 1000, c).state.endReason).toBe("limit");
  });

  it("silence after silenceSeconds without activity; activity resets the timer", () => {
    const s = live();
    const bumped = step(s, { t: "activity" }, 10_000).state;
    expect(step(bumped, { t: "tick" }, 10_000 + cfg.silenceSeconds * 1000 - 1).state.phase).toBe("live");
    expect(step(bumped, { t: "tick" }, 10_000 + cfg.silenceSeconds * 1000).state.endReason).toBe("silence");
  });

  it("a stranger verdict in live ends with stranger", () => {
    const r = step(live(), { t: "verdict", verdict: "stranger", silent: true }, 3000);
    expect(r.state.endReason).toBe("stranger");
    expect(r.state.phase).toBe("ending");
  });

  it.each(["family", "no_face", "uncertain"] as const)("a %s verdict in live changes nothing", (verdict) => {
    const s = live();
    const r = step(s, { t: "verdict", verdict, silent: false }, 3000);
    expect(r.state).toBe(s);
    expect(r.effects).toEqual([]);
  });

  it("unsafe assistant text interrupts audio and ends with unsafe_output", () => {
    const r = step(live(), { t: "assistantText", text: "this is FORBIDDEN text" }, 3000);
    expect(r.state.endReason).toBe("unsafe_output");
    expect(r.effects[0]).toEqual({ type: "interruptAudio" });
    expect(r.effects).toContainEqual({ type: "closeStream" });
  });

  it("two non-Japanese turns end with language; a Japanese turn first prevents it", () => {
    let s = live();
    s = step(s, { t: "assistantText", text: "Hello there friend" }, 2000).state;
    expect(s.phase).toBe("live");
    const r = step(s, { t: "assistantText", text: "How are you today" }, 3000);
    expect(r.state.endReason).toBe("language");

    let ok = live();
    ok = step(ok, { t: "assistantText", text: "こんにちは、おかえりなさい" }, 2000).state;
    ok = step(ok, { t: "assistantText", text: "Hello there friend" }, 3000).state;
    ok = step(ok, { t: "assistantText", text: "How are you today" }, 4000).state;
    expect(ok.phase).toBe("live");
  });

  it("assistant text outside live is ignored", () => {
    const s = initialSession(0);
    expect(step(s, { t: "assistantText", text: "forbidden" }, 10).state).toBe(s);
  });
});

describe("stepSession: ending and the grace deadline", () => {
  it("stays in ending before the grace deadline and finishes at it", () => {
    const s = ending("user"); // endingSince 2000
    expect(step(s, { t: "tick" }, 2000 + CLEANUP_GRACE_MS - 1).state.phase).toBe("ending");
    const r = step(s, { t: "tick" }, 2000 + CLEANUP_GRACE_MS);
    expect(r.state.phase).toBe("ended");
    expect(r.state.endReason).toBe("user");
    expect(r.effects.map((e) => e.type)).toEqual(FINISH_TYPES);
  });

  it("finish effects carry the end reason", () => {
    const r = step(ending("stranger"), { t: "streamClosed", ok: true }, 2500);
    for (const e of r.effects) {
      if (e.type !== "releaseLock") expect(e).toHaveProperty("reason", "stranger");
    }
  });
});

describe("stepSession: streamClosed", () => {
  it("in starting ends with error", () => {
    const r = step(initialSession(0), { t: "streamClosed", ok: false }, 100);
    expect(r.state.phase).toBe("ending");
    expect(r.state.endReason).toBe("error");
  });

  it("in live ends with error", () => {
    const r = step(live(), { t: "streamClosed", ok: true }, 2000);
    expect(r.state.phase).toBe("ending");
    expect(r.state.endReason).toBe("error");
  });

  it("in ending finishes at once and keeps the reason", () => {
    const r = step(ending("silence"), { t: "streamClosed", ok: true }, 2100);
    expect(r.state.phase).toBe("ended");
    expect(r.state.endReason).toBe("silence");
    expect(r.effects.map((e) => e.type)).toEqual(FINISH_TYPES);
  });
});

describe("stepSession: ended absorbs everything", () => {
  it("returns the same state and no effects for every event", () => {
    const ended = step(ending("user"), { t: "streamClosed", ok: true }, 2100).state;
    const events: SessionEvent[] = [
      { t: "tick" },
      { t: "hello" },
      { t: "streamOpened" },
      { t: "activity" },
      { t: "assistantText", text: "forbidden" },
      { t: "toolUse", id: "a", name: "look" },
      { t: "toolDone", id: "a" },
      { t: "verdict", verdict: "stranger", silent: false },
      { t: "endRequest", reason: "error" },
      { t: "streamClosed", ok: false },
    ];
    for (const e of events) {
      const r = step(ended, e, 99_999);
      expect(r.state).toBe(ended);
      expect(r.effects).toEqual([]);
    }
  });
});

describe("stepSession: verdicts in ending", () => {
  it("a late stranger verdict is discarded and keeps the reason", () => {
    const s = ending("user");
    const r = step(s, { t: "verdict", verdict: "stranger", silent: false }, 2200);
    expect(r.state).toBe(s);
    expect(r.state.endReason).toBe("user");
    expect(r.effects).toEqual([]);
  });
});

describe("stepSession: tools and the silent re-check", () => {
  it("counts tool calls, looks and gaze commands", () => {
    let s = live();
    s = step(s, { t: "toolUse", id: "1", name: "look" }, 2000).state;
    s = step(s, { t: "toolUse", id: "2", name: "turn_head" }, 2500).state;
    expect(s).toMatchObject({ toolCalls: 2, looks: 1, gazeCommands: 1, lastGazeAtMs: 2500 });
    expect(s.pendingTools).toEqual(["1", "2"]);
    s = step(s, { t: "toolDone", id: "1" }, 3000).state;
    expect(s.pendingTools).toEqual(["2"]);
  });

  it("the re-check requests a snapshot without touching looks or toolCalls", () => {
    const c = { ...cfg, silenceSeconds: 60, recheckSeconds: 10 };
    let s = live(c); // opened at 1000, first re-check due at 11000
    expect(step(s, { t: "tick" }, 10_999, c).effects).toEqual([]);
    const r = step(s, { t: "tick" }, 11_000, c);
    expect(r.effects).toEqual([{ type: "requestRecheck" }]);
    expect(r.state.looks).toBe(0);
    expect(r.state.toolCalls).toBe(0);
    expect(r.state.nextRecheckAtMs).toBe(21_000);
    // A silent verdict that is not a stranger changes no counter either.
    s = step(r.state, { t: "verdict", verdict: "family", silent: true }, 11_100, c).state;
    expect(s.looks).toBe(0);
    expect(s.toolCalls).toBe(0);
  });

  it("a silent stranger verdict ends the session with stranger", () => {
    const r = step(live(), { t: "verdict", verdict: "stranger", silent: true }, 5000);
    expect(r.state.endReason).toBe("stranger");
    expect(r.state.looks).toBe(0);
  });

  it("recheckSeconds 0 turns the re-check off", () => {
    const c = { ...cfg, silenceSeconds: 60, recheckSeconds: 0 };
    const s = live(c);
    expect(s.nextRecheckAtMs).toBeNull();
    expect(step(s, { t: "tick" }, 30_000, c).effects).toEqual([]);
  });
});
