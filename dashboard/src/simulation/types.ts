// Message types of docs/schema.md (contract v1). Field names and value sets match the
// document exactly. Engine types (SimState, Input, Output, ...) are added by task 6.1.

export const STATES = [
  "sleeping",
  "waking",
  "seeking",
  "gazing",
  "greeting",
  "warning",
  "uncertain",
  "conversing",
  "cooldown",
] as const;
export type State = (typeof STATES)[number];

export const REASONS = [
  "presence",
  "arrived",
  "verdict",
  "no_face",
  "timeout",
  "offline",
  "audio_done",
  "manual",
  "cooldown_done",
  "error",
  "conversation",
  "conversation_done",
  "photo_done",
] as const;
export type Reason = (typeof REASONS)[number];

export const ERROR_CODES = [
  "unknown_type",
  "unsupported_version",
  "malformed_message",
  "wrong_device",
  "speak_rejected",
  "audio_busy",
  "command_rejected_state",
  "unknown_line",
  "voice_line_missing",
  "voice_line_invalid",
  "voice_file_missing",
  "audio_failed",
  "download_failed",
  "audio_device_missing",
  "camera_missing",
  "camera_failed",
  "snapshot_too_large",
  "internal_error",
  "adapter_failed",
  "conversation_failed",
  "microphone_failed",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const VERDICTS = ["family", "stranger", "no_face", "uncertain"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type Mode = "guard" | "sleep";
export type ReactionKind = "family" | "stranger" | "uncertain";
export type PresenceSource = "pir" | "sound" | "manual";
export type EncounterEndReason = "cooldown" | "manual" | "error";

export const CONVERSATION_END_REASONS = [
  "silence",
  "limit",
  "stranger",
  "user",
  "manual",
  "language",
  "unsafe_output",
  "error",
  "no_client",
  "offline",
] as const;
export type ConversationEndReason = (typeof CONVERSATION_END_REASONS)[number];
export type ConversationSource = "family_verdict" | "manual";

export interface FaceBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Fields shared by every message. `type` and `data` come from the union members. */
export interface EnvelopeBase {
  v: 1;
  id: string;
  ts: string;
  deviceId: string;
  encounterId: string | null;
}

export interface StatusReportData {
  state: State;
  mode: Mode;
  panDeg: number;
  tiltDeg: number;
  lantern: number;
  cameraActive: boolean;
  micActive: boolean;
  motionEnabled: boolean;
  uptimeSec: number;
  agentVersion: string;
}

type Msg<T extends string, D> = EnvelopeBase & { type: T; data: D };

// Events (device -> cloud)
export type PresenceDetected = Msg<"presence.detected", { source: PresenceSource }>;
export type SnapshotCaptured = Msg<
  "snapshot.captured",
  {
    snapshotId: string;
    width: number;
    height: number;
    panDeg: number;
    tiltDeg: number;
    jpegBase64: string;
    /** Set only for a snapshot that answers a `snapshot.request`; absent means null. */
    requestId?: string | null;
    /** `photo` marks a remote photo that is only stored; absent means `judge`. */
    purpose?: "judge" | "photo";
  }
>;
export type StateChanged = Msg<"state.changed", { from: State; to: State; reason: Reason }>;
export type ReactionPerformed = Msg<
  "reaction.performed",
  { kind: ReactionKind; lineId: string | null; offline: boolean }
>;
export type EncounterEnded = Msg<"encounter.ended", { reason: EncounterEndReason }>;
export type ConversationRequested = Msg<"conversation.requested", { reason: "family_verdict" }>;
export type ConversationEnded = Msg<
  "conversation.ended",
  { sessionId: string; reason: ConversationEndReason }
>;
export type ErrorReported = Msg<
  "error.reported",
  { code: ErrorCode; message: string; refId: string | null }
>;

// Commands (cloud -> device)
export type JudgementResult = Msg<
  "judgement.result",
  { snapshotId: string; verdict: Verdict; confidence: number; face: FaceBox | null }
>;
export type Speak = Msg<
  "speak",
  { lineId: string | null; audioUrl: string | null; ja: string; en: string; remote?: boolean }
>;
export type Gaze = Msg<"gaze", { panDeg: number; tiltDeg: number }>;
export type Lantern = Msg<"lantern", { level: number; fadeMs: number }>;
export type ModeSet = Msg<"mode.set", { mode: Mode }>;

export type ConversationStart = Msg<
  "conversation.start",
  {
    sessionId: string;
    /** A secret: the simulation never logs or publishes it. */
    token: string;
    maxSeconds: number;
    silenceSeconds: number;
    source: ConversationSource;
  }
>;
export type ConversationEnd = Msg<
  "conversation.end",
  { sessionId: string; reason: ConversationEndReason }
>;
export type SnapshotRequest = Msg<
  "snapshot.request",
  { requestId: string; purpose?: "look" | "photo" }
>;

// Status (device -> cloud)
export type StatusReport = Msg<"status.report", StatusReportData>;
export type StatusOffline = Msg<"status.offline", Record<string, never>>;

export type SchemaMessage =
  | PresenceDetected
  | SnapshotCaptured
  | StateChanged
  | ReactionPerformed
  | EncounterEnded
  | ErrorReported
  | JudgementResult
  | Speak
  | Gaze
  | Lantern
  | ModeSet
  | ConversationRequested
  | ConversationEnded
  | ConversationStart
  | ConversationEnd
  | SnapshotRequest
  | StatusReport
  | StatusOffline;

export type MessageType = SchemaMessage["type"];

// HTTP API shapes (docs/schema.md, "HTTP API")
export type Illustration =
  | "silhouette-family"
  | "silhouette-stranger"
  | "silhouette-none"
  | "silhouette-uncertain";

export interface Encounter {
  encounterId: string;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
  state: State | null;
  verdict: Verdict | null;
  confidence: number | null;
  reaction: { kind: ReactionKind; lineId: string | null; offline: boolean } | null;
  notified: boolean;
  snapshot: { url: string; expiresAt: string } | null;
  illustration: Illustration | null;
  events: SchemaMessage[];
}

export interface Speech {
  lineId: string | null;
  ja: string;
  en: string;
  mp3Url: string | null;
  generated: boolean;
}

// ---------------------------------------------------------------------------------------------
// Engine types (task 6.1). The engine in `engine.ts` is pure: time and randomness are inputs.
// ---------------------------------------------------------------------------------------------

/** States the simulated device can be in. */
export type DeviceState = State;
export type EyeState = "closed" | "half" | "open" | "stare";
/** Verdict text shown to the visitor; `offline` means the doll reacted without a verdict. */
export type VerdictLabel = "family" | "stranger" | "no_face" | "uncertain" | "offline";

export type ScenarioId = "family_home" | "stranger_night" | "nobody_there" | "network_down";

export interface PlannedVerdict {
  verdict: Verdict;
  /** 0..1 */
  confidence: number;
  face: FaceBox | null;
}

export interface ScenarioPlan {
  scenario: ScenarioId;
  /** `down`: `cloud.disconnected` is delivered before `pir.rising`. */
  cloud: "up" | "down";
  /** One per snapshot attempt; the last repeats if more are needed. */
  attempts: PlannedVerdict[];
  /** From the response's `speak.lineId`; null lets the engine choose. */
  reactionLineId: string | null;
  /** Generated text, family verdict only (see privacy.ts). */
  display: { ja: string; en: string } | null;
  /** Default 600. */
  cameraDelayMs: number;
  /** Default 1200. */
  verdictDelayMs: number;
}

export type InternalEvent =
  | { type: "pir.rising" }
  | { type: "audio.finished"; playId: string }
  | { type: "audio.failed"; playId: string; code: "audio_failed" | "interrupted" }
  | { type: "snapshot.ready"; snapshotId: string }
  | { type: "snapshot.failed"; snapshotId: string; code: "camera_failed" | "snapshot_too_large" }
  | { type: "cloud.connected" }
  | { type: "cloud.disconnected" }
  | { type: "servo.arrived"; motionId: string };

export type UserAction =
  | { type: "start"; plan: ScenarioPlan; seed: number; encounterIdSeed?: number }
  | { type: "stop" };

export type Input =
  | { kind: "tick" }
  /** A parsed JSON value; the engine decodes it with the codec. */
  | { kind: "command"; value: unknown }
  /** `servo.arrived` is produced by the engine itself. */
  | { kind: "internal"; event: InternalEvent }
  | { kind: "user"; action: UserAction };

export type Output =
  /** On the wire (events, status); never device-internal events. */
  | { kind: "message"; envelope: SchemaMessage }
  | {
      kind: "audio.play";
      playId: string;
      lineId: string;
      ja: string;
      en: string;
      durationHintMs: number | null;
    }
  | { kind: "audio.stop" };

export interface SimConfig {
  /** Pan limit around center, degrees. Hard limit 60. */
  panLimit: number;
  /** Tilt limit around center, degrees. Hard limit 30. */
  tiltLimit: number;
  /** Degrees per motion step. At most 2. */
  glideStepDeg: number;
  /** Milliseconds between motion steps. At least 30. */
  glideIntervalMs: number;
  nodDeg: number;
  lanternWakeLevel: number;
  lanternFadeInMs: number;
  lanternFadeOutMs: number;
  wakingTimeoutS: number;
  verdictTimeoutS: number;
  glideTimeoutS: number;
  stareS: number;
  audioTimeoutS: number;
  cooldownS: number;
  scanPanPositionsDeg: number[];
  scanAttemptsMax: number;
  cameraHfovDeg: number;
  cameraVfovDeg: number;
  familyConfidenceMin: number;
  strangerConfidenceMin: number;
  dedupWindowSize: number;
  deviceId: string;
  /** Ask for a voice session after a family greeting (`conversation.requested`). */
  conversationEnabled: boolean;
}

/** Verdict category the machine accepted for the encounter. */
export type AcceptedVerdict = "family" | "stranger" | "uncertain" | "no_face";

/**
 * The reaction's voice line. `playId` is null when the category had no line (the next tick
 * then ends the reaction with reason `error`); `deadline` is the audio deadline.
 */
export interface ReactionLine {
  playId: string | null;
  deadline: number | null;
}

/** A pending scan move after a `no_face` verdict. */
export interface ScanMove {
  motionId: string;
  deadline: number;
}

/**
 * The machine's state with its per-state data, mirroring the device's phase records.
 * Times are epoch ms.
 */
export type Phase =
  | { kind: "sleeping" }
  | {
      kind: "waking";
      motionId: string;
      fadeDoneAt: number;
      deadline: number;
      arrived: boolean;
    }
  | { kind: "seeking"; scan: ScanMove | null }
  | { kind: "gazing"; motionId: string; deadline: number }
  | {
      kind: "greeting";
      /** Head angles the nod returns to. */
      pan: number;
      tilt: number;
      nodMotionId: string;
      nodDeadline: number;
      nodReturned: boolean;
      line: ReactionLine;
      /** A `conversation.start` with source `family_verdict` arrived: converse after the line. */
      grant: { sessionId: string; maxSeconds: number } | null;
    }
  | { kind: "warning"; stareUntil: number; line: ReactionLine | null }
  | { kind: "uncertain"; line: ReactionLine }
  | {
      kind: "conversing";
      sessionId: string;
      /** Epoch ms: `maxSeconds` after the start, a `limit` end. */
      deadline: number;
      /** The outstanding `snapshot.request`, or null. At most one at a time. */
      look: { requestId: string; snapshotId: string; deadline: number } | null;
    }
  | {
      kind: "cooldown";
      motionId: string;
      glideDeadline: number;
      released: boolean;
      until: number;
      /** Entered by `mode.set sleep`, so `encounter.ended` says `manual`. */
      manual: boolean;
    };

/** One snapshot request and its wait for a verdict. */
export interface SnapshotAttempt {
  snapshotId: string;
  /** Head targets when the snapshot was requested; the head tracker corrects relative to them. */
  pan: number;
  tilt: number;
  deadline: number;
  /** A second verdict for this snapshot is ignored. */
  verdictProcessed: boolean;
}

/** An unfinished playback, for the `audio_busy` rule. */
export interface PendingAudio {
  playId: string;
  busyUntil: number;
}

/** A world input scheduled for a later tick. */
export interface PendingInput {
  at: number;
  input: Input;
}

export interface SimState {
  config: SimConfig;
  phase: Phase;
  /** Equal to `phase.kind`, kept for the renderer. */
  deviceState: DeviceState;
  mode: Mode;
  pan: number;
  tilt: number;
  panTarget: number;
  tiltTarget: number;
  motion: { id: string | null; lastStepAt: number };
  lantern: number;
  lanternTarget: { level: number; fadeMs: number; startedAt: number; from: number } | null;
  eye: EyeState;
  subtitle: { ja: string; en: string } | null;
  /** The visible verdict text label (Requirement 3.7). */
  verdict: VerdictLabel | null;
  encounter: {
    id: string;
    startedAt: number;
    reacted: boolean;
    accepted: AcceptedVerdict | null;
    /** The current snapshot attempt, or null before the first one. */
    attempt: SnapshotAttempt | null;
    /** Snapshot attempts started in this encounter. */
    attemptsStarted: number;
    /** Scan moves started in this encounter. */
    scansRun: number;
  } | null;
  /** The cloud link as the machine knows it; the engine delivers `cloud.connected` / `.disconnected`. */
  cloudConnected: boolean;
  /** Unfinished playbacks. */
  audio: PendingAudio[];
  plan: ScenarioPlan | null;
  /** Sorted by `at`, then insertion order. */
  pending: PendingInput[];
  /** Last `dedupWindowSize` accepted command ids. */
  seenCommandIds: string[];
  /** 32-bit mulberry32 state; the only source of "random" values. */
  rng: number;
  /** Messages emitted since start, `status.report` included. */
  log: SchemaMessage[];
  /** A scenario is running (buttons are disabled while true). */
  running: boolean;
  /** Epoch ms of the last `start`; `uptimeSec` of every `status.report` counts from here. */
  startedAt?: number;
  /** Epoch ms of the last periodic `status.report`; absent until the first tick after start. */
  lastStatusAt?: number;
}

/** Encounter record shown in the UI: an Encounter of docs/schema.md plus where it came from. */
export interface SimEncounter extends Encounter {
  mode: "simulation" | "live";
  line: { ja: string; en: string } | null;
}
