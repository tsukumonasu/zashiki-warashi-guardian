// The simulation engine: `step(state, input, now) -> { state, outputs }`.
//
// It composes the Schema_Codec (decode), the duplicate window, the device state machine
// (`machine.handle`), the head and lantern models and the world responders of `world.ts`, and
// a bounded feedback loop. Pure and deterministic: time is `now`, randomness is `state.rng`.
// No `Date`, no `Math.random`, no React.

import { decodeValue } from "./codec";
import { validateConfig } from "./config";
import { handle, reportStatus, type MachineEvent } from "./machine";
import { formatIso, uuidV4 } from "./rng";
import type {
  ErrorCode,
  Input,
  ModeSet,
  Output,
  SchemaMessage,
  SimConfig,
  SimState,
  UserAction,
} from "./types";
import { stepMotion, takeDue, updateLantern } from "./world";

export interface StepResult {
  state: SimState;
  outputs: Output[];
}

/** Upper bound of the feedback loop of one `step` call. */
export const MAX_ROUNDS = 16;
/** Period of the `status.report` (device default `status_interval_s`). */
export const STATUS_INTERVAL_MS = 60_000;

/** A time far enough in the past that the first motion step is never delayed. */
const LONG_AGO = -1_000_000;

const COMMAND_TYPES: ReadonlySet<string> = new Set([
  "judgement.result",
  "speak",
  "gaze",
  "lantern",
  "mode.set",
  "conversation.start",
  "conversation.end",
  "snapshot.request",
]);

/** Fixed `error.reported` texts: no input echo, no private data. */
const ERROR_TEXT: Readonly<Record<string, string>> = {
  malformed_message: "message breaks a rule of the message contract",
  unsupported_version: "message version is not supported",
  wrong_device: "message is addressed to another device",
  unknown_type: "message type is not a command this device accepts",
};

export function initialState(config: Partial<SimConfig> = {}): SimState {
  return {
    config: validateConfig(config),
    phase: { kind: "sleeping" },
    deviceState: "sleeping",
    mode: "guard",
    pan: 0,
    tilt: 0,
    panTarget: 0,
    tiltTarget: 0,
    motion: { id: null, lastStepAt: LONG_AGO },
    lantern: 0,
    lanternTarget: null,
    eye: "closed",
    subtitle: null,
    verdict: null,
    encounter: null,
    cloudConnected: true,
    audio: [],
    plan: null,
    pending: [],
    seenCommandIds: [],
    rng: 1,
    log: [],
    running: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Running one machine event and collecting its outputs
// ---------------------------------------------------------------------------------------------

/** Mutable holder that lives for one `step` call and never escapes. */
interface Run {
  s: SimState;
  readonly now: number;
  readonly out: Output[];
}

function uptimeSec(s: SimState, now: number): number {
  return Math.max(0, Math.floor((now - (s.startedAt ?? now)) / 1000));
}

/** Appends outputs; a `status.report` gets the real `uptimeSec` (the machine leaves it at 0). */
function collect(run: Run, state: SimState, outputs: Output[]): void {
  const patched = new Map<SchemaMessage, SchemaMessage>();
  for (const output of outputs) {
    if (output.kind === "message" && output.envelope.type === "status.report") {
      const original = output.envelope;
      const envelope: SchemaMessage = {
        ...original,
        data: { ...original.data, uptimeSec: uptimeSec(state, run.now) },
      } as SchemaMessage;
      patched.set(original, envelope);
      run.out.push({ kind: "message", envelope });
    } else {
      run.out.push(output);
    }
  }
  run.s =
    patched.size === 0
      ? state
      : { ...state, log: state.log.map((m) => patched.get(m) ?? m) };
}

function runMachine(run: Run, event: MachineEvent): void {
  const result = handle(run.s, event, run.now);
  collect(run, result.state, result.outputs);
}

/** An `error.reported` produced by the engine itself (inbound check). Changes only rng and log. */
function reportInboundError(run: Run, code: ErrorCode, refId: string | null): void {
  const [id, rng] = uuidV4(run.s.rng);
  const envelope: SchemaMessage = {
    v: 1,
    id,
    ts: formatIso(run.now),
    deviceId: run.s.config.deviceId,
    encounterId: run.s.encounter?.id ?? null,
    type: "error.reported",
    data: { code, message: ERROR_TEXT[code] ?? "", refId },
  };
  run.s = { ...run.s, rng, log: [...run.s.log, envelope] };
  run.out.push({ kind: "message", envelope });
}

function readableId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

/** Inbound check of the device: decode, version, device id, duplicate window, then dispatch. */
function runCommand(run: Run, value: unknown): void {
  const decoded = decodeValue(value);
  if (decoded.kind === "malformed") {
    const code: ErrorCode = decoded.rule === "unknown_type" ? "unknown_type" : "malformed_message";
    reportInboundError(run, code, readableId(value));
    return;
  }
  if (decoded.kind === "unsupported_version") {
    reportInboundError(run, "unsupported_version", readableId(value));
    return;
  }
  const message = decoded.message;
  if (message.deviceId !== run.s.config.deviceId) {
    reportInboundError(run, "wrong_device", message.id);
    return;
  }
  if (!COMMAND_TYPES.has(message.type)) {
    reportInboundError(run, "unknown_type", message.id);
    return;
  }
  if (run.s.seenCommandIds.includes(message.id)) return; // duplicate: dropped silently
  const window = run.s.config.dedupWindowSize;
  run.s = { ...run.s, seenCommandIds: [...run.s.seenCommandIds, message.id].slice(-window) };
  runMachine(run, { kind: "command", message });
}

function runInput(run: Run, input: Input): void {
  switch (input.kind) {
    case "tick":
      runMachine(run, { kind: "tick" });
      return;
    case "internal":
      runMachine(run, { kind: "internal", event: input.event });
      return;
    case "command":
      runCommand(run, input.value);
      return;
    case "user":
      return; // user actions are never scheduled
  }
}

// ---------------------------------------------------------------------------------------------
// Feedback loop: motion, due world inputs, arrivals
// ---------------------------------------------------------------------------------------------

/** Runs motion and due inputs until nothing changes, at most `MAX_ROUNDS` rounds. */
function settle(run: Run): void {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let progressed = false;

    run.s = updateLantern(run.s, run.now);
    const motion = stepMotion(run.s, run.now);
    run.s = motion.state;
    if (motion.arrivedMotionId !== null) {
      progressed = true;
      runMachine(run, {
        kind: "internal",
        event: { type: "servo.arrived", motionId: motion.arrivedMotionId },
      });
    }

    const due = takeDue(run.s, run.now);
    run.s = due.state;
    for (const input of due.due) {
      progressed = true;
      runInput(run, input);
    }

    if (!progressed) break;
  }
  run.s = updateLantern(run.s, run.now);
}

/** `status.report` on the first tick after start and then every `STATUS_INTERVAL_MS`. */
function periodicStatus(run: Run): void {
  if (!run.s.running) return;
  const last = run.s.lastStatusAt;
  if (last !== undefined && run.now - last < STATUS_INTERVAL_MS) return;
  const result = reportStatus(run.s, run.now);
  collect(run, { ...result.state, lastStatusAt: run.now }, result.outputs);
}

// ---------------------------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------------------------

function start(run: Run, action: Extract<UserAction, { type: "start" }>): void {
  const seed = (action.seed | 0) ^ Math.imul(action.encounterIdSeed ?? 0, 0x9e3779b1);
  run.s = {
    ...initialState(run.s.config),
    plan: action.plan,
    rng: seed | 0,
    running: true,
    startedAt: run.now,
  };
  // The plan decides whether the cloud link is up; the machine learns it before the PIR fires.
  runMachine(run, {
    kind: "internal",
    event: { type: action.plan.cloud === "up" ? "cloud.connected" : "cloud.disconnected" },
  });
  runMachine(run, { kind: "internal", event: { type: "pir.rising" } });
}

/** `stop` is `mode.set` with `mode: "sleep"`; the synthetic command is never published. */
function stop(run: Run): void {
  const [id, rng] = uuidV4(run.s.rng);
  run.s = { ...run.s, rng };
  const message: ModeSet = {
    v: 1,
    id,
    ts: formatIso(run.now),
    deviceId: run.s.config.deviceId,
    encounterId: null,
    type: "mode.set",
    data: { mode: "sleep" },
  };
  runMachine(run, { kind: "command", message });
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export function step(state: SimState, input: Input, now: number): StepResult {
  const run: Run = { s: state, now, out: [] };

  if (input.kind === "user") {
    const action = input.action;
    if (action.type === "start") {
      // A running scenario is not restarted. A device that is not asleep (a stray `pir.rising`
      // woke it) is not reset either: `start` would rewind it to `sleeping` without a state.changed.
      if (state.running || state.deviceState !== "sleeping") return { state, outputs: [] };
      start(run, action);
    } else {
      if (!state.running) return { state, outputs: [] };
      stop(run);
    }
    settle(run);
    return { state: run.s, outputs: run.out };
  }

  if (input.kind === "tick") {
    settle(run);
    runInput(run, input);
    settle(run);
    periodicStatus(run);
  } else {
    runInput(run, input);
    settle(run);
  }
  return { state: run.s, outputs: run.out };
}
