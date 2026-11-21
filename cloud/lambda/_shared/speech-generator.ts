/**
 * Speech generator (cloud-judgement design, "Generated speech (Bedrock + Polly)").
 *
 * Asks Bedrock (through the `SpeechSynth` port) for one short in-character line as JSON
 * `{"ja", "en"}`, checks the Japanese text with the sanitizer, and synthesizes MP3 with Polly.
 * Any failure on the text path falls back to a cached line. The prompt itself is built behind the
 * port from `buildPrompt` (persona rules and situation only), so no name can enter it.
 *
 * The Judge never calls this module and nothing sends its output to the real doll (R7.12).
 * Pure apart from the injected port: no AWS imports.
 */

import { chooseLine } from "./lines.js";
import type { Category, VoiceLine } from "./lines.js";
import type { SpeechSynth } from "./ports.js";
import { sanitizeLine } from "./sanitizer.js";

/** Limit for each Bedrock and Polly call, in milliseconds (R7.4, R7.8). */
export const SPEECH_CALL_TIMEOUT_MS = 5000;

/** Result of `generateSpeech`. The caller turns `mp3` into a pre-signed URL. */
export type GeneratedSpeech = {
  ja: string;
  en: string;
  /** Cached line id, or `null` for a generated line. */
  lineId: string | null;
  /** MP3 bytes, or `null` for a cached line or when Polly failed. */
  mp3: Uint8Array | null;
  generated: boolean;
};

export interface SpeechDeps {
  synth: SpeechSynth;
  /** The cached line catalog, used for every fallback. */
  lines: readonly VoiceLine[];
  /** Random number in [0, 1) for the cached line choice. */
  rand: number;
  blockedWords: readonly string[];
  /** Default false (R7.13): a stranger situation then uses a cached line and no AWS call. */
  allowStrangerGeneration?: boolean;
  /** Per-call limit, default `SPEECH_CALL_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Reject after `ms` so a slow call cannot hold the request. The timer is always cleared. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the model reply. Returns `null` unless it holds string `ja` and a non-empty string `en`. */
function parseLine(raw: string): { ja: string; en: string } | null {
  // Models sometimes wrap JSON in a code fence or add a sentence; take the outermost braces.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { ja, en } = value as Record<string, unknown>;
  if (typeof ja !== "string" || typeof en !== "string" || en.trim().length === 0) {
    return null;
  }
  return { ja, en: en.trim() };
}

function cachedSpeech(
  situation: Category,
  lines: readonly VoiceLine[],
  rand: number,
): GeneratedSpeech {
  const line = chooseLine(lines, situation, rand);
  if (line === null) {
    throw new Error(`no cached voice line for category ${situation}`);
  }
  return { ja: line.ja, en: line.en, lineId: line.id, mp3: null, generated: false };
}

/**
 * One line of speech for `situation`.
 *
 * Text failures (Bedrock error or timeout, bad JSON, missing `ja` or `en`, sanitizer rejection)
 * return a cached line with `generated: false` and `lineId` set (R7.7). A Polly failure returns
 * the sanitized line with `mp3: null` (R7.9). Throws only when the catalog has no line of the
 * category, which the caller reports as an internal error.
 */
export async function generateSpeech(
  situation: Category,
  hint: string | null,
  deps: SpeechDeps,
): Promise<GeneratedSpeech> {
  if (situation === "stranger" && deps.allowStrangerGeneration !== true) {
    return cachedSpeech(situation, deps.lines, deps.rand);
  }
  const timeoutMs = deps.timeoutMs ?? SPEECH_CALL_TIMEOUT_MS;

  let parsed: { ja: string; en: string } | null = null;
  try {
    const raw = await withTimeout(deps.synth.line(situation, hint), timeoutMs);
    parsed = raw === null ? null : parseLine(raw);
  } catch {
    parsed = null;
  }
  const ja = parsed === null ? null : sanitizeLine(parsed.ja, deps.blockedWords);
  if (parsed === null || ja === null) {
    return cachedSpeech(situation, deps.lines, deps.rand);
  }

  let mp3: Uint8Array | null = null;
  try {
    mp3 = await withTimeout(deps.synth.mp3(ja), timeoutMs);
  } catch {
    mp3 = null;
  }
  return { ja, en: parsed.en, lineId: null, mp3, generated: true };
}
