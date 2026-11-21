import { describe, expect, it } from "vitest";
import { chooseLine, type VoiceLine } from "../lambda/_shared/lines.js";

const lines: VoiceLine[] = [
  { id: "a", category: "family", ja: "あ", en: "a" },
  { id: "b", category: "family", ja: "い", en: "b" },
  { id: "c", category: "stranger", ja: "う", en: "c" },
];

describe("chooseLine", () => {
  it("returns null when the category has no lines", () => {
    expect(chooseLine(lines, "uncertain", 0.5)).toBeNull();
    expect(chooseLine([], "family", 0)).toBeNull();
  });

  it("picks within the category by rand", () => {
    expect(chooseLine(lines, "family", 0)?.id).toBe("a");
    expect(chooseLine(lines, "family", 0.5)?.id).toBe("b");
    expect(chooseLine(lines, "stranger", 0.99)?.id).toBe("c");
  });

  it("guards the index for the largest double below 1 and bad rand", () => {
    expect(chooseLine(lines, "family", 1 - Number.EPSILON / 2)?.id).toBe("b");
    expect(chooseLine(lines, "family", Number.NaN)?.id).toBe("a");
    expect(chooseLine(lines, "family", -1)?.id).toBe("a");
  });
});
