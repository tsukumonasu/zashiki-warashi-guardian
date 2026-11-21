// Unit tests of the pure latency helpers (task 24.1). They need no AWS and always run.
import { describe, expect, it } from "vitest";
import { describeGroupsClaim, jwtPayload, percentile, summarize } from "./integration/latency.js";

describe("latency helpers", () => {
  it("computes nearest-rank percentiles", () => {
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(percentile(values, 50)).toBe(1000);
    expect(percentile(values, 95)).toBe(1900);
    expect(percentile([5], 95)).toBe(5);
    expect(() => percentile([], 50)).toThrow(RangeError);
  });

  it("compares p95 with the R6.7 target of the path", () => {
    const ok = summarize("family", Array(20).fill(2900));
    const over = summarize("stranger", Array(20).fill(4100));
    expect(ok.withinTarget).toBe(true);
    expect(over.withinTarget).toBe(false);
  });

  it("describes the claim shape and decodes a JWT payload", () => {
    expect(describeGroupsClaim(["family"])).toBe("array of 1 strings");
    expect(describeGroupsClaim("[family]")).toBe("string");
    expect(describeGroupsClaim(undefined)).toBe("absent");
    const payload = Buffer.from(JSON.stringify({ "cognito:groups": ["family"] })).toString("base64url");
    expect(jwtPayload(`x.${payload}.y`)["cognito:groups"]).toEqual(["family"]);
  });
});
