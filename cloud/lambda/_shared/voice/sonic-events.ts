/**
 * Builders for the Nova Sonic input events of one voice session.
 *
 * Pure module: no AWS imports, no clock, no randomness. Names (`promptName`, `contentName`) are
 * arguments, so the same input always gives the same events. Every function returns JSON strings
 * ready for `SonicStream.send`, in the documented order (design, "Event order"):
 *
 *   sessionStart, promptStart (output config and tools), system contentStart / textInput /
 *   contentEnd, audio contentStart, audioInput..., contentEnd (audio), promptEnd, sessionEnd
 *
 * Tool results are sent between the audio `contentStart` and the audio `contentEnd`, each as its
 * own `contentStart` / `toolResult` / `contentEnd` block. Model ID, voice ID and the inference
 * settings come from `VoiceConfig` and `prompt.ts`; nothing here depends on family data.
 */

import type { VoiceConfig } from "./config.js";
import { SONIC_ENDPOINTING_SENSITIVITY, SONIC_INFERENCE } from "./prompt.js";

/**
 * Minimal shape of a model-facing tool spec (design, "The model-facing tool specs").
 * `tools.ts` (`TOOL_SPECS`) is not imported here so this module stays independent of it;
 * the caller passes the specs in.
 */
export interface SonicToolSpec {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: { json: object };
  };
}

/** The settings of `VoiceConfig` that appear in Sonic events. */
export type SonicVoiceSettings = Pick<VoiceConfig, "voiceModelId" | "voiceId">;

/** Names that tie the events of one prompt together. */
export interface SonicIds {
  promptName: string;
  /** Content name of the audio input block. */
  audioContentName: string;
}

export interface SonicStart extends SonicIds {
  voice: SonicVoiceSettings;
  systemContentName: string;
  systemPrompt: string;
  tools: readonly SonicToolSpec[];
}

export interface ToolResultInput {
  promptName: string;
  /** Unique content name for this result block. */
  contentName: string;
  toolUseId: string;
  /** The result object for the model; it is sent as a JSON string. */
  result: object;
}

/** Audio media settings from the design ("Audio formats"). */
const AUDIO_INPUT = Object.freeze({
  mediaType: "audio/lpcm",
  sampleRateHertz: 16000,
  sampleSizeBits: 16,
  channelCount: 1,
  audioType: "SPEECH",
  encoding: "base64",
});

const AUDIO_OUTPUT = Object.freeze({
  mediaType: "audio/lpcm",
  sampleRateHertz: 24000,
  sampleSizeBits: 16,
  channelCount: 1,
});

function ev(name: string, body: object): string {
  return JSON.stringify({ event: { [name]: body } });
}

/** `sessionStart` .. end of the system prompt block (5 events). */
export function sonicStartEvents(p: SonicStart): readonly string[] {
  return [
    ev("sessionStart", {
      inferenceConfiguration: { ...SONIC_INFERENCE },
      turnDetectionConfiguration: { endpointingSensitivity: SONIC_ENDPOINTING_SENSITIVITY },
    }),
    ev("promptStart", {
      promptName: p.promptName,
      textOutputConfiguration: { mediaType: "text/plain" },
      audioOutputConfiguration: {
        ...AUDIO_OUTPUT,
        voiceId: p.voice.voiceId,
        encoding: "base64",
        audioType: "SPEECH",
      },
      toolUseOutputConfiguration: { mediaType: "application/json" },
      toolConfiguration: { tools: p.tools, toolChoice: { auto: {} } },
    }),
    ev("contentStart", {
      promptName: p.promptName,
      contentName: p.systemContentName,
      type: "TEXT",
      role: "SYSTEM",
      interactive: false,
      textInputConfiguration: { mediaType: "text/plain" },
    }),
    ev("textInput", {
      promptName: p.promptName,
      contentName: p.systemContentName,
      content: p.systemPrompt,
    }),
    ev("contentEnd", { promptName: p.promptName, contentName: p.systemContentName }),
  ];
}

/** Opens the audio input block. Must come after `sonicStartEvents` and before any `audioInput`. */
export function sonicAudioContentStart(p: SonicIds): string {
  return ev("contentStart", {
    promptName: p.promptName,
    contentName: p.audioContentName,
    type: "AUDIO",
    role: "USER",
    interactive: true,
    audioInputConfiguration: { ...AUDIO_INPUT },
  });
}

/** One microphone chunk. `pcmBase64` is 16 kHz S16LE mono, already Base64. */
export function sonicAudioInput(p: SonicIds, pcmBase64: string): string {
  return ev("audioInput", {
    promptName: p.promptName,
    contentName: p.audioContentName,
    content: pcmBase64,
  });
}

/** `contentStart` (TOOL), `toolResult`, `contentEnd` for one `toolUse`. */
export function sonicToolResult(p: ToolResultInput): readonly string[] {
  return [
    ev("contentStart", {
      promptName: p.promptName,
      contentName: p.contentName,
      interactive: false,
      type: "TOOL",
      role: "TOOL",
      toolResultInputConfiguration: {
        toolUseId: p.toolUseId,
        type: "TEXT",
        textInputConfiguration: { mediaType: "text/plain" },
      },
    }),
    ev("toolResult", {
      promptName: p.promptName,
      contentName: p.contentName,
      content: JSON.stringify(p.result),
    }),
    ev("contentEnd", { promptName: p.promptName, contentName: p.contentName }),
  ];
}

/** Closes the audio block, then `promptEnd` and `sessionEnd`. Send once, last. */
export function sonicShutdownEvents(p: SonicIds): readonly string[] {
  return [
    ev("contentEnd", { promptName: p.promptName, contentName: p.audioContentName }),
    ev("promptEnd", { promptName: p.promptName }),
    ev("sessionEnd", {}),
  ];
}

/** One step of a session after the audio block opened. */
export type SonicStep =
  | { kind: "audio"; pcmBase64: string }
  | { kind: "toolResult"; contentName: string; toolUseId: string; result: object };

/**
 * The full ordered list of input events for a session: start events, audio `contentStart`, the
 * steps in the given order, then the shutdown events exactly once. An empty `steps` list is an
 * early end and still produces a complete, balanced script.
 */
export function sessionScript(p: SonicStart, steps: readonly SonicStep[]): readonly string[] {
  const out: string[] = [...sonicStartEvents(p), sonicAudioContentStart(p)];
  for (const step of steps) {
    if (step.kind === "audio") {
      out.push(sonicAudioInput(p, step.pcmBase64));
    } else {
      out.push(
        ...sonicToolResult({
          promptName: p.promptName,
          contentName: step.contentName,
          toolUseId: step.toolUseId,
          result: step.result,
        }),
      );
    }
  }
  out.push(...sonicShutdownEvents(p));
  return out;
}
