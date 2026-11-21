import { describe, expect, it } from "vitest";
import catalog from "../src/simulation/data/voice-catalog.json";
import { validateConfig } from "../src/simulation/config";
import { handle, type MachineEvent } from "../src/simulation/machine";
import {
  buildFamilyHomePlan,
  buildNetworkDownPlan,
  buildNobodyTherePlan,
  buildStrangerNightPlan,
} from "../src/simulation/plans";
import type { Output, ScenarioPlan, SchemaMessage, SimState, Speak } from "../src/simulation/types";
import { schedule, stepMotion, takeDue, updateLantern } from "../src/simulation/world";

const FACE = { left: 0.4, top: 0.3, width: 0.2, height: 0.3 };
const LINES = catalog as { id: string; category: string }[];
const lineOf = (category: string): string => LINES.find((l) => l.category === category)!.id;

function initial(plan: ScenarioPlan): SimState {
  return {
    config: validateConfig(),
    phase: { kind: "sleeping" },
    deviceState: "sleeping",
    mode: "guard",
    pan: 0,
    tilt: 0,
    panTarget: 0,
    tiltTarget: 0,
    motion: { id: null, lastStepAt: -1_000_000 },
    lantern: 0,
    lanternTarget: null,
    eye: "closed",
    subtitle: null,
    verdict: null,
    encounter: null,
    cloudConnected: plan.cloud === "up",
    audio: [],
    plan,
    pending: [],
    seenCommandIds: [],
    rng: 1234,
    log: [],
    running: true,
  };
}

interface Run {
  state: SimState;
  outputs: { at: number; output: Output }[];
  messages: SchemaMessage[];
}

/** A tiny stand-in for engine.ts: world models, ticks every 50 ms, audio ends after 3 s. */
function drive(
  plan: ScenarioPlan,
  opts: { until?: number; onTime?: (t: number, s: SimState) => MachineEvent | null } = {},
): Run {
  let state = initial(plan);
  const outputs: Run["outputs"] = [];
  const apply = (event: MachineEvent, now: number): void => {
    const r = handle(state, event, now);
    state = r.state;
    for (const output of r.outputs) {
      outputs.push({ at: now, output });
      if (output.kind === "audio.play") {
        state = schedule(state, now + 3000, {
          kind: "internal",
          event: { type: "audio.finished", playId: output.playId },
        });
      }
    }
  };
  apply({ kind: "internal", event: { type: "pir.rising" } }, 0);
  for (let t = 50; t <= (opts.until ?? 60_000); t += 50) {
    const injected = opts.onTime?.(t, state);
    if (injected) apply(injected, t);
    const due = takeDue(state, t);
    state = due.state;
    for (const input of due.due) {
      if (input.kind === "internal") apply({ kind: "internal", event: input.event }, t);
      if (input.kind === "command") {
        apply({ kind: "command", message: input.value as SchemaMessage }, t);
      }
    }
    state = updateLantern(state, t);
    const moved = stepMotion(state, t);
    state = moved.state;
    if (moved.arrivedMotionId !== null) {
      apply({ kind: "internal", event: { type: "servo.arrived", motionId: moved.arrivedMotionId } }, t);
    }
    apply({ kind: "tick" }, t);
    if (state.phase.kind === "sleeping") break;
  }
  const messages = outputs.flatMap((o) => (o.output.kind === "message" ? [o.output.envelope] : []));
  return { state, outputs, messages };
}

const changes = (run: Run): string[] =>
  run.messages.flatMap((m) =>
    m.type === "state.changed" ? [`${m.data.from}>${m.data.to}:${m.data.reason}`] : [],
  );

const response = (verdict: "family" | "stranger" | "no_face", confidence = 0.95) => ({
  verdict,
  confidence,
  face: verdict === "no_face" ? null : FACE,
  speech: null,
});

describe("machine scenarios", () => {
  it("family_home: gaze, greet, cooldown, sleep", () => {
    const run = drive(buildFamilyHomePlan(response("family")));
    expect(changes(run)).toEqual([
      "sleeping>waking:presence",
      "waking>seeking:arrived",
      "seeking>gazing:verdict",
      "gazing>greeting:arrived",
      "greeting>cooldown:audio_done",
      "cooldown>sleeping:cooldown_done",
    ]);
    const reactions = run.messages.filter((m) => m.type === "reaction.performed");
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.data).toMatchObject({ kind: "family", offline: false });
    expect(run.messages.find((m) => m.type === "encounter.ended")?.data).toEqual({
      reason: "cooldown",
    });
    expect(run.state.running).toBe(false);
    expect(run.state.lantern).toBe(0);
  });

  it("stranger_night: no audio during the silent stare", () => {
    const run = drive(buildStrangerNightPlan(response("stranger")));
    expect(changes(run)).toContain("gazing>warning:arrived");
    const warnedAt = run.outputs.find(
      (o) => o.output.kind === "message" && o.output.envelope.type === "state.changed" &&
        o.output.envelope.data.to === "warning",
    )!.at;
    const playedAt = run.outputs.find((o) => o.output.kind === "audio.play")!.at;
    expect(playedAt - warnedAt).toBeGreaterThanOrEqual(2000);
    expect(run.state.verdict).toBe("stranger");
  });

  it("nobody_there: four snapshots, scans at -15, 15, 0, then uncertain/no_face", () => {
    const run = drive(buildNobodyTherePlan(response("no_face")));
    const snaps = run.messages.flatMap((m) => (m.type === "snapshot.captured" ? [m.data.panDeg] : []));
    expect(snaps).toEqual([0, -15, 15, 0]);
    expect(changes(run)).toContain("seeking>uncertain:no_face");
    expect(run.state.verdict).toBe("no_face");
  });

  it("network_down: offline reaction without a snapshot", () => {
    const run = drive(buildNetworkDownPlan());
    expect(changes(run)[1]).toBe("waking>uncertain:offline");
    expect(run.messages.some((m) => m.type === "snapshot.captured")).toBe(false);
    expect(run.messages.find((m) => m.type === "reaction.performed")?.data).toMatchObject({
      kind: "uncertain",
      offline: true,
    });
    expect(run.state.verdict).toBe("offline");
  });

  it("a family verdict below 0.80 is treated as uncertain", () => {
    const run = drive(buildFamilyHomePlan(response("family", 0.79)));
    expect(changes(run)[2]).toBe("seeking>uncertain:verdict");
  });

  it("every state.changed has from equal to the previous state", () => {
    const run = drive(buildFamilyHomePlan(response("family")));
    let previous = "sleeping";
    for (const m of run.messages) {
      if (m.type !== "state.changed") continue;
      expect(m.data.from).toBe(previous);
      previous = m.data.to;
    }
  });
});

describe("machine commands", () => {
  const envelope = (data: Speak["data"]): Speak => ({
    v: 1,
    id: "cmd-1",
    ts: "2026-01-01T00:00:00.000Z",
    deviceId: "warashi-sim",
    encounterId: null,
    type: "speak",
    data,
  });
  const errorCodes = (run: Run): string[] =>
    run.messages.flatMap((m) => (m.type === "error.reported" ? [m.data.code] : []));

  it("mode.set sleep ends the encounter with reason manual", () => {
    const run = drive(buildFamilyHomePlan(response("family")), {
      onTime: (t) =>
        t === 1000
          ? {
              kind: "command",
              message: {
                v: 1,
                id: "m1",
                ts: "2026-01-01T00:00:00.000Z",
                deviceId: "warashi-sim",
                encounterId: null,
                type: "mode.set",
                data: { mode: "sleep" },
              },
            }
          : null,
    });
    expect(changes(run)).toContain("waking>cooldown:manual");
    expect(run.messages.find((m) => m.type === "encounter.ended")?.data).toEqual({
      reason: "manual",
    });
    expect(run.state.mode).toBe("guard");
  });

  it("rejects unknown lines, a stranger line for an uncertain visitor, and busy audio", () => {
    const run = drive(buildNetworkDownPlan(), {
      until: 4000,
      onTime: (t) => {
        if (t === 2000) return { kind: "command", message: envelope({ lineId: "nope", audioUrl: null, ja: "", en: "" }) };
        if (t === 2050) {
          return { kind: "command", message: envelope({ lineId: lineOf("stranger"), audioUrl: null, ja: "", en: "" }) };
        }
        if (t === 2100) {
          return { kind: "command", message: envelope({ lineId: lineOf("uncertain"), audioUrl: null, ja: "", en: "" }) };
        }
        return null;
      },
    });
    // The offline reaction line is playing at t = 2000 (the offline reaction starts when waking ends),
    // so the permitted uncertain line is busy and the other two are rejected first.
    expect(errorCodes(run).slice(0, 3)).toEqual(["unknown_line", "speak_rejected", "audio_busy"]);
  });

  it("gaze in sleeping is rejected and moves nothing", () => {
    const plan = buildNetworkDownPlan();
    const state = initial(plan);
    const r = handle(
      state,
      {
        kind: "command",
        message: {
          v: 1,
          id: "g1",
          ts: "2026-01-01T00:00:00.000Z",
          deviceId: "warashi-sim",
          encounterId: null,
          type: "gaze",
          data: { panDeg: 20, tiltDeg: 0 },
        },
      },
      0,
    );
    expect(r.state.panTarget).toBe(0);
    expect(r.outputs.map((o) => o.kind === "message" && o.envelope.type)).toEqual(["error.reported"]);
  });
});
