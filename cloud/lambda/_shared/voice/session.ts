/**
 * Session lifecycle reducer for one voice conversation (design "Reducer rules").
 *
 * Pure module: no AWS imports and no clock reads. The caller passes the time of every step, so
 * tests and property tests control it. The runner executes the returned effects.
 *
 * Rules that hold for every input:
 * - The phase only moves forward: starting, live, ending, ended.
 * - `ended` absorbs every event: same state, no effects.
 * - The first end reason wins; a later end request, language or unsafe-text end changes nothing.
 * - `finish` returns the single effect list publishEnd, notifyDevice, releaseLock, recordSession.
 *   `closeStream` is emitted earlier, when the session enters `ending`.
 */

import type { VoiceConfig } from "./config.js";
import type { EndReason, LookVerdict } from "./frames.js";
import { isUnsafeAssistantText, japaneseRatio, languageVerdict } from "./language.js";

export type { EndReason };

export type Phase = "starting" | "live" | "ending" | "ended";

/** Time the session may stay in `ending` before it finishes without a `streamClosed` (R6.7). */
export const CLEANUP_GRACE_MS = 3_000;

/** A Japanese share at or above this counts as a Japanese turn; mirrors `language.ts`. */
const JAPANESE_TURN_RATIO = 0.6;

export interface SessionState {
  phase: Phase;
  startedAtMs: number;
  openedAtMs: number | null;
  lastActivityMs: number;
  helloSeen: boolean;
  endReason: EndReason | null;
  endingSinceMs: number | null;
  nextRecheckAtMs: number | null;
  /** Tool call counters. The silent re-check never changes `looks` or `toolCalls`. */
  looks: number;
  toolCalls: number;
  gazeCommands: number;
  lastGazeAtMs: number | null;
  pendingTools: readonly string[];
  assistantTurns: number;
  /** `true` once one assistant turn was Japanese, else `null` (undecided). */
  languageOk: boolean | null;
  /**
   * Assistant turns with four or more letters and no Japanese letter. Added to the design's state
   * so the reducer can reach the `bad` verdict of `language.ts` without keeping every turn.
   */
  nonJapaneseTurns: number;
}

export type SessionEvent =
  | { t: "tick" }
  | { t: "hello" }
  | { t: "streamOpened" }
  | { t: "activity" }
  | { t: "assistantText"; text: string }
  | { t: "toolUse"; id: string; name: string }
  | { t: "toolDone"; id: string }
  | { t: "verdict"; verdict: LookVerdict; silent: boolean }
  | { t: "endRequest"; reason: EndReason }
  | { t: "streamClosed"; ok: boolean };

export type Effect =
  | { type: "openStream" }
  | { type: "requestRecheck" }
  | { type: "interruptAudio" }
  | { type: "publishState"; state: "waiting" | "live" | "ending" }
  | { type: "closeStream" }
  | { type: "publishEnd"; reason: EndReason }
  | { type: "notifyDevice"; reason: EndReason }
  | { type: "releaseLock" }
  | { type: "recordSession"; reason: EndReason };

export interface StepResult {
  state: SessionState;
  effects: readonly Effect[];
}

/** The state of a session that was just created at `nowMs`. */
export function initialSession(nowMs: number): SessionState {
  return {
    phase: "starting",
    startedAtMs: nowMs,
    openedAtMs: null,
    lastActivityMs: nowMs,
    helloSeen: false,
    endReason: null,
    endingSinceMs: null,
    nextRecheckAtMs: null,
    looks: 0,
    toolCalls: 0,
    gazeCommands: 0,
    lastGazeAtMs: null,
    pendingTools: [],
    assistantTurns: 0,
    languageOk: null,
    nonJapaneseTurns: 0,
  };
}

/** Enters `ending` once. The first reason wins because only `starting` and `live` can enter. */
function beginEnding(s: SessionState, reason: EndReason, nowMs: number, before: readonly Effect[] = []): StepResult {
  return {
    state: { ...s, phase: "ending", endReason: reason, endingSinceMs: nowMs },
    effects: [...before, { type: "publishState", state: "ending" }, { type: "closeStream" }],
  };
}

/** Enters `ended` and returns the single finish effect list. */
function finish(s: SessionState): StepResult {
  const reason = s.endReason ?? "error";
  return {
    state: { ...s, phase: "ended", endReason: reason },
    effects: [
      { type: "publishEnd", reason },
      { type: "notifyDevice", reason },
      { type: "releaseLock" },
      { type: "recordSession", reason },
    ],
  };
}

const stay = (s: SessionState): StepResult => ({ state: s, effects: [] });

function onTick(s: SessionState, nowMs: number, cfg: VoiceConfig): StepResult {
  if (s.phase === "starting") {
    // No client in time ends the session. A client that said hello but whose stream never opened
    // gets the same deadline, so `starting` cannot last longer than `noClientSeconds`.
    if (nowMs - s.startedAtMs >= cfg.noClientSeconds * 1000) {
      return beginEnding(s, s.helloSeen ? "error" : "no_client", nowMs);
    }
    return stay(s);
  }
  if (s.phase === "live") {
    const openedAt = s.openedAtMs ?? s.startedAtMs;
    if (nowMs - openedAt >= cfg.maxSeconds * 1000) return beginEnding(s, "limit", nowMs);
    if (nowMs - s.lastActivityMs >= cfg.silenceSeconds * 1000) return beginEnding(s, "silence", nowMs);
    if (cfg.recheckSeconds > 0 && s.nextRecheckAtMs !== null && nowMs >= s.nextRecheckAtMs) {
      return {
        state: { ...s, nextRecheckAtMs: nowMs + cfg.recheckSeconds * 1000 },
        effects: [{ type: "requestRecheck" }],
      };
    }
    return stay(s);
  }
  // ending
  if (s.endingSinceMs !== null && nowMs - s.endingSinceMs >= CLEANUP_GRACE_MS) return finish(s);
  return stay(s);
}

function onAssistantText(s: SessionState, text: string, nowMs: number, cfg: VoiceConfig): StepResult {
  if (s.phase !== "live") return stay(s);
  const ratio = japaneseRatio(text);
  const next: SessionState = {
    ...s,
    assistantTurns: s.assistantTurns + 1,
    languageOk: s.languageOk === true || (ratio !== null && ratio >= JAPANESE_TURN_RATIO) ? true : null,
    nonJapaneseTurns: s.nonJapaneseTurns + (ratio === 0 ? 1 : 0),
  };
  if (isUnsafeAssistantText(text, cfg.blockedWords)) {
    return beginEnding(next, "unsafe_output", nowMs, [{ type: "interruptAudio" }]);
  }
  // `language.ts` owns the thresholds: feed it one stand-in turn per non-Japanese turn.
  if (next.languageOk !== true && languageVerdict(Array(next.nonJapaneseTurns).fill("abcd")) === "bad") {
    return beginEnding(next, "language", nowMs);
  }
  return { state: next, effects: [] };
}

function onToolUse(s: SessionState, e: { id: string; name: string }, nowMs: number): StepResult {
  if (s.phase !== "live") return stay(s);
  return {
    state: {
      ...s,
      lastActivityMs: nowMs,
      toolCalls: s.toolCalls + 1,
      looks: s.looks + (e.name === "look" ? 1 : 0),
      gazeCommands: s.gazeCommands + (e.name === "turn_head" ? 1 : 0),
      lastGazeAtMs: e.name === "turn_head" ? nowMs : s.lastGazeAtMs,
      pendingTools: [...s.pendingTools, e.id],
    },
    effects: [],
  };
}

/**
 * One step of the session. Returns the next state and the effects to run, in order.
 *
 * @param nowMs time of this step in milliseconds; the reducer never reads a clock.
 */
export function stepSession(s: SessionState, e: SessionEvent, nowMs: number, cfg: VoiceConfig): StepResult {
  if (s.phase === "ended") return stay(s);

  if (e.t === "endRequest") {
    return s.phase === "starting" || s.phase === "live" ? beginEnding(s, e.reason, nowMs) : stay(s);
  }

  switch (e.t) {
    case "tick":
      return onTick(s, nowMs, cfg);
    case "hello":
      if (s.phase !== "starting" || s.helloSeen) return stay(s);
      return { state: { ...s, helloSeen: true }, effects: [{ type: "openStream" }] };
    case "streamOpened":
      if (s.phase !== "starting") return stay(s);
      return {
        state: {
          ...s,
          phase: "live",
          openedAtMs: nowMs,
          lastActivityMs: nowMs,
          nextRecheckAtMs: cfg.recheckSeconds > 0 ? nowMs + cfg.recheckSeconds * 1000 : null,
        },
        effects: [{ type: "publishState", state: "live" }],
      };
    case "activity":
      return s.phase === "live" ? { state: { ...s, lastActivityMs: nowMs }, effects: [] } : stay(s);
    case "assistantText":
      return onAssistantText(s, e.text, nowMs, cfg);
    case "toolUse":
      return onToolUse(s, e, nowMs);
    case "toolDone":
      return { state: { ...s, pendingTools: s.pendingTools.filter((id) => id !== e.id) }, effects: [] };
    case "verdict":
      // Only a stranger in `live` ends the session. In `ending` the late result is discarded.
      return s.phase === "live" && e.verdict === "stranger" ? beginEnding(s, "stranger", nowMs) : stay(s);
    case "streamClosed":
      return s.phase === "ending" ? finish(s) : beginEnding(s, "error", nowMs);
  }
}
