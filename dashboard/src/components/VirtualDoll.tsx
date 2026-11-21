/**
 * The virtual doll: original SVG and CSS, purely presentational (design D9, Requirement 7).
 *
 * Head, eyes and lantern glow are separate groups with separate transitions, driven by CSS
 * custom properties. Under Reduced_Motion the renderer draws the engine's targets instead of
 * the current values, so the head jumps and the lantern changes within 100 ms. Nothing loops.
 */
import type { CSSProperties } from "react";
import { dollLabel } from "../simulation/doll-label";
import type { DeviceState, EyeState, SimState, State } from "../simulation/types";
import "./VirtualDoll.css";

/** The slice of `SimState` the doll draws. `deviceState` may be a real `conversing` state. */
export interface DollView {
  deviceState: State;
  pan: number;
  tilt: number;
  panTarget: number;
  tiltTarget: number;
  lantern: number;
  /** Final lantern level; equal to `lantern` when no fade is running. */
  lanternTarget: number;
  eye: EyeState;
}

export interface VirtualDollProps {
  view: DollView;
  reducedMotion: boolean;
}

/** Builds the view from the engine state. */
export function dollViewFromSim(sim: SimState): DollView {
  return {
    deviceState: sim.deviceState,
    pan: sim.pan,
    tilt: sim.tilt,
    panTarget: sim.panTarget,
    tiltTarget: sim.tiltTarget,
    lantern: sim.lantern,
    lanternTarget: sim.lanternTarget?.level ?? sim.lantern,
    eye: sim.eye,
  };
}

/** `conversing` (P1) is not simulated; the doll draws the `greeting` pose for it (Requirement 7.3). */
export function poseFor(state: State): Exclude<DeviceState, "conversing"> {
  return state === "conversing" ? "greeting" : state;
}

const RAD = Math.PI / 180;
const PAN_SHIFT_PX = 28;
const TILT_SHIFT_PX = 14;
const FACE_SHIFT_PX = 10;
const GLOW_BLUR_MAX_PX = 14;

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function dollStyle(view: DollView, reducedMotion: boolean): CSSProperties {
  const pan = (reducedMotion ? view.panTarget : view.pan) * RAD;
  const tilt = (reducedMotion ? view.tiltTarget : view.tilt) * RAD;
  const lantern = clamp01(reducedMotion ? view.lanternTarget : view.lantern);
  const vars: Record<string, string> = {
    "--doll-pan-x": `${(Math.sin(pan) * PAN_SHIFT_PX).toFixed(2)}px`,
    "--doll-pan-scale": Math.cos(pan).toFixed(4),
    "--doll-face-x": `${(Math.sin(pan) * FACE_SHIFT_PX).toFixed(2)}px`,
    "--doll-tilt-y": `${(-Math.sin(tilt) * TILT_SHIFT_PX).toFixed(2)}px`,
    "--doll-tilt-rot": `${(-(tilt / RAD) * 0.4).toFixed(2)}deg`,
    "--doll-lantern": lantern.toFixed(3),
    "--doll-glow-blur": `${(lantern * GLOW_BLUR_MAX_PX).toFixed(1)}px`,
  };
  return vars as CSSProperties;
}

/** One eye in each of the four shapes; only the active one is visible. */
function Eye({ cx, active, shape }: { cx: number; active: EyeState; shape: EyeState }) {
  const cy = 172;
  const on = active === shape;
  return (
    <g className="doll__eye" data-shape={shape} data-active={on}>
      {shape === "closed" && <path className="doll__eye-line" d={`M ${cx - 11} ${cy} Q ${cx} ${cy + 6} ${cx + 11} ${cy}`} />}
      {shape === "half" && (
        <>
          <ellipse className="doll__eye-white" cx={cx} cy={cy} rx={11} ry={8} />
          <circle className="doll__eye-pupil" cx={cx} cy={cy + 2} r={4.5} />
          <rect className="doll__eye-lid" x={cx - 12} y={cy - 9} width={24} height={9} />
        </>
      )}
      {shape === "open" && (
        <>
          <ellipse className="doll__eye-white" cx={cx} cy={cy} rx={11} ry={10} />
          <circle className="doll__eye-pupil" cx={cx} cy={cy} r={5.5} />
        </>
      )}
      {shape === "stare" && (
        <>
          <ellipse className="doll__eye-white" cx={cx} cy={cy} rx={13} ry={12} />
          <circle className="doll__eye-pupil" cx={cx} cy={cy} r={3} />
        </>
      )}
    </g>
  );
}

const EYE_SHAPES: EyeState[] = ["closed", "half", "open", "stare"];

export function VirtualDoll({ view, reducedMotion }: VirtualDollProps) {
  const pose = poseFor(view.deviceState);
  const label = dollLabel({ deviceState: pose, pan: view.pan, lantern: view.lantern });
  return (
    <svg
      className="doll"
      viewBox="0 0 320 400"
      role="img"
      aria-label={label}
      data-pose={pose}
      data-reduced={reducedMotion}
      style={dollStyle(view, reducedMotion)}
    >
      <defs>
        <radialGradient id="doll-glow-gradient">
          <stop offset="0%" stopColor="var(--color-andon)" stopOpacity="0.85" />
          <stop offset="55%" stopColor="var(--color-andon)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--color-andon)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Room: shoji wall with a night window, tatami floor. */}
      <g aria-hidden="true">
        <rect className="doll__wall" x="0" y="0" width="320" height="300" />
        <rect className="doll__window" x="30" y="30" width="90" height="110" rx="4" />
        <circle className="doll__moon" cx="75" cy="70" r="16" />
        <path className="doll__shoji-frame" d="M30 85 H120 M75 30 V140" />
        <rect className="doll__tatami" x="0" y="300" width="320" height="100" />
        <path className="doll__tatami-line" d="M0 330 H320 M107 300 V400 M214 330 V400" />
      </g>

      {/* Lantern (andon) on the right; the glow sits behind the doll. */}
      <g aria-hidden="true">
        <ellipse className="doll__glow" cx="262" cy="270" rx="120" ry="120" />
        <path className="doll__andon-frame" d="M240 330 V230 M284 330 V230" />
        <rect className="doll__andon-body" x="236" y="232" width="52" height="70" rx="6" />
        <rect className="doll__andon-light" x="242" y="238" width="40" height="58" rx="4" />
      </g>

      {/* Body and kimono. */}
      <g aria-hidden="true">
        <path className="doll__kimono" d="M110 360 L125 235 Q160 215 195 235 L210 360 Z" />
        <rect className="doll__obi" x="122" y="285" width="76" height="22" />
        <path className="doll__collar" d="M138 232 L160 262 L182 232" />
      </g>

      {/* Head group: pan and tilt move the whole head, the face shifts a little more. */}
      <g className="doll__head" aria-hidden="true">
        <ellipse className="doll__head-shape" cx="160" cy="165" rx="50" ry="56" />
        <path className="doll__hair" d="M108 160 Q110 105 160 106 Q210 105 212 160 Q195 135 160 135 Q125 135 108 160 Z" />
        <g className="doll__face">
          <circle className="doll__cheek" cx="132" cy="196" r="9" />
          <circle className="doll__cheek" cx="188" cy="196" r="9" />
          {EYE_SHAPES.map((shape) => (
            <g key={shape}>
              <Eye cx={140} active={view.eye} shape={shape} />
              <Eye cx={180} active={view.eye} shape={shape} />
            </g>
          ))}
          <path className="doll__mouth" d="M150 206 Q160 211 170 206" />
        </g>
      </g>
    </svg>
  );
}
