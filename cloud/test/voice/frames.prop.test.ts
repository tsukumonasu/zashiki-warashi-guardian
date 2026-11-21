// Feature: voice-conversation, Property 6: Frame codec round trip and robustness
// Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.7, 5.10, 16.4, 16.5

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeIn,
  encodeOut,
  MAX_PCM_BYTES,
  type InFrame,
  type OutFrame,
  type TextFrame,
} from "../../lambda/_shared/voice/frames.js";
import { makeReorder } from "../../lambda/_shared/voice/reorder.js";

const NUM_RUNS = 200;
const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/voice-v1",
);

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** Bytes of an exact length. */
const bytesOf = (n: number) => fc.uint8Array({ minLength: n, maxLength: n });

/** Valid pcm: even decoded length, at most MAX_PCM_BYTES, with the boundaries always reachable. */
const validPcm = fc
  .oneof(
    fc.integer({ min: 0, max: 300 }),
    fc.constantFrom(0, 2, MAX_PCM_BYTES - 2, MAX_PCM_BYTES),
  )
  .map((n) => n - (n % 2))
  .chain((n) => bytesOf(n))
  .map(b64);

const oddPcm = fc
  .integer({ min: 0, max: 300 })
  .chain((k) => bytesOf(2 * k + 1))
  .map(b64);

const oversizePcm = fc
  .integer({ min: MAX_PCM_BYTES / 2 + 1, max: MAX_PCM_BYTES / 2 + 200 })
  .chain((k) => bytesOf(2 * k))
  .map(b64);

/** Strings that are not valid Base64: a character outside the alphabet, or a bad length. */
const badBase64 = fc.oneof(
  fc.tuple(fc.string({ maxLength: 8 }), fc.constantFrom("!", " ", "-", "_", "=", "あ", "\n"), fc.string({ maxLength: 8 }))
    .map(([a, c, b]) => `${a}${c}${b}`)
    .filter((s) => !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)),
  fc.stringMatching(/^[A-Za-z0-9+/]{1,40}$/).filter((s) => s.length % 4 === 1),
);

const seqArb = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
const idArb = fc.stringMatching(/^[A-Za-z0-9-]{1,64}$/);
const verdictArb = fc.constantFrom("family", "stranger", "no_face", "uncertain" as const);

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
    verdict: verdictArb as fc.Arbitrary<"family" | "stranger" | "no_face" | "uncertain">,
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

const END_REASONS = [
  "silence", "limit", "stranger", "user", "manual", "language", "unsafe_output", "error", "no_client", "offline",
] as const;

const outFrameArb = fc.oneof(
  fc.record({ t: fc.constant("audio" as const), seq: seqArb, pcm: validPcm }),
  fc.constant({ t: "interrupt" as const }),
  envelopeArb.map((envelope) => ({ t: "command" as const, envelope })),
) as fc.Arbitrary<OutFrame>;

const textFrameArb = fc.oneof(
  fc.record({ t: fc.constant("state" as const), state: fc.constantFrom("waiting" as const, "live" as const, "ending" as const) }),
  fc.record({
    t: fc.constant("transcript" as const),
    role: fc.constantFrom("user" as const, "assistant" as const),
    text: fc.string({ unit: "grapheme", maxLength: 80 }),
    final: fc.boolean(),
  }),
  fc.record({ t: fc.constant("end" as const), reason: fc.constantFrom(...END_REASONS) }),
) as fc.Arbitrary<TextFrame>;

/** Replaces `key` in an audio frame object and returns its JSON text. */
const audioJson = (over: Record<string, unknown>): string =>
  JSON.stringify({ t: "audio", seq: 0, pcm: "AAAA", ...over });

describe("Feature: voice-conversation, Property 6: Frame codec round trip and robustness", () => {
  it("decodeIn(encode(f)) equals f for every valid inbound frame", () => {
    fc.assert(
      fc.property(inFrameArb, (f) => {
        const r = decodeIn(JSON.stringify(f));
        expect(r).toEqual({ kind: "valid", frame: f });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("encodeOut produces JSON that parses back to the same outbound or text frame", () => {
    fc.assert(
      fc.property(fc.oneof(outFrameArb, textFrameArb), (f) => {
        expect(JSON.parse(encodeOut(f))).toEqual(f);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("decodeIn never throws for any string and a valid result is always a known frame", () => {
    const anyText = fc.oneof(
      fc.string({ unit: "binary", maxLength: 200 }),
      fc.json(),
      fc.jsonValue().map((v) => JSON.stringify(v)),
      inFrameArb.map((f) => JSON.stringify(f).slice(0, 40)),
    );
    fc.assert(
      fc.property(anyText, (s) => {
        const r = decodeIn(s);
        expect(["valid", "malformed"]).toContain(r.kind);
        if (r.kind === "valid") {
          expect(["hello", "audio", "look.result", "bye"]).toContain(r.frame.t);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("an audio frame with odd, oversize or non-Base64 pcm is malformed", () => {
    fc.assert(
      fc.property(fc.oneof(oddPcm, oversizePcm, badBase64), seqArb, (pcm, seq) => {
        expect(decodeIn(audioJson({ pcm, seq })).kind).toBe("malformed");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("wrong field types, a bad seq or an unknown t is malformed", () => {
    const notString = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.string(), { maxLength: 2 }));
    const badSeq = fc.oneof(
      fc.string(),
      fc.double({ noInteger: true, noNaN: true, noDefaultInfinity: true }).filter((n) => !Number.isInteger(n)),
      fc.integer({ max: -1 }),
      fc.constant(null),
      fc.constant(Number.MAX_SAFE_INTEGER + 2),
    );
    const unknownT = fc
      .oneof(fc.string({ maxLength: 12 }), notString)
      .filter((t) => !["hello", "audio", "look.result", "bye"].includes(t as string));
    fc.assert(
      fc.property(
        fc.oneof(
          notString.map((pcm) => audioJson({ pcm })),
          badSeq.map((seq) => audioJson({ seq })),
          unknownT.map((t) => JSON.stringify({ t, seq: 0, pcm: "AAAA" })),
          notString.map((client) => JSON.stringify({ t: "hello", client, v: 1 })),
          fc.oneof(fc.integer().filter((n) => n !== 1), fc.string(), fc.boolean()).map((v) =>
            JSON.stringify({ t: "hello", client: "device", v }),
          ),
          notString.map((requestId) => JSON.stringify({ t: "look.result", requestId, verdict: "family" })),
          fc.string({ maxLength: 12 }).filter((v) => !["family", "stranger", "no_face", "uncertain"].includes(v)).map(
            (verdict) => JSON.stringify({ t: "look.result", requestId: "r1", verdict }),
          ),
          fc.string({ maxLength: 12 }).filter((r) => !["user", "silence", "limit", "error"].includes(r)).map(
            (reason) => JSON.stringify({ t: "bye", reason }),
          ),
        ),
        (raw) => {
          expect(decodeIn(raw).kind).toBe("malformed");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("every golden fixture decodes (inbound) and re-encodes to an equal value", () => {
    const files = readdirSync(FIXTURE_DIR).filter((n) => /^(in|out|text)\..+\.json$/.test(n));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const raw = readFileSync(path.join(FIXTURE_DIR, file), "utf8");
      const parsed = JSON.parse(raw) as InFrame | OutFrame | TextFrame;
      if (file.startsWith("in.")) {
        const r = decodeIn(raw);
        expect(r.kind, file).toBe("valid");
        if (r.kind === "valid") expect(JSON.parse(JSON.stringify(r.frame)), file).toEqual(parsed);
      } else {
        expect(JSON.parse(encodeOut(parsed as OutFrame | TextFrame)), file).toEqual(parsed);
      }
    }
  });

  it("the reorder window delivers increasing, unique seq, holds at most `window` frames and counts every gap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 80 }),
        (window, seqs) => {
          const r = makeReorder(window);
          const pcmOf = (s: number) => `p${s}`;
          const delivered: number[] = [];
          const pushed = new Set<number>();
          for (const s of seqs) {
            pushed.add(s);
            for (const f of r.push(s, pcmOf(s))) {
              expect(f.pcm).toBe(pcmOf(f.seq));
              delivered.push(f.seq);
            }
            // Frames still held are the distinct pushed seqs beyond the delivery point.
            const last = delivered.length > 0 ? delivered[delivered.length - 1] as number : -1;
            const held = [...pushed].filter((x) => x > last).length;
            expect(held).toBeLessThanOrEqual(window);
          }
          for (let i = 1; i < delivered.length; i++) {
            expect(delivered[i] as number).toBeGreaterThan(delivered[i - 1] as number);
          }
          expect(new Set(delivered).size).toBe(delivered.length);
          // Every number between the first and the last delivered seq was delivered or counted missed.
          const first = seqs[0] as number;
          const last = delivered[delivered.length - 1] as number;
          expect(delivered.length + r.missed()).toBe(last - first + 1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
