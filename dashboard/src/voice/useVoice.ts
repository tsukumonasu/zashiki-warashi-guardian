/**
 * React hook around `VoiceClient`. `start` must run inside a click handler so the browser lets the
 * microphone and the audio context start. The session ends on `stop`, on unmount and when the tab
 * closes (`pagehide`), each time with `bye` and `DELETE /conversations/{id}`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api";
import type { SchemaMessage } from "../simulation/types";
import { createBrowserAudio, type AudioIO } from "./browserAudio";
import type { EndReason, LookVerdict } from "./frames";
import { WebSocketTransport, type VoiceTransport } from "./transport";
import { VoiceClient, type VoiceError, type VoiceUiState } from "./VoiceClient";

export interface Subtitle {
  role: "user" | "assistant";
  text: string;
  final: boolean;
}

export interface UseVoiceOptions {
  api: Pick<ApiClient, "startConversation" | "endConversation">;
  deviceId: string;
  /** Receives every `command` frame; wire it to the simulation reducer. */
  onCommand?: (envelope: SchemaMessage) => void;
  /** The simulated answer to a virtual `snapshot.request`. */
  lookVerdict?: (requestId: string) => LookVerdict;
  /** Injected for tests. */
  createTransport?: () => VoiceTransport;
  createAudio?: () => AudioIO;
}

export interface UseVoice {
  state: VoiceUiState;
  error: VoiceError | null;
  endReason: EndReason | null;
  /** The latest subtitle per role; a final line replaces the partial one. */
  subtitle: Subtitle | null;
  start(target: "real" | "virtual"): void;
  stop(): void;
}

export function useVoice(options: UseVoiceOptions): UseVoice {
  const [state, setState] = useState<VoiceUiState>("idle");
  const [error, setError] = useState<VoiceError | null>(null);
  const [endReason, setEndReason] = useState<EndReason | null>(null);
  const [subtitle, setSubtitle] = useState<Subtitle | null>(null);
  const clientRef = useRef<VoiceClient | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stop = useCallback((): void => {
    const client = clientRef.current;
    // The client reports no end frame for a stop the user asked for, so record the reason here.
    if (client !== null && client.state !== "idle" && client.state !== "failed") setEndReason("user");
    void client?.stop();
  }, []);

  const start = useCallback((target: "real" | "virtual"): void => {
    const o = optionsRef.current;
    const client = new VoiceClient({
      api: o.api,
      deviceId: o.deviceId,
      transport: o.createTransport?.() ?? new WebSocketTransport(),
      createAudio: o.createAudio ?? createBrowserAudio,
      lookVerdict: (id) => optionsRef.current.lookVerdict?.(id) ?? "uncertain",
    });
    client.onStateChange((s) => {
      setState(s);
      setError(client.error);
    });
    client.onTranscript((role, text, final) => setSubtitle({ role, text, final }));
    client.onCommand((envelope) => optionsRef.current.onCommand?.(envelope));
    client.onEnd((reason) => setEndReason(reason));
    clientRef.current = client;
    setSubtitle(null);
    setEndReason(null);
    setError(null);
    void client.start({ target });
  }, []);

  useEffect(() => {
    const closing = (): void => {
      void clientRef.current?.stop();
    };
    window.addEventListener("pagehide", closing);
    return () => {
      window.removeEventListener("pagehide", closing);
      closing();
    };
  }, []);

  return { state, error, endReason, subtitle, start, stop };
}
