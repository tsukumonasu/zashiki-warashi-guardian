/**
 * Pure core of `POST /say` (remote-actions R6, `docs/schema.md`, "HTTP API").
 *
 * Lets a family member type a Japanese line that the real doll says. The text is checked with
 * the doll's line sanitizer (length, no Latin letter, no emoji, no threat word), counted against an
 * hourly limit, synthesized to a 16 kHz mono WAV, stored under the expiring `audio/say/` prefix and
 * sent as a `speak` command with a 5-minute URL and `remote: true`. The text is never stored
 * or logged. No AWS imports. Time and ids are injected.
 */
import type { Role } from "../_shared/authz.js";
import type { CloudConfig } from "../_shared/config.js";
import { ApiError } from "../_shared/http.js";
import { makeCommand } from "../_shared/messages.js";
import type { DeviceBus, Repository, SnapshotStore, SpeechSynth, StateStore } from "../_shared/ports.js";
import { guardRemote } from "../_shared/ratelimit.js";
import { sanitizeLine } from "../_shared/sanitizer.js";
import { readDeviceId, readOnline } from "../api-admin/photos-core.js";

/** Typed lines one user may send per hour. */
export const SAYS_PER_HOUR = 30;
/** Longest typed text, in code points, and most sentences. */
export const SAY_MAX_CHARS = 60;
export const SAY_MAX_SENTENCES = 3;
/** The device refuses a WAV above 2,000,000 bytes (`docs/schema.md`); stay below it. */
export const MAX_WAV_BYTES = 1_900_000;
/** Lifetime of the pre-signed WAV URL, in seconds. */
export const SAY_URL_TTL_S = 300;
/** Fixed English subtitle: the cloud has no translation of what the family typed. */
export const SAY_SUBTITLE_EN = "A message from the family.";

export interface SayRequest {
  role: Role;
  userSub: string;
  body: Record<string, unknown>;
}

export interface SayDeps {
  bus: DeviceBus;
  repository: Pick<Repository, "getDeviceStatus">;
  state: Pick<StateStore, "incrementCounter">;
  config: Pick<CloudConfig, "statusIntervalS">;
  synth: Pick<SpeechSynth, "wav16k">;
  /** A store limited to `audio/say/`. */
  store: SnapshotStore;
  blockedWords: readonly string[];
  newId: () => string;
  nowMs: number;
}

export interface SayResponse {
  id: string;
  deviceOnline: boolean;
}

export async function handlePostSay(request: SayRequest, deps: SayDeps): Promise<SayResponse> {
  if (request.role !== "family") throw new ApiError("forbidden", "Not allowed.");
  const deviceId = readDeviceId(request.body);
  const raw = request.body["text"];
  if (typeof raw !== "string") throw new ApiError("validation_failed", "text is required.");
  const text = sanitizeLine(raw, deps.blockedWords, {
    maxChars: SAY_MAX_CHARS,
    maxSentences: SAY_MAX_SENTENCES,
  });
  if (text === null) {
    throw new ApiError(
      "validation_failed",
      "That text cannot be spoken. Use up to 60 Japanese characters, without Latin letters, emoji or frightening words.",
    );
  }
  const guard = await guardRemote("say", request.userSub, SAYS_PER_HOUR, deps.nowMs, deps.state);
  if (!guard.allowed) {
    throw new ApiError("rate_limited", "Too many messages. Try again later.", guard.retryAfterS);
  }
  let wav: Uint8Array;
  let url: string;
  try {
    wav = await deps.synth.wav16k(text);
    if (wav.length > MAX_WAV_BYTES) throw new RangeError("wav too large");
    const key = `audio/say/${deps.newId()}.wav`;
    await deps.store.put(key, wav, "audio/wav");
    url = await deps.store.signGet(key, SAY_URL_TTL_S);
  } catch {
    // No detail: the message must not carry the text or the URL.
    throw new ApiError("internal", "Could not make the speech.");
  }
  const id = deps.newId();
  const envelope = makeCommand(
    "speak",
    { lineId: null, audioUrl: url, ja: text, en: SAY_SUBTITLE_EN, remote: true },
    { id, now: new Date(deps.nowMs), deviceId, encounterId: null },
  );
  const deviceOnline = await readOnline(deviceId, deps);
  try {
    await deps.bus.publish(deviceId, envelope);
  } catch {
    throw new ApiError("internal", "Could not send the message.");
  }
  return { id, deviceOnline };
}
