/**
 * Text alternative of the virtual doll (Requirement 17.6).
 *
 * Pure: the SVG doll is conveyed to screen readers as one sentence with the
 * device state, the head direction and the lantern level.
 */
import type { SimState } from "./types";

/** Pan within this many degrees of center counts as facing ahead. */
export const AHEAD_TOLERANCE_DEG = 2;
/** Lantern levels below this are `dark`; below `BRIGHT_FROM` they are `dim`. */
export const DARK_BELOW = 0.05;
export const BRIGHT_FROM = 0.5;

export type HeadDirection = "left" | "ahead" | "right";
export type LanternLevel = "dark" | "dim" | "bright";

/** Positive pan turns toward the doll's right (docs/schema.md, Angles). */
export function headDirection(panDeg: number): HeadDirection {
  if (Math.abs(panDeg) <= AHEAD_TOLERANCE_DEG) return "ahead";
  return panDeg < 0 ? "left" : "right";
}

export function lanternLevel(lantern: number): LanternLevel {
  if (lantern < DARK_BELOW) return "dark";
  return lantern < BRIGHT_FROM ? "dim" : "bright";
}

export function dollLabel(state: Pick<SimState, "deviceState" | "pan" | "lantern">): string {
  return (
    `Zashiki-warashi doll, state ${state.deviceState}, ` +
    `head turned ${headDirection(state.pan)}, lantern ${lanternLevel(state.lantern)}`
  );
}
