/**
 * `api-simulate` Lambda entry point: `POST /simulate`. Thin glue; every decision is in
 * `simulate-core.ts`.
 *
 * Environment variables (set by the CDK stack, never secrets):
 *   WARASHI_TABLE_NAME, WARASHI_BUCKET_NAME  (read by the adapters)
 *   WARASHI_WEB_ORIGIN               dashboard origin for CORS
 *   WARASHI_BEDROCK_MODEL_ID         Bedrock model id for generated lines (required)
 *   WARASHI_POLLY_VOICE_ID           Polly voice id, default `Kazuha`
 *   WARASHI_DEMO_COLLECTION_ID       Rekognition demo collection, default `warashi-demo`
 *   WARASHI_BLOCKED_WORDS            optional comma-separated words refused in generated lines
 *   WARASHI_*                        tunable settings, see `_shared/config.ts`
 *
 * Stack task (19.6): the Lambda timeout is 29 s, which is the API Gateway integration limit.
 */

import { randomUUID } from "node:crypto";

import { createRepository, createStateStore } from "../_shared/adapters/dynamo.js";
import { createRekognitionFaceSearch } from "../_shared/adapters/rekognition.js";
import { createAudioStore, createSampleSource } from "../_shared/adapters/s3.js";
import { createSpeechSynth } from "../_shared/adapters/speech.js";
import { createApiHandler, ok, readWebOrigin, type RouteContext, type RouteResult } from "../_shared/api-glue.js";
import { loadConfig } from "../_shared/config.js";
import { parseJsonBody } from "../_shared/http.js";
import type { VoiceLine } from "../_shared/lines.js";
import voiceLines from "../_shared/voice-lines.json" with { type: "json" };
import { handleSimulate, type SimulateDeps } from "./simulate-core.js";

const DEFAULT_DEMO_COLLECTION_ID = "warashi-demo";
const DEFAULT_VOICE_ID = "Kazuha";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function blockedWords(): string[] {
  return (process.env["WARASHI_BLOCKED_WORDS"] ?? "")
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word !== "");
}

// Module scope: invalid configuration or a missing variable fails the cold start (R5.16).
const deps: Omit<SimulateDeps, "clockMs"> = {
  repository: createRepository({ samples: createSampleSource() }),
  search: createRekognitionFaceSearch(),
  state: createStateStore(),
  store: createAudioStore(),
  synth: createSpeechSynth({
    modelId: requiredEnv("WARASHI_BEDROCK_MODEL_ID"),
    voiceId: process.env["WARASHI_POLLY_VOICE_ID"] || DEFAULT_VOICE_ID,
  }),
  config: loadConfig(process.env),
  lines: voiceLines as VoiceLine[],
  blockedWords: blockedWords(),
  demoCollectionId: process.env["WARASHI_DEMO_COLLECTION_ID"] || DEFAULT_DEMO_COLLECTION_ID,
  rand: Math.random,
  newId: randomUUID,
};

async function simulate({ request, role, userSub }: RouteContext): Promise<RouteResult> {
  const body = parseJsonBody(request);
  return ok(await handleSimulate({ role, userSub, body }, { ...deps, clockMs: Date.now }));
}

export const handler = createApiHandler({
  allowedOrigin: readWebOrigin(process.env),
  now: Date.now,
  routes: { "POST /simulate": simulate },
});
