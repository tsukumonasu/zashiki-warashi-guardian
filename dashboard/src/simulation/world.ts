// The simulated physical world around the doll: head motion, lantern fade and the responders
// of the camera and the cloud. Pure functions over SimState; independent of machine.ts.
// Mirrors the hardware rules: one slow step at a time, always inside the calibrated limits.

import { formatIso, uuidV4 } from "./rng";
import type { Input, JudgementResult, PendingInput, SimState } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------------------------
// Motion model
// ---------------------------------------------------------------------------------------------

export function clampPan(state: SimState, deg: number): number {
  return clamp(deg, -state.config.panLimit, state.config.panLimit);
}

export function clampTilt(state: SimState, deg: number): number {
  return clamp(deg, -state.config.tiltLimit, state.config.tiltLimit);
}

/**
 * Starts a head movement. Targets are clamped here, so any finite angle stays in range.
 * A non-finite angle keeps the current target of that axis.
 */
export function setTargets(
  state: SimState,
  panDeg: number,
  tiltDeg: number,
  motionId: string,
): SimState {
  return {
    ...state,
    panTarget: Number.isFinite(panDeg) ? clampPan(state, panDeg) : state.panTarget,
    tiltTarget: Number.isFinite(tiltDeg) ? clampTilt(state, tiltDeg) : state.tiltTarget,
    motion: { ...state.motion, id: motionId },
  };
}

function approach(current: number, target: number, maxStep: number): number {
  const remaining = Math.abs(target - current);
  if (remaining <= maxStep) return target;
  return current + Math.sign(target - current) * maxStep;
}

/**
 * Advances the head by at most one step. A step happens only when `glideIntervalMs` has passed
 * since the last one. `arrivedMotionId` is set once, in the call in which both axes are at
 * their targets while a motion is open, and the motion is closed.
 */
export function stepMotion(
  state: SimState,
  now: number,
): { state: SimState; arrivedMotionId: string | null } {
  let next = state;
  const atTarget = state.pan === state.panTarget && state.tilt === state.tiltTarget;

  if (!atTarget && now - state.motion.lastStepAt >= state.config.glideIntervalMs) {
    const stepDeg = state.config.glideStepDeg;
    next = {
      ...state,
      pan: clampPan(state, approach(state.pan, state.panTarget, stepDeg)),
      tilt: clampTilt(state, approach(state.tilt, state.tiltTarget, stepDeg)),
      motion: { ...state.motion, lastStepAt: now },
    };
  }

  const arrivedNow = next.pan === next.panTarget && next.tilt === next.tiltTarget;
  if (arrivedNow && next.motion.id !== null) {
    const arrivedMotionId = next.motion.id;
    return { state: { ...next, motion: { ...next.motion, id: null } }, arrivedMotionId };
  }
  return { state: next, arrivedMotionId: null };
}

// ---------------------------------------------------------------------------------------------
// Lantern model
// ---------------------------------------------------------------------------------------------

/** Linear fade from `from` to the target level over `fadeMs`, recomputed from `now`. */
export function updateLantern(state: SimState, now: number): SimState {
  const target = state.lanternTarget;
  if (target === null) return state;
  const progress =
    target.fadeMs <= 0 ? 1 : clamp((now - target.startedAt) / target.fadeMs, 0, 1);
  const level = clamp(target.from + (target.level - target.from) * progress, 0, 1);
  return level === state.lantern ? state : { ...state, lantern: level };
}

/** Starts a fade from the current level. `level` is clamped to 0..1, `fadeMs` to 0..10000. */
export function setLanternTarget(
  state: SimState,
  level: number,
  fadeMs: number,
  now: number,
): SimState {
  const current = updateLantern(state, now);
  return {
    ...current,
    lanternTarget: {
      level: clamp(Number.isFinite(level) ? level : 0, 0, 1),
      fadeMs: clamp(Number.isFinite(fadeMs) ? fadeMs : 0, 0, 10_000),
      startedAt: now,
      from: current.lantern,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pending inputs and responders
// ---------------------------------------------------------------------------------------------

/** Inserts keeping `pending` sorted by `at`, then by insertion order. */
export function schedule(state: SimState, at: number, input: Input): SimState {
  const entry: PendingInput = { at, input };
  let index = state.pending.length;
  while (index > 0 && (state.pending[index - 1] as PendingInput).at > at) index--;
  const pending = [...state.pending.slice(0, index), entry, ...state.pending.slice(index)];
  return { ...state, pending };
}

/** Removes and returns the inputs due at `now`, in order. */
export function takeDue(state: SimState, now: number): { state: SimState; due: Input[] } {
  const due = state.pending.filter((p) => p.at <= now).map((p) => p.input);
  if (due.length === 0) return { state, due };
  return { state: { ...state, pending: state.pending.filter((p) => p.at > now) }, due };
}

/** Camera responder: the machine asked for a snapshot, `snapshot.ready` follows after the delay. */
export function onTakeSnapshot(state: SimState, snapshotId: string, now: number): SimState {
  const plan = state.plan;
  if (plan === null) return state;
  return schedule(state, now + plan.cameraDelayMs, {
    kind: "internal",
    event: { type: "snapshot.ready", snapshotId },
  });
}

/**
 * Cloud responder: a snapshot was sent. When the cloud is up and the plan has an attempt, a
 * `judgement.result` for this snapshot arrives after `verdictDelayMs`. When the cloud is down,
 * or the plan has no attempt, nothing is scheduled and the attempt deadline ends the wait.
 * `attemptIndex` is 0-based; the last planned attempt repeats.
 */
export function onSnapshotCaptured(
  state: SimState,
  snapshotId: string,
  attemptIndex: number,
  now: number,
): SimState {
  const plan = state.plan;
  if (plan === null || plan.cloud === "down" || plan.attempts.length === 0) return state;
  const planned = plan.attempts[clamp(attemptIndex, 0, plan.attempts.length - 1)];
  if (planned === undefined) return state;

  const at = now + plan.verdictDelayMs;
  const [id, rng] = uuidV4(state.rng);
  const envelope: JudgementResult = {
    v: 1,
    id,
    ts: formatIso(at),
    deviceId: state.config.deviceId,
    encounterId: null,
    type: "judgement.result",
    data: {
      snapshotId,
      verdict: planned.verdict,
      confidence: planned.confidence,
      face: planned.face,
    },
  };
  return schedule({ ...state, rng }, at, { kind: "command", value: envelope });
}
