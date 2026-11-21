import { describe, expect, it } from "vitest";
import { ALL_TYPES, decodeText, decodeValue, encode } from "../src/simulation/codec";

const base = {
  v: 1,
  id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a08",
  ts: "2026-11-20T12:34:56.789Z",
  deviceId: "warashi-01",
  encounterId: null,
};
const speak = (data: object) => ({ ...base, type: "speak", data });
const okData = { lineId: "greet_family_01", audioUrl: null, ja: "あ", en: "a" };

describe("codec", () => {
  it("round-trips a valid message and drops extra fields", () => {
    const r = decodeValue(speak({ ...okData, name: "secret" }));
    expect(r.kind).toBe("valid");
    if (r.kind !== "valid") return;
    expect(r.message.data).toEqual(okData);
    expect(decodeText(encode(r.message))).toEqual(r);
  });

  it("names the first failing rule", () => {
    const rule = (x: unknown) => {
      const r = decodeValue(x);
      return r.kind === "malformed" ? r.rule : r.kind;
    };
    expect(rule(5)).toBe("not_object");
    expect(rule({ ...speak(okData), v: 1.5 })).toBe("version_type");
    expect(rule({ ...speak(okData), v: true })).toBe("version_type");
    expect(rule({ ...speak(okData), v: 2 })).toBe("unsupported_version");
    expect(rule({ ...speak(okData), id: undefined })).toBe("missing_field");
    expect(rule(speak({ ...okData, ja: 1 }))).toBe("wrong_type");
    expect(rule({ ...base, type: "gaze", data: { panDeg: NaN, tiltDeg: 0 } })).toBe("non_finite");
    expect(rule({ ...base, type: "mode.set", data: { mode: "x" } })).toBe("bad_enum");
    expect(rule(speak({ ...okData, audioUrl: "https://x" }))).toBe("speak_source");
    expect(rule({ ...base, type: "nope", data: {} })).toBe("unknown_type");
    expect(decodeText("{")).toMatchObject({ rule: "json" });
    expect(decodeText(" ".repeat(131_073))).toMatchObject({ rule: "size" });
  });

  it("lists every type", () => {
    expect(ALL_TYPES).toHaveLength(18);
  });
});
