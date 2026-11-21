import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_CONFIG } from "../../lambda/_shared/voice/config.js";
import {
  sessionScript,
  type SonicStart,
  type SonicStep,
  type SonicToolSpec,
} from "../../lambda/_shared/voice/sonic-events.js";

// Feature: voice-conversation, Property 10: Sonic event order
// **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5**

const name = fc.stringMatching(/^[a-z0-9-]{1,12}$/);

const toolSpecs: fc.Arbitrary<SonicToolSpec[]> = fc.uniqueArray(name, { maxLength: 3 }).map((names) =>
  names.map((n) => ({
    toolSpec: { name: n, description: "placeholder", inputSchema: { json: { type: "object" } } },
  })),
);

const start: fc.Arbitrary<SonicStart> = fc.record({
  promptName: fc.constant("prompt-1"),
  audioContentName: fc.constant("audio-1"),
  systemContentName: fc.constant("system-1"),
  systemPrompt: fc.string({ maxLength: 200 }),
  voice: fc.constant({ voiceModelId: DEFAULT_VOICE_CONFIG.voiceModelId, voiceId: DEFAULT_VOICE_CONFIG.voiceId }),
  tools: toolSpecs,
});

/** Steps cover audio (also during barge-in), tool results and an empty list (early end). */
const steps: fc.Arbitrary<SonicStep[]> = fc
  .array(
    fc.oneof(
      fc.constantFrom("AAAA", "BBBB", "").map((pcmBase64): SonicStep => ({ kind: "audio", pcmBase64 })),
      fc.record({ result: fc.dictionary(fc.constantFrom("ok", "verdict", "level"), fc.jsonValue()) }).map(
        ({ result }): SonicStep => ({ kind: "toolResult", contentName: "", toolUseId: "u", result }),
      ),
    ),
    { maxLength: 30 },
  )
  .map((list) => list.map((s, i) => (s.kind === "toolResult" ? { ...s, contentName: `tool-${i}`, toolUseId: `use-${i}` } : s)));

interface Ev {
  name: string;
  body: Record<string, unknown>;
}
const parse = (events: readonly string[]): Ev[] =>
  events.map((e) => {
    const event = JSON.parse(e).event as Record<string, Record<string, unknown>>;
    const key = Object.keys(event)[0] as string;
    return { name: key, body: event[key] as Record<string, unknown> };
  });

describe("Property 10: Sonic event order", () => {
  it("keeps the documented order, balanced blocks and a single final shutdown", () => {
    fc.assert(
      fc.property(start, steps, (s, st) => {
        const ev = parse(sessionScript(s, st));
        const names = ev.map((e) => e.name);

        // First three events.
        expect(names.slice(0, 3)).toEqual(["sessionStart", "promptStart", "contentStart"]);
        expect(ev[2]!.body.role).toBe("SYSTEM");

        // Audio contentStart precedes every audioInput.
        const audioStart = ev.findIndex((e) => e.name === "contentStart" && e.body.type === "AUDIO");
        expect(audioStart).toBeGreaterThan(2);
        ev.forEach((e, i) => {
          if (e.name === "audioInput") expect(i).toBeGreaterThan(audioStart);
        });

        // Every contentStart has exactly one contentEnd with the same name, after it.
        ev.forEach((e, i) => {
          if (e.name !== "contentStart") return;
          const ends = ev.flatMap((x, j) =>
            x.name === "contentEnd" && x.body.contentName === e.body.contentName ? [j] : [],
          );
          expect(ends).toHaveLength(1);
          expect(ends[0]).toBeGreaterThan(i);
        });
        expect(names.filter((n) => n === "contentEnd")).toHaveLength(
          names.filter((n) => n === "contentStart").length,
        );

        // Shutdown last, once; nothing after sessionEnd.
        expect(names.slice(-2)).toEqual(["promptEnd", "sessionEnd"]);
        expect(names.filter((n) => n === "promptEnd")).toHaveLength(1);
        expect(names.filter((n) => n === "sessionEnd")).toHaveLength(1);
        expect(names.indexOf("sessionEnd")).toBe(names.length - 1);

        // The audio block closes after all audio and tool events.
        const audioEnd = ev.findIndex((e) => e.name === "contentEnd" && e.body.contentName === s.audioContentName);
        expect(audioEnd).toBe(names.length - 3);
      }),
      { numRuns: 200 },
    );
  });
});
