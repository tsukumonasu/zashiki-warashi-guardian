import { COPY } from "../content/copy";
import type { DeviceStatusResponse } from "../lib/api";
import { capabilities, type Role } from "../lib/roles";
import { Locked } from "./Locked";

export interface DevicePanelProps {
  role: Role;
  /** Last successful `GET /device/status` response, or null. */
  response: DeviceStatusResponse | null;
}

function lastSeen(at: string | null): string {
  return at === null ? COPY.device.neverSeen : at;
}

/**
 * Status of the real doll (Requirements 13.2, 13.3, 13.10). A visitor sees a locked panel
 * (Requirement 16.5) and no status is requested for them.
 */
export function DevicePanel({ role, response }: DevicePanelProps) {
  if (!capabilities(role).deviceStatus) {
    return (
      <section className="device-panel" aria-label="The real doll">
        <Locked label="The real doll" explanation={COPY.locked.visitor} />
      </section>
    );
  }

  if (response === null || !response.online) {
    return (
      <section className="device-panel" aria-label="The real doll">
        <p>{COPY.device.asleepOrOutOfReach}</p>
        <p>Last seen: {lastSeen(response?.lastSeenAt ?? null)}</p>
      </section>
    );
  }

  const s = response.status;
  return (
    <section className="device-panel" aria-label="The real doll">
      <p>{COPY.device.awake}</p>
      {s !== null && (
        <dl>
          <dt>State</dt>
          <dd>{s.state}</dd>
          <dt>Pan</dt>
          <dd>{s.panDeg}°</dd>
          <dt>Tilt</dt>
          <dd>{s.tiltDeg}°</dd>
          <dt>Lantern</dt>
          <dd>{s.lantern}</dd>
        </dl>
      )}
      <p>Last seen: {lastSeen(response.lastSeenAt)}</p>
      {s !== null && !s.motionEnabled && <p>{COPY.device.motionOff}</p>}
    </section>
  );
}
