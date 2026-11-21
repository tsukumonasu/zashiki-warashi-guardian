/**
 * Pure core of the `api-simulate` Lambda: `POST /simulate` (`docs/schema.md`, "HTTP API").
 *
 * Runs the real verdict path on a stored demo sample against the demo collection only, builds
 * the `judgement.result` and `speak` envelopes the doll would act on, and optionally generates
 * speech. It publishes nothing and writes no encounter. Every AWS service sits behind a port;
 * time, randomness and ids are injected. The handler turns a thrown `ApiError` into a response.
 *
 * Requirements: 8.1, 8.3, 15.1 to 15.10, 15.12, 15.13, 15.15.
 */

import { authorize, type Role } from "../_shared/authz.js";
import type { CloudConfig } from "../_shared/config.js";
import { ApiError } from "../_shared/http.js";
import { chooseLine, type Category, type VoiceLine } from "../_shared/lines.js";
import { makeCommand, type Envelope } from "../_shared/messages.js";
import type { FaceSearch, Repository, SnapshotStore, SpeechSynth, StateStore } from "../_shared/ports.js";
import { guardSimulate } from "../_shared/ratelimit.js";
import { generateSpeech, type GeneratedSpeech } from "../_shared/speech-generator.js";
import {
  decideVerdict,
  isStrangerCandidate,
  type FaceBox,
  type FaceQuality,
  type Judgement,
  type SearchOutcome,
  type Verdict,
} from "../_shared/verdict.js";

/** Device id of simulated envelopes (R15.7). */
export const SIMULATION_DEVICE_ID = "warashi-sim";

/** Lifetime of the MP3 URL, in seconds (R15.15). */
export const MP3_URL_TTL_S = 300;

/** Key prefix of generated audio; `api-simulate` may write only here. */
export const AUDIO_KEY_PREFIX = "audio/sim/";

const SAMPLE_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

/** The authenticated caller and the parsed JSON body (an object, extra fields allowed). */
export interface SimulateRequest {
  role: Role;
  /** Cognito `sub` claim. */
  userSub: string;
  body: Readonly<Record<string, unknown>>;
}

export interface SimulateDeps {
  repository: Pick<Repository, "getSampleManifest" | "getSampleImage" | "listMembers">;
  search: FaceSearch;
  state: Pick<StateStore, "incrementCounter" | "releaseCounter">;
  store: Pick<SnapshotStore, "put" | "signGet">;
  synth: SpeechSynth;
  config: CloudConfig;
  lines: readonly VoiceLine[];
  blockedWords: readonly string[];
  /** The demo collection id. The household collection is never used here (R15.4). */
  demoCollectionId: string;
  /** Wall clock in epoch milliseconds, also used to time the request. */
  clockMs: () => number;
  /** Random number in [0, 1). */
  rand: () => number;
  /** New UUID. */
  newId: () => string;
  allowStrangerGeneration?: boolean;
}

export interface SimulateSpeech {
  lineId: string | null;
  ja: string;
  en: string;
  mp3Url: string | null;
  generated: boolean;
}

export interface SimulateResponse {
  sampleId: string;
  verdict: Verdict;
  confidence: number;
  face: FaceBox | null;
  commands: Envelope[];
  speech: SimulateSpeech | null;
  latencyMs: { total: number; search: number };
}

function validationFailed(message: string): ApiError {
  return new ApiError("validation_failed", message);
}

/** R15.1 to R15.3: a valid sample id, and `generate` absent or a boolean. Other fields are ignored (R15.5). */
function parseBody(body: Readonly<Record<string, unknown>>): { sampleId: string; generate: boolean } {
  const sampleId = body["sampleId"];
  if (typeof sampleId !== "string" || !SAMPLE_ID_PATTERN.test(sampleId)) {
    throw validationFailed("sampleId is missing or not valid.");
  }
  const generate = body["generate"];
  if (generate !== undefined && typeof generate !== "boolean") {
    throw validationFailed("generate must be a boolean.");
  }
  return { sampleId, generate: generate === true };
}

function categoryOf(verdict: Verdict): Category {
  return verdict === "family" ? "family" : verdict === "stranger" ? "stranger" : "uncertain";
}

/** True when `text` contains a registered label, case-insensitively (R8.1). */
function leaksLabel(text: string, labels: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return labels.some((label) => label.length > 0 && lower.includes(label.toLowerCase()));
}

/**
 * Proves that no family label reaches an output for a situation other than `family` (R8.1,
 * R8.3). A leaking generated line is replaced by a cached line; a leaking cached line is an
 * internal error, because it would reach a reviewer.
 */
function withoutLabels(
  speech: GeneratedSpeech,
  category: Category,
  labels: readonly string[],
  deps: SimulateDeps,
): GeneratedSpeech {
  if (category === "family" || !leaksLabel(`${speech.ja}\n${speech.en}`, labels)) return speech;
  const line = chooseLine(deps.lines, category, deps.rand());
  if (line === null || leaksLabel(`${line.ja}\n${line.en}`, labels)) {
    throw new Error("no label-free voice line");
  }
  return { ja: line.ja, en: line.en, lineId: line.id, mp3: null, generated: false };
}

async function cachedSpeech(category: Category, deps: SimulateDeps): Promise<GeneratedSpeech> {
  const line = chooseLine(deps.lines, category, deps.rand());
  if (line === null) throw new Error(`no cached voice line for category ${category}`);
  return { ja: line.ja, en: line.en, lineId: line.id, mp3: null, generated: false };
}

/** Stores the MP3 and signs a 300-second URL. Any failure gives `null`: speech is optional (R7.9). */
async function mp3UrlFor(mp3: Uint8Array | null, deps: SimulateDeps): Promise<string | null> {
  if (mp3 === null) return null;
  try {
    const key = `${AUDIO_KEY_PREFIX}${deps.newId()}.mp3`;
    await deps.store.put(key, mp3);
    return await deps.store.signGet(key, MP3_URL_TTL_S);
  } catch {
    return null;
  }
}

/** Search, plus DetectFaces for a stranger candidate. A failure rejects (R15.9). */
async function judge(image: Uint8Array, deps: SimulateDeps): Promise<Judgement> {
  const { config } = deps;
  const outcome: SearchOutcome = await deps.search.search(image, deps.demoCollectionId, config.searchFloor);
  let quality: FaceQuality = null;
  if (isStrangerCandidate(outcome, config)) {
    quality = (await deps.search.detect(image)).quality;
  }
  return decideVerdict(outcome, quality, config);
}

/** `POST /simulate`. Throws `ApiError` for client errors and rate limits; anything else is `500 internal`. */
export async function handleSimulate(request: SimulateRequest, deps: SimulateDeps): Promise<SimulateResponse> {
  if (authorize(request.role, "POST /simulate") !== "allow") {
    throw new ApiError("forbidden", "Not allowed.");
  }
  if (typeof request.userSub !== "string" || request.userSub === "") {
    throw new ApiError("unauthorized", "Missing user.");
  }
  const { sampleId, generate } = parseBody(request.body);
  const startMs = deps.clockMs();

  try {
    const manifest = await deps.repository.getSampleManifest();
    if (!manifest.some((entry) => entry.id === sampleId)) {
      throw validationFailed("Unknown sampleId.");
    }

    // The guard runs before any search, speech or storage call (R15.10, R15.12, R15.13).
    const reviewer = request.role === "reviewer";
    const guard = await guardSimulate(
      request.userSub,
      generate,
      {
        simPerHour: reviewer ? deps.config.reviewerSimulatePerHour : deps.config.familySimulatePerHour,
        genPerHour: reviewer ? deps.config.reviewerGeneratePerHour : deps.config.familyGeneratePerHour,
        simPerDay: deps.config.globalSimulatePerDay,
      },
      startMs,
      deps.state,
    );
    if (!guard.allowed) {
      throw new ApiError("rate_limited", "Too many simulations. Try again later.", guard.retryAfterS);
    }

    const image = await deps.repository.getSampleImage(sampleId);
    if (image === null) throw validationFailed("Unknown sampleId.");

    const searchStartMs = deps.clockMs();
    const judgement = await judge(image, deps);
    const searchMs = deps.clockMs() - searchStartMs;

    const category = categoryOf(judgement.verdict);
    const labels = (await deps.repository.listMembers()).map((m) => m.displayName);
    const raw = generate
      ? await generateSpeech(category, null, {
          synth: deps.synth,
          lines: deps.lines,
          rand: deps.rand(),
          blockedWords: deps.blockedWords,
          allowStrangerGeneration: deps.allowStrangerGeneration,
        })
      : await cachedSpeech(category, deps);
    const spoken = withoutLabels(raw, category, labels, deps);
    const mp3Url = await mp3UrlFor(spoken.mp3, deps);

    const now = new Date(deps.clockMs());
    const ctx = () => ({ id: deps.newId(), now, deviceId: SIMULATION_DEVICE_ID, encounterId: null });
    const commands: Envelope[] = [
      makeCommand(
        "judgement.result",
        { snapshotId: sampleId, verdict: judgement.verdict, confidence: judgement.confidence, face: judgement.face },
        ctx(),
      ),
    ];
    // A generated line without audio has neither a cached id nor a URL, which the contract
    // does not allow in a `speak`, so no `speak` is produced for it. The speech is still returned.
    if (spoken.lineId !== null) {
      commands.push(makeCommand("speak", { lineId: spoken.lineId, audioUrl: null, ja: spoken.ja, en: spoken.en }, ctx()));
    } else if (mp3Url !== null) {
      commands.push(makeCommand("speak", { lineId: null, audioUrl: mp3Url, ja: spoken.ja, en: spoken.en }, ctx()));
    }

    const total = Math.max(0, Math.round(deps.clockMs() - startMs));
    return {
      sampleId,
      verdict: judgement.verdict,
      confidence: judgement.confidence,
      face: judgement.face,
      commands,
      speech: { lineId: spoken.lineId, ja: spoken.ja, en: spoken.en, mp3Url, generated: spoken.generated },
      latencyMs: { total, search: Math.min(total, Math.max(0, Math.round(searchMs))) },
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // No partial output and no internal detail (R15.9).
    throw new ApiError("internal", "Simulation failed.");
  }
}
