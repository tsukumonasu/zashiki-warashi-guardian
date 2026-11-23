import { COPY } from "../content/copy";
import type { DeviceStatusResponse } from "../lib/api";
import { capabilities, type Role } from "../lib/roles";
import type { State } from "../simulation/types";
import { Locked } from "./Locked";

export interface DevicePanelProps {
  role: Role;
  /** Last successful `GET /device/status` response, or null. */
  response: DeviceStatusResponse | null;
}

/** The last report time in the reader's own time zone, or "never". */
function lastSeen(at: string | null): string {
  if (at === null) return COPY.device.neverSeen;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

/** The doll's activity in words; an unknown value (a newer doll) is shown as it came. */
function activity(state: string): string {
  const states: Readonly<Record<string, string>> = COPY.house.states;
  return states[state as State] ?? state;
}

/** Head angle in words: which way she looks, and how far. 0 is straight ahead. */
function direction(deg: number, negative: string, positive: string): string {
  const rounded = Math.round(deg);
  if (rounded === 0) return COPY.device.center;
  return `${rounded < 0 ? negative : positive} ${Math.abs(rounded)}°`;
}

function lantern(level: number): string {
  return level <= 0 ? COPY.device.lanternOff : `${Math.round(level * 100)}%`;
}

/**
 * Status of the real doll (Requirements 13.2, 13.3, 13.10). A visitor sees a locked panel
 * (Requirement 16.5) and no status is requested for them.
 *
 * Whether the doll is reachable and what she is doing are two separate lines: a connected doll
 * is often asleep, and "awake" next to "sleeping" read as a contradiction.
 */
export function DevicePanel({ role, response }: DevicePanelProps) {
  const d = COPY.device;
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
        <p>{d.outOfReach}</p>
        <p>
          {d.lastSeen}: {lastSeen(response?.lastSeenAt ?? null)}
        </p>
      </section>
    );
  }

  const s = response.status;
  return (
    <section className="device-panel" aria-label="The real doll">
      <p>{d.connected}</p>
      {s !== null && (
        <dl>
          <dt>{d.activity}</dt>
          <dd>{activity(s.state)}</dd>
          <dt>{d.mode}</dt>
          <dd>{s.mode === "sleep" ? d.modeSleep : d.modeGuard}</dd>
          <dt>{d.head}</dt>
          <dd>
            {direction(s.panDeg, d.left, d.right)} / {direction(s.tiltDeg, d.down, d.up)}
          </dd>
          <dt>{d.lantern}</dt>
          <dd>{lantern(s.lantern)}</dd>
        </dl>
      )}
      <p>
        {d.lastSeen}: {lastSeen(response.lastSeenAt)}
      </p>
      {s !== null && !s.motionEnabled && <p>{d.motionOff}</p>}
    </section>
  );
}
