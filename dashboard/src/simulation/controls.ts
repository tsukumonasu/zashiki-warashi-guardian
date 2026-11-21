/**
 * Pure builder for the manual controls of the real doll (Requirement 14).
 * It returns the `command` body of `POST /commands` (docs/schema.md), always
 * inside the documented ranges, so the panel cannot ask for an unsafe value.
 */

/** Pan angle of "Look left" / "Look right": inside the default device limit of ±30°. */
export const LOOK_PAN_DEG = 20;
export const MAX_FADE_MS = 10_000;

export type Control =
  | { readonly kind: "speak"; readonly lineId: string }
  | { readonly kind: "look"; readonly side: "left" | "right" }
  | { readonly kind: "lantern"; readonly level: number; readonly fadeS: number }
  | { readonly kind: "mode"; readonly mode: "guard" | "sleep" };

/** The `command` field of the `POST /commands` body. */
export type OutgoingCommand =
  | { readonly type: "speak"; readonly data: { readonly lineId: string } }
  | {
      readonly type: "gaze";
      readonly data: { readonly panDeg: number; readonly tiltDeg: number };
    }
  | {
      readonly type: "lantern";
      readonly data: { readonly level: number; readonly fadeMs: number };
    }
  | {
      readonly type: "mode.set";
      readonly data: { readonly mode: "guard" | "sleep" };
    };

/** NaN and ±Infinity become 0 (Requirement 14.3). */
function finiteOrZero(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function buildCommand(c: Control): OutgoingCommand {
  switch (c.kind) {
    case "speak":
      return { type: "speak", data: { lineId: c.lineId } };
    case "look":
      return {
        type: "gaze",
        data: { panDeg: c.side === "left" ? -LOOK_PAN_DEG : LOOK_PAN_DEG, tiltDeg: 0 },
      };
    case "lantern": {
      const level = clamp(finiteOrZero(c.level), 0, 1);
      // Clamp seconds first so a huge finite value cannot overflow to Infinity.
      const fadeS = clamp(finiteOrZero(c.fadeS), 0, MAX_FADE_MS / 1000);
      const fadeMs = clamp(Math.round(fadeS * 1000), 0, MAX_FADE_MS);
      return { type: "lantern", data: { level, fadeMs } };
    }
    case "mode":
      return { type: "mode.set", data: { mode: c.mode } };
  }
}
