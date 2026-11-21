import { describe, expect, it } from "vitest";
import { MAX_LINE_CHARS, sanitizeLine } from "../lambda/_shared/sanitizer.js";

describe("sanitizeLine", () => {
  it("accepts a normal line and trims it", () => {
    expect(sanitizeLine("  おかえり。きょうも ぶじで よかった。 ", [])).toBe(
      "おかえり。きょうも ぶじで よかった。",
    );
  });

  it("accepts two sentences and rejects three", () => {
    expect(sanitizeLine("おかえり。まってたよ。", [])).not.toBeNull();
    expect(sanitizeLine("おかえり。まってたよ。ねむいよ。", [])).toBeNull();
  });

  it("treats an ellipsis as a pause, not a sentence", () => {
    expect(sanitizeLine("……だれか、いるの？", [])).not.toBeNull();
  });

  it("rejects empty and over-long text", () => {
    expect(sanitizeLine("   ", [])).toBeNull();
    expect(sanitizeLine("あ".repeat(MAX_LINE_CHARS), [])).not.toBeNull();
    expect(sanitizeLine("あ".repeat(MAX_LINE_CHARS + 1), [])).toBeNull();
  });

  it("rejects Latin letters and emoji", () => {
    expect(sanitizeLine("おかえり OK", [])).toBeNull();
    expect(sanitizeLine("おかえり😀", [])).toBeNull();
  });

  it("rejects a blocked word, case-insensitively and after normalization", () => {
    expect(sanitizeLine("たろうが きたね", ["たろう"])).toBeNull();
    expect(sanitizeLine("ｶﾀｶﾅ のひと", ["カタカナ"])).toBeNull();
    expect(sanitizeLine("たろうが きたね", [""])).not.toBeNull();
  });

  it("rejects threats", () => {
    expect(sanitizeLine("ころしてやる", [])).toBeNull();
    expect(sanitizeLine("のろってやる", [])).toBeNull();
    expect(sanitizeLine("ゆるさないよ", [])).toBeNull();
  });
});
