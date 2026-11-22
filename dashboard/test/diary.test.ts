import { describe, expect, it } from "vitest";
import { EN } from "../src/content/copy";
import { JA } from "../src/content/copy.ja";
import { diaryComment, diaryKind } from "../src/lib/diary";

describe("diary", () => {
  it("has the same kinds and counts in both languages, all non-empty", () => {
    const kinds = Object.keys(EN.diary.comments) as Array<keyof typeof EN.diary.comments>;
    expect(Object.keys(JA.diary.comments).sort()).toEqual([...kinds].sort());
    for (const k of kinds) {
      expect(JA.diary.comments[k].length).toBe(EN.diary.comments[k].length);
      for (const t of [...EN.diary.comments[k], ...JA.diary.comments[k]]) expect(t.length).toBeGreaterThan(0);
    }
  });
  it("maps verdicts to kinds", () => {
    const base = { notified: false, reaction: null };
    expect(diaryKind({ ...base, verdict: "stranger" })).toBe("stranger");
    expect(diaryKind({ ...base, notified: true, verdict: "stranger" })).toBe("strangerNotified");
    expect(diaryKind({ ...base, verdict: null })).toBe("unknown");
    expect(diaryKind({ ...base, verdict: null, reaction: { kind: "uncertain", lineId: null, offline: true } })).toBe("offline");
  });
  it("is stable for one id", () => {
    const e = { encounterId: "abc", verdict: "family" as const, notified: false, reaction: null };
    expect(diaryComment(e)).toBe(diaryComment(e));
  });
});
