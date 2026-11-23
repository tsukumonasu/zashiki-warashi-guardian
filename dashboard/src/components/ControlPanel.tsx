import { useEffect, useRef, useState } from "react";
import catalog from "../simulation/data/voice-catalog.json";
import { buildCommand, type Control } from "../simulation/controls";
import { COPY } from "../content/copy";
import { capabilities, type Role } from "../lib/roles";
import type { ApiClient } from "../lib/api";
import { Locked } from "./Locked";
import { refusalMessage, watchRefusal } from "../lib/refusal";

export interface ControlPanelProps {
  api: ApiClient;
  role: Role;
  deviceId: string;
  /** Last reported doll state. `sleeping` and `cooldown` refuse look and lantern commands. */
  dollState?: string | null;
  /** Called after a command reached the cloud. */
  onSent?: () => void;
  /** Refusal check timing; tests shorten it. */
  refusalPollMs?: number;
  refusalWaitMs?: number;
}

type Notice =
  | { kind: "none" }
  | { kind: "sent"; deviceOnline: boolean }
  | { kind: "rejected"; code: string }
  | { kind: "failed"; control: Control };

const LINES = [...catalog].sort((a, b) => a.id.localeCompare(b.id));

/**
 * Manual controls for the real doll (Requirement 14).
 *
 * Family members get working controls. Reviewers and visitors see the same controls as
 * `Locked` ones, so nothing here can reach `POST /commands` for them (Requirements 16.1, 16.2).
 * Each activation sends one request. A failure is never retried automatically.
 */
export function ControlPanel({
  api,
  role,
  deviceId,
  dollState = null,
  onSent,
  refusalPollMs,
  refusalWaitMs,
}: ControlPanelProps) {
  const [lineId, setLineId] = useState<string>(LINES[0]?.id ?? "");
  const [level, setLevel] = useState(0.5);
  const [fadeS, setFadeS] = useState(2);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>({ kind: "none" });
  // A ref closes the gap before React re-renders, so a double click sends one request.
  const inFlight = useRef(false);
  // Bumped on each send, so the refusal check of an older command stops by itself.
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  if (!capabilities(role).controls) {
    const why = role === "visitor" ? COPY.locked.visitor : COPY.controls.lockedControls;
    return (
      <section className="control-panel" aria-label="Call the doll">
        <Locked label="Say a line" explanation={why} />
        <Locked label={COPY.controls.lookLeft} explanation={why} />
        <Locked label={COPY.controls.lookRight} explanation={why} />
        <Locked label="Set the lantern" explanation={why} />
        <Locked label={COPY.controls.remoteStart} explanation={why} />
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
    const mine = ++generation.current;
    const result = await api.command(deviceId, buildCommand(control));
    inFlight.current = false;
    if (!alive.current) return;
    setPending(false);
    setNotice(
      result.ok
        ? { kind: "sent", deviceOnline: result.value.deviceOnline }
        : { kind: "failed", control },
    );
    if (!result.ok || !result.value.deviceOnline) return;
    onSent?.();
    // The doll answers a refused command with error.reported; show why instead of "sent".
    const wanted = () => alive.current && mine === generation.current;
    const code = await watchRefusal(api, result.value.id, wanted, refusalPollMs, refusalWaitMs);
    if (code !== null && wanted()) setNotice({ kind: "rejected", code });
  }

  // The doll rejects gaze and lantern while resting (docs/schema.md, command_rejected_state).
  const resting = dollState === "sleeping" || dollState === "cooldown";
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
        <button type="button" disabled={pending || resting} onClick={() => void send({ kind: "look", side: "left" })}>
          {COPY.controls.lookLeft}
        </button>
        <button type="button" disabled={pending || resting} onClick={() => void send({ kind: "look", side: "right" })}>
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
        <button type="button" disabled={pending || resting} onClick={() => void send({ kind: "lantern", level, fadeS })}>
          Set the lantern
        </button>
      </div>

      <div className="control-row">
        <button type="button" disabled={pending} onClick={() => void send({ kind: "mode", mode: "remote" })}>
          {COPY.controls.remoteStart}
        </button>
        <button type="button" disabled={pending} onClick={() => void send({ kind: "mode", mode: "sleep" })}>
          {COPY.controls.sleep}
        </button>
        <button type="button" disabled={pending} onClick={() => void send({ kind: "mode", mode: "guard" })}>
          {COPY.controls.wake}
        </button>
      </div>

      {resting && <p className="control-hint">{COPY.controls.restingHint}</p>}
      {dollState === "remote" && <p className="control-hint">{COPY.controls.remoteHint}</p>}
      <div role="status" aria-live="polite" className="control-notice">
        {notice.kind === "sent" && (notice.deviceOnline ? COPY.controls.sent : COPY.controls.offline)}
        {notice.kind === "rejected" && refusalMessage(notice.code)}
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
