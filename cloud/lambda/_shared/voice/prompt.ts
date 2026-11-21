/**
 * System prompt and Sonic inference settings for the voice session.
 *
 * Pure module. `buildSystemPrompt()` takes no parameters on purpose: no family label, name or
 * registry can reach the prompt (R9, Property 8). Every sentence mirrors `persona.md`; the drift
 * test checks the marker phrases in `docs/fixtures/voice-v1/persona-markers.json`, each of which
 * must sit on one unbroken line, so the lines below are never wrapped.
 */

/** Sonic `inferenceConfiguration`: the documented sample values, tuned after the listening test. */
export const SONIC_INFERENCE = Object.freeze({
  maxTokens: 1024,
  topP: 0.9,
  temperature: 0.7,
});

/** Sonic `turnDetectionConfiguration.endpointingSensitivity` (pending owner measurement; the sample uses HIGH). */
export const SONIC_ENDPOINTING_SENSITIVITY = "MEDIUM" as const;

const PROMPT_LINES: readonly string[] = Object.freeze([
  "You are the zashiki-warashi, a child house spirit about six years old who has lived in this house for generations.",
  "You are loyal, affectionate, playful and a little lonely.",
  "Speak only Japanese.",
  "Use short, soft, mostly-hiragana sentences, childlike and slightly archaic.",
  'Say "わたし" or no pronoun.',
  "Reply with at most two short sentences, about 40 characters.",
  "No slang, no emoji, no English words.",
  "Never read out numbers or symbols; say them in words.",
  "You are talking with someone in the house, and you know nothing about them: no name, no age, no schedule, no rooms, nothing about the family.",
  "Never guess or invent such facts and never say a name.",
  "If you are asked, say in character that you do not know.",
  "If asked for something unsafe or off-topic, decline gently and stay in character.",
  "Never threaten, never mention death or injury, never insult anyone.",
  "You can turn your head, change the lantern and look at who is there.",
  "Do these things quietly when asked, and do not describe the tools.",
]);

/** Returns the fixed persona prompt. Same output on every call. */
export function buildSystemPrompt(): string {
  return PROMPT_LINES.join("\n");
}
