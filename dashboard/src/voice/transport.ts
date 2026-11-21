/**
 * The WebSocket slice the voice client needs, a browser implementation and an in-memory fake.
 * The client speaks the AppSync Events protocol on top (`appsync.ts`); transports only move text.
 * Nothing here logs, so a token in a subprotocol never reaches the console.
 */

export interface VoiceTransport {
  /** Resolves when the socket is open; rejects when it fails or closes first. */
  open(url: string, protocols: string[]): Promise<void>;
  send(message: string): void;
  onMessage(cb: (message: string) => void): void;
  onClose(cb: (code: number) => void): void;
  close(): void;
}

/** The part of `WebSocket` used here, so tests can pass a fake socket. */
export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

const OPEN = 1;
/** Close code used when the socket never opened. */
export const CLOSE_ABNORMAL = 1006;

export class WebSocketTransport implements VoiceTransport {
  private socket: SocketLike | null = null;
  private messageCb: (message: string) => void = () => undefined;
  private closeCb: (code: number) => void = () => undefined;

  constructor(
    private readonly create: (url: string, protocols: string[]) => SocketLike = (url, protocols) =>
      new WebSocket(url, protocols) as unknown as SocketLike,
  ) {}

  open(url: string, protocols: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let socket: SocketLike;
      try {
        socket = this.create(url, protocols);
      } catch {
        reject(new Error("The voice connection could not be created."));
        return;
      }
      this.socket = socket;
      let opened = false;
      socket.onopen = () => {
        opened = true;
        resolve();
      };
      socket.onmessage = (ev) => {
        if (typeof ev.data === "string") this.messageCb(ev.data);
      };
      socket.onerror = () => {
        if (!opened) reject(new Error("The voice connection failed."));
      };
      socket.onclose = (ev) => {
        if (!opened) reject(new Error("The voice connection closed."));
        else this.closeCb(ev.code);
      };
    });
  }

  send(message: string): void {
    if (this.socket !== null && this.socket.readyState === OPEN) this.socket.send(message);
  }

  onMessage(cb: (message: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (code: number) => void): void {
    this.closeCb = cb;
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    // Detach first: a deliberate close is not reported as a server close.
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000);
    } catch {
      // Already closed.
    }
  }
}

export interface FakeVoiceTransportOptions {
  /** Make `open` reject. */
  failOpen?: boolean;
  /**
   * Answer like AppSync: `connection_ack` for `connection_init`, `subscribe_success` for each
   * `subscribe` and `publish_success` for each `publish` (default true). The reply comes in a
   * microtask, after `send` returns.
   */
  autoServer?: boolean;
  /** Subscribe ids to answer with `subscribe_error` instead of `subscribe_success`. */
  rejectChannels?: readonly string[];
}

/** In-memory transport for tests: records what the client sends and lets a test play the server. */
export class FakeVoiceTransport implements VoiceTransport {
  url: string | null = null;
  protocols: string[] = [];
  readonly sent: string[] = [];
  closed = false;
  private messageCb: (message: string) => void = () => undefined;
  private closeCb: (code: number) => void = () => undefined;

  constructor(private readonly options: FakeVoiceTransportOptions = {}) {}

  open(url: string, protocols: string[]): Promise<void> {
    this.url = url;
    this.protocols = protocols;
    return this.options.failOpen === true
      ? Promise.reject(new Error("The voice connection failed."))
      : Promise.resolve();
  }

  send(message: string): void {
    if (this.closed) return;
    this.sent.push(message);
    if (this.options.autoServer === false) return;
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed !== "object" || parsed === null) return;
    const m = parsed as Record<string, unknown>;
    let reply: Record<string, unknown> | null = null;
    if (m.type === "connection_init") reply = { type: "connection_ack", connectionTimeoutMs: 300000 };
    else if (m.type === "subscribe") {
      reply = this.options.rejectChannels?.includes(String(m.channel))
        ? { type: "subscribe_error", id: m.id, errors: [{ errorType: "UnauthorizedException" }] }
        : { type: "subscribe_success", id: m.id };
    } else if (m.type === "publish") reply = { type: "publish_success", id: m.id };
    if (reply !== null) {
      const text = JSON.stringify(reply);
      queueMicrotask(() => this.receive(text));
    }
  }

  onMessage(cb: (message: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (code: number) => void): void {
    this.closeCb = cb;
  }

  close(): void {
    this.closed = true;
  }

  // ---- Test helpers: play the server ----

  /** Delivers a raw text message to the client. */
  receive(message: string): void {
    if (!this.closed) this.messageCb(message);
  }

  /** Delivers an AppSync `data` message carrying one published frame on a subscription. */
  receiveData(subscriptionId: string, frame: string): void {
    this.receive(JSON.stringify({ type: "data", id: subscriptionId, event: [frame] }));
  }

  /** The server (or the network) closes the socket. */
  serverClose(code = 1000): void {
    this.closed = true;
    this.closeCb(code);
  }

  /** Every decoded message the client sent, parsed. */
  sentMessages(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  /** The subscription id the client used for a channel, or null. */
  subscriptionId(channel: string): string | null {
    const m = this.sentMessages().find((x) => x.type === "subscribe" && x.channel === channel);
    return m === undefined ? null : String(m.id);
  }

  /** Frames the client published to a channel, parsed from their JSON strings. */
  published(channel: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const m of this.sentMessages()) {
      if (m.type !== "publish" || m.channel !== channel || !Array.isArray(m.events)) continue;
      for (const e of m.events) out.push(JSON.parse(String(e)) as Record<string, unknown>);
    }
    return out;
  }
}
