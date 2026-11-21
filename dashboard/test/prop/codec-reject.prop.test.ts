// Feature: dashboard-simulation, Property 2: Codec rejects each broken rule with its name
// **Validates: Requirements 4.3, 4.4**

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { decodeText, decodeValue, MAX_MESSAGE_BYTES } from "../../src/simulation/codec";
import {
  arbValid,
  arbValidOf,
  clone,
  ENUM_FIELDS,
  NUMERIC_TYPES,
  numberPaths,
  type Wire,
} from "../helpers/arbBroken";

const RUNS = { numRuns: 150 };
const ENVELOPE_DROPPABLE = ["id", "ts", "deviceId", "encounterId", "type", "data"] as const;
const ENVELOPE_STRINGS = ["id", "ts", "deviceId", "type", "encounterId"] as const;

const malformed = (rule: string, path?: string) =>
  path === undefined
    ? expect.objectContaining({ kind: "malformed", rule })
    : expect.objectContaining({ kind: "malformed", rule, path });

/** A value of a different JSON type than `orig`, so the type rule must fire. */
function wrongTypeFor(orig: unknown): unknown {
  if (typeof orig === "string") return 5;
  if (typeof orig === "number") return "1";
  if (typeof orig === "boolean") return 0;
  if (orig === null) return 5;
  if (typeof orig === "object") return "x";
  return [];
}

describe("Property 2: codec rejects each broken rule with its name", () => {
  it("size: text over 131,072 bytes", () => {
    fc.assert(
      fc.property(arbValid, fc.integer({ min: 1, max: 5000 }), (msg, extra) => {
        const text = JSON.stringify(msg);
        const bytes = new TextEncoder().encode(text).length;
        const padded = text + " ".repeat(Math.max(0, MAX_MESSAGE_BYTES - bytes) + extra);
        expect(decodeText(padded)).toEqual(malformed("size"));
      }),
      RUNS,
    );
  });

  it("json: broken JSON text", () => {
    fc.assert(
      fc.property(arbValid, fc.constantFrom("truncate", "prefix", "suffix"), (msg, how) => {
        const text = JSON.stringify(msg);
        const broken =
          how === "truncate" ? text.slice(0, -1) : how === "prefix" ? "{" + text : text + "x";
        expect(decodeText(broken)).toEqual(malformed("json"));
      }),
      RUNS,
    );
  });

  it("not_object: valid JSON that is not an object", () => {
    const nonObject = fc.oneof(
      fc.integer(),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.integer(), { maxLength: 4 }),
    );
    fc.assert(
      fc.property(nonObject, (value) => {
        expect(decodeText(JSON.stringify(value))).toEqual(malformed("not_object"));
      }),
      RUNS,
    );
  });

  it("version_type: v is not an integer >= 1", () => {
    const badV = fc.oneof(
      fc.constantFrom<unknown>(0, -1, 1.5, "1", true, false, null, [], {}),
      fc.integer({ max: 0 }),
      fc.double({ noNaN: true, noDefaultInfinity: true }).filter((x) => !Number.isInteger(x)),
      fc.string(),
    );
    fc.assert(
      fc.property(arbValid, badV, (msg, v) => {
        const broken = { ...clone(msg), v };
        expect(decodeValue(broken)).toEqual(malformed("version_type", "v"));
        expect(decodeText(JSON.stringify(broken))).toEqual(malformed("version_type", "v"));
      }),
      RUNS,
    );
  });

  it("unsupported_version: any integer v above 1, with no message", () => {
    fc.assert(
      fc.property(arbValid, fc.integer({ min: 2, max: Number.MAX_SAFE_INTEGER }), (msg, v) => {
        const r = decodeText(JSON.stringify({ ...msg, v }));
        expect(r).toEqual({ kind: "unsupported_version", v });
        expect(r).not.toHaveProperty("message");
      }),
      RUNS,
    );
  });

  it("missing_field: a dropped envelope or data field", () => {
    const arb = arbValid.chain((msg) => {
      const targets: string[][] = [
        ...ENVELOPE_DROPPABLE.map((k) => [k]),
        ...Object.keys(msg.data).map((k) => ["data", k]),
      ];
      const face = msg.data.face;
      if (face !== null && typeof face === "object") {
        for (const k of Object.keys(face)) targets.push(["data", "face", k]);
      }
      return fc.record({ msg: fc.constant(msg), target: fc.constantFrom(...targets) });
    });
    fc.assert(
      fc.property(arb, ({ msg, target }) => {
        const broken = clone(msg) as unknown as Record<string, unknown>;
        let parent = broken;
        for (const k of target.slice(0, -1)) parent = parent[k] as Record<string, unknown>;
        delete parent[(target.at(-1) as string)];
        expect(decodeText(JSON.stringify(broken))).toEqual(malformed("missing_field", target.join(".")));
      }),
      RUNS,
    );
  });

  it("wrong_type: an envelope or data field of the wrong JSON type", () => {
    const arb = arbValid.chain((msg) => {
      const targets: string[][] = [
        ...ENVELOPE_STRINGS.map((k) => [k]),
        ["data"],
        ...Object.keys(msg.data).map((k) => ["data", k]),
      ];
      return fc.record({ msg: fc.constant(msg), target: fc.constantFrom(...targets) });
    });
    fc.assert(
      fc.property(arb, ({ msg, target }) => {
        const broken = clone(msg) as unknown as Record<string, unknown>;
        let parent = broken;
        for (const k of target.slice(0, -1)) parent = parent[k] as Record<string, unknown>;
        const last = (target.at(-1) as string);
        parent[last] = last === "data" && target.length === 1 ? [] : wrongTypeFor(parent[last]);
        expect(decodeText(JSON.stringify(broken))).toEqual(malformed("wrong_type", target.join(".")));
      }),
      RUNS,
    );
  });

  it("non_finite: NaN, Infinity, -Infinity or 1e400 in a number field", () => {
    const arb = arbValidOf(NUMERIC_TYPES).chain((msg) =>
      fc.record({
        msg: fc.constant(msg),
        path: fc.constantFrom(...numberPaths(msg.data)),
        bad: fc.constantFrom(NaN, Infinity, -Infinity, Number.MAX_VALUE * 10),
      }),
    );
    fc.assert(
      fc.property(arb, ({ msg, path, bad }) => {
        const broken = clone(msg);
        let parent = broken.data;
        for (const k of path.slice(0, -1)) parent = parent[k] as Record<string, unknown>;
        parent[(path.at(-1) as string)] = bad;
        const expected = malformed("non_finite", ["data", ...path].join("."));
        expect(decodeValue(broken)).toEqual(expected);
        // JSON text cannot carry NaN; 1e400 parses to Infinity.
        parent[(path.at(-1) as string)] = "__BIG__";
        const text = JSON.stringify(broken).replace('"__BIG__"', "1e400");
        expect(decodeText(text)).toEqual(expected);
      }),
      RUNS,
    );
  });

  it("bad_enum: an enumeration field outside its values", () => {
    const arb = arbValidOf(Object.keys(ENUM_FIELDS)).chain((msg) =>
      fc.record({
        msg: fc.constant(msg),
        field: fc.constantFrom(...ENUM_FIELDS[msg.type] ?? []),
        junk: fc.string({ maxLength: 10 }),
      }),
    );
    fc.assert(
      fc.property(arb, ({ msg, field, junk }) => {
        const broken: Wire = clone(msg);
        broken.data[field] = "x-" + junk;
        expect(decodeText(JSON.stringify(broken))).toEqual(malformed("bad_enum", `data.${field}`));
      }),
      RUNS,
    );
  });

  it("speak_source: speak with both or neither of lineId and audioUrl", () => {
    const arb = fc.record({
      msg: arbValidOf(["speak"]),
      both: fc.boolean(),
      s: fc.string({ maxLength: 10 }),
    });
    fc.assert(
      fc.property(arb, ({ msg, both, s }) => {
        const broken = clone(msg);
        broken.data.lineId = both ? s : null;
        broken.data.audioUrl = both ? s : null;
        expect(decodeText(JSON.stringify(broken))).toEqual(malformed("speak_source", "data"));
      }),
      RUNS,
    );
  });

  it("unknown_type: a string type that is not in the contract", () => {
    fc.assert(
      fc.property(arbValid, fc.string({ maxLength: 10 }), (msg, s) => {
        const broken = { ...clone(msg), type: "x." + s };
        expect(decodeText(JSON.stringify(broken))).toEqual(malformed("unknown_type", "type"));
      }),
      RUNS,
    );
  });
});
