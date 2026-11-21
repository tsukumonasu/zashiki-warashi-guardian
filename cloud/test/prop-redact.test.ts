// Feature: cloud-judgement, Property 14: Redaction
// Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.7
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { redactEncounter } from "../lambda/_shared/redact.js";
import type { EncounterRecord } from "../lambda/_shared/types.js";

/** Independent copy of the forbidden key list, so the test does not trust the implementation. */
const FORBIDDEN = [
  "hasImage",
  "jpegBase64",
  "face",
  "faceId",
  "faceIds",
  "memberId",
  "displayName",
  "faceCount",
  "snapshot",
  "snapshotUrl",
  "snapshotKey",
  "imageUrl",
  "imageKey",
  "s3Key",
  "stagingKey",
  "bucket",
] as const;

const S3_KEY_TEXT = "snapshots/secret-bucket-key-0001.jpg";

const safeKeyArb = fc.stringMatching(/^k_[a-z0-9]{1,8}$/);
const forbiddenKeyArb = fc.constantFrom(...FORBIDDEN);
const safeStringArb = fc.stringMatching(/^[a-z0-9 ]{0,12}$/);

type Tree = unknown;

/** JSON-like trees whose object keys mix safe and forbidden names, at any depth. */
const { tree } = fc.letrec<{ tree: Tree }>((tie) => ({
  tree: fc.oneof(
    { depthSize: "small", maxDepth: 4 },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    safeStringArb,
    fc.array(tie("tree"), { maxLength: 3 }),
    fc.dictionary(fc.oneof(safeKeyArb, forbiddenKeyArb), tie("tree"), { maxKeys: 4 }),
  ),
}));

/** A forbidden-key payload that really looks like image or face data. */
const sensitiveArb = fc.record({
  hasImage: fc.constant(true),
  jpegBase64: fc.constant("QUJD"),
  face: fc.constant({ left: 0.1, top: 0.2, width: 0.3, height: 0.4 }),
  s3Key: fc.constant(S3_KEY_TEXT),
});

const dataArb = fc.tuple(tree, sensitiveArb, fc.boolean()).map(([extra, sensitive, withSensitive]) => ({
  extra,
  ...(withSensitive ? sensitive : {}),
}));

const envelopeArb = fc.record({
  v: fc.constant(1),
  id: fc.uuid(),
  ts: fc.constant("2026-11-20T12:34:56.789Z"),
  deviceId: fc.constant("warashi-01"),
  encounterId: fc.constant(null),
  type: fc.constantFrom("snapshot.captured", "state.changed", "error.reported"),
  data: dataArb,
});

const verdictArb = fc.constantFrom("family", "stranger", "no_face", "uncertain", null);

const recordArb: fc.Arbitrary<EncounterRecord> = fc
  .record({
    encounterId: fc.uuid(),
    deviceId: fc.constant("warashi-01"),
    startedAt: fc.constant("2026-11-20T12:34:56.789Z"),
    endedAt: fc.constantFrom("2026-11-20T12:35:30.100Z", null),
    state: fc.constantFrom("cooldown", "seeking", null),
    verdict: verdictArb,
    confidence: fc.constantFrom(0.5, 0.97, null),
    reaction: fc.constantFrom({ kind: "stranger", lineId: "stranger_first", offline: false }, null),
    notified: fc.boolean(),
    snapshot: fc.constantFrom({ url: `https://example.invalid/${S3_KEY_TEXT}`, expiresAt: "x" }, null),
    illustration: fc.constantFrom("silhouette-family", null),
    events: fc.array(envelopeArb, { maxLength: 5 }),
  })
  .chain((base) =>
    fc.tuple(fc.dictionary(forbiddenKeyArb, tree, { maxKeys: 3 })).map(([topForbidden]) => ({
      ...base,
      ...topForbidden,
      // The record's own snapshot field is part of the contract; keep the generated one.
      snapshot: base.snapshot,
    })),
  ) as unknown as fc.Arbitrary<EncounterRecord>;

/** Every object key found at any depth. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      out.push(key);
      allKeys(inner, out);
    }
  }
  return out;
}

/** Oracle: remove forbidden keys at any depth. */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!(FORBIDDEN as readonly string[]).includes(key)) out[key] = strip(inner);
    }
    return out;
  }
  return value;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("Feature: cloud-judgement, Property 14: Redaction", () => {
  it("reviewer output has no forbidden key at any depth and no S3 key text", () => {
    fc.assert(
      fc.property(recordArb, (record) => {
        const out = redactEncounter(record, "reviewer");
        const keys = allKeys(out).filter((k) => k !== "snapshot");
        for (const key of keys) {
          expect(FORBIDDEN as readonly string[]).not.toContain(key);
        }
        expect(out.snapshot).toBeNull();
        expect(JSON.stringify(out)).not.toContain(S3_KEY_TEXT);
      }),
      { numRuns: 200 },
    );
  });

  it("reviewer output keeps every other field, event order and event count", () => {
    fc.assert(
      fc.property(recordArb, (record) => {
        const out = redactEncounter(record, "reviewer");
        const expected = strip(record) as EncounterRecord;
        expect(out.events.length).toBe(record.events.length);
        expect(out.events.map((e) => e.id)).toEqual(record.events.map((e) => e.id));
        expect({ ...out, snapshot: null, illustration: null }).toEqual({
          ...expected,
          snapshot: null,
          illustration: null,
        });
      }),
      { numRuns: 200 },
    );
  });

  it("illustration follows the verdict, and the input is not mutated", () => {
    const table: Record<string, string> = {
      family: "silhouette-family",
      stranger: "silhouette-stranger",
      no_face: "silhouette-none",
      uncertain: "silhouette-uncertain",
    };
    fc.assert(
      fc.property(recordArb, (record) => {
        const before = clone(record);
        const out = redactEncounter(record, "reviewer");
        expect(out.illustration).toBe(record.verdict === null ? "silhouette-uncertain" : table[record.verdict]);
        expect(clone(record)).toEqual(before);
      }),
      { numRuns: 100 },
    );
  });

  it("is idempotent for reviewer and the identity for family", () => {
    fc.assert(
      fc.property(recordArb, (record) => {
        const once = redactEncounter(record, "reviewer");
        expect(redactEncounter(once, "reviewer")).toEqual(once);
        expect(redactEncounter(record, "family")).toBe(record);
      }),
      { numRuns: 100 },
    );
  });
});
