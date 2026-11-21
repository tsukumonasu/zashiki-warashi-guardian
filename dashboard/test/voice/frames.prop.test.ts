// Feature: voice-conversation, Property 6: Frame codec round trip and robustness (dashboard)
// **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.10, 13.3, 16.4**

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeIn,
  decodeOut,
  decodeText,
  encodeIn,
  encodeOut,
  END_REASONS,
  MAX_PCM_BYTES,
  type InFrame,
  type OutFrame,
  type TextFrame,
} from "../../src/voice/frames";

const NUM_RUNS = 200;
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "fixtures", "voice-v1");

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const bytesOf = (n: number) => fc.uint8Array({ minLength: n, maxLength: n });

const validPcm = fc
  .oneof(fc.integer({ min: 0, max: 300 }), fc.constantFrom(0, 2, MAX_PCM_BYTES - 2, MAX_PCM_BYTES))
  .map((n) => n - (n % 2))
  .chain((n) => bytesOf(n))
  .map(b64);
const oddPcm = fc.integer({ min: 0, max: 300 }).chain((k) => bytesOf(2 * k + 1)).map(b64);
const oversizePcm = fc
  .integer({ min: MAX_PCM_BYTES / 2 + 1, max: MAX_PCM_BYTES / 2 + 200 })
  .chain((k) => bytesOf(2 * k))
  .map(b64);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const badBase64 = fc.oneof(
  fc
    .tuple(fc.string({ maxLength: 8 }), fc.constantFrom("!", " ", "-", "_", "=", "あ", "\n"), fc.string({ maxLength: 8 }))
    .map(([a, c, b]) => `${a}${c}${b}`)
    .filter((s) => !BASE64_RE.test(s)),
  fc.stringMatching(/^[A-Za-z0-9+/]{1,40}$/).filter((s) => s.length % 4 === 1),
);

const seqArb = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
const idArb = fc.stringMatching(/^[A-Za-z0-9-]{1,64}$/);

const inFrameArb: fc.Arbitrary<InFrame> = fc.oneof(
  fc.record({
    t: fc.constant("hello" as const),
    client: fc.constantFrom("device" as const, "browser" as const),
    v: fc.constant(1 as const),
  }),
  fc.record({ t: fc.constant("audio" as const), seq: seqArb, pcm: validPcm }),
  fc.record({
    t: fc.constant("look.result" as const),
    requestId: idArb,
    verdict: fc.constantFrom("family" as const, "stranger" as const, "no_face" as const, "uncertain" as const),
  }),
  fc.record({
    t: fc.constant("bye" as const),
    reason: fc.constantFrom("user" as const, "silence" as const, "limit" as const, "error" as const),
  }),
);

const envelopeArb = fc.record({
  v: fc.constant(1 as const),
  id: fc.uuid(),
  ts: fc.constant("2026-11-20T12:34:56.789Z"),
  deviceId: fc.constant("warashi-sim"),
  encounterId: fc.constant(null),
  type: fc.constant("gaze" as const),
  data: fc.record({ panDeg: fc.integer({ min: -60, max: 60 }), tiltDeg: fc.integer({ min: -30, max: 30 }) }),
});

const outFrameArb = fc.oneof(
  fc.record({ t: fc.constant("audio" as const), seq: seqArb, pcm: validPcm }),
  fc.constant({ t: "interrupt" as const }),
  envelopeArb.map((envelope) => ({ t: "command" as const, envelope })),
) as unknown as fc.Arbitrary<OutFrame>;

const textFrameArb = fc.oneof(
  fc.record({
    t: fc.constant("state" as const),
    state: fc.constantFrom("waiting" as const, "live" as const, "ending" as const),
  }),
  fc.record({
    t: fc.constant("transcript" as const),
    role: fc.constantFrom("user" as const, "assistant" as const),
    text: fc.string({ unit: "grapheme", maxLength: 80 }),
    final: fc.boolean(),
  }),
  fc.record({ t: fc.constant("end" as const), reason: fc.constantFrom(...END_REASONS) }),
) as fc.Arbitrary<TextFrame>;

const audioJson = (over: Record<string, unknown>): string =>
  JSON.stringify({ t: "audio", seq: 0, pcm: "AAAA", ...over });

describe("Feature: voice-conversation, Property 6: Frame codec round trip and robustness (dashboard)", () => {
  it("decodeIn(encodeIn(f)) equals f for every valid inbound frame", () => {
    fc.assert(
      fc.property(inFrameArb, (f) => {
        expect(decodeIn(encodeIn(f))).toEqual({ kind: "valid", frame: f });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("decodeOut and decodeText invert encodeOut for every valid frame", () => {
    fc.assert(
      fc.property(outFrameArb, (f) => {
        expect(decodeOut(encodeOut(f))).toEqual({ kind: "valid", frame: f });
      }),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(textFrameArb, (f) => {
        expect(decodeText(encodeOut(f))).toEqual({ kind: "valid", frame: f });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("no decoder throws for any string, and a valid result has a known t", () => {
    const anyText = fc.oneof(
      fc.string({ unit: "binary", maxLength: 200 }),
      fc.json(),
      fc.jsonValue().map((v) => JSON.stringify(v)),
      inFrameArb.map((f) => JSON.stringify(f).slice(0, 40)),
      outFrameArb.map((f) => JSON.stringify(f).slice(0, 40)),
      textFrameArb.map((f) => JSON.stringify(f).slice(0, 20)),
    );
    fc.assert(
      fc.property(anyText, (s) => {
        const a = decodeIn(s);
        const b = decodeOut(s);
        const c = decodeText(s);
        for (const r of [a, b, c]) expect(["valid", "malformed"]).toContain(r.kind);
        if (a.kind === "valid") expect(["hello", "audio", "look.result", "bye"]).toContain(a.frame.t);
        if (b.kind === "valid") expect(["audio", "interrupt", "command"]).toContain(b.frame.t);
        if (c.kind === "valid") expect(["state", "transcript", "end"]).toContain(c.frame.t);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("an audio frame with odd, oversize or non-Base64 pcm is malformed (in and out)", () => {
    fc.assert(
      fc.property(fc.oneof(oddPcm, oversizePcm, badBase64), seqArb, (pcm, seq) => {
        const raw = audioJson({ pcm, seq });
        expect(decodeIn(raw).kind).toBe("malformed");
        expect(decodeOut(raw).kind).toBe("malformed");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("wrong field types, a bad seq or an unknown t is malformed", () => {
    const notString = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.string(), { maxLength: 2 }));
    const badSeq = fc.oneof(
      fc.string(),
      fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Number.isInteger(n)),
      fc.integer({ max: -1 }),
      fc.constant(null),
      fc.constant(Number.MAX_SAFE_INTEGER + 2),
    );
    const unknownT = fc
      .oneof(fc.string({ maxLength: 12 }), notString)
      .filter((t) => !["hello", "audio", "look.result", "bye"].includes(t as string));
    const notIn = (xs: string[]) => fc.string({ maxLength: 12 }).filter((v) => !xs.includes(v));
    fc.assert(
      fc.property(
        fc.oneof(
          notString.map((pcm) => audioJson({ pcm })),
          badSeq.map((seq) => audioJson({ seq })),
          unknownT.map((t) => JSON.stringify({ t, seq: 0, pcm: "AAAA" })),
          notString.map((client) => JSON.stringify({ t: "hello", client, v: 1 })),
          fc
            .oneof(fc.integer().filter((n) => n !== 1), fc.string(), fc.boolean())
            .map((v) => JSON.stringify({ t: "hello", client: "device", v })),
          notString.map((requestId) => JSON.stringify({ t: "look.result", requestId, verdict: "family" })),
          notIn(["family", "stranger", "no_face", "uncertain"]).map((verdict) =>
            JSON.stringify({ t: "look.result", requestId: "r1", verdict }),
          ),
          notIn(["user", "silence", "limit", "error"]).map((reason) => JSON.stringify({ t: "bye", reason })),
        ),
        (raw) => {
          expect(decodeIn(raw).kind).toBe("malformed");
        },
      ),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(
        fc.oneof(
          notIn([...END_REASONS]).map((reason) => JSON.stringify({ t: "end", reason })),
          notIn(["waiting", "live", "ending"]).map((state) => JSON.stringify({ t: "state", state })),
          notIn(["user", "assistant"]).map((role) =>
            JSON.stringify({ t: "transcript", role, text: "x", final: true }),
          ),
        ),
        (raw) => {
          expect(decodeText(raw).kind).toBe("malformed");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("every golden fixture decodes and re-encodes to an equal value", () => {
    const files = readdirSync(FIXTURE_DIR).filter((n) => /^(in|out|text)\..+\.json$/.test(n));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const raw = readFileSync(join(FIXTURE_DIR, file), "utf8");
      const parsed: unknown = JSON.parse(raw);
      const result = file.startsWith("in.") ? decodeIn(raw) : file.startsWith("out.") ? decodeOut(raw) : decodeText(raw);
      expect(result.kind, file).toBe("valid");
      if (result.kind === "valid") {
        const reencoded = file.startsWith("in.")
          ? encodeIn(result.frame as InFrame)
          : encodeOut(result.frame as OutFrame | TextFrame);
        expect(JSON.parse(reencoded), file).toEqual(parsed);
      }
    }
  });
});
