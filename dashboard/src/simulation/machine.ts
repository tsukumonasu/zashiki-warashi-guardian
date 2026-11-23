// The simulated doll's state machine. It mirrors `device/warashi_agent/state_machine.py`: the
// same states, the same edges, the same reasons (docs/schema.md, "Reason mapping") and the same
// rejection rules for commands. Pure and deterministic: time is the `now` argument and
// randomness is `state.rng`. No `Date`, no `Math.random`, no React.
//
// API (used by `engine.ts`, task 6.6):
//
//   handle(state, event, now) -> { state, outputs }
//
//   event is one of
//     { kind: "tick" }                              deadlines are checked on ticks only
//     { kind: "internal", event: InternalEvent }    pir.rising, snapshot.ready, servo.arrived,
//                                                   audio.finished, cloud.connected, ...
//     { kind: "command", message: SchemaMessage }   an already decoded and de-duplicated
//                                                   judgement.result, speak, gaze, lantern or
//                                                   mode.set; any other type is ignored
//
//   outputs are the contract messages published by this call (`Output.message`, in order),
//   `audio.play` and `audio.stop`. Device-internal events never appear as messages.
//
// Contract with the engine:
//   - The engine decodes commands, drops duplicate ids, checks `deviceId` and feeds the head
//     and lantern models (`stepMotion`, `updateLantern`, `takeDue` of world.ts). It calls
//     `handle` for each due input and for `servo.arrived` when `stepMotion` reports an arrival.
//   - The engine delivers `cloud.connected` or `cloud.disconnected` (from `plan.cloud`) before
//     `pir.rising`; the machine starts with `cloudConnected` as it is in the state.
//   - The `stop` user action is `mode.set` with `mode: "sleep"`.
//   - An event with no meaning in the current state returns the same state object and no
//     outputs (Requirement 5.4).
//   - `status.report` is emitted once per call that changed the state. The periodic report and
//     the uptime are left to the engine; `uptimeSec` is 0 here.
//   - A `speak` with `audioUrl` cannot be played in the browser simulation: in a `family`
//     situation it is reported as `download_failed`; otherwise it is `speak_rejected`, as on
//     the device.
//
// Every `state.changed` goes through `enter()`, which reads `from` from the state before the
// change, so `from` always equals the previous `deviceState` (Requirement 5.7).

import catalog from "./data/voice-catalog.json";
import { headTarget } from "./head";
import { next, formatIso, uuidV4 } from "./rng";
import { safeLineText } from "./privacy";
import {
  onSnapshotCaptured,
  onTakeSnapshot,
  setLanternTarget,
  setTargets,
} from "./world";
import type {
  AcceptedVerdict,
  DeviceState,
  ConversationEnd,
  ConversationEndReason,
  ConversationStart,
  ErrorCode,
  EyeState,
  FaceBox,
  InternalEvent,
  JudgementResult,
  MessageType,
  Output,
  Phase,
  ReactionKind,
  ReactionLine,
  Reason,
  SchemaMessage,
  SimState,
  SnapshotRequest,
  Speak,
  Verdict,
  VerdictLabel,
} from "./types";

export type MachineEvent =
  | { kind: "tick" }
  | { kind: "internal"; event: InternalEvent }
  | { kind: "command"; message: SchemaMessage };

export interface MachineResult {
  state: SimState;
  outputs: Output[];
}

interface CatalogLine {
  id: string;
  category: ReactionKind;
  ja: string;
  en: string;
  durationMs: number | null;
}

const CATALOG: readonly CatalogLine[] = (catalog as CatalogLine[])
  .slice()
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const SNAPSHOT_WIDTH = 640;
const SNAPSHOT_HEIGHT = 480;

const EYE: Readonly<Record<DeviceState, EyeState>> = {
  sleeping: "closed",
  waking: "half",
  seeking: "open",
  gazing: "open",
  greeting: "open",
  warning: "stare",
  uncertain: "open",
  conversing: "open",
  cooldown: "half",
  remote: "open", // never entered by the virtual doll (remote-mode M4)
};

/** Fixed `error.reported` texts: no line text, no URL, no private data. */
const MESSAGES = {
  unknown_line: "speak names a line that is not cached on the device",
  speak_rejected: "speak is not permitted for the current situation",
  command_rejected_state: "command is not accepted in the current state",
  audio_busy: "speak arrived while earlier audio is unfinished",
  voice_line_missing: "no cached voice line of the reaction's category",
  audio_failed: "playback failed, timed out or the file was missing",
  download_failed: "audio download is not available in the simulation",
  camera_failed: "snapshot capture failed or timed out",
  snapshot_too_large: "snapshot above the JPEG size limit at the lowest quality",
} as const;

// ---------------------------------------------------------------------------------------------
// Call context: a mutable holder that lives for one `handle` call and never escapes.
// ---------------------------------------------------------------------------------------------

interface Ctx {
  s: SimState;
  readonly now: number;
  readonly out: Output[];
  /** The `encounterId` of every message of this call; kept while entering `sleeping`. */
  encounterId: string | null;
  stateChanged: boolean;
}

function sec(seconds: number): number {
  return seconds * 1000;
}

function newId(ctx: Ctx, kind: "snap" | "motion" | "play"): string {
  const [uuid, rng] = uuidV4(ctx.s.rng);
  ctx.s = { ...ctx.s, rng };
  return `${kind}-${uuid}`;
}

function emit<T extends MessageType>(
  ctx: Ctx,
  type: T,
  data: Extract<SchemaMessage, { type: T }>["data"],
  encounterId: string | null = ctx.encounterId,
): void {
  const [id, rng] = uuidV4(ctx.s.rng);
  const envelope = {
    v: 1,
    id,
    ts: formatIso(ctx.now),
    deviceId: ctx.s.config.deviceId,
    encounterId,
    type,
    data,
  } as SchemaMessage;
  ctx.s = { ...ctx.s, rng, log: [...ctx.s.log, envelope] };
  ctx.out.push({ kind: "message", envelope });
}

function reportError(ctx: Ctx, code: ErrorCode & keyof typeof MESSAGES, refId: string | null): void {
  emit(ctx, "error.reported", { code, message: MESSAGES[code], refId });
}

/** The only place that announces a state change: `from` is read before the change. */
function enter(ctx: Ctx, to: DeviceState, reason: Reason): void {
  const from = ctx.s.deviceState;
  emit(ctx, "state.changed", { from, to, reason });
  ctx.s = { ...ctx.s, deviceState: to, eye: EYE[to] };
  ctx.stateChanged = true;
}

function setPhase(ctx: Ctx, phase: Phase): void {
  ctx.s = { ...ctx.s, phase };
}

function patchEncounter(
  ctx: Ctx,
  patch: Partial<NonNullable<SimState["encounter"]>>,
): void {
  if (ctx.s.encounter === null) return;
  ctx.s = { ...ctx.s, encounter: { ...ctx.s.encounter, ...patch } };
}

/** Starts a head movement to the clamped target and returns its motion id. */
function move(ctx: Ctx, pan: number, tilt: number): string {
  const motionId = newId(ctx, "motion");
  ctx.s = setTargets(ctx.s, pan, tilt, motionId);
  return motionId;
}

function setVerdict(ctx: Ctx, verdict: VerdictLabel): void {
  ctx.s = { ...ctx.s, verdict };
}

// ---------------------------------------------------------------------------------------------
// sleeping -> waking -> seeking, and the snapshot attempt
// ---------------------------------------------------------------------------------------------

function enterWaking(ctx: Ctx): void {
  const [id, rng] = uuidV4(ctx.s.rng);
  ctx.s = {
    ...ctx.s,
    rng,
    verdict: null,
    subtitle: null,
    encounter: {
      id,
      startedAt: ctx.now,
      reacted: false,
      accepted: null,
      attempt: null,
      attemptsStarted: 0,
      scansRun: 0,
    },
  };
  // The new id is on the announcement already (Requirement 5.7 / schema: encounterId).
  ctx.encounterId = id;
  const cfg = ctx.s.config;
  // `presence.detected` opens the encounter, so it comes before the first state change.
  emit(ctx, "presence.detected", { source: "pir" });
  enter(ctx, "waking", "presence");
  ctx.s = setLanternTarget(ctx.s, cfg.lanternWakeLevel, cfg.lanternFadeInMs, ctx.now);
  const motionId = move(ctx, 0, 0);
  setPhase(ctx, {
    kind: "waking",
    motionId,
    fadeDoneAt: ctx.now + cfg.lanternFadeInMs,
    deadline: ctx.now + sec(cfg.wakingTimeoutS),
    arrived: false,
  });
}

/** Leaves `waking`: to `seeking` with the cloud up, else the offline reaction. */
function leaveWaking(ctx: Ctx, reason: Reason): void {
  if (ctx.s.cloudConnected) enterSeeking(ctx, reason);
  else enterUncertain(ctx, true, "offline");
}

function enterSeeking(ctx: Ctx, reason: Reason): void {
  enter(ctx, "seeking", reason);
  setPhase(ctx, { kind: "seeking", scan: null });
  startAttempt(ctx);
}

/** Requests a snapshot; the angles are the last head targets (the camera sees where it looks). */
function startAttempt(ctx: Ctx): void {
  const encounter = ctx.s.encounter;
  if (encounter === null) return;
  const snapshotId = newId(ctx, "snap");
  patchEncounter(ctx, {
    attemptsStarted: encounter.attemptsStarted + 1,
    attempt: {
      snapshotId,
      pan: ctx.s.panTarget,
      tilt: ctx.s.tiltTarget,
      deadline: ctx.now + sec(ctx.s.config.verdictTimeoutS),
      verdictProcessed: false,
    },
  });
  ctx.s = onTakeSnapshot(ctx.s, snapshotId, ctx.now);
}

function onSnapshotReady(ctx: Ctx, snapshotId: string): void {
  const encounter = ctx.s.encounter;
  const attempt = encounter?.attempt;
  if (ctx.s.phase.kind !== "seeking" || !encounter || !attempt) return;
  if (snapshotId !== attempt.snapshotId) return;
  emit(ctx, "snapshot.captured", {
    snapshotId,
    width: SNAPSHOT_WIDTH,
    height: SNAPSHOT_HEIGHT,
    panDeg: attempt.pan,
    tiltDeg: attempt.tilt,
    jpegBase64: "", // the simulation has no picture
  });
  ctx.s = onSnapshotCaptured(ctx.s, snapshotId, encounter.attemptsStarted - 1, ctx.now);
}

function onSnapshotFailed(
  ctx: Ctx,
  snapshotId: string,
  code: "camera_failed" | "snapshot_too_large",
): void {
  reportError(ctx, code, null);
  const phase = ctx.s.phase;
  const attempt = ctx.s.encounter?.attempt;
  if (phase.kind !== "seeking" || phase.scan !== null || !attempt) return;
  if (snapshotId !== attempt.snapshotId) return;
  enterUncertain(ctx, true, "error");
}

// ---------------------------------------------------------------------------------------------
// Verdict, scanning, gazing
// ---------------------------------------------------------------------------------------------

/** Accept rule: a low-confidence family or stranger verdict counts as uncertain. */
export function accept(
  verdict: Verdict,
  confidence: number,
  cfg: Pick<SimState["config"], "familyConfidenceMin" | "strangerConfidenceMin">,
): AcceptedVerdict {
  if (verdict === "family") return confidence >= cfg.familyConfidenceMin ? "family" : "uncertain";
  if (verdict === "stranger") {
    return confidence >= cfg.strangerConfidenceMin ? "stranger" : "uncertain";
  }
  return verdict === "no_face" ? "no_face" : "uncertain";
}

function onJudgement(ctx: Ctx, message: JudgementResult): void {
  const phase = ctx.s.phase;
  const encounter = ctx.s.encounter;
  const attempt = encounter?.attempt;
  if (phase.kind !== "seeking" || phase.scan !== null || !encounter || !attempt) return;
  const { snapshotId, verdict, confidence, face } = message.data;
  if (snapshotId !== attempt.snapshotId || attempt.verdictProcessed) return;

  const accepted = accept(verdict, confidence, ctx.s.config);
  // A final verdict (family, stranger, uncertain) is kept; only no_face can be replaced.
  const keep = encounter.accepted !== null && encounter.accepted !== "no_face";
  patchEncounter(ctx, {
    attempt: { ...attempt, verdictProcessed: true },
    accepted: keep ? encounter.accepted : accepted,
  });

  if (accepted === "family" || accepted === "stranger") {
    setVerdict(ctx, accepted);
    if (face !== null) enterGazing(ctx, face, attempt.pan, attempt.tilt);
    else if (accepted === "family") enterGreeting(ctx, "verdict");
    else enterWarning(ctx, "verdict");
  } else if (accepted === "uncertain") {
    enterUncertain(ctx, false, "verdict");
  } else {
    onNoFace(ctx);
  }
}

/** An accepted `no_face`: scan, or give up with the cautious line once the scans are used up. */
function onNoFace(ctx: Ctx): void {
  const encounter = ctx.s.encounter;
  if (encounter === null) return;
  const cfg = ctx.s.config;
  const pan = cfg.scanPanPositionsDeg[encounter.scansRun];
  if (encounter.scansRun < cfg.scanAttemptsMax && pan !== undefined) {
    const motionId = move(ctx, pan, 0);
    patchEncounter(ctx, { scansRun: encounter.scansRun + 1 });
    setPhase(ctx, {
      kind: "seeking",
      scan: { motionId, deadline: ctx.now + sec(cfg.glideTimeoutS) },
    });
    return;
  }
  enterUncertain(ctx, false, "no_face");
}

function endScanMove(ctx: Ctx): void {
  setPhase(ctx, { kind: "seeking", scan: null });
  startAttempt(ctx);
}

function enterGazing(ctx: Ctx, face: FaceBox, snapPan: number, snapTilt: number): void {
  enter(ctx, "gazing", "verdict");
  const [pan, tilt] = headTarget(face, snapPan, snapTilt, ctx.s.config);
  const motionId = move(ctx, pan, tilt);
  setPhase(ctx, {
    kind: "gazing",
    motionId,
    deadline: ctx.now + sec(ctx.s.config.glideTimeoutS),
  });
}

function leaveGazing(ctx: Ctx, reason: Reason): void {
  const accepted = ctx.s.encounter?.accepted;
  if (accepted === "family") enterGreeting(ctx, reason);
  else if (accepted === "stranger") enterWarning(ctx, reason);
  else enterUncertain(ctx, false, "error"); // unreachable: gazing needs family or stranger
}

// ---------------------------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------------------------

const NO_LINE: ReactionLine = { playId: null, deadline: null };

/** Family hears family and uncertain lines; everyone else only lines of their own category. */
function permitted(category: ReactionKind, situation: ReactionKind): boolean {
  return situation === "family" ? category !== "stranger" : category === situation;
}

function situationOf(ctx: Ctx): ReactionKind {
  const accepted = ctx.s.encounter?.accepted;
  return accepted === "family" || accepted === "stranger" ? accepted : "uncertain";
}

function lineById(id: string): CatalogLine | undefined {
  return CATALOG.find((l) => l.id === id);
}

/** The plan's line when the catalog has it and it is permitted, else a draw from `state.rng`. */
function chooseLine(ctx: Ctx, kind: ReactionKind): CatalogLine | null {
  const planned = ctx.s.plan?.reactionLineId;
  if (planned !== null && planned !== undefined) {
    const line = lineById(planned);
    if (line !== undefined && permitted(line.category, kind)) return line;
  }
  const pool = CATALOG.filter((l) => l.category === kind); // already sorted by id
  if (pool.length === 0) return null;
  const [value, rng] = next(ctx.s.rng);
  ctx.s = { ...ctx.s, rng };
  return pool[Math.min(Math.floor(value * pool.length), pool.length - 1)] ?? null;
}

/** Subtitle text: the catalog, except a family line whose generated text passes `safeLineText`. */
function subtitleFor(ctx: Ctx, kind: ReactionKind, line: CatalogLine): { ja: string; en: string } {
  const own = { ja: line.ja, en: line.en };
  const plan = ctx.s.plan;
  if (kind === "family" && plan?.display && plan.reactionLineId === line.id) {
    return safeLineText("family", own, plan.display, []);
  }
  return own;
}

function startPlayback(ctx: Ctx, line: CatalogLine, text: { ja: string; en: string }): ReactionLine {
  const playId = newId(ctx, "play");
  const deadline = ctx.now + sec(ctx.s.config.audioTimeoutS);
  ctx.s = {
    ...ctx.s,
    subtitle: text,
    audio: [...ctx.s.audio, { playId, busyUntil: deadline }],
  };
  ctx.out.push({
    kind: "audio.play",
    playId,
    lineId: line.id,
    ja: text.ja,
    en: text.en,
    durationHintMs: line.durationMs,
  });
  return { playId, deadline };
}

/** Plays the reaction line (once per encounter) and publishes `reaction.performed`. */
function react(ctx: Ctx, kind: ReactionKind, offline: boolean): ReactionLine {
  const encounter = ctx.s.encounter;
  if (encounter === null || encounter.reacted) return NO_LINE;
  const line = chooseLine(ctx, kind);
  const reactionLine = line ? startPlayback(ctx, line, subtitleFor(ctx, kind, line)) : NO_LINE;
  emit(ctx, "reaction.performed", { kind, lineId: line?.id ?? null, offline });
  if (line === null) reportError(ctx, "voice_line_missing", null);
  patchEncounter(ctx, { reacted: true });
  return reactionLine;
}

function enterGreeting(ctx: Ctx, reason: Reason): void {
  enter(ctx, "greeting", reason);
  const pan = ctx.s.panTarget;
  const tilt = ctx.s.tiltTarget;
  const line = react(ctx, "family", false);
  const nodMotionId = move(ctx, pan, tilt - ctx.s.config.nodDeg);
  setPhase(ctx, {
    kind: "greeting",
    pan,
    tilt,
    nodMotionId,
    nodDeadline: ctx.now + sec(ctx.s.config.glideTimeoutS),
    nodReturned: false,
    line,
    grant: null,
  });
  // The cloud decides whether the doll gets a voice session (docs/schema.md, S1).
  if (ctx.s.config.conversationEnabled && ctx.s.cloudConnected) {
    emit(ctx, "conversation.requested", { reason: "family_verdict" });
  }
}

function returnFromNod(ctx: Ctx): void {
  const phase = ctx.s.phase;
  if (phase.kind !== "greeting") return;
  move(ctx, phase.pan, phase.tilt);
  setPhase(ctx, { ...phase, nodReturned: true });
}

/** A silent stare; the stranger line follows on the first tick after `stareUntil`. */
function enterWarning(ctx: Ctx, reason: Reason): void {
  enter(ctx, "warning", reason);
  setPhase(ctx, { kind: "warning", stareUntil: ctx.now + sec(ctx.s.config.stareS), line: null });
}

function enterUncertain(ctx: Ctx, offline: boolean, reason: Reason): void {
  enter(ctx, "uncertain", reason);
  setVerdict(ctx, offline ? "offline" : reason === "no_face" ? "no_face" : "uncertain");
  const line = react(ctx, "uncertain", offline);
  setPhase(ctx, { kind: "uncertain", line });
}

/** The reaction ends: a granted voice session starts after the line, else the cooldown. */
function endReaction(ctx: Ctx, reason: Reason): void {
  const phase = ctx.s.phase;
  if (reason === "audio_done" && phase.kind === "greeting" && phase.grant !== null) {
    enterConversing(ctx, phase.grant.sessionId, phase.grant.maxSeconds, "conversation");
    return;
  }
  enterCooldown(ctx, reason, false);
}

/** Tick rule shared by the three reaction states. */
function endReactionOnTick(ctx: Ctx, line: ReactionLine): void {
  if (line.playId === null) enterCooldown(ctx, "error", false);
  else if (line.deadline !== null && ctx.now >= line.deadline) enterCooldown(ctx, "timeout", false);
}

// ---------------------------------------------------------------------------------------------
// conversing (docs/schema.md, S7 to S11)
// ---------------------------------------------------------------------------------------------

const MAX_SECONDS_RANGE = [30, 420] as const;

function enterConversing(ctx: Ctx, sessionId: string, maxSeconds: number, reason: Reason): void {
  enter(ctx, "conversing", reason);
  const seconds = Math.min(MAX_SECONDS_RANGE[1], Math.max(MAX_SECONDS_RANGE[0], maxSeconds));
  setPhase(ctx, {
    kind: "conversing",
    sessionId,
    deadline: ctx.now + sec(seconds),
    look: null,
  });
}

/** Every exit from `conversing` publishes `conversation.ended`, then goes to cooldown. */
function leaveConversing(
  ctx: Ctx,
  endReason: ConversationEndReason,
  reason: Reason,
  manual: boolean,
): void {
  const phase = ctx.s.phase;
  if (phase.kind !== "conversing") return;
  emit(ctx, "conversation.ended", { sessionId: phase.sessionId, reason: endReason });
  enterCooldown(ctx, reason, manual);
}

function onConversationStart(ctx: Ctx, message: ConversationStart): void {
  const { sessionId, maxSeconds, source } = message.data;
  const phase = ctx.s.phase;
  if (source === "manual" && phase.kind === "sleeping" && ctx.s.mode === "guard") {
    ctx.s = setLanternTarget(ctx.s, ctx.s.config.lanternWakeLevel, ctx.s.config.lanternFadeInMs, ctx.now);
    enterConversing(ctx, sessionId, maxSeconds, "conversation");
    return;
  }
  if (source === "family_verdict" && phase.kind === "greeting" && phase.grant === null) {
    setPhase(ctx, { ...phase, grant: { sessionId, maxSeconds } });
    return;
  }
  reportError(ctx, "command_rejected_state", message.id);
}

function onConversationEnd(ctx: Ctx, message: ConversationEnd): void {
  const phase = ctx.s.phase;
  // Safe to receive twice and for an unknown session.
  if (phase.kind !== "conversing" || phase.sessionId !== message.data.sessionId) return;
  leaveConversing(ctx, message.data.reason, "conversation_done", false);
}

function onSnapshotRequest(ctx: Ctx, message: SnapshotRequest): void {
  const phase = ctx.s.phase;
  if (phase.kind !== "conversing" || phase.look !== null) {
    reportError(ctx, "command_rejected_state", message.id);
    return;
  }
  const { requestId } = message.data;
  const snapshotId = newId(ctx, "snap");
  emit(ctx, "snapshot.captured", {
    snapshotId,
    width: SNAPSHOT_WIDTH,
    height: SNAPSHOT_HEIGHT,
    panDeg: ctx.s.panTarget,
    tiltDeg: ctx.s.tiltTarget,
    jpegBase64: "", // the simulation has no picture
    requestId,
  });
  setPhase(ctx, {
    ...phase,
    look: { requestId, snapshotId, deadline: ctx.now + sec(ctx.s.config.verdictTimeoutS) },
  });
  // The simulated cloud answers with the plan's last verdict (a look is a re-check).
  const plan = ctx.s.plan;
  ctx.s = onSnapshotCaptured(ctx.s, snapshotId, plan ? plan.attempts.length - 1 : 0, ctx.now);
}

/** A verdict for a look: a stranger ends the conversation, anything else is only consumed. */
function onLookVerdict(ctx: Ctx, message: JudgementResult): void {
  const phase = ctx.s.phase;
  if (phase.kind !== "conversing" || phase.look === null) return;
  if (message.data.snapshotId !== phase.look.snapshotId) return;
  const accepted = accept(message.data.verdict, message.data.confidence, ctx.s.config);
  if (accepted === "stranger") {
    setVerdict(ctx, "stranger");
    leaveConversing(ctx, "stranger", "verdict", false);
    return;
  }
  setPhase(ctx, { ...phase, look: null });
}

// ---------------------------------------------------------------------------------------------
// cooldown -> sleeping
// ---------------------------------------------------------------------------------------------

function enterCooldown(ctx: Ctx, reason: Reason, manual: boolean): void {
  enter(ctx, "cooldown", reason);
  const cfg = ctx.s.config;
  const motionId = move(ctx, 0, 0);
  ctx.s = { ...ctx.s, subtitle: null };
  if (manual) {
    ctx.s = { ...ctx.s, audio: [] };
    ctx.out.push({ kind: "audio.stop" });
  }
  setPhase(ctx, {
    kind: "cooldown",
    motionId,
    glideDeadline: ctx.now + sec(cfg.glideTimeoutS),
    released: false,
    until: ctx.now + sec(cfg.cooldownS),
    manual,
  });
}

/** The head is at center (or the glide ran out): fade the lantern out, once. */
function releaseAfterGlide(ctx: Ctx): void {
  const phase = ctx.s.phase;
  if (phase.kind !== "cooldown" || phase.released) return;
  ctx.s = setLanternTarget(ctx.s, 0, ctx.s.config.lanternFadeOutMs, ctx.now);
  setPhase(ctx, { ...phase, released: true });
}

function enterSleeping(ctx: Ctx): void {
  const phase = ctx.s.phase;
  const manual = phase.kind === "cooldown" && phase.manual;
  enter(ctx, "sleeping", "cooldown_done");
  // A manual voice session has no encounter, so there is nothing to end.
  if (ctx.encounterId !== null) {
    emit(ctx, "encounter.ended", { reason: manual ? "manual" : "cooldown" });
  }
  // Backstop: a sleeping doll never keeps a lit lantern.
  if (ctx.s.lantern !== 0 || (ctx.s.lanternTarget !== null && ctx.s.lanternTarget.level !== 0)) {
    ctx.s = setLanternTarget(ctx.s, 0, 0, ctx.now);
  }
  setPhase(ctx, { kind: "sleeping" });
  ctx.s = { ...ctx.s, encounter: null, mode: "guard", subtitle: null, audio: [], running: false };
}

// ---------------------------------------------------------------------------------------------
// Tick, servo.arrived, audio, cloud
// ---------------------------------------------------------------------------------------------

function onTick(ctx: Ctx): void {
  const phase = ctx.s.phase;
  switch (phase.kind) {
    case "sleeping":
      return;
    case "waking":
      if (phase.arrived && ctx.now >= phase.fadeDoneAt) leaveWaking(ctx, "arrived");
      else if (ctx.now >= phase.deadline) leaveWaking(ctx, "timeout");
      return;
    case "seeking": {
      if (phase.scan !== null) {
        if (ctx.now >= phase.scan.deadline) endScanMove(ctx);
        return;
      }
      const attempt = ctx.s.encounter?.attempt;
      if (!attempt || attempt.verdictProcessed || ctx.now < attempt.deadline) return;
      enterUncertain(ctx, true, "timeout");
      return;
    }
    case "gazing":
      if (ctx.now >= phase.deadline) leaveGazing(ctx, "timeout");
      return;
    case "greeting":
      if (!phase.nodReturned && ctx.now >= phase.nodDeadline) returnFromNod(ctx);
      endReactionOnTick(ctx, phase.line);
      return;
    case "warning": {
      if (phase.line !== null) {
        endReactionOnTick(ctx, phase.line);
        return;
      }
      if (ctx.now < phase.stareUntil) return;
      const line = react(ctx, "stranger", false);
      setPhase(ctx, { ...phase, line });
      return;
    }
    case "uncertain":
      endReactionOnTick(ctx, phase.line);
      return;
    case "conversing":
      if (ctx.now >= phase.deadline) leaveConversing(ctx, "limit", "timeout", false);
      else if (phase.look !== null && ctx.now >= phase.look.deadline) {
        setPhase(ctx, { ...phase, look: null }); // no verdict arrived: a later look may start
      }
      return;
    case "cooldown":
      if (!phase.released && ctx.now >= phase.glideDeadline) releaseAfterGlide(ctx);
      if (ctx.now >= phase.until) enterSleeping(ctx);
      return;
  }
}

function onServoArrived(ctx: Ctx, motionId: string): void {
  const phase = ctx.s.phase;
  switch (phase.kind) {
    case "waking":
      if (motionId !== phase.motionId) return;
      if (ctx.now >= phase.fadeDoneAt) leaveWaking(ctx, "arrived");
      else if (!phase.arrived) setPhase(ctx, { ...phase, arrived: true });
      return;
    case "seeking":
      if (phase.scan !== null && motionId === phase.scan.motionId) endScanMove(ctx);
      return;
    case "gazing":
      if (motionId === phase.motionId) leaveGazing(ctx, "arrived");
      return;
    case "greeting":
      if (!phase.nodReturned && motionId === phase.nodMotionId) returnFromNod(ctx);
      return;
    case "cooldown":
      if (!phase.released && motionId === phase.motionId) releaseAfterGlide(ctx);
      return;
    default:
      return; // stale arrival
  }
}

function reactionLineOf(phase: Phase): ReactionLine | null {
  if (phase.kind === "greeting" || phase.kind === "uncertain") return phase.line;
  if (phase.kind === "warning") return phase.line;
  return null;
}

/** An audio result ends the playback in every state; in a reaction it ends the reaction. */
function onAudioResult(ctx: Ctx, playId: string, failureCode: "audio_failed" | null): void {
  if (failureCode !== null) reportError(ctx, "audio_failed", null);
  const listed = ctx.s.audio.some((a) => a.playId === playId);
  if (listed) {
    ctx.s = { ...ctx.s, audio: ctx.s.audio.filter((a) => a.playId !== playId) };
  }
  const line = reactionLineOf(ctx.s.phase);
  if (line !== null && line.playId === playId) {
    endReaction(ctx, "audio_done");
  } else if (listed && ctx.s.subtitle !== null && line === null) {
    ctx.s = { ...ctx.s, subtitle: null }; // a manual line ended
  }
}

function onInternal(ctx: Ctx, event: InternalEvent): void {
  switch (event.type) {
    case "pir.rising":
      if (ctx.s.phase.kind === "sleeping" && ctx.s.mode === "guard") enterWaking(ctx);
      return;
    case "servo.arrived":
      onServoArrived(ctx, event.motionId);
      return;
    case "snapshot.ready":
      onSnapshotReady(ctx, event.snapshotId);
      return;
    case "snapshot.failed":
      onSnapshotFailed(ctx, event.snapshotId, event.code);
      return;
    case "audio.finished":
      onAudioResult(ctx, event.playId, null);
      return;
    case "audio.failed":
      // `interrupted` is not an error: the doll itself stopped the playback.
      onAudioResult(ctx, event.playId, event.code === "interrupted" ? null : "audio_failed");
      return;
    case "cloud.connected":
      if (!ctx.s.cloudConnected) ctx.s = { ...ctx.s, cloudConnected: true };
      return;
    case "cloud.disconnected":
      if (ctx.s.cloudConnected) ctx.s = { ...ctx.s, cloudConnected: false };
      if (ctx.s.phase.kind === "seeking") enterUncertain(ctx, true, "offline");
      else if (ctx.s.phase.kind === "conversing") leaveConversing(ctx, "offline", "offline", false);
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

function audioBusy(ctx: Ctx): boolean {
  return ctx.s.audio.some((a) => ctx.now < a.busyUntil);
}

/** `speak`: the first failing check gives the single rejection (device order). */
function onSpeak(ctx: Ctx, message: Speak): void {
  const { lineId, audioUrl } = message.data;
  const situation = situationOf(ctx);
  const line = lineId !== null ? lineById(lineId) : undefined;
  if (lineId !== null) {
    if (line === undefined) return reportError(ctx, "unknown_line", message.id);
    if (!permitted(line.category, situation)) {
      return reportError(ctx, "speak_rejected", message.id);
    }
  } else if (situation !== "family") {
    return reportError(ctx, "speak_rejected", message.id);
  }
  const phase = ctx.s.phase;
  if ((phase.kind === "warning" && phase.line === null) || phase.kind === "conversing") {
    return reportError(ctx, "command_rejected_state", message.id);
  }
  if (audioBusy(ctx)) return reportError(ctx, "audio_busy", message.id);
  if (line !== undefined) {
    startPlayback(ctx, line, { ja: line.ja, en: line.en });
    return;
  }
  if (audioUrl !== null) reportError(ctx, "download_failed", message.id);
}

function onCommand(ctx: Ctx, message: SchemaMessage): void {
  switch (message.type) {
    case "judgement.result":
      if (ctx.s.phase.kind === "conversing") onLookVerdict(ctx, message);
      else onJudgement(ctx, message);
      return;
    case "conversation.start":
      onConversationStart(ctx, message);
      return;
    case "conversation.end":
      onConversationEnd(ctx, message);
      return;
    case "snapshot.request":
      onSnapshotRequest(ctx, message);
      return;
    case "speak":
      onSpeak(ctx, message);
      return;
    case "gaze":
      if (ctx.s.phase.kind === "sleeping" || ctx.s.phase.kind === "cooldown") {
        reportError(ctx, "command_rejected_state", message.id);
        return;
      }
      move(ctx, message.data.panDeg, message.data.tiltDeg);
      return;
    case "lantern":
      if (ctx.s.phase.kind === "sleeping" || ctx.s.phase.kind === "cooldown") {
        reportError(ctx, "command_rejected_state", message.id);
        return;
      }
      ctx.s = setLanternTarget(ctx.s, message.data.level, message.data.fadeMs, ctx.now);
      return;
    case "mode.set": {
      const mode = message.data.mode;
      if (mode === "remote") {
        // The virtual doll does not model remote control (remote-mode M4).
        reportError(ctx, "command_rejected_state", message.id);
        return;
      }
      if (ctx.s.mode === mode) return;
      ctx.s = { ...ctx.s, mode };
      const kind = ctx.s.phase.kind;
      if (mode === "sleep" && kind === "conversing") {
        leaveConversing(ctx, "manual", "manual", true);
      } else if (mode === "sleep" && ctx.s.encounter !== null && kind !== "sleeping" && kind !== "cooldown") {
        enterCooldown(ctx, "manual", true);
      }
      return;
    }
    default:
      return; // events and status are not commands
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

function publishStatus(ctx: Ctx): void {
  const s = ctx.s;
  const attempt = s.encounter?.attempt;
  emit(
    ctx,
    "status.report",
    {
      state: s.deviceState,
      mode: s.mode,
      panDeg: s.panTarget,
      tiltDeg: s.tiltTarget,
      lantern: s.lanternTarget?.level ?? s.lantern,
      cameraActive: s.phase.kind === "seeking" && !!attempt && !attempt.verdictProcessed,
      micActive: s.phase.kind === "conversing",
      motionEnabled: true,
      uptimeSec: 0,
      agentVersion: "sim",
    },
    null,
  );
}

/** Publishes one `status.report` (the engine's first-tick and periodic reports). */
export function reportStatus(state: SimState, now: number): MachineResult {
  const ctx: Ctx = { s: state, now, out: [], encounterId: null, stateChanged: false };
  publishStatus(ctx);
  return { state: ctx.s, outputs: ctx.out };
}

/** Handles one event. Returns the same state object and no outputs when nothing happens. */
export function handle(state: SimState, event: MachineEvent, now: number): MachineResult {
  const ctx: Ctx = {
    s: state,
    now,
    out: [],
    encounterId: state.encounter?.id ?? null,
    stateChanged: false,
  };
  switch (event.kind) {
    case "tick":
      onTick(ctx);
      break;
    case "internal":
      onInternal(ctx, event.event);
      break;
    case "command":
      onCommand(ctx, event.message);
      break;
  }
  if (ctx.stateChanged) {
    // Finished playbacks no longer count as busy once the state moves on.
    ctx.s = { ...ctx.s, audio: ctx.s.audio.filter((a) => now < a.busyUntil) };
    publishStatus(ctx);
  }
  return { state: ctx.s, outputs: ctx.out };
}
