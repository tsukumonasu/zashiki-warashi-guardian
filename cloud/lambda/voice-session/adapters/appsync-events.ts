/**
 * `VoiceChannel` over AWS AppSync Events with IAM (SigV4) authorization.
 *
 * - Subscribe: one WebSocket to the real-time endpoint. The SigV4 headers travel in the
 *   `header-<base64url JSON>` subprotocol next to `aws-appsync-event-ws`; then `connection_init`,
 *   `connection_ack`, `subscribe` for `/voice/<sid>/in`. A silent connection (no message within
 *   `connectionTimeoutMs`) is closed.
 * - Publish: HTTP POST to `/event`, at most 5 events per request and at most 10 requests per
 *   second (the service allows 25 per connection; the margin leaves room for retries).
 *
 * Why HTTP for publishing: one failed publish then never disturbs the subscription connection.
 *
 * Nothing here logs frames or tokens; an error carries only a short fixed message.
 * Verified against the AppSync Events WebSocket protocol page (design, "Region and service facts").
 */
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";
import type { VoiceChannel } from "../../_shared/voice/ports.js";

/**
 * An error whose `name` tells the log reader which step failed (for example `AppSyncPublish403`).
 * The session runner logs only `err.name`, so the name carries the reason. It never holds a body,
 * a token or a frame.
 */
export function appSyncError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** Events per publish request, a service limit. */
export const MAX_EVENTS_PER_PUBLISH = 5;
/** At most 10 publish requests per second, so at least 100 ms between two request starts. */
export const MIN_PUBLISH_INTERVAL_MS = 100;
/** Time allowed for the connection, `connection_ack` and `subscribe_success`. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** Time allowed for one publish request. */
export const PUBLISH_TIMEOUT_MS = 5_000;
export const SUBPROTOCOL = "aws-appsync-event-ws";

/** The few WebSocket members used here; the Node.js global `WebSocket` provides them. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data?: unknown }) => void): void;
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

export interface AppSyncOptions {
  /** HTTP host of the Events API (`<id>.appsync-api.<region>.amazonaws.com`). */
  readonly httpHost: string;
  /** Real-time host (`<id>.appsync-realtime-api.<region>.amazonaws.com`). */
  readonly realtimeHost: string;
  readonly region: string;
  readonly credentials?: AwsCredentialIdentityProvider | AwsCredentialIdentity;
  readonly fetchImpl?: typeof fetch;
  readonly webSocketFactory?: WebSocketFactory;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Base64URL without padding, as the subprotocol needs. */
export function base64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** The IAM `authorization` object (also the content of the subprotocol header). */
export type SignedHeaders = Record<string, string>;

/** Signs `POST https://<httpHost>/event` with `body`, as AppSync Events expects. */
export async function signEventRequest(
  opts: Pick<AppSyncOptions, "httpHost" | "region"> & {
    credentials: AwsCredentialIdentityProvider | AwsCredentialIdentity;
  },
  body: string,
  date?: Date,
): Promise<SignedHeaders> {
  const signer = new SignatureV4({
    credentials: opts.credentials,
    region: opts.region,
    service: "appsync",
    sha256: Sha256,
    applyChecksum: false,
  });
  const request = new HttpRequest({
    method: "POST",
    protocol: "https:",
    hostname: opts.httpHost,
    path: "/event",
    headers: {
      accept: "application/json, text/javascript",
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=UTF-8",
      host: opts.httpHost,
    },
    body,
  });
  const signed = await signer.sign(request, date === undefined ? {} : { signingDate: date });
  const h = signed.headers;
  const out: SignedHeaders = {
    accept: h["accept"] ?? "",
    "content-encoding": h["content-encoding"] ?? "",
    "content-type": h["content-type"] ?? "",
    host: opts.httpHost,
    "x-amz-date": h["x-amz-date"] ?? "",
    Authorization: h["authorization"] ?? h["Authorization"] ?? "",
  };
  const token = h["x-amz-security-token"];
  if (token !== undefined) out["X-Amz-Security-Token"] = token;
  return out;
}

/** The `[SUBPROTOCOL, header-...]` list for the connect handshake. */
export function connectProtocols(headers: SignedHeaders): string[] {
  return [SUBPROTOCOL, `header-${base64Url(JSON.stringify(headers))}`];
}

export function inChannel(sessionId: string): string {
  return `/voice/${sessionId}/in`;
}

/** Splits events into publish batches of at most 5. */
export function batches<T>(items: readonly T[], size = MAX_EVENTS_PER_PUBLISH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Single-consumer async queue that can end or fail. */
function makeQueue<T>(): {
  iterable: AsyncIterable<T>;
  push(v: T): void;
  end(): void;
  fail(err: Error): void;
} {
  const items: T[] = [];
  let ended = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const notify = (): void => wake?.();
  return {
    push(v) {
      if (ended) return;
      items.push(v);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    fail(err) {
      if (!ended) failure = err;
      ended = true;
      notify();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = items.shift();
          if (next !== undefined) {
            yield next;
          } else if (failure !== null) {
            throw failure;
          } else if (ended) {
            return;
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
          }
        }
      },
    },
  };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const defaultFactory: WebSocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as WebSocketLike;

export function createAppSyncChannel(options: AppSyncOptions): VoiceChannel {
  const credentials = options.credentials ?? defaultProvider();
  const fetchImpl = options.fetchImpl ?? fetch;
  const factory = options.webSocketFactory ?? defaultFactory;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const signOpts = { httpHost: options.httpHost, region: options.region, credentials };
  const sockets = new Set<WebSocketLike>();
  let nextAllowedAt = 0;
  let closed = false;

  /** Serializes publish requests and keeps at least 100 ms between two starts. */
  async function waitForSlot(): Promise<void> {
    const wait = nextAllowedAt - now();
    nextAllowedAt = Math.max(now(), nextAllowedAt) + MIN_PUBLISH_INTERVAL_MS;
    if (wait > 0) await sleep(wait);
  }

  async function publishOne(channel: string, events: readonly string[]): Promise<void> {
    await waitForSlot();
    const body = JSON.stringify({ channel, events });
    const headers = await signEventRequest(signOpts, body);
    const { host: _host, ...sendHeaders } = headers;
    void _host;
    const res = await fetchImpl(`https://${options.httpHost}/event`, {
      method: "POST",
      headers: sendHeaders,
      body,
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // The body may echo input, so only the status leaves this function.
      throw appSyncError(`AppSyncPublish${res.status}`, `AppSync publish failed with status ${res.status}`);
    }
    const parsed = (await res.json().catch(() => null)) as { failed?: unknown[] } | null;
    if (parsed !== null && Array.isArray(parsed.failed) && parsed.failed.length > 0) {
      throw appSyncError("AppSyncPublishRejected", "AppSync rejected some events");
    }
  }

  return {
    subscribeIn(sessionId: string): AsyncIterable<string> {
      const queue = makeQueue<string>();
      const channel = inChannel(sessionId);
      const subId = `in-${sessionId}`.slice(0, 128);
      void (async () => {
        let ws: WebSocketLike | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timeoutMs = CONNECT_TIMEOUT_MS;
        const arm = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(() => {
            queue.fail(appSyncError("AppSyncTimeout", "AppSync connection timed out"));
            ws?.close();
          }, timeoutMs);
        };
        try {
          const headers = await signEventRequest(signOpts, "{}");
          ws = factory(`wss://${options.realtimeHost}/event/realtime`, connectProtocols(headers));
          const socket = ws;
          sockets.add(socket);
          arm();
          socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "connection_init" })));
          socket.addEventListener("error", () => {
            queue.fail(appSyncError("AppSyncWebSocketError", "AppSync WebSocket error"));
          });
          socket.addEventListener("close", () => {
            if (timer !== undefined) clearTimeout(timer);
            sockets.delete(socket);
            queue.end();
          });
          socket.addEventListener("message", (ev) => {
            arm();
            if (typeof ev.data !== "string") return;
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(ev.data) as Record<string, unknown>;
            } catch {
              return;
            }
            switch (msg["type"]) {
              case "connection_ack": {
                const t = msg["connectionTimeoutMs"];
                if (typeof t === "number" && t > 0) timeoutMs = t;
                void signEventRequest(signOpts, JSON.stringify({ channel })).then(
                  (authorization) =>
                    socket.send(JSON.stringify({ type: "subscribe", id: subId, channel, authorization })),
                  () => queue.fail(appSyncError("AppSyncSigningFailed", "AppSync signing failed")),
                );
                break;
              }
              case "data":
                if (msg["id"] === subId && typeof msg["event"] === "string") queue.push(msg["event"]);
                break;
              case "connection_error":
              case "subscribe_error":
              case "error":
                queue.fail(
                  appSyncError(`AppSync_${String(msg["type"])}`, `AppSync ${String(msg["type"])}`),
                );
                socket.close();
                break;
              default:
                break; // `ka`, `subscribe_success`
            }
          });
        } catch {
          queue.fail(appSyncError("AppSyncConnectFailed", "AppSync connect failed"));
        }
      })();
      return queue.iterable;
    },

    async publish(sessionId: string, channel: "out" | "text", events: readonly string[]): Promise<void> {
      if (closed) throw new Error("AppSync channel is closed");
      const path = `/voice/${sessionId}/${channel}`;
      for (const batch of batches(events)) await publishOne(path, batch);
    },

    async close(): Promise<void> {
      closed = true;
      for (const ws of sockets) ws.close();
      sockets.clear();
    },
  };
}
