// Opt-in integration tests for the voice conversation (task 20.1, owner step O3).
//
// Skipped unless WARASHI_AWS_INTEGRATION=1, so `make test` never runs them. They call real AWS:
//   1. Amazon Bedrock (Nova Sonic) in Tokyo: one Japanese text turn, reports `japaneseRatio`.
//   2. The deployed API and AppSync Events API: one browser-style session against the virtual
//      doll with a session token. It speaks synthetic Japanese (Polly) and reports the loop
//      latency (p50 and p95), the lead time of assistant text over audio (design V13) and the
//      price per minute computed from the token counts of the stream (no invoice needed).
//
// Settings come from the environment, never from the repository:
//   WARASHI_IT_API_URL            base URL of the deployed API (stack output), for test 2
//   WARASHI_IT_FAMILY_TOKEN       Cognito access token of a user in the `family` group, for test 2
//   WARASHI_IT_DEVICE_ID          optional, default warashi-01
//   WARASHI_VOICE_MODEL_ID        optional, default amazon.nova-2-5-sonic
//   WARASHI_VOICE_ID              optional, default tiffany
//   WARASHI_VOICE_REGION / AWS_REGION  optional, default ap-northeast-1
//
// Test 2 needs `voiceEnabled` on in the deployed stack and uses one session of the family's daily
// cap. Measured values are printed to the console only; the owner copies them into `design.md`
// (items marked "pending owner measurement"). Nothing is written to a tracked file.
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { PollyClient } from "@aws-sdk/client-polly";
import { describe, expect, it } from "vitest";

import { createSpeechSynth } from "../../../lambda/_shared/adapters/speech.js";
import { DEFAULT_VOICE_CONFIG } from "../../../lambda/_shared/voice/config.js";
import { japaneseRatio } from "../../../lambda/_shared/voice/language.js";
import { buildSystemPrompt } from "../../../lambda/_shared/voice/prompt.js";
import { sessionScript, sonicShutdownEvents } from "../../../lambda/_shared/voice/sonic-events.js";
import { createSonicClient, type SonicBedrock } from "../../../lambda/voice-session/adapters/sonic.js";
import { describeIntegration, integrationEnabled } from "../../integration.js";
import { percentile } from "../latency.js";

const REGION = process.env["WARASHI_VOICE_REGION"] || process.env["AWS_REGION"] || "ap-northeast-1";
const MODEL_ID = process.env["WARASHI_VOICE_MODEL_ID"] || DEFAULT_VOICE_CONFIG.voiceModelId;
const VOICE_ID = process.env["WARASHI_VOICE_ID"] || DEFAULT_VOICE_CONFIG.voiceId;
const DEVICE_ID = process.env["WARASHI_IT_DEVICE_ID"] || "warashi-01";
const TURNS = 3;

/** USD per 1,000 tokens, Nova 2.5 Sonic, Tokyo, read 2026-11-21 (design, "Verified AWS facts"). */
const PRICE_PER_1K = { speechIn: 0.0037411, speechOut: 0.0149643, textIn: 0.000396, textOut: 0.003311 } as const;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} must be set to run this test`);
  return value.trim();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function summarize(label: string, samples: readonly number[]): void {
  if (samples.length === 0) {
    console.info(`[measured] ${label}: no samples`);
    return;
  }
  console.info(
    `[measured] ${label}: n=${samples.length} p50=${Math.round(percentile(samples, 50))}ms ` +
      `p95=${Math.round(percentile(samples, 95))}ms max=${Math.round(Math.max(...samples))}ms`,
  );
}

// ---------------------------------------------------------------------------------------------
// Token usage, read from the raw output stream (the parser keeps only what the session needs)
// ---------------------------------------------------------------------------------------------

interface Usage {
  speechIn: number;
  speechOut: number;
  textIn: number;
  textOut: number;
}

const emptyUsage = (): Usage => ({ speechIn: 0, speechOut: 0, textIn: 0, textOut: 0 });

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Adds the `usageEvent` delta of one raw output event to `usage`. Unknown shapes add nothing. */
export function addUsage(usage: Usage, rawJson: string): void {
  let root: unknown;
  try {
    root = JSON.parse(rawJson);
  } catch {
    return;
  }
  const event = (root as { event?: { usageEvent?: { details?: { delta?: Record<string, Record<string, unknown>> } } } })
    .event;
  const delta = event?.usageEvent?.details?.delta;
  if (delta === undefined) return;
  usage.speechIn += num(delta["input"]?.["speechTokens"]);
  usage.textIn += num(delta["input"]?.["textTokens"]);
  usage.speechOut += num(delta["output"]?.["speechTokens"]);
  usage.textOut += num(delta["output"]?.["textTokens"]);
}

export function priceUsd(u: Usage): number {
  return (
    (u.speechIn * PRICE_PER_1K.speechIn +
      u.speechOut * PRICE_PER_1K.speechOut +
      u.textIn * PRICE_PER_1K.textIn +
      u.textOut * PRICE_PER_1K.textOut) /
    1000
  );
}

/** A Bedrock client that copies the usage of every output chunk into `usage`. */
function usageTap(inner: BedrockRuntimeClient, usage: Usage): SonicBedrock {
  const decoder = new TextDecoder();
  return {
    send: (async (command: never) => {
      const response = (await inner.send(command)) as { body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> };
      const body = response.body;
      if (body === undefined) return response;
      async function* tee() {
        for await (const part of body as AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>) {
          if (part.chunk?.bytes !== undefined) addUsage(usage, decoder.decode(part.chunk.bytes));
          yield part;
        }
      }
      return { ...response, body: tee() };
    }) as unknown as SonicBedrock["send"],
  };
}

// ---------------------------------------------------------------------------------------------
// 1. One real Japanese turn against Bedrock in Tokyo
// ---------------------------------------------------------------------------------------------

describeIntegration("Nova Sonic in Tokyo: one Japanese turn (R9.4, R15.6)", () => {
  it("answers a Japanese text prompt in Japanese and reports japaneseRatio and token usage", async () => {
    const usage = emptyUsage();
    const bedrock = new BedrockRuntimeClient({ region: REGION });
    const sonic = createSonicClient({ client: usageTap(bedrock, usage) });
    const ids = { promptName: crypto.randomUUID(), audioContentName: crypto.randomUUID() };
    const userName = crypto.randomUUID();

    const stream = await sonic.open(MODEL_ID);
    // Start events and the system prompt, then one interactive text turn from the user.
    const start = sessionScript(
      {
        ...ids,
        voice: { voiceModelId: MODEL_ID, voiceId: VOICE_ID },
        systemContentName: crypto.randomUUID(),
        systemPrompt: buildSystemPrompt(),
        tools: [],
      },
      [],
    );
    // `sessionScript` with no steps ends at the shutdown events; send everything before them.
    const shutdown = sonicShutdownEvents(ids);
    for (const e of start.slice(0, start.length - shutdown.length)) await stream.send(e);
    const text = (name: string, role: string, content: string, interactive: boolean) => [
      JSON.stringify({
        event: {
          contentStart: {
            promptName: ids.promptName,
            contentName: name,
            type: "TEXT",
            role,
            interactive,
            textInputConfiguration: { mediaType: "text/plain" },
          },
        },
      }),
      JSON.stringify({ event: { textInput: { promptName: ids.promptName, contentName: name, content } } }),
      JSON.stringify({ event: { contentEnd: { promptName: ids.promptName, contentName: name } } }),
    ];
    for (const e of text(userName, "USER", "こんにちは。今日はどんな一日でしたか？ 短く教えてください。", true)) {
      await stream.send(e);
    }

    const finals: string[] = [];
    let audioChunks = 0;
    const startedAt = performance.now();
    let firstAudioMs: number | null = null;
    const deadline = startedAt + 60_000;
    try {
      for await (const ev of stream.events()) {
        if (ev.kind === "audio") {
          audioChunks += 1;
          firstAudioMs ??= performance.now() - startedAt;
        }
        if (ev.kind === "text" && ev.role === "ASSISTANT" && ev.stage !== "SPECULATIVE") finals.push(ev.text);
        if (ev.kind === "error") throw new Error(`Sonic stream error: ${ev.code}`);
        if (ev.kind === "completionEnd" || performance.now() > deadline) break;
      }
    } finally {
      await stream.close();
    }

    const transcript = finals.join("");
    const ratio = japaneseRatio(transcript);
    console.info(`[measured] Sonic ${MODEL_ID} voice=${VOICE_ID} ${REGION}: transcript length ${[...transcript].length}`);
    console.info(`[measured] japaneseRatio=${ratio === null ? "n/a" : ratio.toFixed(2)} (target >= 0.60)`);
    console.info(
      `[measured] first audio after ${firstAudioMs === null ? "n/a" : Math.round(firstAudioMs)}ms, ` +
        `${audioChunks} audio chunks, usage=${JSON.stringify(usage)}`,
    );
    expect(audioChunks).toBeGreaterThan(0);
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThanOrEqual(0.6);
  }, 90_000);
});

// ---------------------------------------------------------------------------------------------
// 2. A browser-style session through the deployed API and Events API
// ---------------------------------------------------------------------------------------------

interface StartedSession {
  sessionId: string;
  clientToken: string;
  hosts: { http: string; realtime: string };
  channels: { in: string; out: string; text: string };
}

const b64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/** WAV bytes (16 kHz mono 16-bit, 44-byte header) to raw PCM. */
function wavToPcm(wav: Uint8Array): Buffer {
  return Buffer.from(wav.slice(44));
}

describeIntegration("voice session through the deployed Events API (V13, R10.6, R15.6)", () => {
  it("reports loop latency, text lead over audio and the price per minute", async () => {
    const api = required("WARASHI_IT_API_URL").replace(/\/+$/, "");
    const bearer = { Authorization: `Bearer ${required("WARASHI_IT_FAMILY_TOKEN")}`, "Content-Type": "application/json" };

    // The user's turns: synthetic Japanese speech from Polly, 16 kHz mono.
    const synth = createSpeechSynth({
      modelId: process.env["WARASHI_BEDROCK_MODEL_ID"] || "amazon.nova-lite-v1:0",
      voiceId: process.env["WARASHI_POLLY_VOICE_ID"] || "Kazuha",
      bedrock: new BedrockRuntimeClient({ region: REGION }),
      polly: new PollyClient({ region: REGION }),
    });
    const phrases = ["こんにちは。", "きょうは、いいてんきですね。", "ありがとう。またね。"];
    const speech = await Promise.all(phrases.map(async (p) => wavToPcm(await synth.wav16k(p))));

    const res = await fetch(`${api}/conversations`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ deviceId: DEVICE_ID, client: "browser", target: "virtual" }),
    });
    expect(res.status).toBe(201);
    const session = (await res.json()) as StartedSession;
    const auth = { host: session.hosts.http, Authorization: session.clientToken };

    const sessionStartedAt = performance.now();
    const outAudioAt: number[] = []; // arrival times of model audio frames
    const assistantTextAt: number[] = []; // arrival times of assistant transcript frames
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`wss://${session.hosts.realtime}/event/realtime`, [
        `header-${b64url(JSON.stringify(auth))}`,
        "aws-appsync-event-ws",
      ]);
      const socket = ws;
      let subscribed = 0;
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("AppSync connect timed out")), 15_000);
        socket.addEventListener("error", () => reject(new Error("AppSync WebSocket error")));
        socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "connection_init" })));
        socket.addEventListener("message", (ev) => {
          const msg = JSON.parse(String(ev.data)) as { type?: string; id?: string; event?: string };
          const at = performance.now();
          if (msg.type === "connection_ack") {
            for (const [id, channel] of [["out", session.channels.out], ["text", session.channels.text]] as const) {
              socket.send(JSON.stringify({ type: "subscribe", id, channel, authorization: auth }));
            }
          } else if (msg.type === "subscribe_success") {
            subscribed += 1;
            if (subscribed === 2) {
              clearTimeout(timer);
              resolve();
            }
          } else if (msg.type === "data" && typeof msg.event === "string") {
            const frame = JSON.parse(msg.event) as { t?: string; role?: string; final?: boolean };
            if (msg.id === "out" && frame.t === "audio") outAudioAt.push(at);
            if (msg.id === "text" && frame.t === "transcript" && frame.role === "assistant") assistantTextAt.push(at);
          } else if (msg.type?.endsWith("_error")) {
            clearTimeout(timer);
            reject(new Error(`AppSync ${msg.type}`));
          }
        });
      });
      await ready;

      let pubId = 0;
      const publish = (frames: object[]): void => {
        // At most 5 events per publish (AppSync Events limit).
        for (let i = 0; i < frames.length; i += 5) {
          socket.send(
            JSON.stringify({
              type: "publish",
              id: `p${(pubId += 1)}`,
              channel: session.channels.in,
              events: frames.slice(i, i + 5).map((f) => JSON.stringify(f)),
              authorization: auth,
            }),
          );
        }
      };

      publish([{ t: "hello", client: "browser", v: 1 }]);
      let seq = 0;
      const chunkBytes = 3200; // 100 ms of 16 kHz S16LE mono
      const sendPcm = async (pcm: Buffer): Promise<void> => {
        for (let off = 0; off < pcm.length; off += chunkBytes) {
          const chunk = Buffer.alloc(chunkBytes);
          pcm.copy(chunk, 0, off, Math.min(pcm.length, off + chunkBytes));
          publish([{ t: "audio", seq: (seq += 1) - 1, pcm: chunk.toString("base64") }]);
          await sleep(100); // real time: AppSync Events allows about 10 publishes per second
        }
      };

      const loopMs: number[] = [];
      const leadMs: number[] = [];
      for (let turn = 0; turn < TURNS; turn += 1) {
        const audioBefore = outAudioAt.length;
        const textBefore = assistantTextAt.length;
        await sendPcm(speech[turn] as Buffer);
        const lastChunkAt = performance.now();
        // Silence lets the model's turn detection end the user's turn.
        await sendPcm(Buffer.alloc(chunkBytes * 15));
        for (let i = 0; i < 300 && outAudioAt.length === audioBefore; i += 1) await sleep(100);
        expect(outAudioAt.length).toBeGreaterThan(audioBefore);
        loopMs.push((outAudioAt[audioBefore] as number) - lastChunkAt);
        if (assistantTextAt.length > textBefore) {
          // Positive: the text arrived before the first audio of the turn (V13).
          leadMs.push((outAudioAt[audioBefore] as number) - (assistantTextAt[textBefore] as number));
        }
        // Let the model finish speaking: wait for a quiet period without audio.
        let last = outAudioAt.length;
        for (let quiet = 0; quiet < 20; ) {
          await sleep(100);
          if (outAudioAt.length === last) quiet += 1;
          else {
            last = outAudioAt.length;
            quiet = 0;
          }
        }
      }
      publish([{ t: "bye", reason: "user" }]);
      await sleep(500);

      summarize("loop latency (last user chunk to first model audio)", loopMs);
      if (leadMs.length > 0) summarize("assistant text lead over first audio (positive = text first)", leadMs);
      else console.info("[measured] assistant text lead: no assistant transcript frames arrived");
      const minutes = (performance.now() - sessionStartedAt) / 60_000;
      console.info(
        `[measured] session length ${minutes.toFixed(2)} min; the price per minute comes from the ` +
          "Bedrock usage events, which the Lambda does not forward: read the `usage` log of test 1 and " +
          "multiply by the turn rate, or check Cost Explorer (Bedrock, tag project=zashiki-warashi).",
      );
    } finally {
      ws?.close();
      await fetch(`${api}/conversations/${session.sessionId}`, { method: "DELETE", headers: bearer }).catch(() => undefined);
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------
// Pure helpers (run in every `make test`, no AWS)
// ---------------------------------------------------------------------------------------------

describe("voice integration helpers", () => {
  it("is skipped from the AWS suites without the opt-in variable", () => {
    expect(integrationEnabled({})).toBe(false);
  });

  it("adds the token deltas of a usage event and ignores everything else", () => {
    const usage = emptyUsage();
    addUsage(
      usage,
      JSON.stringify({
        event: {
          usageEvent: {
            details: { delta: { input: { speechTokens: 100, textTokens: 10 }, output: { speechTokens: 200, textTokens: 20 } } },
          },
        },
      }),
    );
    addUsage(usage, "not json");
    addUsage(usage, JSON.stringify({ event: { textOutput: { content: "x" } } }));
    expect(usage).toEqual({ speechIn: 100, textIn: 10, speechOut: 200, textOut: 20 });
    expect(priceUsd(usage)).toBeCloseTo(
      (100 * 0.0037411 + 200 * 0.0149643 + 10 * 0.000396 + 20 * 0.003311) / 1000,
      10,
    );
  });
});
