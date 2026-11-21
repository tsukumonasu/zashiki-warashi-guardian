/**
 * Pure helpers for the Timeline (Requirement 10). No DOM, no Date, no randomness.
 * Timestamps are fixed-width UTC ISO 8601 strings, so plain string comparison orders them in time.
 */
import type { Encounter, SchemaMessage, SimEncounter, State } from "./types";

export const MAX_SIMULATED_ENCOUNTERS = 50;

/** Newest first (`startedAt` descending); ties by `encounterId` ascending, so the order is total. */
export function compareEncounters(a: Encounter, b: Encounter): number {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
  if (a.encounterId !== b.encounterId) return a.encounterId < b.encounterId ? -1 : 1;
  return 0;
}

/** Returns a sorted copy; the input is not changed. */
export function sortEncounters<T extends Encounter>(list: readonly T[]): T[] {
  return [...list].sort(compareEncounters);
}

/**
 * Adds `e` and keeps the newest `max` entries. Entries beyond the cap are the oldest ones.
 * `Array.prototype.sort` is stable, so equal entries keep their relative order.
 */
export function insertSimulated(
  list: readonly SimEncounter[],
  e: SimEncounter,
  max: number = MAX_SIMULATED_ENCOUNTERS,
): SimEncounter[] {
  return sortEncounters([e, ...list]).slice(0, Math.max(0, max));
}

/** docs/schema.md: a stored `snapshot.captured` has `jpegBase64` removed and gains `hasImage: true`. */
function storedEvent(message: SchemaMessage): SchemaMessage {
  if (message.type !== "snapshot.captured") return message;
  const { jpegBase64: _image, ...rest } = message.data;
  void _image;
  return { ...message, data: { ...rest, hasImage: true } } as unknown as SchemaMessage;
}

/**
 * Builds the Timeline record of one finished encounter from its message log.
 * `meta.ja` / `meta.en` is the line the doll said; it is kept apart from the events
 * so that no spoken text is ever copied into them.
 */
export function buildSimEncounter(
  log: readonly SchemaMessage[],
  meta: { mode: "simulation" | "live"; ja: string; en: string },
): SimEncounter {
  let encounterId = "";
  let deviceId = "";
  let startedAt = "";
  let endedAt: string | null = null;
  let state: State | null = null;
  let verdict: SimEncounter["verdict"] = null;
  let confidence: number | null = null;
  let reaction: SimEncounter["reaction"] = null;

  for (const m of log) {
    if (deviceId === "") deviceId = m.deviceId;
    if (encounterId === "" && m.encounterId !== null) encounterId = m.encounterId;
    if (startedAt === "" || m.type === "presence.detected") startedAt = m.ts;
    switch (m.type) {
      case "state.changed":
        state = m.data.to;
        break;
      case "judgement.result":
        verdict = m.data.verdict;
        confidence = m.data.confidence;
        break;
      case "reaction.performed":
        reaction = {
          kind: m.data.kind,
          lineId: m.data.lineId,
          offline: m.data.offline,
        };
        break;
      case "encounter.ended":
        endedAt = m.ts;
        break;
      default:
        break;
    }
  }

  return {
    encounterId,
    deviceId,
    startedAt,
    endedAt,
    state,
    verdict,
    confidence,
    reaction,
    notified: verdict === "stranger" && reaction?.kind === "stranger",
    snapshot: null,
    illustration: null,
    events: log.map(storedEvent),
    mode: meta.mode,
    line: reaction === null ? null : { ja: meta.ja, en: meta.en },
  };
}
