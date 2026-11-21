// Feature: cloud-judgement, Property 9: Envelope round trip
// **Validates: Requirements 6.3, 24.1, 24.6, 24.7, 24.8**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_INBOUND_BYTES,
  MESSAGE_TYPES,
  decodeEnvelope,
  encodeEnvelope,
  type Envelope,
} from "../lambda/_shared/messages.js";

const NUM_RUNS = 200;
const TAG = "Feature: cloud-judgement, Property 9: Envelope round trip";

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/** Finite double without negative zero (JSON writes -0 as 0). */
const finiteNumber = fc
  .double({ noNaN: true, noDefaultInfinity: true })
  .map((x) => (x === 0 ? 0 : x));
const intValue = fc.integer({ min: 0, max: 2_000_000_000 });
const text = fc.string({ unit: "grapheme", maxLength: 40 });
const nullableText = fc.option(text, { nil: null });

const STATES = [
  "sleeping", "waking", "seeking", "gazing", "greeting", "warning", "uncertain", "conversing",
  "cooldown",
] as const;
const REASONS = [
  "presence", "arrived", "verdict", "no_face", "timeout", "offline", "audio_done", "manual",
  "cooldown_done", "error",
] as const;
const ERROR_CODES = [
  "unknown_type", "unsupported_version", "malformed_message", "wrong_device", "speak_rejected",
  "audio_busy", "command_rejected_state", "unknown_line", "voice_line_missing",
  "voice_line_invalid", "voice_file_missing", "audio_failed", "download_failed",
  "audio_device_missing", "camera_missing", "camera_failed", "snapshot_too_large",
  "internal_error", "adapter_failed",
] as const;

const faceBox = fc.record({
  left: finiteNumber,
  top: finiteNumber,
  width: finiteNumber,
  height: finiteNumber,
});

const speakData = fc.oneof(
  fc.record({ lineId: text, audioUrl: fc.constant(null), ja: text, en: text }),
  fc.record({ lineId: fc.constant(null), audioUrl: text, ja: text, en: text }),
);

const DATA_BY_TYPE: Record<string, fc.Arbitrary<unknown>> = {
  "presence.detected": fc.record({ source: fc.constantFrom("pir", "sound", "manual") }),
  "snapshot.captured": fc.record({
    snapshotId: text,
    width: intValue,
    height: intValue,
    panDeg: finiteNumber,
    tiltDeg: finiteNumber,
    jpegBase64: fc.base64String({ maxLength: 200 }),
  }),
  "state.changed": fc.record({
    from: fc.constantFrom(...STATES),
    to: fc.constantFrom(...STATES),
    reason: fc.constantFrom(...REASONS),
  }),
  "reaction.performed": fc.record({
    kind: fc.constantFrom("family", "stranger", "uncertain"),
    lineId: nullableText,
    offline: fc.boolean(),
  }),
  "encounter.ended": fc.record({ reason: fc.constantFrom("cooldown", "manual", "error") }),
  "error.reported": fc.record({
    code: fc.constantFrom(...ERROR_CODES),
    message: fc.string({ unit: "grapheme", maxLength: 200 }),
    refId: nullableText,
  }),
  "judgement.result": fc.record({
    snapshotId: text,
    verdict: fc.constantFrom("family", "stranger", "no_face", "uncertain"),
    confidence: finiteNumber,
    face: fc.option(faceBox, { nil: null }),
  }),
  speak: speakData,
  gaze: fc.record({ panDeg: finiteNumber, tiltDeg: finiteNumber }),
  lantern: fc.record({ level: finiteNumber, fadeMs: intValue }),
  "mode.set": fc.record({ mode: fc.constantFrom("guard", "sleep") }),
  "status.report": fc.record({
    state: fc.constantFrom(...STATES),
    mode: fc.constantFrom("guard", "sleep"),
    panDeg: finiteNumber,
    tiltDeg: finiteNumber,
    lantern: finiteNumber,
    cameraActive: fc.boolean(),
    micActive: fc.boolean(),
    motionEnabled: fc.boolean(),
    uptimeSec: intValue,
    agentVersion: text,
  }),
  "status.offline": fc.constant({}),
};

const isoTs = fc
  .date({ min: new Date("1970-01-01T00:00:00.000Z"), max: new Date("2100-01-01T00:00:00.000Z"), noInvalidDate: true })
  .map((d) => d.toISOString());

const envelopeFor = (type: string): fc.Arbitrary<Envelope> =>
  fc.record({
    v: fc.constant(1 as const),
    id: fc.uuid(),
    ts: isoTs,
    deviceId: fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
    encounterId: fc.option(fc.uuid(), { nil: null }),
    type: fc.constant(type),
    data: DATA_BY_TYPE[type] as fc.Arbitrary<unknown>,
  });

const anyEnvelope = fc.constantFrom(...MESSAGE_TYPES).chain(envelopeFor);

// A minimal valid wire object used as the base of the rejection checks.
const baseWire = (): Record<string, unknown> => ({
  v: 1,
  id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
  ts: "2026-11-20T12:34:56.789Z",
  deviceId: "warashi-01",
  encounterId: null,
  type: "mode.set",
  data: { mode: "guard" },
});

const decodeObj = (o: unknown) => decodeEnvelope(JSON.stringify(o));

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe(TAG, () => {
  it("has a generator for every message type", () => {
    expect([...MESSAGE_TYPES].sort()).toEqual(Object.keys(DATA_BY_TYPE).sort());
  });

  it(`${TAG}: decode(encode(e)) equals e for every message type`, () => {
    fc.assert(
      fc.property(anyEnvelope, (e) => {
        const result = decodeEnvelope(encodeEnvelope(e));
        expect(result).toEqual({ kind: "valid", message: e });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`${TAG}: bytes and text input decode alike`, () => {
    fc.assert(
      fc.property(anyEnvelope, (e) => {
        const encoded = encodeEnvelope(e);
        expect(decodeEnvelope(new TextEncoder().encode(encoded))).toEqual(decodeEnvelope(encoded));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`${TAG}: undefined and unknown data fields are dropped`, () => {
    fc.assert(
      fc.property(anyEnvelope, text, (e, extra) => {
        const withExtra = JSON.parse(encodeEnvelope(e)) as Record<string, unknown>;
        (withExtra["data"] as Record<string, unknown>)["extraField_"] = extra;
        withExtra["topLevelExtra_"] = extra;
        expect(decodeObj(withExtra)).toEqual({ kind: "valid", message: e });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`${TAG}: a non-integer or too small v is malformed`, () => {
    const badV = fc.oneof(
      fc.integer({ max: 0 }),
      fc.double({ noNaN: true, noDefaultInfinity: true }).filter((x) => !Number.isInteger(x)),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
    );
    fc.assert(
      fc.property(badV, (v) => {
        expect(decodeObj({ ...baseWire(), v }).kind).toBe("malformed");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`${TAG}: an integer v above 1 is ignored as unsupported_version`, () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 1_000_000 }), (v) => {
        expect(decodeObj({ ...baseWire(), v })).toEqual({
          kind: "ignored",
          reason: "unsupported_version",
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`${TAG}: a missing or wrongly typed id, ts, deviceId or encounterId is malformed`, () => {
    const field = fc.constantFrom("id", "ts", "deviceId", "encounterId");
    const wrong = fc.oneof(fc.integer(), fc.boolean(), fc.array(fc.integer(), { maxLength: 2 }));
    fc.assert(
      fc.property(field, fc.option(wrong, { nil: undefined }), (name, value) => {
        const wire = baseWire();
        if (value === undefined) delete wire[name];
        else wire[name] = value;
        expect(decodeObj(wire).kind).toBe("malformed");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`${TAG}: a ts that is not ISO 8601 with an offset is malformed`, () => {
    const badTs = fc.oneof(
      fc.string({ maxLength: 20 }).filter((s) => !/^\d{4}-/.test(s)),
      fc.constantFrom("2026-11-20T12:34:56.789", "2026-13-20T12:34:56Z", "2026-02-30T00:00:00Z"),
    );
    fc.assert(
      fc.property(badTs, (ts) => {
        expect(decodeObj({ ...baseWire(), ts }).kind).toBe("malformed");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`${TAG}: a value outside an enumeration is malformed`, () => {
    const badEnum = fc
      .string({ maxLength: 12 })
      .filter((s) => s !== "guard" && s !== "sleep");
    fc.assert(
      fc.property(badEnum, (mode) => {
        const wire = { ...baseWire(), data: { mode } };
        expect(decodeObj(wire).kind).toBe("malformed");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`${TAG}: a non-finite number is malformed, even with v above 1 or an unknown type`, () => {
    const bigNumber = fc.constantFrom("1e400", "-1e400", "1e999");
    const variant = fc.constantFrom(
      { v: "1", type: "gaze" },
      { v: "2", type: "gaze" },
      { v: "1", type: "no.such.type" },
    );
    fc.assert(
      fc.property(bigNumber, variant, (literal, { v, type }) => {
        const raw = `{"v":${v},"id":"a","ts":"2026-11-20T12:34:56.789Z","deviceId":"d","encounterId":null,"type":"${type}","data":{"panDeg":${literal},"tiltDeg":0}}`;
        expect(decodeEnvelope(raw).kind).toBe("malformed");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`${TAG}: encode throws for a non-finite number`, () => {
    const nonFinite = fc.constantFrom(NaN, Infinity, -Infinity);
    fc.assert(
      fc.property(nonFinite, (panDeg) => {
        const e: Envelope = { ...baseWire(), type: "gaze", data: { panDeg, tiltDeg: 0 } } as Envelope;
        expect(() => encodeEnvelope(e)).toThrow(RangeError);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`${TAG}: input above the size limit is malformed`, () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2000 }), fc.boolean(), (extra, asBytes) => {
        const e = {
          ...baseWire(),
          type: "snapshot.captured",
          data: {
            snapshotId: "s",
            width: 1,
            height: 1,
            panDeg: 0,
            tiltDeg: 0,
            jpegBase64: "A".repeat(MAX_INBOUND_BYTES + extra),
          },
        } as Envelope;
        const encoded = encodeEnvelope(e);
        const input = asBytes ? new TextEncoder().encode(encoded) : encoded;
        expect(decodeEnvelope(input).kind).toBe("malformed");
      }),
      { numRuns: 100 },
    );
  });

  it(`${TAG}: invalid UTF-8 bytes and non-JSON input are malformed`, () => {
    expect(decodeEnvelope(new Uint8Array([0xff, 0xfe, 0x7b])).kind).toBe("malformed");
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }).filter((s) => !s.trim().startsWith("{")), (s) => {
        expect(decodeEnvelope(s).kind).toBe("malformed");
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
