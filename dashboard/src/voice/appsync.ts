/**
 * AWS AppSync Events WebSocket protocol builders and parser (browser copy of
 * `device/warashi_agent/conversation/appsync.py`). Pure: no sockets, no clock, no logging.
 * The token is a secret; nothing here puts it in an error or a description.
 *
 * Protocol: https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html
 */

export const SUBPROTOCOL = "aws-appsync-event-ws";
export const MAX_EVENTS_PER_PUBLISH = 5;
/** Server connection timeout when `connection_ack` does not say (the documented default). */
export const DEFAULT_KEEPALIVE_MS = 300_000;

interface Auth {
  host: string;
  Authorization: string;
}

function auth(httpHost: string, token: string): Auth {
  return { host: httpHost, Authorization: token };
}

/** Base64URL without padding of an ASCII string. */
function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `header-<Base64URL of the JSON auth header>`. */
export function headerSubprotocol(httpHost: string, token: string): string {
  return "header-" + base64Url(JSON.stringify(auth(httpHost, token)));
}

/** The two WebSocket subprotocols: the `header-...` one first, then `aws-appsync-event-ws`. */
export function subprotocols(httpHost: string, token: string): string[] {
  return [headerSubprotocol(httpHost, token), SUBPROTOCOL];
}

/** `wss://<realtime host>/event/realtime`. A scheme or path on the host is dropped. */
export function realtimeUrl(realtimeHost: string): string {
  const host = realtimeHost.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  return `wss://${host}/event/realtime`;
}

export function connectionInit(): string {
  return JSON.stringify({ type: "connection_init" });
}

export function subscribe(subId: string, channel: string, httpHost: string, token: string): string {
  return JSON.stringify({
    type: "subscribe",
    id: subId,
    channel,
    authorization: auth(httpHost, token),
  });
}

/**
 * One publish of 1 to 5 events; each event is an already-encoded JSON string.
 * Throws `RangeError` for any other count (a programming error, not input).
 */
export function publish(
  pubId: string,
  channel: string,
  frames: readonly string[],
  httpHost: string,
  token: string,
): string {
  if (frames.length < 1 || frames.length > MAX_EVENTS_PER_PUBLISH) {
    throw new RangeError("a publish carries 1 to 5 events");
  }
  return JSON.stringify({
    type: "publish",
    id: pubId,
    channel,
    events: frames,
    authorization: auth(httpHost, token),
  });
}

export type ServerMessage =
  | { kind: "ack"; timeoutMs: number | null }
  | { kind: "ka" }
  | { kind: "subscribed"; id: string }
  | { kind: "published"; id: string }
  | { kind: "data"; id: string; events: string[] }
  | { kind: "rejected"; type: string; id: string | null; code: string }
  | { kind: "unknown" };

const ERROR_TYPES: readonly string[] = [
  "connection_error",
  "subscribe_error",
  "publish_error",
  "broadcast_error",
  "error",
];

function firstErrorCode(msg: Record<string, unknown>): string {
  const errors = msg.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first: unknown = errors[0];
    if (typeof first === "object" && first !== null) {
      const code = (first as Record<string, unknown>).errorType;
      if (typeof code === "string") return code.slice(0, 64);
    }
  }
  return "unknown";
}

/** Parses one WebSocket text message from AppSync. Never throws. */
export function parseServerMessage(raw: string): ServerMessage {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: "unknown" };
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return { kind: "unknown" };
  const m = msg as Record<string, unknown>;
  const t = m.type;
  const id = typeof m.id === "string" ? m.id : null;
  if (t === "connection_ack") {
    const timeout = m.connectionTimeoutMs;
    return { kind: "ack", timeoutMs: typeof timeout === "number" && Number.isInteger(timeout) ? timeout : null };
  }
  if (t === "ka") return { kind: "ka" };
  if (t === "subscribe_success" && id !== null) return { kind: "subscribed", id };
  if (t === "publish_success" && id !== null) return { kind: "published", id };
  if (t === "data" && id !== null) {
    const event = m.event;
    if (typeof event === "string") return { kind: "data", id, events: [event] };
    if (Array.isArray(event) && event.every((e) => typeof e === "string")) {
      return { kind: "data", id, events: event as string[] };
    }
  }
  if (typeof t === "string" && ERROR_TYPES.includes(t)) {
    return { kind: "rejected", type: t, id, code: firstErrorCode(m) };
  }
  return { kind: "unknown" };
}
