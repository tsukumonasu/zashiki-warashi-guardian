/**
 * Browser voice session client (design: "Dashboard (`dashboard/src/voice`)").
 *
 * `start` asks `POST /conversations`, opens the AppSync Events socket, subscribes, says `hello` and
 * (for a browser session) streams the microphone as 100 ms `audio` frames and plays the model's
 * 24 kHz speech back to back. A session with the real doll (`target: "real"`) is watch-only:
 * the doll is the audio client and the browser subscribes `text` with the observer token.
 *
 * Tokens are secrets: nothing here logs them or puts them in an error. The client talks to the
 * network and the audio hardware only through `VoiceTransport` and `AudioIO`, so tests use fakes.
 */
import type { ApiClient, ApiErrorCode } from "../lib/api";
import type { SchemaMessage } from "../simulation/types";
import { base64ToPcm16, makeReorder, pcm16ToBase64 } from "./audio";
import type { AudioIO } from "./browserAudio";
import {
  connectionInit,
  parseServerMessage,
  publish,
  realtimeUrl,
  subprotocols,
  subscribe,
  type ServerMessage,
} from "./appsync";
import {
  decodeOut,
  decodeText,
  encodeIn,
  type ByeReason,
  type EndReason,
  type InFrame,
  type LookVerdict,
} from "./frames";
import type { VoiceTransport } from "./transport";

export type VoiceUiState = "idle" | "starting" | "listening" | "speaking" | "ending" | "failed";

/** Why a session failed, for the panel to word. */
export type VoiceError = ApiErrorCode | "microphone" | "connection";

export interface VoiceClientDeps {
  api: Pick<ApiClient, "startConversation" | "endConversation">;
  transport: VoiceTransport;
  /** Called inside `start`, which the caller runs from a click (browsers need a user gesture). */
  createAudio: () => AudioIO;
  deviceId: string;
  /** The simulated answer to a virtual `snapshot.request`. Defaults to `uncertain`. */
  lookVerdict?: (requestId: string) => LookVerdict;
  /** How long the socket handshake may take. */
  handshakeTimeoutMs?: number;
  reorderWindow?: number;
}

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const REORDER_WINDOW = 8;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

type Waiter = (m: ServerMessage) => boolean;

export class VoiceClient {
  private current: VoiceUiState = "idle";
  private errorValue: VoiceError | null = null;
  private endReasonValue: EndReason | null = null;
  private sessionId: string | null = null;
  private audio: AudioIO | null = null;
  private opened = false;
  private pubCount = 0;
  private seq = 0;
  private streamSessions = 0;

  private stateCb: (state: VoiceUiState) => void = () => undefined;
  private transcriptCb: (role: "user" | "assistant", text: string, final: boolean) => void = () => undefined;
  private commandCb: (envelope: SchemaMessage) => void = () => undefined;
  private endCb: (reason: EndReason) => void = () => undefined;

  private waiters: Waiter[] = [];
  private subs = new Map<string, "out" | "text">();
  private httpHost = "";
  private clientToken = "";
  private channelIn = "";
  private reorder = makeReorder(REORDER_WINDOW);
  private isBrowserClient = false;

  constructor(private readonly deps: VoiceClientDeps) {}

  get state(): VoiceUiState {
    return this.current;
  }
  get error(): VoiceError | null {
    return this.errorValue;
  }
  get endReason(): EndReason | null {
    return this.endReasonValue;
  }

  onStateChange(cb: (state: VoiceUiState) => void): void {
    this.stateCb = cb;
  }
  onTranscript(cb: (role: "user" | "assistant", text: string, final: boolean) => void): void {
    this.transcriptCb = cb;
  }
  /** Wired to the simulation reducer by the caller. */
  onCommand(cb: (envelope: SchemaMessage) => void): void {
    this.commandCb = cb;
  }
  onEnd(cb: (reason: EndReason) => void): void {
    this.endCb = cb;
  }

  private setState(next: VoiceUiState): void {
    if (this.current === next) return;
    this.current = next;
    this.stateCb(next);
  }

  private fail(error: VoiceError): void {
    this.errorValue = error;
    this.teardown();
    const id = this.sessionId;
    this.sessionId = null;
    if (id !== null) void this.deps.api.endConversation(id);
    this.setState("failed");
  }

  async start(opts: { target: "real" | "virtual" }): Promise<void> {
    if (this.current !== "idle" && this.current !== "failed") return;
    this.errorValue = null;
    this.endReasonValue = null;
    this.reorder = makeReorder(this.deps.reorderWindow ?? REORDER_WINDOW);
    this.seq = 0;
    this.setState("starting");
    const generation = ++this.streamSessions;
    const alive = (): boolean => this.streamSessions === generation && this.current === "starting";

    // The doll is the audio client for a real-doll session; the browser only watches.
    const client = opts.target === "real" ? "device" : "browser";
    this.isBrowserClient = client === "browser";
    if (this.isBrowserClient) this.audio = this.deps.createAudio();

    const started = await this.deps.api.startConversation({
      deviceId: this.deps.deviceId,
      client,
      target: opts.target,
    });
    if (!alive()) {
      if (started.ok) void this.deps.api.endConversation(started.value.sessionId);
      return;
    }
    if (!started.ok) {
      this.errorValue = started.error.code;
      this.teardown();
      this.setState("failed");
      return;
    }
    const session = started.value;
    this.sessionId = session.sessionId;
    this.httpHost = session.hosts.http;
    const token = "clientToken" in session ? session.clientToken : session.observerToken;
    this.clientToken = token;
    this.channelIn = session.channels.in;

    try {
      this.deps.transport.onMessage((m) => this.onSocketMessage(m));
      this.deps.transport.onClose(() => this.onSocketClose());
      await this.deps.transport.open(realtimeUrl(session.hosts.realtime), subprotocols(this.httpHost, token));
      this.opened = true;
      if (!alive()) return;
      await this.handshake(session.channels, token);
      if (!alive()) return;
      if (this.isBrowserClient) {
        this.send({ t: "hello", client: "browser", v: 1 }, session.channels.in, token);
        await this.startMicrophone(session.channels.in, token);
        if (!alive()) return;
      }
      this.setState("listening");
    } catch (err) {
      if (!alive()) return;
      this.fail(err instanceof MicrophoneError ? "microphone" : "connection");
    }
  }

  private async startMicrophone(channelIn: string, token: string): Promise<void> {
    const audio = this.audio;
    if (audio === null) return;
    audio.onPlayback((playing) => {
      if (this.current === "listening" || this.current === "speaking") {
        this.setState(playing ? "speaking" : "listening");
      }
    });
    try {
      await audio.startCapture((chunk) => {
        if (this.current !== "listening" && this.current !== "speaking") return;
        const frame: InFrame = { t: "audio", seq: this.seq++, pcm: pcm16ToBase64(chunk) };
        this.send(frame, channelIn, token);
      });
    } catch {
      throw new MicrophoneError();
    }
  }

  /** Sends `connection_init`, waits for the ack, then subscribes and waits for each success. */
  private async handshake(
    channels: { in: string; out: string; text: string },
    token: string,
  ): Promise<void> {
    const timeoutMs = this.deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const ack = this.expect((m) => m.kind === "ack", timeoutMs);
    this.deps.transport.send(connectionInit());
    await ack;

    const wanted: ["out" | "text", string][] = this.isBrowserClient
      ? [
          ["out", channels.out],
          ["text", channels.text],
        ]
      : [["text", channels.text]];
    for (const [kind, channel] of wanted) {
      const id = `s-${kind}`;
      this.subs.set(id, kind);
      const done = this.expect((m) => m.kind === "subscribed" && m.id === id, timeoutMs);
      this.deps.transport.send(subscribe(id, channel, this.httpHost, token));
      await done;
    }
  }

  /** Resolves on the first server message the predicate accepts; rejects on an error message or timeout. */
  private expect(match: (m: ServerMessage) => boolean, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error("The voice handshake timed out."));
      }, timeoutMs);
      const waiter: Waiter = (m) => {
        if (m.kind === "rejected") {
          clearTimeout(timer);
          reject(new Error("The voice service refused the connection."));
          return true;
        }
        if (!match(m)) return false;
        clearTimeout(timer);
        resolve();
        return true;
      };
      this.waiters.push(waiter);
    });
  }

  private send(frame: InFrame, channel: string, token: string): void {
    this.pubCount += 1;
    try {
      this.deps.transport.send(
        publish(`p-${this.pubCount}`, channel, [encodeIn(frame)], this.httpHost, token),
      );
    } catch {
      // A failed send surfaces as a closed socket.
    }
  }

  private onSocketMessage(raw: string): void {
    const m = parseServerMessage(raw);
    const waiting = this.waiters.find((w) => w(m));
    if (waiting !== undefined) {
      this.waiters = this.waiters.filter((w) => w !== waiting);
      return;
    }
    if (m.kind !== "data") return;
    const channel = this.subs.get(m.id);
    if (channel === undefined) return;
    for (const event of m.events) {
      if (channel === "out") this.onOutFrame(event);
      else this.onTextFrame(event);
    }
  }

  private onOutFrame(raw: string): void {
    const r = decodeOut(raw);
    if (r.kind !== "valid") return;
    const frame = r.frame;
    if (frame.t === "audio") {
      for (const part of this.reorder.push(frame.seq, frame.pcm)) {
        const pcm = base64ToPcm16(part.pcm);
        if (pcm !== null) this.audio?.play(pcm);
      }
    } else if (frame.t === "interrupt") {
      this.audio?.stopPlayback();
    } else {
      this.onCommandFrame(frame.envelope);
    }
  }

  private onCommandFrame(envelope: SchemaMessage): void {
    this.commandCb(envelope);
    if (envelope.type !== "snapshot.request") return;
    const requestId = (envelope.data as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string" || !ID_RE.test(requestId)) return;
    const verdict = this.deps.lookVerdict?.(requestId) ?? "uncertain";
    this.send({ t: "look.result", requestId, verdict }, this.channelIn, this.clientToken);
  }

  private onTextFrame(raw: string): void {
    const r = decodeText(raw);
    if (r.kind !== "valid") return;
    const frame = r.frame;
    if (frame.t === "transcript") {
      this.transcriptCb(frame.role, frame.text, frame.final);
    } else if (frame.t === "state") {
      if (frame.state === "live" && this.current === "starting") this.setState("listening");
      if (frame.state === "ending") this.setState("ending");
    } else {
      this.endReasonValue = frame.reason;
      this.sessionId = null; // the session already ended on the server
      this.teardown();
      this.setState("idle");
      this.endCb(frame.reason);
    }
  }

  private onSocketClose(): void {
    if (this.current === "idle" || this.current === "failed") return;
    this.fail("connection");
  }

  /** Stops the microphone, the playback and the socket. Safe to call twice. */
  private teardown(): void {
    this.waiters = [];
    this.audio?.close();
    this.audio = null;
    this.deps.transport.close();
    this.opened = false;
    this.subs.clear();
  }

  /**
   * Ends the session: `bye`, stop capture, close the socket, then `DELETE /conversations/{id}`.
   * The local work runs before the first await, so it also completes when a closing tab calls this.
   */
  async stop(): Promise<void> {
    if (this.current === "idle" || this.current === "failed") return;
    const id = this.sessionId;
    this.sessionId = null;
    this.streamSessions += 1; // abandons a start that is still in flight
    this.setState("ending");
    if (this.isBrowserClient && this.opened) {
      const reason: ByeReason = "user";
      this.send({ t: "bye", reason }, this.channelIn, this.clientToken);
    }
    this.teardown();
    this.endReasonValue = "user";
    const pending = id === null ? Promise.resolve() : this.deps.api.endConversation(id);
    this.setState("idle");
    await pending;
  }
}

class MicrophoneError extends Error {}
