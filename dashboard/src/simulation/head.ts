import type { FaceBox, SimConfig } from "./types";

/** Limits a finite value to [lo, hi]. Non-finite input throws, like the device's `clamp`. */
export function clamp(value: number, lo: number, hi: number): number {
  if (!(Number.isFinite(value) && Number.isFinite(lo) && Number.isFinite(hi))) {
    throw new RangeError("clamp() needs finite numbers");
  }
  if (lo > hi) throw new RangeError("clamp() needs lo <= hi");
  return Math.min(Math.max(value, lo), hi);
}

/** Clamps a (pan, tilt) pair to the calibrated range, as the device's `clamp_gaze`. */
export function clampGaze(
  target: readonly [number, number],
  cfg: Pick<SimConfig, "panLimit" | "tiltLimit">,
): [number, number] {
  return [
    clamp(target[0], -cfg.panLimit, cfg.panLimit),
    clamp(target[1], -cfg.tiltLimit, cfg.tiltLimit),
  ];
}

/**
 * Gaze target (pan, tilt in degrees) that turns the head toward `face`.
 *
 * Mirrors the device's `head_tracker.head_target`: the camera looks where the head looked when
 * the snapshot was taken, so the correction is relative to the snapshot angles. Box fields are
 * clamped to 0..1 first, the centre is capped at 1, image y grows downward (face above centre
 * gives positive tilt), and the result is clamped to the configured limits.
 */
export function headTarget(
  face: FaceBox,
  snapPan: number,
  snapTilt: number,
  cfg: Pick<SimConfig, "panLimit" | "tiltLimit" | "cameraHfovDeg" | "cameraVfovDeg">,
): [number, number] {
  const left = clamp(face.left, 0, 1);
  const top = clamp(face.top, 0, 1);
  const width = clamp(face.width, 0, 1);
  const height = clamp(face.height, 0, 1);
  const cx = Math.min(1, left + width / 2);
  const cy = Math.min(1, top + height / 2);
  const panCorr = (cx - 0.5) * cfg.cameraHfovDeg;
  const tiltCorr = (0.5 - cy) * cfg.cameraVfovDeg;
  return clampGaze([snapPan + panCorr, snapTilt + tiltCorr], cfg);
}
