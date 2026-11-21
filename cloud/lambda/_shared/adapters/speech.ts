/**
 * Bedrock and Polly adapter for the `SpeechSynth` port (cloud-judgement design, "Generated speech").
 *
 * Thin on purpose: it builds requests and reshapes responses. Whether a line is acceptable is
 * decided by `sanitizer.ts`, and what to do on failure by `speech-generator.ts`. Every call has a
 * 5 s limit (R7.8); a failure rejects and the caller falls back to a cached line.
 *
 * - Text: Bedrock `InvokeModel` with the Amazon Nova messages schema. Nova Lite is in-Region in
 *   Tokyo (design, "Verified AWS facts").
 * - Speech: Polly `Engine: neural`, SSML `prosody` with `rate` and `volume` only (neural voices
 *   do not support `pitch`). `mp3` for browsers, raw 16 kHz `pcm` wrapped by `pcm16ToWav`.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import type { OutputFormat, VoiceId } from "@aws-sdk/client-polly";

import type { Category } from "../lines.js";
import { buildPrompt } from "../persona.js";
import type { SpeechSynth } from "../ports.js";
import { pcm16ToWav } from "../wav.js";

/** Created once per Lambda container. The region comes from `AWS_REGION`. */
const defaultBedrock = new BedrockRuntimeClient({});
const defaultPolly = new PollyClient({});

/** Limit for each Bedrock or Polly call, in milliseconds (R7.8). */
export const SPEECH_CALL_TIMEOUT_MS = 5000;

const MAX_OUTPUT_TOKENS = 200;
const TEMPERATURE = 0.7;

export type SpeechAdapterOptions = {
  /** Bedrock model id, for example `amazon.nova-lite-v1:0`. Comes from configuration. */
  modelId: string;
  /** Polly voice id, for example `Kazuha`. Comes from configuration. */
  voiceId: string;
  /** SSML prosody rate. Default `slow`. */
  rate?: string;
  /** SSML prosody volume. Default `soft`. */
  volume?: string;
  bedrock?: BedrockRuntimeClient;
  polly?: PollyClient;
  timeoutMs?: number;
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Pull the first text block out of a Nova response body, or `null` when there is none. */
function extractText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const content = (body as { output?: { message?: { content?: unknown } } }).output?.message
    ?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block === "object" && block !== null && "text" in block) {
      const text = (block as { text: unknown }).text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

export function createSpeechSynth(options: SpeechAdapterOptions): SpeechSynth {
  const bedrock = options.bedrock ?? defaultBedrock;
  const polly = options.polly ?? defaultPolly;
  const timeoutMs = options.timeoutMs ?? SPEECH_CALL_TIMEOUT_MS;
  const rate = options.rate ?? "slow";
  const volume = options.volume ?? "soft";

  async function line(situation: Category, hint: string | null): Promise<string | null> {
    const { system, user } = buildPrompt(situation, hint);
    const body = {
      schemaVersion: "messages-v1",
      system: [{ text: system }],
      messages: [{ role: "user", content: [{ text: user }] }],
      inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS, temperature: TEMPERATURE },
    };
    const out = await bedrock.send(
      new InvokeModelCommand({
        modelId: options.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(body),
      }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(out.body));
    } catch {
      // A body that is not JSON is "no line available", like any other unusable answer.
      return null;
    }
    return extractText(parsed);
  }

  async function synthesize(
    text: string,
    format: OutputFormat,
    sampleRate: string,
  ): Promise<Uint8Array> {
    const ssml = `<speak><prosody rate="${rate}" volume="${volume}">${escapeXml(text)}</prosody></speak>`;
    const out = await polly.send(
      new SynthesizeSpeechCommand({
        Engine: "neural",
        VoiceId: options.voiceId as VoiceId,
        LanguageCode: "ja-JP",
        TextType: "ssml",
        Text: ssml,
        OutputFormat: format,
        SampleRate: sampleRate,
      }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
    if (out.AudioStream === undefined) throw new Error("Polly returned no audio");
    return out.AudioStream.transformToByteArray();
  }

  return {
    line,
    mp3: (text) => synthesize(text, "mp3", "24000"),
    wav16k: async (text) => pcm16ToWav(await synthesize(text, "pcm", "16000"), 16000),
  };
}
