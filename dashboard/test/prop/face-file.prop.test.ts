// Feature: dashboard-simulation, Property 21: Face file rules
// **Validates: Requirements 15.6**

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { validateFaceFile, MAX_FACE_FILE_BYTES } from "../../src/simulation/faces";

const RUNS = { numRuns: 200 };

const arbAllowedType = fc.constantFrom("image/jpeg", "image/png");
const arbOtherType = fc.oneof(
  fc.constantFrom(
    "image/gif",
    "image/webp",
    "image/jpg",
    "IMAGE/JPEG",
    "image/jpeg ",
    "image/png; charset=x",
    "application/pdf",
    "text/plain",
    "",
  ),
  fc.string().filter((s) => s !== "image/jpeg" && s !== "image/png"),
);
const arbSizeOk = fc.oneof(
  fc.integer({ min: 0, max: MAX_FACE_FILE_BYTES }),
  fc.constantFrom(0, 1, MAX_FACE_FILE_BYTES - 1, MAX_FACE_FILE_BYTES),
);
const arbSizeTooBig = fc.oneof(
  fc.integer({ min: MAX_FACE_FILE_BYTES + 1, max: 2_000_000_000 }),
  fc.constantFrom(MAX_FACE_FILE_BYTES + 1, Number.MAX_SAFE_INTEGER, Infinity),
);

describe("Property 21: Face file rules", () => {
  it("accepts JPEG and PNG of at most 5,000,000 bytes", () => {
    fc.assert(
      fc.property(arbAllowedType, arbSizeOk, (type, size) => {
        expect(validateFaceFile({ type, size })).toEqual({ ok: true });
      }),
      RUNS,
    );
  });

  it("rejects every other media type with a reason", () => {
    fc.assert(
      fc.property(arbOtherType, fc.oneof(arbSizeOk, arbSizeTooBig), (type, size) => {
        const result = validateFaceFile({ type, size });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  it("rejects files above 5,000,000 bytes with a reason", () => {
    fc.assert(
      fc.property(arbAllowedType, arbSizeTooBig, (type, size) => {
        const result = validateFaceFile({ type, size });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  it("matches the exact rule for any type and size", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbAllowedType, arbOtherType),
        fc.oneof(arbSizeOk, arbSizeTooBig),
        (type, size) => {
          const expected =
            (type === "image/jpeg" || type === "image/png") && size <= MAX_FACE_FILE_BYTES;
          expect(validateFaceFile({ type, size }).ok).toBe(expected);
        },
      ),
      RUNS,
    );
  });
});
