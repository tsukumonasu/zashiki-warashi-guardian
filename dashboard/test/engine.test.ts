import { describe, expect, it } from "vitest";
import { initialState, step } from "../src/simulation/engine";
import {
  buildFamilyHomePlan,
  buildNetworkDownPlan,
  buildNobodyTherePlan,
  buildStrangerNightPlan,
} from "../src/simulation/plans";
import type {
  Input,
  Output,
  ScenarioPlan,
  SchemaMessage,
  SimState,
  StateChanged,
} from "../src/simulation/types";

const FACE = { left: 0.4, top: 0.3, width: 0.2, height: 0.3 };
const T0 = 1_800_000_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function response(verdict: "family" | "stranger" | "no_face", face = FACE) {
  return {
    verdict,
    confidence: 0.95,
    face: verdict === "no_face" ? null : face,
    speech: null,
  };
}

interface Result {
  state: SimState;
  messages: SchemaMessage[];
  outputs: Output[];
}

/** Plays a plan like the runner does: start, tick every 50 ms, audio ends 3 s after it starts. */
function runScenario(plan: ScenarioPlan, untilMs = 60_000): Result {
  let state = initialState();
  const outputs: Output[] = [];
  const audioEnds: { at: number; playId: string }[] = [];
  const feed = (input: Input, now: number): void => {
    const r = step(state, input, now);
    state = r.state;
    for (const o of r.outputs) {
      outputs.push(o);
      if (o.kind === "audio.play") audioEnds.push({ at: now + 3000, playId: o.playId });
    }
  };
  feed({ kind: "user", action: { type: "start", plan, seed: 42 } }, T0);
  for (let t = T0 + 50; t <= T0 + untilMs; t += 50) {
    for (const end of audioEnds.filter((a) => a.at <= t)) {
      feed({ kind: "internal", event: { type: "audio.finished", playId: end.playId } }, t);
      audioEnds.splice(audioEnds.indexOf(end), 1);
    }
    feed({ kind: "tick" }, t);
    if (!state.running) break;
  }
  const messages = outputs.flatMap((o) => (o.kind === "message" ? [o.envelope] : []));
  return { state, messages, outputs };
}

const transitions = (messages: SchemaMessage[]): string[] =>
  messages
    .filter((m): m is StateChanged => m.type === "state.changed")
    .map((m) => `${m.data.from}>${m.data.to}:${m.data.reason}`);

const eventTypes = (messages: SchemaMessage[]): string[] =>
  messages.filter((m) => m.type !== "status.report").map((m) => m.type);

function expectEnvelopeRules(messages: SchemaMessage[]): void {
  const started = messages.findIndex((m) => m.type === "presence.detected");
  const ended = messages.findIndex((m) => m.type === "encounter.ended");
  const encounterId = messages[started]?.encounterId;
  expect(encounterId).toMatch(UUID);
  messages.forEach((m, i) => {
    expect(m.v).toBe(1);
    expect(m.id).toMatch(UUID);
    expect(m.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(m.deviceId).toBe("warashi-sim");
    if (m.type === "status.report") expect(m.encounterId).toBeNull();
    else if (i >= started && i <= ended) expect(m.encounterId).toBe(encounterId);
  });
  expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
}

describe("engine scenarios through step()", () => {
  it("family_home: gaze, greeting, cooldown, sleeping", () => {
    const { state, messages } = runScenario(buildFamilyHomePlan(response("family")));
    expect(transitions(messages)).toEqual([
      "sleeping>waking:presence",
      "waking>seeking:arrived",
      "seeking>gazing:verdict",
      "gazing>greeting:arrived",
      "greeting>cooldown:audio_done",
      "cooldown>sleeping:cooldown_done",
    ]);
    expect(eventTypes(messages)).toContain("snapshot.captured");
    const reaction = messages.find((m) => m.type === "reaction.performed");
    expect(reaction?.data).toMatchObject({ kind: "family", offline: false });
    expect(messages.find((m) => m.type === "encounter.ended")?.data).toEqual({ reason: "cooldown" });
    expectEnvelopeRules(messages);
    expect(state.running).toBe(false);
    expect(state.lantern).toBe(0);
    expect(state.pan).toBe(0);
    expect(state.tilt).toBe(0);
  });

  it("stranger_night: silent stare, then the stranger line", () => {
    const { messages, outputs } = runScenario(buildStrangerNightPlan(response("stranger")));
    expect(transitions(messages)).toEqual([
      "sleeping>waking:presence",
      "waking>seeking:arrived",
      "seeking>gazing:verdict",
      "gazing>warning:arrived",
      "warning>cooldown:audio_done",
      "cooldown>sleeping:cooldown_done",
    ]);
    const reaction = messages.find((m) => m.type === "reaction.performed");
    expect(reaction?.data).toMatchObject({ kind: "stranger", offline: false });
    expect(outputs.filter((o) => o.kind === "audio.play")).toHaveLength(1);
    expectEnvelopeRules(messages);
  });

  it("nobody_there: four snapshots, then uncertain with reason no_face", () => {
    const { messages } = runScenario(buildNobodyTherePlan(response("no_face")));
    expect(transitions(messages)).toEqual([
      "sleeping>waking:presence",
      "waking>seeking:arrived",
      "seeking>uncertain:no_face",
      "uncertain>cooldown:audio_done",
      "cooldown>sleeping:cooldown_done",
    ]);
    expect(messages.filter((m) => m.type === "snapshot.captured")).toHaveLength(4);
    expectEnvelopeRules(messages);
  });

  it("network_down: offline reaction with no snapshot", () => {
    const { messages } = runScenario(buildNetworkDownPlan());
    expect(transitions(messages)).toEqual([
      "sleeping>waking:presence",
      "waking>uncertain:offline",
      "uncertain>cooldown:audio_done",
      "cooldown>sleeping:cooldown_done",
    ]);
    expect(messages.some((m) => m.type === "snapshot.captured")).toBe(false);
    expect(messages.find((m) => m.type === "reaction.performed")?.data).toMatchObject({
      kind: "uncertain",
      offline: true,
    });
    expectEnvelopeRules(messages);
  });

  it("is deterministic and keeps device-internal events off the wire", () => {
    const plan = buildFamilyHomePlan(response("family"));
    const a = runScenario(plan);
    const b = runScenario(plan);
    expect(a.state).toEqual(b.state);
    expect(a.messages).toEqual(b.messages);
    const internal = ["tick", "pir.rising", "servo.arrived", "audio.finished", "snapshot.ready"];
    expect(a.messages.some((m) => internal.includes(m.type))).toBe(false);
  });
});

describe("engine inbound checks", () => {
  const running = (): SimState =>
    step(
      initialState(),
      { kind: "user", action: { type: "start", plan: buildNetworkDownPlan(), seed: 7 } },
      T0,
    ).state;

  const gaze = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    v: 1,
    id: "11111111-1111-4111-8111-111111111111",
    ts: "2026-11-20T12:00:00.000Z",
    deviceId: "warashi-sim",
    encounterId: null,
    type: "gaze",
    data: { panDeg: 5, tiltDeg: 0 },
    ...over,
  });

  function errorOnly(value: unknown, code: string): void {
    const before = running();
    const r = step(before, { kind: "command", value }, T0); // same time: only the inbound check acts
    expect(r.outputs).toHaveLength(1);
    expect(r.outputs[0]).toMatchObject({
      kind: "message",
      envelope: { type: "error.reported", data: { code } },
    });
    // Only rng and log may differ.
    expect({ ...r.state, rng: 0, log: [] }).toEqual({ ...before, rng: 0, log: [] });
    expect(r.state.log).toHaveLength(before.log.length + 1);
  }

  it("reports malformed_message once and changes nothing else", () => {
    errorOnly(gaze({ data: { panDeg: Number.NaN, tiltDeg: 0 } }), "malformed_message");
    errorOnly("not an object", "malformed_message");
  });

  it("reports unsupported_version and wrong_device", () => {
    errorOnly(gaze({ v: 2 }), "unsupported_version");
    errorOnly(gaze({ deviceId: "warashi-99" }), "wrong_device");
  });

  it("drops a repeated command id without output", () => {
    const first = step(running(), { kind: "command", value: gaze() }, T0 + 100);
    const again = step(first.state, { kind: "command", value: gaze() }, T0 + 150);
    expect(again.outputs).toEqual([]);
  });

  it("keeps only the last 256 accepted ids", () => {
    let s = running();
    for (let i = 0; i < 300; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      s = step(s, { kind: "command", value: gaze({ id }) }, T0 + 100).state;
    }
    expect(s.seenCommandIds).toHaveLength(256);
  });

  it("clamps a gaze target to the calibrated limit", () => {
    const r = step(
      running(),
      { kind: "command", value: gaze({ data: { panDeg: 1e6, tiltDeg: -1e6 } }) },
      T0 + 100,
    );
    expect(r.state.panTarget).toBe(30);
    expect(r.state.tiltTarget).toBe(-20);
  });
});

describe("engine user actions and status", () => {
  it("ignores start while a scenario is running", () => {
    const plan = buildNetworkDownPlan();
    const s = step(initialState(), { kind: "user", action: { type: "start", plan, seed: 1 } }, T0)
      .state;
    const r = step(s, { kind: "user", action: { type: "start", plan, seed: 2 } }, T0 + 10);
    expect(r.state).toBe(s);
    expect(r.outputs).toEqual([]);
  });

  it("stop acts like mode.set sleep: cooldown manual, then encounter.ended manual", () => {
    const plan = buildFamilyHomePlan(response("family"));
    let s = step(initialState(), { kind: "user", action: { type: "start", plan, seed: 3 } }, T0)
      .state;
    const msgs: SchemaMessage[] = [];
    const collect = (r: ReturnType<typeof step>): void => {
      s = r.state;
      for (const o of r.outputs) if (o.kind === "message") msgs.push(o.envelope);
    };
    collect(step(s, { kind: "tick" }, T0 + 50));
    collect(step(s, { kind: "user", action: { type: "stop" } }, T0 + 100));
    for (let t = T0 + 150; t <= T0 + 20_000 && s.running; t += 50) {
      collect(step(s, { kind: "tick" }, t));
    }
    expect(transitions(msgs)).toContain("waking>cooldown:manual");
    expect(msgs.find((m) => m.type === "encounter.ended")?.data).toEqual({ reason: "manual" });
    expect(s.running).toBe(false);
    expect(s.mode).toBe("guard");
  });

  it("emits a status.report on the first tick and then every 60 s, with uptimeSec", () => {
    const plan = buildNetworkDownPlan();
    let s = step(initialState(), { kind: "user", action: { type: "start", plan, seed: 5 } }, T0)
      .state;
    const reports = (r: ReturnType<typeof step>) =>
      r.outputs.flatMap((o) =>
        o.kind === "message" && o.envelope.type === "status.report" ? [o.envelope] : [],
      );
    const first = step(s, { kind: "tick" }, T0 + 50);
    s = first.state;
    const firstReports = reports(first);
    expect(firstReports.length).toBeGreaterThan(0);
    expect(firstReports.every((m) => m.encounterId === null)).toBe(true);
    expect(firstReports[0]?.data.uptimeSec).toBe(0);

    // Keep the scenario alive long enough: jump forward without finishing the cooldown.
    const later = step(s, { kind: "tick" }, T0 + 61_000);
    const laterReports = reports(later);
    expect(laterReports.some((m) => m.data.uptimeSec === 61)).toBe(true);
  });
});
