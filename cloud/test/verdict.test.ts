// Unit tests for the Verdict_Engine branches and boundaries (task 7.2; R5.2 to R5.7, R5.9).
import { describe, expect, it } from "vitest";
import {
  classifySearchError,
  decideVerdict,
  isStrangerCandidate,
  type AdapterFailure,
  type FaceBox,
  type FaceQuality,
  type SearchOutcome,
  type VerdictConfig,
} from "../lambda/_shared/verdict.js";

const C: VerdictConfig = {
  searchFloor: 50,
  familyMin: 90,
  strangerMax: 70,
  faceConfidenceMin: 90,
  minFaceWidth: 0.08,
  minSharpness: 30,
  minBrightness: 25,
  maxYawDeg: 40,
  acceptMin: 0.8,
};

const BOX: FaceBox = { left: 0.4, top: 0.3, width: 0.2, height: 0.25 };
const GOOD_Q: FaceQuality = { sharpness: 80, brightness: 100, yawDeg: 5 };

function face(
  bestSimilarity: number | null,
  opts: { faceConfidence?: number; box?: FaceBox } = {},
): SearchOutcome {
  return {
    kind: "face",
    box: opts.box ?? BOX,
    faceConfidence: opts.faceConfidence ?? 99,
    bestSimilarity,
  };
}

describe("decideVerdict: failure and no_face (R5.6, R5.9)", () => {
  it.each(["search", "detect", "store"] as const)("adapter failure at %s is uncertain", (stage) => {
    const f: AdapterFailure = { kind: "failure", stage };
    expect(decideVerdict(f, GOOD_Q, C)).toEqual({
      verdict: "uncertain",
      confidence: 0,
      face: null,
      reason: "adapter_failure",
    });
  });

  it("no_face has confidence 1 and no face box", () => {
    expect(decideVerdict({ kind: "no_face" }, null, C)).toEqual({
      verdict: "no_face",
      confidence: 1,
      face: null,
      reason: "no_face",
    });
  });
});

describe("decideVerdict: family band (R5.2)", () => {
  it("exactly familyMin is family", () => {
    const j = decideVerdict(face(90), null, C);
    expect(j.verdict).toBe("family");
    expect(j.confidence).toBeCloseTo(0.9);
    expect(j.face).toEqual(BOX);
  });

  it("just below familyMin is uncertain", () => {
    const j = decideVerdict(face(89.99), null, C);
    expect(j.verdict).toBe("uncertain");
    expect(j.reason).toBe("similarity_band");
  });

  it("family below acceptMin is uncertain", () => {
    const j = decideVerdict(face(90), null, { ...C, familyMin: 75, acceptMin: 0.8 });
    expect(j.verdict).toBe("family");
    const k = decideVerdict(face(79), null, { ...C, familyMin: 75, acceptMin: 0.8 });
    expect(k).toMatchObject({ verdict: "uncertain", reason: "low_confidence" });
  });

  it("family does not need face quality", () => {
    expect(decideVerdict(face(100), null, C).verdict).toBe("family");
  });
});

describe("decideVerdict: uncertain band (R5.3)", () => {
  it("exactly strangerMax is uncertain, not stranger", () => {
    const j = decideVerdict(face(70), GOOD_Q, C);
    expect(j).toMatchObject({ verdict: "uncertain", reason: "similarity_band" });
    expect(j.confidence).toBeCloseTo(0.7);
  });

  it("just below strangerMax with a good face is stranger", () => {
    expect(decideVerdict(face(69.99), GOOD_Q, C).verdict).toBe("stranger");
  });
});

describe("decideVerdict: stranger (R5.4, R5.5, R5.7)", () => {
  it("no match with a good face is stranger; confidence is the face confidence", () => {
    const j = decideVerdict(face(null, { faceConfidence: 97 }), GOOD_Q, C);
    expect(j).toMatchObject({ verdict: "stranger", reason: "no_household_match" });
    expect(j.confidence).toBeCloseTo(0.97);
    expect(j.face).toEqual(BOX);
  });

  it("weak face confidence is uncertain; exactly the minimum is allowed", () => {
    const weak = decideVerdict(face(null, { faceConfidence: 89.9 }), GOOD_Q, C);
    expect(weak).toMatchObject({ verdict: "uncertain", reason: "weak_face" });
    expect(weak.confidence).toBeCloseTo(0.899);
    expect(decideVerdict(face(null, { faceConfidence: 90 }), GOOD_Q, C).verdict).toBe("stranger");
  });

  it("small face is uncertain; exactly minFaceWidth is allowed", () => {
    const small = decideVerdict(face(null, { box: { ...BOX, width: 0.079 } }), GOOD_Q, C);
    expect(small).toMatchObject({ verdict: "uncertain", reason: "face_too_small" });
    expect(decideVerdict(face(null, { box: { ...BOX, width: 0.08 } }), GOOD_Q, C).verdict).toBe(
      "stranger",
    );
  });

  it("missing quality is uncertain", () => {
    expect(decideVerdict(face(null), null, C)).toMatchObject({
      verdict: "uncertain",
      reason: "poor_quality",
    });
  });

  it.each([
    ["sharpness", { sharpness: 29.9 }, { sharpness: 30 }],
    ["brightness", { brightness: 24.9 }, { brightness: 25 }],
    ["yaw right", { yawDeg: 40.1 }, { yawDeg: 40 }],
    ["yaw left", { yawDeg: -40.1 }, { yawDeg: -40 }],
  ] as const)("quality limit %s: just beyond is uncertain, at the limit is stranger", (_n, bad, ok) => {
    const qBad = { ...GOOD_Q!, ...bad };
    const qOk = { ...GOOD_Q!, ...ok };
    expect(decideVerdict(face(null), qBad, C)).toMatchObject({
      verdict: "uncertain",
      reason: "poor_quality",
    });
    expect(decideVerdict(face(null), qOk, C).verdict).toBe("stranger");
  });

  it("stranger below acceptMin is uncertain", () => {
    const c = { ...C, faceConfidenceMin: 50 };
    const j = decideVerdict(face(null, { faceConfidence: 79 }), GOOD_Q, c);
    expect(j).toMatchObject({ verdict: "uncertain", reason: "low_confidence" });
  });
});

describe("decideVerdict: output ranges", () => {
  it("clamps the face box to 0..1 and maps non-finite numbers to 0", () => {
    const box = { left: -0.2, top: 1.5, width: Number.NaN, height: Number.POSITIVE_INFINITY };
    const j = decideVerdict(face(95, { box }), null, C);
    expect(j.face).toEqual({ left: 0, top: 1, width: 0, height: 0 });
  });

  it("clamps confidence to 0..1", () => {
    expect(decideVerdict(face(150), null, C).confidence).toBe(1);
  });
});

describe("isStrangerCandidate", () => {
  it("is false for no_face", () => {
    expect(isStrangerCandidate({ kind: "no_face" }, C)).toBe(false);
  });
  it("is true for no match and for similarity below strangerMax", () => {
    expect(isStrangerCandidate(face(null), C)).toBe(true);
    expect(isStrangerCandidate(face(69.99), C)).toBe(true);
  });
  it("is false at strangerMax and above", () => {
    expect(isStrangerCandidate(face(70), C)).toBe(false);
    expect(isStrangerCandidate(face(95), C)).toBe(false);
  });
});

describe("classifySearchError (R5.7)", () => {
  it("maps InvalidParameterException to the no-face check", () => {
    expect(classifySearchError("InvalidParameterException")).toBe("no_face_or_bad_param");
  });
  it.each([
    "ThrottlingException",
    "ProvisionedThroughputExceededException",
    "LimitExceededException",
  ])("maps %s to throttled", (name) => {
    expect(classifySearchError(name)).toBe("throttled");
  });
  it.each(["AccessDeniedException", "InternalServerError", "", "invalidparameterexception"])(
    "maps %j to failure",
    (name) => {
      expect(classifySearchError(name)).toBe("failure");
    },
  );
});
