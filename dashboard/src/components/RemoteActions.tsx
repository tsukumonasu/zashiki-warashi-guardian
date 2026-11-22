import { useEffect, useRef, useState, type FormEvent } from "react";
import { COPY } from "../content/copy";
import type { ApiClient, ApiError } from "../lib/api";
import { InfoTip } from "./InfoTip";

export interface RemoteActionsProps {
  api: ApiClient;
  deviceId: string;
  /** Time between two checks for the picture. Tests shorten it. */
  pollMs?: number;
  /** How long to wait for the picture before giving up. Tests shorten it. */
  waitMs?: number;
}

/** Longest text the cloud accepts (`docs/schema.md`, `POST /say`). */
export const SAY_MAX_CHARS = 60;

type PhotoState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "waiting" }
  | { kind: "ready"; url: string }
  | { kind: "timeout" }
  | { kind: "offline" }
  | { kind: "failed"; error: ApiError };

type SayState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; deviceOnline: boolean }
  | { kind: "failed"; error: ApiError };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

function photoMessage(error: ApiError): string {
  if (error.code === "rate_limited") return COPY.remote.limited(error.retryAfterS ?? 60);
  return COPY.remote.photoFailed;
}

function sayMessage(error: ApiError): string {
  if (error.code === "validation_failed") return COPY.remote.sayInvalid;
  if (error.code === "rate_limited") return COPY.remote.limited(error.retryAfterS ?? 60);
  return COPY.remote.sayFailed;
}

/**
 * Remote actions of the real doll, for the family: take one photo and say a typed line.
 *
 * A photo wakes the doll for a moment. The picture is asked for by `POST /photos` and then
 * fetched by polling `GET /photos/{requestId}` until the cloud has it. Nothing is retried
 * automatically. A typed line goes through `POST /say`; the cloud checks it before the doll
 * speaks. Neither request is stored for later: an offline doll never replays them.
 */
export function RemoteActions({ api, deviceId, pollMs = 2000, waitMs = 40_000 }: RemoteActionsProps) {
  const [photo, setPhoto] = useState<PhotoState>({ kind: "idle" });
  const [say, setSay] = useState<SayState>({ kind: "idle" });
  const [text, setText] = useState("");
  const alive = useRef(true);
  // Bumped on each photo request, so a poll of an older request stops by itself.
  const generation = useRef(0);
  const busyPhoto = useRef(false);
  const busySay = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function takePhoto(): Promise<void> {
    if (busyPhoto.current) return;
    busyPhoto.current = true;
    const mine = ++generation.current;
    setPhoto({ kind: "sending" });
    const asked = await api.photoRequest(deviceId);
    if (!alive.current || mine !== generation.current) {
      busyPhoto.current = false;
      return;
    }
    if (!asked.ok) {
      busyPhoto.current = false;
      setPhoto({ kind: "failed", error: asked.error });
      return;
    }
    if (!asked.value.deviceOnline) {
      // The request was sent once and is never replayed, so waiting would only mislead.
      busyPhoto.current = false;
      setPhoto({ kind: "offline" });
      return;
    }
    setPhoto({ kind: "waiting" });
    const deadline = Date.now() + waitMs;
    while (alive.current && mine === generation.current && Date.now() < deadline) {
      await sleep(pollMs);
      if (!alive.current || mine !== generation.current) break;
      const status = await api.photo(asked.value.requestId);
      if (!alive.current || mine !== generation.current) break;
      if (status.ok && status.value.status === "ready") {
        busyPhoto.current = false;
        setPhoto({ kind: "ready", url: status.value.url });
        return;
      }
    }
    busyPhoto.current = false;
    if (alive.current && mine === generation.current) setPhoto({ kind: "timeout" });
  }

  async function submitSay(event: FormEvent): Promise<void> {
    event.preventDefault();
    const line = text.trim();
    if (line === "" || busySay.current) return;
    busySay.current = true;
    setSay({ kind: "sending" });
    const result = await api.say(deviceId, line);
    busySay.current = false;
    if (!alive.current) return;
    if (result.ok) {
      setSay({ kind: "sent", deviceOnline: result.value.deviceOnline });
      setText("");
    } else {
      setSay({ kind: "failed", error: result.error });
    }
  }

  const photoBusy = photo.kind === "sending" || photo.kind === "waiting";
  return (
    <section className="remote-actions" aria-labelledby="remote-heading">
      <h2 id="remote-heading">{COPY.remote.heading}</h2>

      <div className="remote-card">
        <h3>
          {COPY.remote.photoHeading}
          <InfoTip text={COPY.remote.photoTip} />
        </h3>
        <p className="remote-card__note">{COPY.remote.photoNote}</p>
        <button type="button" className="button" disabled={photoBusy} onClick={() => void takePhoto()}>
          {photoBusy ? COPY.remote.photoWaiting : COPY.remote.photoButton}
        </button>
        <div role="status" aria-live="polite" className="remote-card__status">
          {photo.kind === "timeout" && COPY.remote.photoTimeout}
          {photo.kind === "offline" && COPY.remote.offline}
          {photo.kind === "failed" && photoMessage(photo.error)}
          {photo.kind === "ready" && COPY.remote.photoReady}
        </div>
        {photo.kind === "ready" && (
          <img className="remote-card__photo" src={photo.url} alt={COPY.remote.photoAlt} width={640} height={480} />
        )}
      </div>

      <form className="remote-card" onSubmit={(e) => void submitSay(e)}>
        <h3>
          {COPY.remote.sayHeading}
          <InfoTip text={COPY.remote.sayTip} />
        </h3>
        <label>
          {COPY.remote.sayLabel}
          <input
            type="text"
            lang="ja"
            value={text}
            maxLength={SAY_MAX_CHARS}
            onChange={(e) => setText(e.target.value)}
            disabled={say.kind === "sending"}
            autoComplete="off"
          />
        </label>
        <p className="remote-card__note">{COPY.remote.sayWarning}</p>
        <button
          type="submit"
          className="button"
          disabled={say.kind === "sending" || text.trim() === ""}
        >
          {COPY.remote.sayButton}
        </button>
        <div role="status" aria-live="polite" className="remote-card__status">
          {say.kind === "sent" && (say.deviceOnline ? COPY.remote.saySent : COPY.remote.offline)}
          {say.kind === "failed" && sayMessage(say.error)}
        </div>
      </form>
    </section>
  );
}
