/**
 * Logging for the voice session (R14.5).
 *
 * Why: a voice session id doubles as the first half of the session token, so logs carry at most
 * its first 8 characters. Audio, text, transcripts and tokens are dropped by key before the
 * generic safe logger sees the fields.
 */

import { log, type LogFields } from "../safelog.js";

/** Longest part of a session id that may reach a log line. */
export const LOGGED_SESSION_ID_LENGTH = 8;

/** Keys that never reach a log line, compared case-insensitively. */
const DROPPED_KEYS: ReadonlySet<string> = new Set([
  "sessionid",
  "token",
  "clienttoken",
  "observertoken",
  "clienttokenhash",
  "observertokenhash",
  "pcm",
  "audio",
  "text",
  "transcript",
]);

/** The first 8 characters of a session id. */
export function shortSessionId(sessionId: string): string {
  return String(sessionId).slice(0, LOGGED_SESSION_ID_LENGTH);
}

/** Logs one voice event with the shortened session id and without speech or token fields. */
export function logVoice(event: string, sessionId: string, fields: LogFields = {}): void {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!DROPPED_KEYS.has(key.toLowerCase())) kept[key] = value;
  }
  log(event, { ...kept, session: shortSessionId(sessionId) });
}
