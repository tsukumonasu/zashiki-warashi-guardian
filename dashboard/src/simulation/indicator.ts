/**
 * Privacy indicator view model (Requirement 13.5 to 13.8).
 *
 * Pure: maps the outcome of the last `GET /device/status` call to what the
 * header indicator shows. "Off" is claimed only when an online doll reported
 * both flags as false; any missing evidence gives "unknown" or "simulation".
 */
import type { StatusReportData } from "./types";

export const INDICATOR_TEXT = {
  simulation: "Simulation: no real camera or microphone is in use",
  unknown: "Camera and microphone state unknown",
  off: "Camera off, microphone off",
  cameraOn: "Camera on",
  microphoneOn: "Microphone on",
} as const;

export type StatusFetch =
  | { kind: "none" }
  | { kind: "failed" }
  | { kind: "ok"; online: boolean; status: StatusReportData | null };

export type IndicatorView =
  | { kind: "simulation"; text: typeof INDICATOR_TEXT.simulation }
  | { kind: "unknown"; text: typeof INDICATOR_TEXT.unknown }
  | { kind: "off"; text: typeof INDICATOR_TEXT.off }
  | { kind: "active"; parts: ("Camera on" | "Microphone on")[] };

const SIMULATION: IndicatorView = { kind: "simulation", text: INDICATOR_TEXT.simulation };
const UNKNOWN: IndicatorView = { kind: "unknown", text: INDICATOR_TEXT.unknown };
const OFF: IndicatorView = { kind: "off", text: INDICATOR_TEXT.off };

/**
 * `cameraRequested` is true while the page itself has asked the doll for a photo and waits for it.
 * The doll's own report can lag by seconds, and the camera runs for less time than a poll takes,
 * so the indicator also shows "Camera on" for that wait: it may over-report, never under-report.
 */
export function indicatorView(f: StatusFetch, cameraRequested = false): IndicatorView {
  const view = reportedView(f);
  if (!cameraRequested) return view;
  if (view.kind !== "active") return { kind: "active", parts: [INDICATOR_TEXT.cameraOn] };
  if (view.parts.includes(INDICATOR_TEXT.cameraOn)) return view;
  return { kind: "active", parts: [INDICATOR_TEXT.cameraOn, ...view.parts] };
}
function reportedView(f: StatusFetch): IndicatorView {
  if (f.kind === "none") return SIMULATION;
  if (f.kind === "failed") return UNKNOWN;
  // Offline takes precedence: the last report may be stale (Requirement 13.8).
  if (!f.online) return UNKNOWN;
  if (f.status === null) return SIMULATION;

  const parts: ("Camera on" | "Microphone on")[] = [];
  if (f.status.cameraActive) parts.push(INDICATOR_TEXT.cameraOn);
  if (f.status.micActive) parts.push(INDICATOR_TEXT.microphoneOn);
  return parts.length > 0 ? { kind: "active", parts } : OFF;
}
