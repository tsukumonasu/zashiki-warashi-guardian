import { useRef } from "react";
import { COPY } from "../content/copy";
import type { ApiClient, VoiceInfo } from "../lib/api";
import type { Role } from "../lib/roles";
import type { SchemaMessage } from "../simulation/types";
import type { AudioIO } from "../voice/browserAudio";
import type { LookVerdict } from "../voice/frames";
import type { VoiceTransport } from "../voice/transport";
import type { VoiceError } from "../voice/VoiceClient";
import { useVoice } from "../voice/useVoice";

export interface TalkPanelProps {
  api: Pick<ApiClient, "startConversation" | "endConversation">;
  role: Role;
  deviceId: string;
  /** `voice` of `GET /me`; null or undefined when the cloud did not report it. */
  voice: VoiceInfo | null | undefined;
  /** False while the browser is offline. Default true. */
  online?: boolean;
  /** Receives every `command` frame for the virtual doll. */
  onCommand?: (envelope: SchemaMessage) => void;
  lookVerdict?: (requestId: string) => LookVerdict;
  /** Injected for tests. */
  createTransport?: () => VoiceTransport;
  createAudio?: () => AudioIO;
}

/** Why the Talk button is disabled, or null when talking is allowed (Requirement 13.10). */
export function disabledReason(role: Role, voice: VoiceInfo | null | undefined, online: boolean): string | null {
  if (role === "visitor") return COPY.talk.disabled.visitor;
  if (!online) return COPY.talk.disabled.offline;
  if (voice === null || voice === undefined) return COPY.talk.disabled.unknown;
  if (!voice.enabled) return COPY.talk.disabled.off;
  if (voice.remainingToday <= 0) return COPY.talk.disabled.none;
  return null;
}

function errorText(error: VoiceError): string {
  switch (error) {
    case "rate_limited":
    case "session_active":
    case "voice_unavailable":
    case "forbidden":
    case "unauthorized":
    case "microphone":
    case "connection":
      return COPY.talk.errors[error];
    default:
      return COPY.talk.errors.other;
  }
}

/**
 * Talk button, microphone indicator, live subtitles and the end reason (Requirements 13.7 to 13.12).
 *
 * The browser's microphone indicator shows only while this page captures audio (a `virtual`
 * session). A `real` session is watch-only: the doll's own microphone is shown by the header
 * indicator. Subtitles come from the session as sent and carry no names.
 */
export function TalkPanel({
  api,
  role,
  deviceId,
  voice,
  online = true,
  onCommand,
  lookVerdict,
  createTransport,
  createAudio,
}: TalkPanelProps) {
  const session = useVoice({ api, deviceId, onCommand, lookVerdict, createTransport, createAudio });
  const lastTarget = useRef<"real" | "virtual">("virtual");
  const { state, error, endReason, subtitle } = session;

  const busy = state === "starting" || state === "listening" || state === "speaking" || state === "ending";
  const reason = disabledReason(role, voice, online);
  const blocked = reason !== null;
  const capturing = state === "listening" || state === "speaking";
  // Remember which button started the session so the panel words the status correctly.
  const watchOnly = capturing && lastTarget.current === "real";

  return (
    <section className="talk-panel" aria-labelledby="talk-heading">
      <h2 id="talk-heading">{COPY.talk.heading}</h2>
      <p className="talk-panel__notice">{COPY.talk.notice}</p>

      {!busy && (
        <div className="talk-panel__actions">
          <button
            type="button"
            className="button"
            disabled={blocked}
            aria-describedby={blocked ? "talk-reason" : undefined}
            onClick={() => {
              lastTarget.current = "virtual";
              session.start("virtual");
            }}
          >
            {COPY.talk.talk}
          </button>
          {role === "family" && (
            <button
              type="button"
              className="button"
              disabled={blocked}
              aria-describedby={blocked ? "talk-reason" : undefined}
              onClick={() => {
                lastTarget.current = "real";
                session.start("real");
              }}
            >
              {COPY.talk.talkReal}
            </button>
          )}
        </div>
      )}
      {blocked && (
        <p id="talk-reason" className="talk-panel__reason">
          {reason}
        </p>
      )}
      {!blocked && voice && !busy && (
        <p className="talk-panel__remaining">{COPY.talk.remainingToday(voice.remainingToday)}</p>
      )}

      {busy && (
        <div className="talk-panel__live">
          {capturing && !watchOnly && (
            <p className="talk-panel__mic" role="status" data-testid="talk-mic-on">
              <span aria-hidden="true">● </span>
              {COPY.talk.micOn}
            </p>
          )}
          {watchOnly && <p role="status">{COPY.talk.watching}</p>}
          {state === "starting" && <p role="status">{COPY.talk.starting}</p>}
          {state === "ending" && <p role="status">{COPY.talk.ending}</p>}
          <button type="button" className="button" disabled={state === "ending"} onClick={session.stop}>
            {COPY.talk.stop}
          </button>
        </div>
      )}

      <div className="talk-panel__subtitles" role="log" aria-live="polite" aria-label={COPY.talk.subtitlesLabel}>
        {subtitle !== null && (
          <p data-role={subtitle.role} data-final={subtitle.final}>
            <strong>{subtitle.role === "user" ? COPY.talk.you : COPY.talk.doll}: </strong>
            <span lang="ja">{subtitle.text}</span>
          </p>
        )}
      </div>

      <div role="status" className="talk-panel__result">
        {state === "failed" && error !== null && <p>{errorText(error)}</p>}
        {state === "idle" && endReason !== null && <p>{COPY.talk.ended[endReason]}</p>}
      </div>
    </section>
  );
}
