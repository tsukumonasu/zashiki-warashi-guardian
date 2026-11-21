// Feature: cloud-judgement, Property 10: Cross-language contract
// Validates: Requirements 24.13, 24.14
//
// Every golden fixture in docs/fixtures/schema-v1, and every mutation of it from the corpus
// below, gets the outcome kind declared in the corpus and, when valid, re-encodes to the
// expected value. The Python suite (device/tests/test_prop_cross_language.py) holds the SAME
// corpus (same names, same order, same declared outcomes). Both suites check their codec
// against those declared outcomes, so the two codecs agree with each other for the same input.
// Keep the two files in sync: a mutation changes in both or in neither.
//
// Known difference, deliberately not generated: JSON.parse cannot tell `1.0` from `1`, so
// messages.ts accepts `1.0` for an integer field while the Python decoder rejects it. No
// mutation writes a float with a zero fraction into an integer field.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope } from "../lambda/_shared/messages.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/fixtures/schema-v1",
);

type Obj = Record<string, unknown>;
type Kind = "valid" | "ignored" | "malformed";
type Case = { raw: string; kind: Kind; expected: Obj | null };

const FIXTURES: Obj[] = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as Obj);

// Same alphabet in both languages; no lone surrogates.
const ALPHABET = [..."abcXYZ019-_ .あいう界é"];
const PARAM = fc.string({ unit: fc.constantFrom(...ALPHABET), maxLength: 40 });

const dump = (obj: unknown): string => JSON.stringify(obj);
const withKey = (obj: Obj, key: string, value: unknown): Obj => ({ ...obj, [key]: value });
const without = (obj: Obj, key: string): Obj => {
  const copy = { ...obj };
  delete copy[key];
  return copy;
};
/** Appends `"x":<literal>` to a compact JSON object text. */
const spliceLiteral = (obj: Obj, literal: string): string => `${dump(obj).slice(0, -1)},"x":${literal}}`;
const reversed = (obj: Obj): Obj => Object.fromEntries(Object.entries(obj).reverse());

const valid = (obj: Obj, expected: Obj): Case => ({ raw: dump(obj), kind: "valid", expected });
const bad = (raw: string): Case => ({ raw, kind: "malformed", expected: null });

type Mutation = { name: string; build: (f: Obj, param: string) => Case };

// Deterministic corpus. Order and names match the Python file.
const MUTATIONS: Mutation[] = [
  { name: "identity", build: (f) => valid(f, f) },
  {
    name: "reversed_key_order",
    build: (f) => valid({ ...reversed(f), data: reversed(f["data"] as Obj) }, f),
  },
  { name: "extra_top_level_field", build: (f) => valid(withKey(f, "extra", { a: [1, 2] }), f) },
  {
    name: "extra_data_field",
    build: (f) => valid({ ...f, data: withKey(f["data"] as Obj, "nickname", "x") }, f),
  },
  {
    name: "device_id_text",
    build: (f, p) => valid(withKey(f, "deviceId", p), withKey(f, "deviceId", p)),
  },
  {
    name: "encounter_id_text",
    build: (f, p) => valid(withKey(f, "encounterId", p), withKey(f, "encounterId", p)),
  },
  {
    name: "encounter_id_null",
    build: (f) => valid(withKey(f, "encounterId", null), withKey(f, "encounterId", null)),
  },
  {
    name: "higher_version",
    build: (f) => ({ raw: dump(withKey(f, "v", 2)), kind: "ignored", expected: null }),
  },
  {
    name: "much_higher_version_unknown_type",
    build: (f) => ({
      raw: dump({ ...f, v: 100, type: "ghost.type" }),
      kind: "ignored",
      expected: null,
    }),
  },
  { name: "version_zero", build: (f) => bad(dump(withKey(f, "v", 0))) },
  { name: "version_negative", build: (f) => bad(dump(withKey(f, "v", -1))) },
  { name: "version_fraction", build: (f) => bad(dump(withKey(f, "v", 1.5))) },
  { name: "version_string", build: (f) => bad(dump(withKey(f, "v", "1"))) },
  { name: "version_bool", build: (f) => bad(dump(withKey(f, "v", true))) },
  { name: "version_null", build: (f) => bad(dump(withKey(f, "v", null))) },
  {
    name: "unknown_type",
    build: (f) => ({
      raw: dump({ ...f, type: "ghost.type", data: [] }),
      kind: "ignored",
      expected: null,
    }),
  },
  { name: "missing_id", build: (f) => bad(dump(without(f, "id"))) },
  { name: "missing_ts", build: (f) => bad(dump(without(f, "ts"))) },
  { name: "missing_device_id", build: (f) => bad(dump(without(f, "deviceId"))) },
  { name: "missing_encounter_id", build: (f) => bad(dump(without(f, "encounterId"))) },
  { name: "missing_type", build: (f) => bad(dump(without(f, "type"))) },
  { name: "missing_data", build: (f) => bad(dump(without(f, "data"))) },
  { name: "ts_without_offset", build: (f) => bad(dump(withKey(f, "ts", "2026-11-20T12:34:56.789"))) },
  { name: "ts_not_a_time", build: (f) => bad(dump(withKey(f, "ts", "yesterday"))) },
  { name: "data_is_array", build: (f) => bad(dump(withKey(f, "data", []))) },
  {
    // First data field replaced by an array: wrong type for every field kind. A type with no
    // data fields (status.offline) keeps its empty data, so the case stays valid there.
    name: "first_data_field_is_array",
    build: (f) => {
      const data = f["data"] as Obj;
      const first = Object.keys(data)[0];
      if (first === undefined) return valid(f, f);
      return bad(dump({ ...f, data: withKey(data, first, []) }));
    },
  },
  { name: "non_finite_number", build: (f) => bad(spliceLiteral(f, "1e400")) },
  {
    name: "non_finite_beats_higher_version",
    build: (f) => bad(spliceLiteral(withKey(f, "v", 2), "1e400")),
  },
  { name: "invalid_json", build: () => bad("{") },
  { name: "top_level_array", build: () => bad("[]") },
  { name: "top_level_string", build: () => bad('"text"') },
  { name: "oversize", build: (f) => bad(spliceLiteral(f, `"${"a".repeat(131_100)}"`)) },
];

function run(raw: string): { kind: Kind; roundTrip: unknown; reason: string | null } {
  const result = decodeEnvelope(raw);
  if (result.kind === "valid") {
    return { kind: "valid", roundTrip: JSON.parse(encodeEnvelope(result.message)), reason: null };
  }
  return {
    kind: result.kind,
    roundTrip: null,
    reason: result.kind === "ignored" ? result.reason : null,
  };
}

function check(c: Case, label: string): void {
  const out = run(c.raw);
  expect(out.kind, label).toBe(c.kind);
  if (c.kind === "valid") expect(out.roundTrip, label).toEqual(c.expected);
}

describe("Feature: cloud-judgement, Property 10: Cross-language contract", () => {
  it("has fixtures and a corpus", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(13);
    expect(new Set(MUTATIONS.map((m) => m.name)).size).toBe(MUTATIONS.length);
  });

  it("every fixture decodes to valid and re-encodes to an equal value (R24.13, R24.14)", () => {
    for (const fixture of FIXTURES) {
      check(valid(fixture, fixture), String(fixture["type"]));
    }
  });

  it("every mutation of every fixture has its declared outcome (exhaustive, fixed text)", () => {
    for (const fixture of FIXTURES) {
      for (const m of MUTATIONS) {
        check(m.build(fixture, "abc-あ"), `${String(fixture["type"])} / ${m.name}`);
      }
    }
  });

  it("holds for generated fixture, mutation and text", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FIXTURES),
        fc.constantFrom(...MUTATIONS),
        PARAM,
        (fixture, mutation, param) => {
          check(
            mutation.build(fixture, param),
            `${String(fixture["type"])} / ${mutation.name}`,
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it("ignored outcomes carry the declared reason", () => {
    const fixture = FIXTURES[0] as Obj;
    expect(run(dump({ ...fixture, v: 2 })).reason).toBe("unsupported_version");
    expect(run(dump({ ...fixture, type: "ghost.type" })).reason).toBe("unknown_type");
    expect(run(dump({ ...fixture, v: 2, type: "ghost.type" })).reason).toBe("unsupported_version");
  });
});
