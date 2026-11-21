// Unit tests for the voice frame codec and the reorder window.
// Validates: Requirements 5.3, 5.4, 5.7, 5.10, 16.5
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_PCM_BYTES,
  decodeIn,
  encodeOut,
  type OutFrame,
  type TextFrame,
} from "../../lambda/_shared/voice/frames.js";
import { makeReorder } from "../../lambda/_shared/voice/reorder.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../../../docs/fixtures/voice-v1");

/** Every frame of docs/schema.md "Voice session channels", as `<channel>.<t>`. */
const FRAME_NAMES = [
  "in.hello",
  "in.audio",
  "in.look.result",
  "in.bye",
  "out.audio",
  "out.interrupt",
  "out.command",
  "text.state",
  "text.transcript",
  "text.end",
];

const frameFiles = readdirSync(FIXTURE_DIR)
  .filter((n) => /^(in|out|text)\..+\.json$/.test(n))
  .sort();

const read = (file: string): unknown => JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
const b64 = (bytes: number): string => Buffer.alloc(bytes, 1).toString("base64");
const audio = (pcm: unknown, seq: unknown = 0): string => JSON.stringify({ t: "audio", seq, pcm });

describe("voice-v1 fixtures", () => {
  it("has exactly one fixture per frame type and direction", () => {
    const have = frameFiles.map((f) => f.replace(/\.json$/, ""));
    for (const name of FRAME_NAMES) {
      expect(have, `frame ${name} has no fixture`).toContain(name);
    }
    for (const name of have) {
      expect(FRAME_NAMES, `fixture ${name}.json has no frame`).toContain(name);
    }
  });

  it.each(frameFiles.filter((f) => f.startsWith("in.")))(
    "%s decodes to valid and re-encodes to an equal value",
    (file) => {
      const value = read(file);
      const result = decodeIn(JSON.stringify(value));
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") {
        expect(JSON.parse(JSON.stringify(result.frame))).toEqual(value);
      }
    },
  );

  it.each(frameFiles.filter((f) => !f.startsWith("in.")))(
    "%s is a frame with the right t and survives encodeOut",
    (file) => {
      const value = read(file) as OutFrame | TextFrame;
      expect(file).toBe(`${file.split(".")[0]}.${value.t}.json`);
      expect(JSON.parse(encodeOut(value))).toEqual(value);
    },
  );

  it("decodeIn does not accept an out or text frame as an in frame", () => {
    for (const file of frameFiles.filter((f) => !f.startsWith("in."))) {
      const raw = JSON.stringify(read(file));
      const t = (JSON.parse(raw) as { t: string }).t;
      // audio exists in both directions; the others must be refused or fail field checks.
      if (t !== "audio") expect(decodeIn(raw).kind).toBe("malformed");
    }
  });
});

describe("decodeIn", () => {
  it("accepts a chunk at the 12,800 byte limit and an empty chunk", () => {
    expect(decodeIn(audio(b64(MAX_PCM_BYTES))).kind).toBe("valid");
    expect(decodeIn(audio("")).kind).toBe("valid");
  });

  it.each([
    ["odd decoded length", audio(b64(3))],
    ["invalid Base64 characters", audio("@@@@")],
    ["bad Base64 padding", audio("AAA")],
    ["oversize chunk", audio(b64(MAX_PCM_BYTES + 2))],
    ["pcm not a string", audio(123)],
    ["pcm missing", JSON.stringify({ t: "audio", seq: 0 })],
    ["seq not a number", audio("AAAA", "1")],
    ["seq fractional", audio("AAAA", 1.5)],
    ["seq negative", audio("AAAA", -1)],
    ["hello bad client", JSON.stringify({ t: "hello", client: "tv", v: 1 })],
    ["hello bad v", JSON.stringify({ t: "hello", client: "device", v: "1" })],
    ["look.result bad requestId", JSON.stringify({ t: "look.result", requestId: "a b", verdict: "family" })],
    ["look.result bad verdict", JSON.stringify({ t: "look.result", requestId: "r1", verdict: "friend" })],
    ["bye bad reason", JSON.stringify({ t: "bye", reason: "stranger" })],
    ["unknown t", JSON.stringify({ t: "ghost" })],
    ["missing t", JSON.stringify({ seq: 1 })],
    ["t not a string", JSON.stringify({ t: 1 })],
    ["not JSON", "{nope"],
    ["array", "[]"],
    ["null", "null"],
    ["number", "5"],
  ])("returns malformed for %s without throwing", (_name, raw) => {
    const result = decodeIn(raw);
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("encodeOut", () => {
  it("never throws and returns an object without t for unencodable values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(encodeOut(circular as unknown as OutFrame)).toBe("{}");
    expect(encodeOut(undefined as unknown as OutFrame)).toBe("{}");
    expect(encodeOut({ t: "interrupt" })).toBe('{"t":"interrupt"}');
  });
});

describe("makeReorder", () => {
  const seqs = (r: readonly { seq: number }[]): number[] => r.map((f) => f.seq);

  it("delivers in-order frames at once", () => {
    const r = makeReorder(4);
    expect(seqs(r.push(0, "a"))).toEqual([0]);
    expect(seqs(r.push(1, "b"))).toEqual([1]);
    expect(r.missed()).toBe(0);
  });

  it("holds a frame until the gap fills, then delivers in order", () => {
    const r = makeReorder(4);
    r.push(0, "a");
    expect(r.push(2, "c")).toEqual([]);
    expect(r.push(3, "d")).toEqual([]);
    expect(seqs(r.push(1, "b"))).toEqual([1, 2, 3]);
    expect(r.missed()).toBe(0);
  });

  it("drops duplicates, both held and already delivered", () => {
    const r = makeReorder(4);
    r.push(0, "a");
    expect(r.push(0, "a")).toEqual([]);
    r.push(2, "c");
    expect(r.push(2, "c")).toEqual([]);
    expect(seqs(r.push(1, "b"))).toEqual([1, 2]);
  });

  it("gives up on a gap when more than `window` frames are held and counts the skipped numbers", () => {
    const r = makeReorder(2);
    r.push(0, "a");
    r.push(3, "d");
    r.push(4, "e");
    expect(seqs(r.push(5, "f"))).toEqual([3, 4, 5]);
    expect(r.missed()).toBe(2);
  });

  it("drops a late frame behind the delivery point and does not count it", () => {
    const r = makeReorder(1);
    r.push(0, "a");
    r.push(3, "d");
    r.push(4, "e"); // gap 1..2 abandoned
    expect(r.missed()).toBe(2);
    expect(r.push(1, "b")).toEqual([]);
    expect(r.missed()).toBe(2);
  });

  it("starts at the first frame seen and ignores invalid seq values", () => {
    const r = makeReorder(4);
    expect(r.push(-1, "x")).toEqual([]);
    expect(r.push(1.5, "x")).toEqual([]);
    expect(r.push(Number.NaN, "x")).toEqual([]);
    expect(seqs(r.push(7, "a"))).toEqual([7]);
  });

  it("treats a non-finite or tiny window as 1", () => {
    for (const w of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = makeReorder(w);
      r.push(0, "a");
      r.push(2, "c");
      expect(seqs(r.push(3, "d"))).toEqual([2, 3]);
      expect(r.missed()).toBe(1);
    }
  });
});
