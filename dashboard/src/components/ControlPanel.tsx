import { useRef, useState } from "react";
import catalog from "../simulation/data/voice-catalog.json";
import { buildCommand, type Control } from "../simulation/controls";
import { COPY } from "../content/copy";
import { capabilities, type Role } from "../lib/roles";
import type { ApiClient } from "../lib/api";
import { Locked } from "./Locked";

export interface ControlPanelProps {
  api: ApiClient;
  role: Role;
  deviceId: string;
}

type Notice =
  | { kind: "none" }
  | { kind: "sent"; deviceOnline: boolean }
  | { kind: "failed"; control: Control };

const LINES = [...catalog].sort((a, b) => a.id.localeCompare(b.id));

/**
 * Manual controls for the real doll (Requirement 14).
 *
 * Family members get working controls. Reviewers and visitors see the same controls as
 * `Locked` ones, so nothing here can reach `POST /commands` for them (Requirements 16.1, 16.2).
 * Each activation sends one request. A failure is never retried automatically.
 */
export function ControlPanel({ api, role, deviceId }: ControlPanelProps) {
  const [lineId, setLineId] = useState<string>(LINES[0]?.id ?? "");
  const [level, setLevel] = useState(0.5);
  const [fadeS, setFadeS] = useState(2);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>({ kind: "none" });
  // A ref closes the gap before React re-renders, so a double click sends one request.
  const inFlight = useRef(false);

  if (!capabilities(role).controls) {
    const why = role === "visitor" ? COPY.locked.visitor : COPY.controls.lockedControls;
    return (
      <section className="control-panel" aria-label="Call the doll">
        <Locked label="Say a line" explanation={why} />
        <Locked label={COPY.controls.lookLeft} explanation={why} />
        <Locked label={COPY.controls.lookRight} explanation={why} />
        <Locked label="Set the lantern" explanation={why} />
        <Locked label={COPY.controls.sleep} explanation={why} />
        <Locked label={COPY.controls.wake} explanation={why} />
      </section>
    );
  }

  async function send(control: Control): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setNotice({ kind: "none" });
    const result = await api.command(deviceId, buildCommand(control));
    inFlight.current = false;
    setPending(false);
    setNotice(
      result.ok
        ? { kind: "sent", deviceOnline: result.value.deviceOnline }
        : { kind: "failed", control },
    );
  }

  const lastFailed = notice.kind === "failed" ? notice.control : null;

  return (
    <section className="control-panel" aria-label="Call the doll">
      <div className="control-row">
        <label>
          Line
          <select value={lineId} onChange={(e) => setLineId(e.target.value)} disabled={pending}>
            {LINES.map((line) => (
              <option key={line.id} value={line.id}>
                {`${line.id}: ${line.ja} / ${line.en}`}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={pending || lineId === ""} onClick={() => void send({ kind: "speak", lineId })}>
          Say it
        </button>
      </div>

      <div className="control-row">
        <button type="button" disabled={pending} onClick={() => void send({ kind: "look", side: "left" })}>
          {COPY.controls.lookLeft}
        </button>
        <button type="button" disabled={pending} onClick={() => void send({ kind: "look", side: "right" })}>
          {COPY.controls.lookRight}
        </button>
      </div>

      <div className="control-row">
        <label>
          Lantern level
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
          />
        </label>
        <label>
          Fade (seconds)
          <input
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={fadeS}
            onChange={(e) => setFadeS(Number(e.target.value))}
          />
        </label>
        <button type="button" disabled={pending} onClick={() => void send({ kind: "lantern", level, fadeS })}>
          Set the lantern
        </button>
      </div>

      <div className="control-row">
        <button type="button" disabled={pending} onClick={() => void send({ kind: "mode", mode: "sleep" })}>
          {COPY.controls.sleep}
        </button>
        <button type="button" disabled={pending} onClick={() => void send({ kind: "mode", mode: "guard" })}>
          {COPY.controls.wake}
        </button>
      </div>

      <div role="status" aria-live="polite" className="control-notice">
        {notice.kind === "sent" && (notice.deviceOnline ? COPY.controls.sent : COPY.controls.offline)}
        {lastFailed !== null && (
          <>
            <span>The command could not be sent. </span>
            <button type="button" disabled={pending} onClick={() => void send(lastFailed)}>
              {COPY.controls.tryAgain}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
