// The simulation reducer with conversation.* and snapshot.request (docs/schema.md, S1 to S11).
// Requirements 13.5, 13.6, 16.3.

import { describe, expect, it } from "vitest";
import catalog from "../src/simulation/data/voice-catalog.json";
import { initialState, step } from "../src/simulation/engine";
import { buildFamilyHomePlan } from "../src/simulation/plans";
import type { Input, Output, SchemaMessage, SimState } from "../src/simulation/types";

const T0 = 1_000_000;
const SESSION = "00000000-0000-4000-8000-000000000000";
const UNCERTAIN_LINE = (catalog as { id: string; category: string }[]).find(
  (l) => l.category === "uncertain",
)!.id;
const FACE = { left: 0.4, top: 0.3, width: 0.2, height: 0.3 };

let counter = 0;
function cmd(type: string, data: Record<string, unknown>): Input {
  counter += 1;
  return {
    kind: "command",
    value: {
      v: 1,
      id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
      ts: "2026-11-20T12:34:56.789Z",
      deviceId: "warashi-sim",
      encounterId: null,
      type,
      data,
    },
  };
}

const start = (source: "family_verdict" | "manual", maxSeconds = 180): Input =>
  cmd("conversation.start", { sessionId: SESSION, token: "t", maxSeconds, silenceSeconds: 20, source });

class Rig {
  state: SimState;
  now = T0;
  messages: SchemaMessage[] = [];
  outputs: Output[] = [];
  audio: string[] = [];

  constructor(enabled = true) {
    this.state = initialState({ conversationEnabled: enabled });
  }

  feed(input: Input): void {
    const r = step(this.state, input, this.now);
    this.state = r.state;
    for (const o of r.outputs) {
      this.outputs.push(o);
      if (o.kind === "message") this.messages.push(o.envelope);
      if (o.kind === "audio.play") this.audio.push(o.playId);
    }
  }

  /** Ticks every 50 ms until `done` or `ms` pass; finishes audio at once. */
  run(ms: number, done: () => boolean = () => false): void {
    for (let t = 0; t < ms && !done(); t += 50) {
      this.now += 50;
      for (const playId of this.audio.splice(0)) {
        this.feed({ kind: "internal", event: { type: "audio.finished", playId } });
      }
      this.feed({ kind: "tick" });
    }
  }

  get kind(): string {
    return this.state.phase.kind;
  }
  types(): string[] {
    return this.messages.filter((m) => m.type !== "status.report").map((m) => m.type);
  }
  changes(): string[] {
    return this.messages.flatMap((m) =>
      m.type === "state.changed" ? [`${m.data.from}>${m.data.to}:${m.data.reason}`] : [],
    );
  }
}

const planOf = (verdict: "family" | "stranger") =>
  buildFamilyHomePlan({ verdict, confidence: 0.95, face: FACE, speech: null });

/** A family encounter, paused in `greeting` right after `conversation.requested`. */
function inGreeting(enabled = true): Rig {
  const rig = new Rig(enabled);
  rig.feed({ kind: "user", action: { type: "start", plan: planOf("family"), seed: 7 } });
  // Do not feed audio.finished yet: stop as soon as greeting starts.
  for (let i = 0; i < 400 && rig.kind !== "greeting"; i++) {
    rig.now += 50;
    rig.feed({ kind: "tick" });
  }
  return rig;
}

describe("conversation in the simulation reducer", () => {
  it("asks for a session only when conversation is enabled", () => {
    expect(inGreeting(true).types()).toContain("conversation.requested");
    expect(inGreeting(false).types()).not.toContain("conversation.requested");
  });

  it("granted session starts after the greeting line and ends with conversation.end", () => {
    const rig = inGreeting();
    rig.feed(start("family_verdict"));
    expect(rig.kind).toBe("greeting");
    rig.run(10_000, () => rig.kind === "conversing");
    expect(rig.kind).toBe("conversing");
    expect(rig.changes()).toContain("greeting>conversing:conversation");
    const status = [...rig.messages].reverse().find((m) => m.type === "status.report");
    expect(status?.data).toMatchObject({ state: "conversing", micActive: true });

    rig.feed(cmd("conversation.end", { sessionId: SESSION, reason: "user" }));
    expect(rig.kind).toBe("cooldown");
    expect(rig.changes()).toContain("conversing>cooldown:conversation_done");
    const ended = rig.messages.find((m) => m.type === "conversation.ended");
    expect(ended?.data).toEqual({ sessionId: SESSION, reason: "user" });

    // A repeated end (new id) and an unknown session change nothing.
    const before = rig.messages.length;
    rig.feed(cmd("conversation.end", { sessionId: SESSION, reason: "user" }));
    expect(rig.messages).toHaveLength(before);
    rig.run(20_000, () => rig.kind === "sleeping");
    expect(rig.kind).toBe("sleeping");
    expect(rig.messages.find((m) => m.type === "encounter.ended")?.data).toEqual({
      reason: "cooldown",
    });
  });

  it("answers a look with a captured snapshot and consumes the verdict", () => {
    const rig = inGreeting();
    rig.feed(start("family_verdict"));
    rig.run(10_000, () => rig.kind === "conversing");

    rig.feed(cmd("snapshot.request", { requestId: "req-1" }));
    const captured = rig.messages.filter((m) => m.type === "snapshot.captured");
    const last = captured[captured.length - 1];
    expect(last?.type === "snapshot.captured" && last.data.requestId).toBe("req-1");

    // A second request while one is outstanding is rejected.
    rig.feed(cmd("snapshot.request", { requestId: "req-2" }));
    const err = rig.messages[rig.messages.length - 1];
    expect(err?.type === "error.reported" && err.data.code).toBe("command_rejected_state");

    rig.run(3_000); // the plan's family verdict arrives
    expect(rig.kind).toBe("conversing");
    rig.feed(cmd("snapshot.request", { requestId: "req-3" }));
    expect(rig.messages.filter((m) => m.type === "snapshot.captured")).toHaveLength(
      captured.length + 1,
    );
  });

  it("a stranger verdict for a look ends the conversation", () => {
    // A manual session needs a sleeping doll; the plan decides the verdict of the look.
    const manual = new Rig();
    manual.feed({ kind: "internal", event: { type: "cloud.connected" } });
    manual.state = { ...manual.state, plan: planOf("stranger") };
    manual.feed(start("manual"));
    expect(manual.kind).toBe("conversing");
    manual.feed(cmd("snapshot.request", { requestId: "req-1" }));
    manual.run(3_000, () => manual.kind === "cooldown");
    expect(manual.changes()).toContain("conversing>cooldown:verdict");
    const ended = manual.messages.find((m) => m.type === "conversation.ended");
    expect(ended?.data).toMatchObject({ reason: "stranger" });
  });

  it("a manual session starts from sleeping and ends with the limit", () => {
    const rig = new Rig();
    rig.feed(start("manual", 10)); // clamped to 30 s
    expect(rig.kind).toBe("conversing");
    expect(rig.changes()).toEqual(["sleeping>conversing:conversation"]);
    rig.run(29_000);
    expect(rig.kind).toBe("conversing");
    rig.run(2_000, () => rig.kind === "cooldown");
    expect(rig.changes()).toContain("conversing>cooldown:timeout");
    expect(rig.messages.find((m) => m.type === "conversation.ended")?.data).toMatchObject({
      reason: "limit",
    });
    rig.run(20_000, () => rig.kind === "sleeping");
    expect(rig.kind).toBe("sleeping");
    // No encounter, so no encounter.ended.
    expect(rig.types()).not.toContain("encounter.ended");
  });

  it("rejects snapshot.request and speak outside or inside conversing as the device does", () => {
    const rig = new Rig();
    rig.feed(cmd("snapshot.request", { requestId: "r" }));
    expect(rig.types()).toEqual(["error.reported"]);
    rig.feed(start("manual"));
    rig.feed(cmd("speak", { lineId: UNCERTAIN_LINE, audioUrl: null, ja: "a", en: "b" }));
    const err = rig.messages[rig.messages.length - 1];
    expect(err?.type === "error.reported" && err.data.code).toBe("command_rejected_state");
  });

  it("mode.set sleep ends a conversation as manual", () => {
    const rig = new Rig();
    rig.feed(start("manual"));
    rig.feed(cmd("mode.set", { mode: "sleep" }));
    expect(rig.changes()).toContain("conversing>cooldown:manual");
    expect(rig.messages.find((m) => m.type === "conversation.ended")?.data).toMatchObject({
      reason: "manual",
    });
  });
});
