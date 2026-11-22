/**
 * `api-say` Lambda entry point: `POST /say` (family only). Thin glue; every decision is in
 * `say-core.ts`.
 *
 * Environment variables (set by the CDK stack, never secrets):
 *   WARASHI_TABLE_NAME, WARASHI_BUCKET_NAME, IOT_DATA_ENDPOINT  (read by the adapters)
 *   WARASHI_POLLY_VOICE_ID           Polly voice id, default `Kazuha`
 *   WARASHI_BLOCKED_WORDS            optional comma-separated words refused in typed text
 *   WARASHI_*                        tunable settings, see `_shared/config.ts`
 */
import { randomUUID } from "node:crypto";
import { createRepository, createStateStore } from "../_shared/adapters/dynamo.js";
import { createIotBus } from "../_shared/adapters/iot-bus.js";
import { createSampleSource, createSayAudioStore } from "../_shared/adapters/s3.js";
import { createSpeechSynth } from "../_shared/adapters/speech.js";
import { createApiHandler, readWebOrigin, type RouteContext, type RouteResult } from "../_shared/api-glue.js";
import { loadConfig } from "../_shared/config.js";
import { parseJsonBody } from "../_shared/http.js";
import { handlePostSay, type SayDeps } from "./say-core.js";

const DEFAULT_VOICE_ID = "Kazuha";

function blockedWords(): string[] {
  return (process.env["WARASHI_BLOCKED_WORDS"] ?? "")
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word !== "");
}

// Module scope: invalid configuration or a missing variable fails the cold start (R5.16).
const deps: Omit<SayDeps, "nowMs"> = {
  bus: createIotBus(),
  repository: createRepository({ samples: createSampleSource() }),
  state: createStateStore(),
  config: loadConfig(process.env),
  // Bedrock is not used here: only `wav16k` is called, so the model id is a placeholder.
  synth: createSpeechSynth({ modelId: "unused", voiceId: process.env["WARASHI_POLLY_VOICE_ID"] || DEFAULT_VOICE_ID }),
  store: createSayAudioStore(),
  blockedWords: blockedWords(),
  newId: randomUUID,
};

async function say({ request, role, userSub, nowMs }: RouteContext): Promise<RouteResult> {
  const body = parseJsonBody(request);
  return { status: 202, body: await handlePostSay({ role, userSub, body }, { ...deps, nowMs }) };
}

export const handler = createApiHandler({
  allowedOrigin: readWebOrigin(process.env),
  now: Date.now,
  routes: { "POST /say": say },
});
