/**
 * Pure verdict logic for the Judge function. No AWS imports: the adapters turn Rekognition
 * responses into `SearchOutcome` values and this module decides what they mean.
 *
 * Why the bands: Rekognition only reports a similarity. A high value is family, a low value
 * (or no match) may be a stranger, and the middle band is `uncertain` so the doll never
 * accuses a family member. A stranger needs a good-quality face, because a blurred or dark
 * face also looks like "no match".
 */

export type Verdict = "family" | "stranger" | "no_face" | "uncertain";

/** Fractions 0..1 of the image. */
export type FaceBox = { left: number; top: number; width: number; height: number };

export type SearchOutcome =
  | { kind: "no_face" }
  | { kind: "face"; box: FaceBox; faceConfidence: number; bestSimilarity: number | null }; // 0..100

export type FaceQuality = { sharpness: number; brightness: number; yawDeg: number } | null;

export type AdapterFailure = { kind: "failure"; stage: "search" | "detect" | "store" };

/** Thresholds, see the design's "Verdict decision". Defaults live in config.ts. */
export interface VerdictConfig {
  searchFloor: number;
  familyMin: number;
  strangerMax: number;
  faceConfidenceMin: number;
  minFaceWidth: number;
  minSharpness: number;
  minBrightness: number;
  maxYawDeg: number;
  acceptMin: number;
}

export type Judgement = {
  verdict: Verdict;
  confidence: number;
  face: FaceBox | null;
  reason: string;
};

/** Clamps to 0..1; a non-finite value becomes 0 so the result is always a valid fraction. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function clampBox(b: FaceBox): FaceBox {
  return {
    left: clamp01(b.left),
    top: clamp01(b.top),
    width: clamp01(b.width),
    height: clamp01(b.height),
  };
}

/** Converts a 0..100 score to a 0..1 confidence. */
function pct(n: number): number {
  return clamp01(n / 100);
}

export function decideVerdict(
  s: SearchOutcome | AdapterFailure,
  q: FaceQuality,
  c: VerdictConfig,
): Judgement {
  if (s.kind === "failure") {
    return { verdict: "uncertain", confidence: 0, face: null, reason: "adapter_failure" };
  }
  if (s.kind === "no_face") {
    return { verdict: "no_face", confidence: 1, face: null, reason: "no_face" };
  }

  const box = clampBox(s.box);
  const sim = s.bestSimilarity;

  if (sim !== null && sim >= c.familyMin) {
    const conf = pct(sim);
    if (conf >= c.acceptMin) return { verdict: "family", confidence: conf, face: box, reason: "match" };
    return { verdict: "uncertain", confidence: conf, face: box, reason: "low_confidence" };
  }

  if (sim !== null && sim >= c.strangerMax) {
    return { verdict: "uncertain", confidence: pct(sim), face: box, reason: "similarity_band" };
  }

  // Stranger candidate: below the band, or no match at all.
  const faceConf = pct(s.faceConfidence);
  if (s.faceConfidence < c.faceConfidenceMin) {
    return { verdict: "uncertain", confidence: faceConf, face: box, reason: "weak_face" };
  }
  if (box.width < c.minFaceWidth) {
    return { verdict: "uncertain", confidence: faceConf, face: box, reason: "face_too_small" };
  }
  if (
    q === null ||
    q.sharpness < c.minSharpness ||
    q.brightness < c.minBrightness ||
    Math.abs(q.yawDeg) > c.maxYawDeg
  ) {
    return { verdict: "uncertain", confidence: faceConf, face: box, reason: "poor_quality" };
  }
  if (faceConf < c.acceptMin) {
    return { verdict: "uncertain", confidence: faceConf, face: box, reason: "low_confidence" };
  }
  return { verdict: "stranger", confidence: faceConf, face: box, reason: "no_household_match" };
}

/**
 * True when the outcome could end as a stranger, so the caller must run DetectFaces to get
 * the face quality before calling `decideVerdict`.
 */
export function isStrangerCandidate(s: SearchOutcome, c: VerdictConfig): boolean {
  if (s.kind !== "face") return false;
  return s.bestSimilarity === null || s.bestSimilarity < c.strangerMax;
}

/**
 * Maps a Rekognition error name to a decision. `InvalidParameterException` is returned for
 * "no face" and for other bad parameters, so the caller checks with DetectFaces.
 */
export function classifySearchError(
  errorName: string,
): "no_face_or_bad_param" | "throttled" | "failure" {
  switch (errorName) {
    case "InvalidParameterException":
      return "no_face_or_bad_param";
    case "ThrottlingException":
    case "ProvisionedThroughputExceededException":
    case "LimitExceededException":
      return "throttled";
    default:
      return "failure";
  }
}
