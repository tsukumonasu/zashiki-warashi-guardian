/**
 * Tests for the Bedrock and Polly adapter (cloud-judgement task 16.8).
 *
 * Request and response shapes were checked against the AWS documentation:
 * - https://docs.aws.amazon.com/polly/latest/APIReference/API_SynthesizeSpeech.html
 *   (Engine standard|neural|long-form|generative; TextType ssml|text; OutputFormat includes mp3
 *   and pcm; SampleRate for mp3 includes "24000", for pcm only "8000" or "16000"; pcm is signed
 *   16-bit mono little-endian; LanguageCode ja-JP is valid; voice Kazuha is in the VoiceId list)
 * - https://docs.aws.amazon.com/nova/latest/userguide/using-invoke-api.html
 *   (Amazon Nova v1 InvokeModel body: `schemaVersion: "messages-v1"`, `system: [{text}]`,
 *   `messages: [{role, content: [{text}]}]`, `inferenceConfig: {maxTokens, temperature, ...}`;
 *   `schemaVersion` is shown in the official example, so it is valid and kept)
 * - https://docs.aws.amazon.com/nova/latest/userguide/complete-request-schema.html
 *   (`system` optional, `messages` required, `inferenceConfig.maxTokens` up to 5K,
 *   `temperature` 0.00001..1; response is read from `output.message.content[].text`)
 * - https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-invoke-api.html
 *   (response body: `output.message.content`, first block with a `text` key)
 * The adapter needed no fix.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { createSpeechSynth } from "../lambda/_shared/adapters/speech.js";

const bedrockMock = mockClient(BedrockRuntimeClient);
const pollyMock = mockClient(PollyClient);

const MODEL_ID = "amazon.nova-lite-v1:0";

function synth(extra: { rate?: string; volume?: string; timeoutMs?: number } = {}) {
  return createSpeechSynth({
    modelId: MODEL_ID,
    voiceId: "Kazuha",
    bedrock: new BedrockRuntimeClient({ region: "ap-northeast-1" }),
    polly: new PollyClient({ region: "ap-northeast-1" }),
    ...extra,
  });
}

/** The shape the SDK returns for a Polly stream: only `transformToByteArray` is used. */
function audio(bytes: Uint8Array) {
  return { transformToByteArray: async () => bytes } as never;
}

function novaBody(value: unknown): never {
  return { body: new TextEncoder().encode(JSON.stringify(value)) } as never;
}

beforeEach(() => {
  bedrockMock.reset();
  pollyMock.reset();
});

describe("line (Bedrock)", () => {
  it("sends the documented Nova messages request", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(novaBody({}));
    await synth().line("family", null);
    const input = bedrockMock.commandCalls(InvokeModelCommand)[0]?.args[0].input;
    expect(input?.modelId).toBe(MODEL_ID);
    expect(input?.contentType).toBe("application/json");
    expect(input?.accept).toBe("application/json");
    const body = JSON.parse(input?.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["inferenceConfig", "messages", "schemaVersion", "system"]);
    expect(body.schemaVersion).toBe("messages-v1");
    expect(body.system).toEqual([{ text: expect.any(String) }]);
    expect(body.messages).toEqual([{ role: "user", content: [{ text: expect.any(String) }] }]);
    expect(body.inferenceConfig).toEqual({ maxTokens: 200, temperature: 0.7 });
  });

  it("returns the first text block of output.message.content", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(
      novaBody({ output: { message: { role: "assistant", content: [{ reasoning: 1 }, { text: "おかえり" }, { text: "x" }] } } }),
    );
    expect(await synth().line("family", null)).toBe("おかえり");
  });

  it.each([
    ["no output", {}],
    ["content is not an array", { output: { message: { content: "x" } } }],
    ["no text block", { output: { message: { content: [{ image: {} }] } } }],
    ["text is not a string", { output: { message: { content: [{ text: 5 }] } } }],
    ["body is not an object", "hello"],
    ["body is null", null],
  ])("returns null when %s", async (_name, value) => {
    bedrockMock.on(InvokeModelCommand).resolves(novaBody(value));
    expect(await synth().line("stranger", null)).toBeNull();
  });

  it("returns null when the body is not JSON", async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: new TextEncoder().encode("not json {") } as never);
    expect(await synth().line("uncertain", null)).toBeNull();
  });

  it("passes an abort signal that fires after the time limit", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(novaBody({}));
    await synth({ timeoutMs: 20 }).line("family", null);
    const options = (bedrockMock.commandCalls(InvokeModelCommand)[0]?.args as unknown[])[1] as
      | { abortSignal?: AbortSignal }
      | undefined;
    const signal = options?.abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signal?.aborted).toBe(true);
  });

  it("rejects when Bedrock fails, so the caller can fall back", async () => {
    bedrockMock.on(InvokeModelCommand).rejects(new Error("ThrottlingException"));
    await expect(synth().line("family", null)).rejects.toThrow("ThrottlingException");
  });
});

describe("mp3 and wav16k (Polly)", () => {
  it("requests neural ja-JP SSML mp3 at 24 kHz with prosody rate and volume only", async () => {
    pollyMock.on(SynthesizeSpeechCommand).resolves({ AudioStream: audio(new Uint8Array([9, 8])) });
    const out = await synth().mp3("こんばんは");
    expect(out).toEqual(new Uint8Array([9, 8]));
    const input = pollyMock.commandCalls(SynthesizeSpeechCommand)[0]?.args[0].input;
    expect(input).toEqual({
      Engine: "neural",
      VoiceId: "Kazuha",
      LanguageCode: "ja-JP",
      TextType: "ssml",
      Text: '<speak><prosody rate="slow" volume="soft">こんばんは</prosody></speak>',
      OutputFormat: "mp3",
      SampleRate: "24000",
    });
    expect(input?.Text).not.toContain("pitch");
  });

  it("uses configured rate and volume and escapes XML in the text", async () => {
    pollyMock.on(SynthesizeSpeechCommand).resolves({ AudioStream: audio(new Uint8Array([1])) });
    await synth({ rate: "x-slow", volume: "x-soft" }).mp3(`a<b>&"c"'d'`);
    const input = pollyMock.commandCalls(SynthesizeSpeechCommand)[0]?.args[0].input;
    expect(input?.Text).toBe(
      '<speak><prosody rate="x-slow" volume="x-soft">a&lt;b&gt;&amp;&quot;c&quot;&apos;d&apos;</prosody></speak>',
    );
  });

  it("requests 16 kHz pcm and wraps it as a 16 kHz mono 16-bit WAV", async () => {
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
    pollyMock.on(SynthesizeSpeechCommand).resolves({ AudioStream: audio(pcm) });
    const wav = await synth().wav16k("やあ");
    const input = pollyMock.commandCalls(SynthesizeSpeechCommand)[0]?.args[0].input;
    expect(input?.OutputFormat).toBe("pcm");
    expect(input?.SampleRate).toBe("16000");
    expect(input?.Engine).toBe("neural");
    expect(input?.TextType).toBe("ssml");
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it("passes an abort signal that fires after the time limit", async () => {
    pollyMock.on(SynthesizeSpeechCommand).resolves({ AudioStream: audio(new Uint8Array([1])) });
    await synth({ timeoutMs: 20 }).mp3("x");
    const options = (pollyMock.commandCalls(SynthesizeSpeechCommand)[0]?.args as unknown[])[1] as
      | { abortSignal?: AbortSignal }
      | undefined;
    const signal = options?.abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signal?.aborted).toBe(true);
  });

  it("rejects when Polly returns no audio", async () => {
    pollyMock.on(SynthesizeSpeechCommand).resolves({});
    await expect(synth().mp3("x")).rejects.toThrow("no audio");
  });

  it("rejects when Polly fails", async () => {
    pollyMock.on(SynthesizeSpeechCommand).rejects(new Error("ServiceFailureException"));
    await expect(synth().wav16k("x")).rejects.toThrow("ServiceFailureException");
  });
});
