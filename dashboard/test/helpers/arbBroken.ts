// Generators of valid wire messages (plain JSON objects) for the codec rejection property.
// Kept separate from other helpers so each test file owns its generators.

import fc from "fast-check";
import { ERROR_CODES, REASONS, STATES, VERDICTS } from "../../src/simulation/types";

export type Wire = {
  v: number;
  id: string;
  ts: string;
  deviceId: string;
  encounterId: string | null;
  type: string;
  data: Record<string, unknown>;
};

const str = fc.string({ unit: "grapheme", maxLength: 30 });
const strOrNull = fc.option(str, { nil: null });
const num = fc.double({ noNaN: true, noDefaultInfinity: true });
const int = fc.integer({ min: 0, max: 1_000_000 });
const fraction = fc.double({ min: 0, max: 1, noNaN: true });
const mode = fc.constantFrom("guard", "sleep");
const state = fc.constantFrom(...STATES);

const dataByType: Record<string, fc.Arbitrary<Record<string, unknown>>> = {
  "presence.detected": fc.record({ source: fc.constantFrom("pir", "sound", "manual") }),
  "snapshot.captured": fc.record({
    snapshotId: str,
    width: int,
    height: int,
    panDeg: num,
    tiltDeg: num,
    jpegBase64: str,
  }),
  "state.changed": fc.record({ from: state, to: state, reason: fc.constantFrom(...REASONS) }),
  "reaction.performed": fc.record({
    kind: fc.constantFrom("family", "stranger", "uncertain"),
    lineId: strOrNull,
    offline: fc.boolean(),
  }),
  "encounter.ended": fc.record({ reason: fc.constantFrom("cooldown", "manual", "error") }),
  "error.reported": fc.record({
    code: fc.constantFrom(...ERROR_CODES),
    message: str,
    refId: strOrNull,
  }),
  "judgement.result": fc.record({
    snapshotId: str,
    verdict: fc.constantFrom(...VERDICTS),
    confidence: fraction,
    face: fc.option(
      fc.record({ left: fraction, top: fraction, width: fraction, height: fraction }),
      { nil: null },
    ),
  }),
  speak: fc.oneof(
    fc.record({ lineId: str, audioUrl: fc.constant(null), ja: str, en: str }),
    fc.record({ lineId: fc.constant(null), audioUrl: str, ja: str, en: str }),
  ),
  gaze: fc.record({ panDeg: num, tiltDeg: num }),
  lantern: fc.record({ level: num, fadeMs: int }),
  "mode.set": fc.record({ mode }),
  "status.report": fc.record({
    state,
    mode,
    panDeg: num,
    tiltDeg: num,
    lantern: fraction,
    cameraActive: fc.boolean(),
    micActive: fc.boolean(),
    motionEnabled: fc.boolean(),
    uptimeSec: int,
    agentVersion: str,
  }),
  "status.offline": fc.constant({}),
};

/** Types whose data has at least one number (for non_finite). */
export const NUMERIC_TYPES = [
  "snapshot.captured",
  "judgement.result",
  "gaze",
  "lantern",
  "status.report",
];

/** Data fields that are enumerations, per type. */
export const ENUM_FIELDS: Record<string, string[]> = {
  "presence.detected": ["source"],
  "state.changed": ["from", "to", "reason"],
  "reaction.performed": ["kind"],
  "encounter.ended": ["reason"],
  "error.reported": ["code"],
  "judgement.result": ["verdict"],
  "mode.set": ["mode"],
  "status.report": ["state", "mode"],
};

export function arbValidOf(types: readonly string[]): fc.Arbitrary<Wire> {
  return fc
    .constantFrom(...types)
    .chain((type) =>
      fc.record({
        v: fc.constant(1),
        id: fc.uuid(),
        ts: fc.constant("2026-11-20T12:34:56.789Z"),
        deviceId: fc.constantFrom("warashi-01", "warashi-sim"),
        encounterId: fc.option(fc.uuid(), { nil: null }),
        type: fc.constant(type),
        data: dataByType[type] as fc.Arbitrary<Record<string, unknown>>,
      }),
    );
}

export const arbValid = arbValidOf(Object.keys(dataByType));

/** Paths (as key arrays inside `data`) of every number in a message's data. */
export function numberPaths(data: Record<string, unknown>): string[][] {
  const out: string[][] = [];
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "number") out.push([k]);
    else if (v !== null && typeof v === "object") {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (typeof v2 === "number") out.push([k, k2]);
      }
    }
  }
  return out;
}

export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
