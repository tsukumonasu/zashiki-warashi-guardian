/**
 * The virtual doll: original SVG and CSS, purely presentational (design D9, Requirement 7).
 *
 * Drawn after the real doll (notes/doll): a lumpy white papier-mache face with the camera
 * lens in the middle of the forehead, thin painted eyes, coarse black yarn hair, a red
 * plum-blossom kimono and clay hands, lit from one side by the andon. Quiet folk horror.
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

/** One eye in each of the four shapes; only the active one is visible. Thin painted doll eyes. */
function Eye({ cx, active, shape }: { cx: number; active: EyeState; shape: EyeState }) {
  const cy = 172;
  const on = active === shape;
  return (
    <g className="doll__eye" data-shape={shape} data-active={on}>
      {shape === "closed" && (
        <>
          <path className="doll__eye-line" d={`M ${cx - 11} ${cy} Q ${cx} ${cy + 4} ${cx + 11} ${cy}`} />
          <path
            className="doll__lash"
            d={`M ${cx - 6} ${cy + 2.6} l -1 3 M ${cx} ${cy + 3.2} l 0 3 M ${cx + 6} ${cy + 2.6} l 1 3`}
          />
        </>
      )}
      {shape === "half" && (
        <>
          <path
            className="doll__eye-white"
            d={`M ${cx - 11} ${cy} Q ${cx} ${cy - 3} ${cx + 11} ${cy} Q ${cx} ${cy + 5} ${cx - 11} ${cy} Z`}
          />
          <circle className="doll__eye-pupil" cx={cx} cy={cy + 1.4} r={2.8} />
          <path className="doll__eye-line" d={`M ${cx - 12} ${cy + 0.5} Q ${cx} ${cy - 3.5} ${cx + 12} ${cy + 0.5}`} />
        </>
      )}
      {shape === "open" && (
        <>
          <path
            className="doll__eye-white"
            d={`M ${cx - 11} ${cy} Q ${cx} ${cy - 7} ${cx + 11} ${cy} Q ${cx} ${cy + 6} ${cx - 11} ${cy} Z`}
          />
          <circle className="doll__eye-pupil" cx={cx} cy={cy} r={3.6} />
          <path className="doll__eye-line" d={`M ${cx - 12} ${cy + 0.5} Q ${cx} ${cy - 8} ${cx + 12} ${cy + 0.5}`} />
        </>
      )}
      {shape === "stare" && (
        <>
          <path
            className="doll__eye-white"
            d={`M ${cx - 12} ${cy} Q ${cx} ${cy - 11} ${cx + 12} ${cy} Q ${cx} ${cy + 10} ${cx - 12} ${cy} Z`}
          />
          <circle className="doll__eye-pupil" cx={cx} cy={cy} r={1.7} />
          <path className="doll__eye-line doll__eye-line--thin" d={`M ${cx - 13} ${cy} Q ${cx} ${cy - 12} ${cx + 13} ${cy}`} />
        </>
      )}
    </g>
  );
}

/** Plum blossoms on the kimono, as on the real doll's brocade. */
const BLOSSOMS: ReadonlyArray<readonly [number, number]> = [
  [126, 262], [190, 254], [134, 318], [186, 314], [150, 342],
  [204, 336], [114, 344], [170, 244], [204, 290], [118, 296],
];
const PETALS = [0, 72, 144, 216, 288].map((deg) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [3.2 * Math.cos(a), 3.2 * Math.sin(a)] as const;
});

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
      <radialGradient id="doll-glow-gradient"><stop offset="0%" stopColor="#f2b45a" stopOpacity="0.85" /><stop offset="55%" stopColor="#f2b45a" stopOpacity="0.3" /><stop offset="100%" stopColor="#f2b45a" stopOpacity="0" /></radialGradient>
      <linearGradient id="doll-wall-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0c1128" /><stop offset="100%" stopColor="#1a2142" /></linearGradient>
      <radialGradient id="doll-face-gradient" cx="0.58" cy="0.42" r="0.7"><stop offset="0%" stopColor="#ffffff" /><stop offset="80%" stopColor="#fcfcfb" /><stop offset="100%" stopColor="#efefed" /></radialGradient>
      <linearGradient id="doll-shade-gradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#0b1026" stopOpacity="0.38" /><stop offset="55%" stopColor="#0b1026" stopOpacity="0.12" /><stop offset="100%" stopColor="#0b1026" stopOpacity="0" /></linearGradient>
      <linearGradient id="doll-lit-gradient" x1="0" y1="0" x2="1" y2="0"><stop offset="40%" stopColor="#f2b45a" stopOpacity="0" /><stop offset="100%" stopColor="#f2b45a" stopOpacity="0.45" /></linearGradient>
      <radialGradient id="doll-vignette-gradient" cx="0.5" cy="0.48" r="0.72"><stop offset="55%" stopColor="#05070f" stopOpacity="0" /><stop offset="100%" stopColor="#05070f" stopOpacity="0.78" /></radialGradient>
      <filter id="doll-grain-filter" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" /><feColorMatrix type="matrix" values="0 0 0 0 0.45  0 0 0 0 0.38  0 0 0 0 0.25  0 0 0 0.9 -0.35" /></filter>
      <linearGradient id="doll-body-shade-gradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#0b1026" stopOpacity="0.6" /><stop offset="60%" stopColor="#0b1026" stopOpacity="0.1" /><stop offset="100%" stopColor="#0b1026" stopOpacity="0" /></linearGradient>
      </defs>

      {/* Room, andon lantern and body: shoji window with a moon, tatami, the glow behind the doll. */}
      <g aria-hidden="true">
        <rect className="doll__wall" x="0" y="0" width="320" height="300" />
        <rect className="doll__pillar" x="14" y="0" width="10" height="300" />
        <rect className="doll__window" x="34" y="28" width="92" height="114" rx="2" />
        <circle className="doll__moon" cx="70" cy="64" r="15" />
        <path className="doll__cloud" d="M48 74 Q66 68 84 73 Q96 76 108 72" />
        <path className="doll__shoji-frame" d="M34 66 H126 M34 104 H126 M65 28 V142 M96 28 V142" />
        <rect className="doll__tatami" x="0" y="300" width="320" height="100" />
        <path className="doll__tatami-line" d="M0 334 H320 M100 300 V400 M220 334 V400" />
        <ellipse className="doll__glow" cx="262" cy="270" rx="120" ry="120" />
        <path className="doll__andon-frame" d="M240 334 V226 M284 334 V226 M236 226 H288" />
        <rect className="doll__andon-body" x="236" y="232" width="52" height="70" rx="3" />
        <rect className="doll__andon-light" x="242" y="238" width="40" height="58" rx="2" />
        <path className="doll__andon-rib" d="M236 255 H288 M236 279 H288" />
        <ellipse className="doll__floor-shadow" cx="150" cy="360" rx="86" ry="11" />
        <path className="doll__kimono" d="M112 352 C100 336 104 298 116 262 C122 244 136 232 160 230 C184 232 198 244 204 262 C216 298 220 336 208 352 Z" />
        <path className="doll__kimono-lap" d="M90 358 C94 336 120 326 160 326 C200 326 226 336 230 358 C200 366 120 366 90 358 Z" />
        <path className="doll__fold" d="M124 270 C120 300 118 326 120 346 M196 270 C200 300 202 326 200 346 M110 352 C140 344 180 344 210 352" />
        {BLOSSOMS.map(([x, y]) => (
          <g key={`${x}-${y}`} className="doll__blossom">
            {PETALS.map(([dx, dy], i) => (
              <circle key={i} className="doll__petal" cx={x + dx} cy={y + dy} r={2.3} />
            ))}
            <circle className="doll__blossom-heart" cx={x} cy={y} r={1.2} />
          </g>
        ))}
        <path className="doll__collar-under" d="M144 233 L160 262 L176 233" />
        <path className="doll__collar" d="M138 233 L160 268 L182 233" />
        <rect className="doll__obi" x="120" y="278" width="80" height="26" rx="2" />
        <path className="doll__obi-cord" d="M120 291 H200" />
        <g className="doll__obi-flower"><circle cx="136" cy="284" r="2.2" /><circle cx="152" cy="298" r="1.8" /><circle cx="171" cy="284" r="2" /><circle cx="188" cy="297" r="2.2" /></g>
        <ellipse className="doll__hand" cx="147" cy="322" rx="10.5" ry="7.5" transform="rotate(-12 147 322)" />
        <ellipse className="doll__hand" cx="172" cy="324" rx="10" ry="7" transform="rotate(9 172 324)" />
        <path className="doll__body-shade" d="M112 352 C100 336 104 298 116 262 C122 244 136 232 160 230 L160 352 Z" />
      </g>

      {/* Head group: pan and tilt move the whole head, the face (eyes, lens) shifts a little more. */}
      <g className="doll__head" aria-hidden="true">
        <g transform="translate(0 32)">
      <path className="doll__hair" d="M94 160 C90 110 120 82 160 82 C200 82 230 110 226 160 C227 172 226 182 224 190 L96 190 C94 182 93 172 94 160 Z" />
      <path className="doll__head-shape" d="M160 116 C194 115 219 135 218 159 C217 181 194 194 160 194 C126 194 103 182 102 160 C101 136 126 117 160 116 Z" />
      <path className="doll__lump" d="M128 183 Q134 189 141 191 M196 160 Q201 166 202 172" />
      <g className="doll__face">
      <ellipse className="doll__cheek" cx="124" cy="181" rx="9" ry="6" />
      <ellipse className="doll__cheek" cx="196" cy="181" rx="9" ry="6" />
      <path className="doll__brow" d="M118 162 Q130 156 142 160 M178 160 Q190 156 202 162" />
      {EYE_SHAPES.map((shape) => (
        <g key={shape}>
          <Eye cx={131} active={view.eye} shape={shape} />
          <Eye cx={189} active={view.eye} shape={shape} />
        </g>
      ))}
      <path className="doll__nose" d="M158.5 178 q1.5 1.2 3 0" />
      <path className="doll__mouth" d="M154 184.5 Q157 182 160 183.5 Q163 182 166 184.5 Q160 189 154 184.5 Z" />
      <circle className="doll__lens-ring" cx="160" cy="160" r="6" />
      <circle className="doll__lens" cx="160" cy="160" r="4.4" />
      <circle className="doll__lens-glint" cx="158.6" cy="158.6" r="1.2" />
      </g>
      <path className="doll__face-shade" d="M160 116 C194 115 219 135 218 159 C217 181 194 194 160 194 C126 194 103 182 102 160 C101 136 126 117 160 116 Z" />
      <path className="doll__face-lit" d="M160 116 C194 115 219 135 218 159 C217 181 194 194 160 194 C126 194 103 182 102 160 C101 136 126 117 160 116 Z" />
      <path className="doll__hair" d="M99 160 C97 106 126 87 160 87 C194 87 223 106 221 160 L217 151 L103 151 Z" />
      <path className="doll__hair" d="M100 150 C95 166 95 180 98 190 L116 190 C110 178 108 164 111 150 Z M220 150 C225 166 225 180 222 190 L204 190 C210 178 212 164 209 150 Z" />
      <path className="doll__strand" d="M118 100 L117 150 M133 93 L132 150 M148 90 L148 150 M172 90 L172 150 M187 93 L188 150 M202 100 L203 150 M104 156 L103 188 M109 158 L108 188 M216 156 L217 188 M211 158 L212 188" />
        </g>
      </g>

      {/* Vignette and washi grain on top; they never take pointer events. */}
      <g aria-hidden="true" className="doll__overlay">
        <rect className="doll__vignette" x="0" y="0" width="320" height="400" />
        <rect className="doll__grain" x="0" y="0" width="320" height="400" />
      </g>
    </svg>
  );
}
