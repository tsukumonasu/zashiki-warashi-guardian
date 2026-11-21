/**
 * Shared record types for the HTTP API ("Encounter record" in `docs/schema.md`).
 * Types only: no runtime code, no AWS imports.
 */

import type { Envelope } from "./messages.js";

export type Verdict = "family" | "stranger" | "no_face" | "uncertain";

export type Illustration =
  | "silhouette-family"
  | "silhouette-stranger"
  | "silhouette-none"
  | "silhouette-uncertain";

export type ReactionKind = "family" | "stranger" | "uncertain";

export type EncounterReaction = {
  kind: ReactionKind;
  lineId: string | null;
  offline: boolean;
};

/** Pre-signed GET URL for the snapshot. Family only; `null` on the record when absent. */
export type EncounterSnapshot = {
  url: string;
  expiresAt: string;
};

export type EncounterRecord = {
  encounterId: string;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
  state: string | null;
  verdict: Verdict | null;
  confidence: number | null;
  reaction: EncounterReaction | null;
  notified: boolean;
  snapshot: EncounterSnapshot | null;
  illustration: Illustration | null;
  /** `[]` in list responses; envelopes in time order in the detail response. */
  events: Envelope[];
};
