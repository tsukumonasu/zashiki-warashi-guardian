import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ALL_TYPES, decodeText, decodeValue, encode } from "../../src/simulation/codec";
import { MESSAGE_TYPES, arbEnvelope } from "../helpers/arbEnvelope";

describe("Feature: dashboard-simulation, Property 1: Codec round trip", () => {
  it("decode(encode(m)) equals m for every valid SchemaMessage", () => {
    // **Validates: Requirements 4.2, 4.5, 4.6**
    fc.assert(
      fc.property(arbEnvelope, (m) => {
        const result = decodeText(encode(m));
        expect(result.kind).toBe("valid");
        if (result.kind === "valid") expect(result.message).toEqual(m);
      }),
      { numRuns: 200 },
    );
  });

  it("ignores key order of the encoded object", () => {
    // **Validates: Requirements 4.2, 4.5, 4.6**
    fc.assert(
      fc.property(arbEnvelope, (m) => {
        const reversed = Object.fromEntries(Object.entries(m).reverse());
        const result = decodeValue(reversed);
        expect(result.kind).toBe("valid");
        if (result.kind === "valid") expect(result.message).toEqual(m);
      }),
      { numRuns: 100 },
    );
  });

  it("the generators cover every type the codec knows", () => {
    expect([...MESSAGE_TYPES].sort()).toEqual([...ALL_TYPES].sort());
  });
});
