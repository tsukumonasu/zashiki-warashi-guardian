// Feature: cloud-judgement, Property 11: Snapshot size bound
// Validates: Requirements 2.5
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope, type Envelope } from "../lambda/_shared/messages.js";

/** The AWS IoT Core publish limit is 131,072 bytes; the contract promises a bound below 128,000. */
const WIRE_LIMIT = 128_000;
const MAX_JPEG_BYTES = 90_000;
const MAX_DEVICE_ID = 64;
const UUID_LENGTH = 36;
const TS = "2026-11-20T12:34:56.789Z";

/** Extreme finite angles: the longest decimal renderings JSON can produce. */
const EXTREME_ANGLES = [-Number.MAX_VALUE, -5e-324, -1.2345678901234e-300, Number.MAX_VALUE];

const uuidLike = fc.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const deviceIdArb = fc
  .string({ unit: fc.constantFrom(..."ABCxyz019_-".split("")), minLength: 1, maxLength: MAX_DEVICE_ID });
const angleArb = fc.oneof(fc.constantFrom(...EXTREME_ANGLES), fc.double({ noNaN: true, noDefaultInfinity: true }));

function jpegBase64(byteLength: number): string {
  return Buffer.alloc(byteLength, 0xff).toString("base64");
}

function snapshot(args: {
  id: string;
  deviceId: string;
  encounterId: string;
  snapshotId: string;
  jpegBytes: number;
  panDeg: number;
  tiltDeg: number;
}): Envelope {
  return {
    v: 1,
    id: args.id,
    ts: TS,
    deviceId: args.deviceId,
    encounterId: args.encounterId,
    type: "snapshot.captured",
    data: {
      snapshotId: args.snapshotId,
      width: 640,
      height: 480,
      panDeg: args.panDeg,
      tiltDeg: args.tiltDeg,
      jpegBase64: jpegBase64(args.jpegBytes),
    },
  };
}

describe("snapshot size bound", () => {
  it("Feature: cloud-judgement, Property 11: Snapshot size bound (largest legal message)", () => {
    const uuid = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    for (const angle of EXTREME_ANGLES) {
      const wire = encodeEnvelope(
        snapshot({
          id: uuid,
          deviceId: "D".repeat(MAX_DEVICE_ID),
          encounterId: uuid,
          snapshotId: "s".repeat(MAX_DEVICE_ID),
          jpegBytes: MAX_JPEG_BYTES,
          panDeg: angle,
          tiltDeg: angle,
        }),
      );
      expect(Buffer.byteLength(wire, "utf8")).toBeLessThan(WIRE_LIMIT);
    }
  });

  it("Feature: cloud-judgement, Property 11: Snapshot size bound (any legal input stays below the limit and decodes)", () => {
    fc.assert(
      fc.property(
        uuidLike,
        deviceIdArb,
        uuidLike,
        fc.stringMatching(/^[a-z0-9_-]{1,64}$/),
        fc.integer({ min: 0, max: MAX_JPEG_BYTES }),
        angleArb,
        angleArb,
        (id, deviceId, encounterId, snapshotId, jpegBytes, panDeg, tiltDeg) => {
          expect(id).toHaveLength(UUID_LENGTH);
          const wire = encodeEnvelope(
            snapshot({ id, deviceId, encounterId, snapshotId, jpegBytes, panDeg, tiltDeg }),
          );
          expect(Buffer.byteLength(wire, "utf8")).toBeLessThan(WIRE_LIMIT);
          expect(decodeEnvelope(wire).kind).toBe("valid");
        },
      ),
      { numRuns: 100 },
    );
  });
});
