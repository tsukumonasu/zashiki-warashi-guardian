import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_CONFIG } from "../../lambda/_shared/voice/config.js";
import { isUnsafeAssistantText, japaneseRatio, languageVerdict } from "../../lambda/_shared/voice/language.js";
import {
  buildSystemPrompt,
  SONIC_ENDPOINTING_SENSITIVITY,
  SONIC_INFERENCE,
} from "../../lambda/_shared/voice/prompt.js";
import {
  sessionScript,
  sonicAudioContentStart,
  sonicShutdownEvents,
  sonicStartEvents,
  sonicToolResult,
  type SonicStart,
  type SonicToolSpec,
} from "../../lambda/_shared/voice/sonic-events.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const readText = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

interface PersonaMarker {
  rule: string;
  marker: string;
  source: string;
}

/** True when `file` holds a markdown heading whose text equals `heading`. */
function hasHeading(file: string, heading: string): boolean {
  return readText(file)
    .split("\n")
    .some((line) => /^#{1,6}\s/.test(line) && line.replace(/^#{1,6}\s+/, "").trim() === heading);
}

const SOURCE_FILES: Record<string, string> = {
  "persona.md": ".kiro/steering/persona.md",
  "design.md": ".kiro/specs/voice-conversation/design.md",
};

describe("buildSystemPrompt", () => {
  const markers = JSON.parse(readText("docs/fixtures/voice-v1/persona-markers.json")) as PersonaMarker[];

  it("contains the marker phrase of every persona rule", () => {
    const prompt = buildSystemPrompt();
    const missing = markers.filter((m) => !prompt.includes(m.marker)).map((m) => m.rule);
    expect(missing, `prompt lacks marker for: ${missing.join(", ")}`).toEqual([]);
  });

  it("still finds every source heading named by a marker", () => {
    const missing: string[] = [];
    for (const m of markers) {
      const [file, heading] = m.source.split(" > ");
      const path = SOURCE_FILES[file ?? ""];
      if (!path || !heading || !hasHeading(path, heading)) missing.push(`${m.rule} (${m.source})`);
    }
    expect(missing, `missing rule heading: ${missing.join("; ")}`).toEqual([]);
  });

  it("takes no parameters, is stable, and holds no blocked word", () => {
    expect(buildSystemPrompt.length).toBe(0);
    expect(buildSystemPrompt()).toBe(buildSystemPrompt());
    const blocked = [...DEFAULT_VOICE_CONFIG.blockedWords, "stupid", "idiot", "shut up", "馬鹿", "ばか"];
    expect(isUnsafeAssistantText(buildSystemPrompt(), blocked)).toBe(false);
  });
});

describe("language check", () => {
  it("returns null under four letters and a ratio otherwise", () => {
    expect(japaneseRatio("")).toBeNull();
    expect(japaneseRatio("はい！")).toBeNull();
    expect(japaneseRatio("ab c")).toBeNull();
    expect(japaneseRatio("おかえりなさい")).toBe(1);
    expect(japaneseRatio("hello there")).toBe(0);
    expect(japaneseRatio(undefined as unknown as string)).toBeNull();
  });

  it("counts kana, katakana with the long mark, and kanji", () => {
    expect(japaneseRatio("コーヒー")).toBe(1);
    expect(japaneseRatio("今日はいい天気")).toBe(1);
    expect(japaneseRatio("あいうえ abcd")).toBeCloseTo(0.5);
  });

  it("is ok for Japanese, bad after two English turns, undecided otherwise", () => {
    expect(languageVerdict([])).toBe("undecided");
    expect(languageVerdict(["おかえり、まっていたよ。"])).toBe("ok");
    expect(languageVerdict(["Hello there, friend."])).toBe("undecided");
    expect(languageVerdict(["Hello there, friend.", "How are you today?"])).toBe("bad");
    expect(languageVerdict(["Hi", "Ok", "No"])).toBe("undecided");
  });

  it("treats mixed text by its Japanese share", () => {
    expect(languageVerdict(["おかえり、hello"])).toBe("undecided"); // 4 of 9 letters: below 60 %
    expect(languageVerdict(["おかえりなさい、hi"])).toBe("ok"); // 7 of 9 letters
  });

  it("lets a later Japanese turn win over earlier English turns", () => {
    expect(languageVerdict(["Hello there.", "Good evening.", "おかえりなさい"])).toBe("ok");
  });

  it("detects blocked words ignoring case, and skips empty words", () => {
    expect(isUnsafeAssistantText("You are STUPID", ["stupid"])).toBe(true);
    expect(isUnsafeAssistantText("ばか", ["ばか"])).toBe(true);
    expect(isUnsafeAssistantText("hello", ["stupid"])).toBe(false);
    expect(isUnsafeAssistantText("hello", [""])).toBe(false);
    expect(isUnsafeAssistantText("hello", [])).toBe(false);
    expect(isUnsafeAssistantText("", ["x"])).toBe(false);
  });
});

const TOOLS: SonicToolSpec[] = ["turn_head", "set_lantern", "look"].map((name) => ({
  toolSpec: { name, description: "placeholder tool", inputSchema: { json: { type: "object", properties: {}, required: [] } } },
}));

const START: SonicStart = {
  promptName: "prompt-0001",
  audioContentName: "audio-0001",
  systemContentName: "system-0001",
  systemPrompt: "placeholder system prompt",
  voice: { voiceModelId: DEFAULT_VOICE_CONFIG.voiceModelId, voiceId: DEFAULT_VOICE_CONFIG.voiceId },
  tools: TOOLS,
};

/** Parsed JSON read by path. Every property access yields the same type, so no `any` is needed. */
interface Loose {
  [key: string]: Loose;
}
const parse = (events: readonly string[]): Loose[] => events.map((e) => JSON.parse(e) as Loose);
const nameOf = (e: Loose): string => Object.keys(e["event"] as Loose)[0] as string;

describe("Sonic event builders", () => {
  it("uses the default model and voice", () => {
    expect(DEFAULT_VOICE_CONFIG.voiceModelId).toBe("amazon.nova-2-5-sonic");
    expect(DEFAULT_VOICE_CONFIG.voiceId).toBe("tiffany");
    expect(parse(sonicStartEvents(START))[1].event.promptStart.audioOutputConfiguration.voiceId).toBe("tiffany");
  });

  it("builds the start events in order with the documented shapes", () => {
    const ev = parse(sonicStartEvents(START));
    expect(ev.map(nameOf)).toEqual(["sessionStart", "promptStart", "contentStart", "textInput", "contentEnd"]);
    expect(ev[0].event.sessionStart).toEqual({
      inferenceConfiguration: { ...SONIC_INFERENCE },
      turnDetectionConfiguration: { endpointingSensitivity: SONIC_ENDPOINTING_SENSITIVITY },
    });
    const ps = ev[1].event.promptStart;
    expect(ps.promptName).toBe("prompt-0001");
    expect(ps.audioOutputConfiguration).toMatchObject({ mediaType: "audio/lpcm", sampleRateHertz: 24000, channelCount: 1 });
    expect(ps.toolConfiguration.tools).toHaveLength(3);
    expect(ev[2].event.contentStart).toMatchObject({ type: "TEXT", role: "SYSTEM", interactive: false });
    expect(ev[3].event.textInput.content).toBe("placeholder system prompt");
  });

  it("builds the audio contentStart, tool result and shutdown events", () => {
    expect(JSON.parse(sonicAudioContentStart(START)).event.contentStart).toMatchObject({
      type: "AUDIO",
      role: "USER",
      interactive: true,
      audioInputConfiguration: { sampleRateHertz: 16000 },
    });
    const tool = parse(sonicToolResult({ promptName: "p", contentName: "c", toolUseId: "u", result: { ok: true } }));
    expect(tool.map(nameOf)).toEqual(["contentStart", "toolResult", "contentEnd"]);
    expect(tool[0].event.contentStart.toolResultInputConfiguration.toolUseId).toBe("u");
    expect(tool[1].event.toolResult.content).toBe('{"ok":true}');
    expect(parse(sonicShutdownEvents(START)).map(nameOf)).toEqual(["contentEnd", "promptEnd", "sessionEnd"]);
  });

  it("keeps the order and balance in a script, even with no steps", () => {
    const script = parse(
      sessionScript(START, [
        { kind: "audio", pcmBase64: "AAAA" },
        { kind: "toolResult", contentName: "tool-1", toolUseId: "u1", result: {} },
        { kind: "audio", pcmBase64: "BBBB" },
      ]),
    );
    const names = script.map(nameOf);
    expect(names[0]).toBe("sessionStart");
    expect(names.indexOf("contentStart", 3)).toBeGreaterThan(names.indexOf("promptStart"));
    expect(names.filter((n) => n === "contentStart")).toHaveLength(names.filter((n) => n === "contentEnd").length);
    expect(names.slice(-2)).toEqual(["promptEnd", "sessionEnd"]);
    expect(names.filter((n) => n === "sessionEnd")).toHaveLength(1);
    expect(sessionScript(START, []).length).toBe(5 + 1 + 3);
  });

  it.each(["sonic-session-ok.jsonl", "sonic-session-tools.jsonl"])("matches the input events of fixture %s", (file) => {
    const lines = readText(`docs/fixtures/voice-v1/${file}`)
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
    const inputs = lines.filter((e) => {
      const n = nameOf(e);
      if (["textOutput", "audioOutput", "toolUse"].includes(n)) return false;
      return !(n === "contentEnd" && String(e.event.contentEnd.contentName).startsWith("out-"));
    });
    const built = parse(sessionScript(START, [{ kind: "audio", pcmBase64: "AAABAAIAAwA=" }]));
    expect(inputs).toEqual(built);
  });
});
