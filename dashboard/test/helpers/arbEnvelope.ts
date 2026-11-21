// fast-check generators for valid SchemaMessages (docs/schema.md, contract v1).
import fc from "fast-check";
import {
  CONVERSATION_END_REASONS,
  ERROR_CODES,
  REASONS,
  STATES,
  VERDICTS,
  type SchemaMessage,
} from "../../src/simulation/types";

/** Finite double without -0 (JSON turns -0 into 0). */
export const arbFiniteNumber: fc.Arbitrary<number> = fc
  .double({ noNaN: true, noDefaultInfinity: true })
  .map((n) => (Object.is(n, -0) ? 0 : n));

const arbText = fc.string({ maxLength: 40 });
const arbTextOrNull = fc.option(arbText, { nil: null });
const arbInt = fc.integer({ min: -1_000_000, max: 1_000_000 });
const arbMode = fc.constantFrom("guard", "sleep");
const arbState = fc.constantFrom(...STATES);

const arbFace = fc.record({
  left: arbFiniteNumber,
  top: arbFiniteNumber,
  width: arbFiniteNumber,
  height: arbFiniteNumber,
});

const arbSpeakSource = fc.oneof(
  fc.record({ lineId: arbText, audioUrl: fc.constant(null) }),
  fc.record({ lineId: fc.constant(null), audioUrl: arbText }),
);

/** `data` for each message type, keyed by type. */
const DATA: Record<SchemaMessage["type"], fc.Arbitrary<unknown>> = {
  "presence.detected": fc.record({ source: fc.constantFrom("pir", "sound", "manual") }),
  "snapshot.captured": fc.record({
    snapshotId: arbText,
    width: arbInt,
    height: arbInt,
    panDeg: arbFiniteNumber,
    tiltDeg: arbFiniteNumber,
    jpegBase64: fc.string({ maxLength: 200 }),
    requestId: fc.option(arbText, { nil: undefined }),
  }),
  "state.changed": fc.record({
    from: arbState,
    to: arbState,
    reason: fc.constantFrom(...REASONS),
  }),
  "reaction.performed": fc.record({
    kind: fc.constantFrom("family", "stranger", "uncertain"),
    lineId: arbTextOrNull,
    offline: fc.boolean(),
  }),
  "encounter.ended": fc.record({ reason: fc.constantFrom("cooldown", "manual", "error") }),
  "error.reported": fc.record({
    code: fc.constantFrom(...ERROR_CODES),
    message: arbText,
    refId: arbTextOrNull,
  }),
  "judgement.result": fc.record({
    snapshotId: arbText,
    verdict: fc.constantFrom(...VERDICTS),
    confidence: arbFiniteNumber,
    face: fc.option(arbFace, { nil: null }),
  }),
  speak: fc
    .tuple(arbSpeakSource, arbText, arbText)
    .map(([src, ja, en]) => ({ ...src, ja, en })),
  gaze: fc.record({ panDeg: arbFiniteNumber, tiltDeg: arbFiniteNumber }),
  lantern: fc.record({ level: arbFiniteNumber, fadeMs: arbInt }),
  "mode.set": fc.record({ mode: arbMode }),
  "conversation.requested": fc.record({ reason: fc.constant("family_verdict") }),
  "conversation.ended": fc.record({
    sessionId: arbText,
    reason: fc.constantFrom(...CONVERSATION_END_REASONS),
  }),
  "conversation.start": fc.record({
    sessionId: arbText,
    token: arbText,
    maxSeconds: arbInt,
    silenceSeconds: arbInt,
    source: fc.constantFrom("family_verdict", "manual"),
  }),
  "conversation.end": fc.record({
    sessionId: arbText,
    reason: fc.constantFrom(...CONVERSATION_END_REASONS),
  }),
  "snapshot.request": fc.record({ requestId: arbText }),
  "status.report": fc.record({
    state: arbState,
    mode: arbMode,
    panDeg: arbFiniteNumber,
    tiltDeg: arbFiniteNumber,
    lantern: arbFiniteNumber,
    cameraActive: fc.boolean(),
    micActive: fc.boolean(),
    motionEnabled: fc.boolean(),
    uptimeSec: arbInt,
    agentVersion: arbText,
  }),
  "status.offline": fc.constant({}),
};

export const MESSAGE_TYPES = Object.keys(DATA) as SchemaMessage["type"][];

/** A valid envelope of the given type. */
export function arbEnvelopeOf(type: SchemaMessage["type"]): fc.Arbitrary<SchemaMessage> {
  return fc
    .record({
      v: fc.constant(1),
      id: fc.uuid(),
      ts: fc
        .date({ min: new Date("2020-01-01"), max: new Date("2100-01-01"), noInvalidDate: true })
        .map((d) => d.toISOString()),
      deviceId: arbText,
      encounterId: fc.option(fc.uuid(), { nil: null }),
      type: fc.constant(type),
      data: DATA[type],
    })
    .map((m) => m as unknown as SchemaMessage);
}

/** A valid envelope of any type. */
export const arbEnvelope: fc.Arbitrary<SchemaMessage> = fc
  .constantFrom(...MESSAGE_TYPES)
  .chain(arbEnvelopeOf);
