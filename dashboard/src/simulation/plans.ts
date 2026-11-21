// Scenario plans (design D4, D5, D6). Pure: a plan is data; the engine's world rules run it.

import catalog from "./data/voice-catalog.json";
import { DEFAULT_CONFIG } from "./config";
import { formatIso, uuidV4 } from "./rng";
import { safeLineText } from "./privacy";
import type {
  FaceBox,
  JudgementResult,
  PlannedVerdict,
  ScenarioId,
  ScenarioPlan,
  Verdict,
} from "./types";

/** The part of a `POST /simulate` response (or bundled Sample_Response) a plan needs. */
export interface PlanResponse {
  verdict: Verdict;
  confidence: number;
  face: FaceBox | null;
  speech: { lineId: string | null; ja: string; en: string } | null;
}

export const SCENARIOS: readonly ScenarioId[] = [
  "family_home",
  "stranger_night",
  "nobody_there",
  "network_down",
];

export type SampleLabel = "family" | "stranger" | "no_face";

/** Sample label used to look up a response for a scenario; `network_down` needs none. */
export const SCENARIO_SAMPLE_LABEL: Readonly<Record<ScenarioId, SampleLabel | null>> = {
  family_home: "family",
  stranger_night: "stranger",
  nobody_there: "no_face",
  network_down: null,
};

export function sampleLabelFor(scenario: ScenarioId): SampleLabel | null {
  return SCENARIO_SAMPLE_LABEL[scenario];
}

/** Snapshot attempts of `nobody_there`: the first one plus every scan move (Q3). */
const NO_FACE_ATTEMPTS = DEFAULT_CONFIG.scanAttemptsMax + 1;

const DEFAULT_CAMERA_DELAY_MS = 600;
const DEFAULT_VERDICT_DELAY_MS = 1200;

interface CatalogLine {
  id: string;
  ja: string;
  en: string;
}
const CATALOG = catalog as CatalogLine[];

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function basePlan(scenario: ScenarioId): ScenarioPlan {
  return {
    scenario,
    cloud: "up",
    attempts: [],
    reactionLineId: null,
    display: null,
    cameraDelayMs: DEFAULT_CAMERA_DELAY_MS,
    verdictDelayMs: DEFAULT_VERDICT_DELAY_MS,
  };
}

function attemptFrom(response: PlanResponse): PlannedVerdict {
  return {
    verdict: response.verdict,
    confidence: clamp01(response.confidence),
    face: response.face ? { ...response.face } : null,
  };
}

/** Line id from the response, only when the bundled catalog knows it. */
function knownLineId(response: PlanResponse): string | null {
  const id = response.speech?.lineId ?? null;
  return id !== null && CATALOG.some((l) => l.id === id) ? id : null;
}

/**
 * Displayed text of the reaction line. Only a `family` verdict may show response text, and it
 * goes through `safeLineText` (D6); for every other verdict the engine shows the catalog text.
 */
function displayFor(
  response: PlanResponse,
  lineId: string | null,
  labels: readonly string[],
): { ja: string; en: string } | null {
  if (response.verdict !== "family" || lineId === null || !response.speech) return null;
  const line = CATALOG.find((l) => l.id === lineId);
  if (!line) return null;
  return safeLineText(
    "family",
    { ja: line.ja, en: line.en },
    { ja: response.speech.ja, en: response.speech.en },
    labels,
  );
}

export function buildFamilyHomePlan(response: PlanResponse, labels: readonly string[] = []): ScenarioPlan {
  const lineId = knownLineId(response);
  return {
    ...basePlan("family_home"),
    attempts: [attemptFrom(response)],
    reactionLineId: lineId,
    display: displayFor(response, lineId, labels),
  };
}

export function buildStrangerNightPlan(response: PlanResponse, labels: readonly string[] = []): ScenarioPlan {
  const lineId = knownLineId(response);
  return {
    ...basePlan("stranger_night"),
    attempts: [attemptFrom(response)],
    reactionLineId: lineId,
    display: displayFor(response, lineId, labels),
  };
}

export function buildNobodyTherePlan(response: PlanResponse, labels: readonly string[] = []): ScenarioPlan {
  const lineId = knownLineId(response);
  const attempt = attemptFrom(response);
  return {
    ...basePlan("nobody_there"),
    attempts: Array.from({ length: NO_FACE_ATTEMPTS }, () => ({ ...attempt })),
    reactionLineId: lineId,
    display: displayFor(response, lineId, labels),
  };
}

/** The cloud is down: no snapshot is judged, so there are no attempts and no response. */
export function buildNetworkDownPlan(): ScenarioPlan {
  return { ...basePlan("network_down"), cloud: "down" };
}

/**
 * Plan for a scenario from a simulate response. The response's verdict, confidence and face are
 * kept as they are (Property 18). `network_down` ignores the response.
 */
export function planFromResponse(
  scenario: ScenarioId,
  response: PlanResponse | null,
  labels: readonly string[] = [],
): ScenarioPlan {
  if (scenario === "network_down" || response === null) return buildNetworkDownPlan();
  switch (scenario) {
    case "family_home":
      return buildFamilyHomePlan(response, labels);
    case "stranger_night":
      return buildStrangerNightPlan(response, labels);
    case "nobody_there":
      return buildNobodyTherePlan(response, labels);
  }
}

/**
 * A fresh `judgement.result` for the engine's current snapshot (D5). The response's own
 * `snapshotId` and `id` are never reused. Returns the envelope and the next rng state.
 */
export function buildJudgementEnvelope(
  attempt: PlannedVerdict,
  snapshotId: string,
  rng: number,
  now: number,
  deviceId: string = DEFAULT_CONFIG.deviceId,
): [JudgementResult, number] {
  const [id, nextRng] = uuidV4(rng);
  const envelope: JudgementResult = {
    v: 1,
    id,
    ts: formatIso(now),
    deviceId,
    encounterId: null,
    type: "judgement.result",
    data: {
      snapshotId,
      verdict: attempt.verdict,
      confidence: attempt.confidence,
      face: attempt.face ? { ...attempt.face } : null,
    },
  };
  return [envelope, nextRng];
}
