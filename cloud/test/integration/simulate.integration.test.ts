// Opt-in integration test for generated speech and POST /simulate (task 24.2).
//
// Skipped unless WARASHI_AWS_INTEGRATION=1, so `make test` never runs it. It calls real AWS:
//   - Amazon Bedrock (Nova Lite) and Amazon Polly in Tokyo, through the production adapter;
//   - the deployed API's POST /simulate with a reviewer token and a seeded sample.
//
// Settings come from the environment, never from the repository:
//   WARASHI_IT_API_URL          base URL of the deployed API (stack output)
//   WARASHI_IT_REVIEWER_TOKEN   Cognito access token of a user in the `reviewer` group
//   WARASHI_IT_SAMPLE_ID        a sample id from GET /samples
//   WARASHI_BEDROCK_MODEL_ID    optional, default amazon.nova-lite-v1:0
//   WARASHI_POLLY_VOICE_ID      optional, default Kazuha
//   AWS_REGION                  optional, default ap-northeast-1
//
// Measured values (latency, token and character counts) are printed to the console only. The
// billed cost is read afterwards in the owner's Cost Explorer (filter by service and the
// `project=zashiki-warashi` tag); it is never written to a tracked file.
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { PollyClient } from "@aws-sdk/client-polly";
import { expect, it } from "vitest";

import { createSpeechSynth, SPEECH_CALL_TIMEOUT_MS } from "../../lambda/_shared/adapters/speech.js";
import { buildPrompt } from "../../lambda/_shared/persona.js";
import { sanitizeLine } from "../../lambda/_shared/sanitizer.js";
import { describeIntegration } from "../integration.js";

const REGION = process.env["AWS_REGION"] || "ap-northeast-1";
const MODEL_ID = process.env["WARASHI_BEDROCK_MODEL_ID"] || "amazon.nova-lite-v1:0";
const VOICE_ID = process.env["WARASHI_POLLY_VOICE_ID"] || "Kazuha";
const ROUNDS = 5;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} must be set to run the simulate integration test`);
  }
  return value.trim();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

function summarize(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  console.info(
    `[measured] ${label}: n=${sorted.length} p50=${percentile(sorted, 50)}ms ` +
      `p95=${percentile(sorted, 95)}ms max=${sorted[sorted.length - 1] ?? 0}ms`,
  );
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await work();
  return { value, ms: Math.round(performance.now() - start) };
}

describeIntegration("speech in Tokyo: Nova Lite line and Polly MP3 (R7.4, R7.8)", () => {
  const synth = createSpeechSynth({
    modelId: MODEL_ID,
    voiceId: VOICE_ID,
    bedrock: new BedrockRuntimeClient({ region: REGION }),
    polly: new PollyClient({ region: REGION }),
  });

  it("returns a JSON line with ja and en within the 5 s limit", async () => {
    const lineMs: number[] = [];
    let accepted = 0;
    for (let i = 0; i < ROUNDS; i += 1) {
      const { value: raw, ms } = await timed(() => synth.line("family", null));
      lineMs.push(ms);
      expect(ms).toBeLessThan(SPEECH_CALL_TIMEOUT_MS);
      expect(raw).not.toBeNull();
      const start = (raw as string).indexOf("{");
      const end = (raw as string).lastIndexOf("}");
      expect(start).toBeGreaterThanOrEqual(0);
      const parsed = JSON.parse((raw as string).slice(start, end + 1)) as Record<string, unknown>;
      expect(typeof parsed["ja"]).toBe("string");
      expect(typeof parsed["en"]).toBe("string");
      // The model may break a rule now and then; the generator then falls back to a cached
      // line (R7.7). Count how often the raw line passes, as a quality measurement.
      if (sanitizeLine(parsed["ja"] as string, []) !== null) accepted += 1;
    }
    summarize(`Nova Lite line (${MODEL_ID}, ${REGION})`, lineMs);
    console.info(`[measured] Nova Lite lines passing the sanitizer: ${accepted}/${ROUNDS}`);
  });

  it("reports Nova Lite token usage for one line", async () => {
    const { system, user } = buildPrompt("family", null);
    const client = new BedrockRuntimeClient({ region: REGION });
    const out = await client.send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          schemaVersion: "messages-v1",
          system: [{ text: system }],
          messages: [{ role: "user", content: [{ text: user }] }],
          inferenceConfig: { maxTokens: 200, temperature: 0.7 },
        }),
      }),
    );
    const body = JSON.parse(new TextDecoder().decode(out.body)) as {
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    expect(body.usage?.inputTokens).toBeGreaterThan(0);
    console.info(
      `[measured] Nova Lite usage per line: input=${body.usage?.inputTokens} ` +
        `output=${body.usage?.outputTokens} tokens`,
    );
  });

  it("synthesizes a non-empty MP3 with Polly within the 5 s limit", async () => {
    const text = "おかえりなさい。";
    const mp3Ms: number[] = [];
    let bytes = 0;
    for (let i = 0; i < ROUNDS; i += 1) {
      const { value, ms } = await timed(() => synth.mp3(text));
      mp3Ms.push(ms);
      expect(ms).toBeLessThan(SPEECH_CALL_TIMEOUT_MS);
      expect(value.length).toBeGreaterThan(100);
      // MP3 starts with an ID3 tag or an MPEG frame sync (11 set bits).
      const isId3 = value[0] === 0x49 && value[1] === 0x44 && value[2] === 0x33;
      const isFrame = value[0] === 0xff && ((value[1] as number) & 0xe0) === 0xe0;
      expect(isId3 || isFrame).toBe(true);
      bytes = value.length;
    }
    summarize(`Polly MP3 (${VOICE_ID}, neural, ${REGION})`, mp3Ms);
    console.info(
      `[measured] Polly billed characters per call: ${[...text].length}; MP3 size ${bytes} bytes`,
    );
  });

  it("synthesizes a WAV for the doll with a valid RIFF header", async () => {
    const wav = await synth.wav16k("だれか、いますか。");
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(wav.length).toBeGreaterThan(44);
  });
});

type SimulateBody = {
  sampleId?: string;
  verdict?: string;
  confidence?: number;
  commands?: { type: string }[];
  speech?: {
    lineId: string | null;
    ja: string;
    en: string;
    mp3Url: string | null;
    generated: boolean;
  } | null;
  latencyMs: { total: number; search: number };
  error?: { code: string };
};

describeIntegration("POST /simulate on the deployed API (R15.6)", () => {
  const apiUrl = (): string => required("WARASHI_IT_API_URL").replace(/\/+$/, "");
  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${required("WARASHI_IT_REVIEWER_TOKEN")}`,
    "Content-Type": "application/json",
  });

  async function simulate(generate: boolean): Promise<{ status: number; body: SimulateBody; ms: number }> {
    const { value: res, ms } = await timed(() =>
      fetch(`${apiUrl()}/simulate`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ sampleId: required("WARASHI_IT_SAMPLE_ID"), generate }),
      }),
    );
    return { status: res.status, body: (await res.json()) as SimulateBody, ms };
  }

  it("rejects a request without a token", async () => {
    const res = await fetch(`${apiUrl()}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sampleId: required("WARASHI_IT_SAMPLE_ID") }),
    });
    expect(res.status).toBe(401);
  });

  it("returns a verdict and the commands without generated speech", async () => {
    const { status, body, ms } = await simulate(false);
    expect(status).toBe(200);
    expect(body.sampleId).toBe(required("WARASHI_IT_SAMPLE_ID"));
    expect(["family", "stranger", "no_face", "uncertain"]).toContain(body.verdict);
    expect(body.confidence).toBeGreaterThanOrEqual(0);
    expect(body.confidence).toBeLessThanOrEqual(1);
    const types = (body.commands ?? []).map((c) => c.type);
    expect(types).toEqual(["judgement.result", "speak"]);
    expect(Number.isInteger(body.latencyMs.total)).toBe(true);
    expect(body.latencyMs.search).toBeLessThanOrEqual(body.latencyMs.total);
    console.info(
      `[measured] POST /simulate generate=false: round trip ${ms}ms, ` +
        `total=${body.latencyMs.total}ms search=${body.latencyMs.search}ms`,
    );
  });

  it("returns generated speech with a pre-signed MP3 URL when generation is allowed", async () => {
    const { status, body, ms } = await simulate(true);
    // A 429 means the hourly generation limit is used up; that is a valid, documented outcome.
    if (status === 429) {
      console.info("[measured] POST /simulate generate=true: rate_limited");
      expect(body.error?.code).toBe("rate_limited");
      return;
    }
    expect(status).toBe(200);
    const speech = body.speech ?? null;
    expect(speech).not.toBeNull();
    expect(typeof speech?.ja).toBe("string");
    expect(typeof speech?.en).toBe("string");
    if (speech?.generated === true) {
      expect(speech.lineId).toBeNull();
    } else {
      expect(speech?.lineId).not.toBeNull();
    }
    if (speech?.mp3Url) {
      const audio = await fetch(speech.mp3Url);
      expect(audio.status).toBe(200);
      expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(100);
    }
    console.info(
      `[measured] POST /simulate generate=true: round trip ${ms}ms, generated=${speech?.generated}, ` +
        `mp3=${speech?.mp3Url ? "yes" : "no"}, total=${body.latencyMs.total}ms`,
    );
  });
});
