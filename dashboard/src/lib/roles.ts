// Capabilities per role (docs/schema.md role matrix). Pure: no React, no network.
// The role comes only from `GET /me`; a signed-in user whose role is not known yet is a visitor.

export type Role = "visitor" | "reviewer" | "family";

export interface Capabilities {
  /** `POST /simulate` against the live cloud. */
  liveCloud: boolean;
  /** `GET /device/status`. */
  deviceStatus: boolean;
  /** `GET /encounters` real list (family: full, reviewer: redacted). */
  realTimeline: boolean;
  /** `POST /commands`. */
  controls: boolean;
  /** `/faces` routes. */
  faces: boolean;
  /** Which image reference a real encounter may show. */
  snapshot: "none" | "url" | "illustration";
}

const VISITOR: Capabilities = {
  liveCloud: false,
  deviceStatus: false,
  realTimeline: false,
  controls: false,
  faces: false,
  snapshot: "none",
};

const REVIEWER: Capabilities = {
  liveCloud: true,
  deviceStatus: true,
  realTimeline: true,
  controls: false,
  faces: false,
  snapshot: "illustration",
};

const FAMILY: Capabilities = {
  liveCloud: true,
  deviceStatus: true,
  realTimeline: true,
  controls: true,
  faces: true,
  snapshot: "url",
};

/** Returns a fresh copy, so callers cannot mutate the shared tables. */
export function capabilities(role: Role): Capabilities {
  switch (role) {
    case "family":
      return { ...FAMILY };
    case "reviewer":
      return { ...REVIEWER };
    default:
      return { ...VISITOR };
  }
}
