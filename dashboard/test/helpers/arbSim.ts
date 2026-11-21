// fast-check generators for the simulation engine's inputs.
import fc from "fast-check";
import {
  buildFamilyHomePlan,
  buildNetworkDownPlan,
  buildNobodyTherePlan,
  buildStrangerNightPlan,
  SCENARIOS,
  type PlanResponse,
} from "../../src/simulation/plans";
import type { Input, ScenarioId, ScenarioPlan } from "../../src/simulation/types";
import family from "../../src/simulation/data/sample-responses/family.json";
import stranger from "../../src/simulation/data/sample-responses/stranger.json";
import noFace from "../../src/simulation/data/sample-responses/no_face.json";
import { arbEnvelopeOf } from "./arbEnvelope";

export { arbEnvelope } from "./arbEnvelope";

export const arbSeed: fc.Arbitrary<number> = fc.integer({ min: -0x80000000, max: 0x7fffffff });

export const arbScenario: fc.Arbitrary<ScenarioId> = fc.constantFrom(...SCENARIOS);

/** Milliseconds between ticks: from the 50 ms UI tick up to 1 s. */
export const arbTickGap: fc.Arbitrary<number> = fc.integer({ min: 10, max: 1000 });

/** Any finite double, extremes included (1e300), no -0. */
export const arbFiniteAngle: fc.Arbitrary<number> = fc
  .oneof(
    fc.double({ min: -200, max: 200, noNaN: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.constantFrom(1e300, -1e300, Number.MAX_VALUE, -Number.MAX_VALUE, 0),
  )
  .map((n) => (Object.is(n, -0) ? 0 : n));

/** Family labels (names). Never empty strings, so substring checks are meaningful. */
export const arbLabels: fc.Arbitrary<string[]> = fc.array(
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }),
  { maxLength: 4 },
);

const RESPONSES = {
  family: family as unknown as PlanResponse,
  stranger: stranger as unknown as PlanResponse,
  no_face: noFace as unknown as PlanResponse,
};

/** The plan of a scenario built from the bundled sample response. */
export function planFor(scenario: ScenarioId, labels: readonly string[] = []): ScenarioPlan {
  switch (scenario) {
    case "family_home":
      return buildFamilyHomePlan(RESPONSES.family, labels);
    case "stranger_night":
      return buildStrangerNightPlan(RESPONSES.stranger, labels);
    case "nobody_there":
      return buildNobodyTherePlan(RESPONSES.no_face, labels);
    case "network_down":
      return buildNetworkDownPlan();
  }
}

export const arbPlan: fc.Arbitrary<ScenarioPlan> = fc
  .tuple(arbScenario, arbLabels)
  .map(([scenario, labels]) => planFor(scenario, labels));

const COMMAND_TYPES = ["judgement.result", "speak", "gaze", "lantern", "mode.set"] as const;

/** Valid commands addressed to the simulated doll (angles may be extreme but finite). */
const arbValidCommand: fc.Arbitrary<unknown> = fc
  .constantFrom(...COMMAND_TYPES)
  .chain(arbEnvelopeOf)
  .map((m) => ({ ...m, deviceId: "warashi-sim", encounterId: null }));

const arbGaze: fc.Arbitrary<unknown> = fc
  .tuple(arbEnvelopeOf("gaze"), arbFiniteAngle, arbFiniteAngle)
  .map(([m, panDeg, tiltDeg]) => ({
    ...m,
    deviceId: "warashi-sim",
    encounterId: null,
    data: { panDeg, tiltDeg },
  }));

/** Values the engine must reject without changing anything but its log. */
const arbMalformedCommand: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything(),
  fc.constantFrom(null, 42, "text", [], {}),
  arbValidCommand.map((m) => ({ ...(m as object), v: 0 })),
  arbValidCommand.map((m) => ({ ...(m as object), v: 2 })),
  arbValidCommand.map((m) => ({ ...(m as object), deviceId: "someone-else" })),
  arbValidCommand.map((m) => ({ ...(m as object), type: "no.such.type" })),
  arbValidCommand.map((m) => ({ ...(m as object), data: "broken" })),
  arbEnvelopeOf("presence.detected"), // an event received as a command
);

/** A command value, valid or malformed, as `Input` of kind `command` carries it. */
export const arbCommand: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 3, arbitrary: arbValidCommand },
  { weight: 2, arbitrary: arbGaze },
  { weight: 2, arbitrary: arbMalformedCommand },
);

/** Any engine input. */
export const arbInput: fc.Arbitrary<Input> = fc.oneof(
  fc.constant<Input>({ kind: "tick" }),
  arbCommand.map((value): Input => ({ kind: "command", value })),
  fc
    .oneof(
      fc.constant({ type: "pir.rising" as const }),
      fc.constant({ type: "cloud.connected" as const }),
      fc.constant({ type: "cloud.disconnected" as const }),
      fc.string({ maxLength: 12 }).map((playId) => ({ type: "audio.finished" as const, playId })),
      fc
        .string({ maxLength: 12 })
        .map((snapshotId) => ({ type: "snapshot.ready" as const, snapshotId })),
      fc.string({ maxLength: 12 }).map((motionId) => ({ type: "servo.arrived" as const, motionId })),
    )
    .map((event): Input => ({ kind: "internal", event })),
  arbPlan.chain((plan) =>
    arbSeed.map((seed): Input => ({ kind: "user", action: { type: "start", plan, seed } })),
  ),
  fc.constant<Input>({ kind: "user", action: { type: "stop" } }),
);
