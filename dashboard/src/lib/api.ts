/**
 * API_Client: the only module that calls the cloud HTTP API (docs/schema.md, "HTTP API").
 * Every function returns a Result and never throws. It never logs and never puts a token,
 * image data, a face id or a pre-signed URL into an error message.
 */
import type { Encounter, FaceBox, Speech, StatusReportData, Verdict } from "../simulation/types";
import { VERDICTS } from "../simulation/types";
import type { OutgoingCommand } from "../simulation/controls";

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "consent_required"
  | "face_count_invalid"
  | "rate_limited"
  | "internal"
  | "session_active"
  | "voice_unavailable"
  | "timeout"
  | "network";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  retryAfterS?: number;
}

export type ApiResult<T> = Result<T, ApiError>;

export const REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRY_AFTER_S = 60;
export const MIN_RETRY_AFTER_S = 1;
export const MAX_RETRY_AFTER_S = 86_400;

// Codes the server may send. `timeout` and `network` are produced locally only.
const SERVER_CODES: readonly ApiErrorCode[] = [
  "unauthorized",
  "forbidden",
  "not_found",
  "validation_failed",
  "consent_required",
  "face_count_invalid",
  "rate_limited",
  "internal",
  "session_active",
  "voice_unavailable",
];

/** Unknown, missing or locally-produced codes become `internal`. */
export function mapErrorCode(code: unknown): ApiErrorCode {
  return typeof code === "string" && (SERVER_CODES as readonly string[]).includes(code)
    ? (code as ApiErrorCode)
    : "internal";
}

/** Integer seconds clamped to 1..86400; 60 when missing or not an integer. */
export function parseRetryAfter(header: string | null | undefined): number {
  if (typeof header !== "string" || !/^\s*\d+\s*$/.test(header)) return DEFAULT_RETRY_AFTER_S;
  const n = Number(header.trim());
  if (!Number.isFinite(n)) return DEFAULT_RETRY_AFTER_S;
  return Math.min(MAX_RETRY_AFTER_S, Math.max(MIN_RETRY_AFTER_S, Math.trunc(n)));
}

// ---- Response shapes -----------------------------------------------------------------------

export type ApiRole = "family" | "reviewer";
export interface MeResponse {
  role: ApiRole;
  consentNoticeVersion: string;
  limits: { simulatePerHour: number; generatePerHour: number };
  /** Voice availability (S18). Absent on a cloud that predates voice: the panel treats it as unavailable. */
  voice?: VoiceInfo;
}
export interface VoiceInfo {
  enabled: boolean;
  maxSeconds: number;
  remainingToday: number;
}
export interface SampleInfo {
  sampleId: string;
  label: Verdict;
}
export interface EncountersPage {
  items: Encounter[];
  nextCursor: string | null;
}
export interface DeviceStatusResponse {
  deviceId: string;
  online: boolean;
  lastSeenAt: string | null;
  status: StatusReportData | null;
}
export interface SimulateResponse {
  sampleId: string;
  verdict: Verdict;
  confidence: number;
  face: FaceBox | null;
  commands: unknown[];
  speech: Speech | null;
  latencyMs: { total: number; search: number };
}
export interface CommandResponse {
  id: string;
  deviceOnline: boolean;
}
/** `POST /photos` (remote-actions R4). */
export interface PhotoRequestResponse {
  requestId: string;
  deviceOnline: boolean;
}
/** `GET /photos/{requestId}` (remote-actions R5). */
export type PhotoStatus = { status: "pending" } | { status: "ready"; url: string; expiresAt: string };
export interface FaceMember {
  memberId: string;
  displayName: string;
  createdAt: string;
  consentVersion: string;
  faceCount: number;
}
export interface FaceUploadTicket {
  url: string;
  fields: Record<string, string>;
  stagingKey: string;
  expiresInS: number;
}
export interface FaceRegisterBody {
  stagingKey: string;
  displayName: string;
  memberId: string | null;
  consent: { noticeVersion: string; accepted: true };
}
export interface FaceRegisterResponse {
  memberId: string;
  faceCount: number;
}

/** Body of `POST /conversations` (docs/schema.md, S16). */
export interface StartConversationBody {
  deviceId: string;
  client: "browser" | "device";
  target: "real" | "virtual";
}
export interface ConversationHosts {
  http: string;
  realtime: string;
}
export interface ConversationChannels {
  in: string;
  out: string;
  text: string;
}
/** `201` for `client: "browser"`: the browser is the audio client. */
export interface BrowserConversation {
  sessionId: string;
  clientToken: string;
  hosts: ConversationHosts;
  channels: ConversationChannels;
  maxSeconds: number;
  silenceSeconds: number;
  expiresAt: string;
}
/** `202` for `client: "device"`: the doll is the audio client; the browser only watches `text`. */
export interface DeviceConversation {
  sessionId: string;
  observerToken: string;
  hosts: ConversationHosts;
  channels: ConversationChannels;
  deviceOnline: boolean;
}
export type StartConversationResponse = BrowserConversation | DeviceConversation;

export interface ApiClient {
  me(): Promise<ApiResult<MeResponse>>;
  samples(): Promise<ApiResult<{ samples: SampleInfo[] }>>;
  encounters(limit: number, cursor?: string): Promise<ApiResult<EncountersPage>>;
  encounter(id: string): Promise<ApiResult<Encounter>>;
  deviceStatus(deviceId: string): Promise<ApiResult<DeviceStatusResponse>>;
  simulate(sampleId: string, generate: boolean): Promise<ApiResult<SimulateResponse>>;
  command(deviceId: string, command: OutgoingCommand): Promise<ApiResult<CommandResponse>>;
  /** Asks the doll for one photo. The picture is fetched later with `photo`. */
  photoRequest(deviceId: string): Promise<ApiResult<PhotoRequestResponse>>;
  photo(requestId: string): Promise<ApiResult<PhotoStatus>>;
  /** Makes the doll say typed Japanese text (`POST /say`). */
  say(deviceId: string, text: string): Promise<ApiResult<CommandResponse>>;
  faces(): Promise<ApiResult<{ members: FaceMember[] }>>;
  faceUpload(): Promise<ApiResult<FaceUploadTicket>>;
  faceRegister(body: FaceRegisterBody): Promise<ApiResult<FaceRegisterResponse>>;
  faceDelete(memberId: string): Promise<ApiResult<null>>;
  startConversation(body: StartConversationBody): Promise<ApiResult<StartConversationResponse>>;
  /** `DELETE /conversations/{id}`. Sent with `keepalive` so it survives a closing tab. */
  endConversation(sessionId: string): Promise<ApiResult<null>>;
}

export interface ApiClientDeps {
  baseUrl: string;
  getToken: () => string | null;
  fetch: typeof fetch;
  /** Schedules `fn` after `ms`; returns a function that cancels it. Injected for fake timers. */
  setTimer: (fn: () => void, ms: number) => () => void;
}

// ---- Guards (hand-written, shallow on purpose: the cloud is our own code) -------------------

type Guard<T> = (v: unknown) => v is T;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const strOrNull = (v: unknown): boolean => v === null || isStr(v);

const isFaceBox = (v: unknown): boolean =>
  isObj(v) && isNum(v.left) && isNum(v.top) && isNum(v.width) && isNum(v.height);

const isMe: Guard<MeResponse> = (v): v is MeResponse =>
  isObj(v) &&
  (v.role === "family" || v.role === "reviewer") &&
  isStr(v.consentNoticeVersion) &&
  isObj(v.limits) &&
  isInt(v.limits.simulatePerHour) &&
  isInt(v.limits.generatePerHour) &&
  (v.voice === undefined ||
    (isObj(v.voice) && isBool(v.voice.enabled) && isInt(v.voice.maxSeconds) && isInt(v.voice.remainingToday)));

const isSamples: Guard<{ samples: SampleInfo[] }> = (v): v is { samples: SampleInfo[] } =>
  isObj(v) &&
  Array.isArray(v.samples) &&
  v.samples.every(
    (s) => isObj(s) && isStr(s.sampleId) && (VERDICTS as readonly unknown[]).includes(s.label),
  );

const isEncounter = (v: unknown): v is Encounter =>
  isObj(v) &&
  isStr(v.encounterId) &&
  isStr(v.deviceId) &&
  isStr(v.startedAt) &&
  strOrNull(v.endedAt) &&
  isBool(v.notified) &&
  Array.isArray(v.events) &&
  (v.snapshot === null || (isObj(v.snapshot) && isStr(v.snapshot.url) && isStr(v.snapshot.expiresAt)));

const isEncountersPage: Guard<EncountersPage> = (v): v is EncountersPage =>
  isObj(v) && Array.isArray(v.items) && v.items.every(isEncounter) && strOrNull(v.nextCursor);

const isDeviceStatus: Guard<DeviceStatusResponse> = (v): v is DeviceStatusResponse =>
  isObj(v) &&
  isStr(v.deviceId) &&
  isBool(v.online) &&
  strOrNull(v.lastSeenAt) &&
  (v.status === null ||
    (isObj(v.status) &&
      isStr(v.status.state) &&
      isBool(v.status.cameraActive) &&
      isBool(v.status.micActive)));

const isSpeech = (v: unknown): boolean =>
  isObj(v) && strOrNull(v.lineId) && isStr(v.ja) && isStr(v.en) && strOrNull(v.mp3Url) && isBool(v.generated);

const isSimulate: Guard<SimulateResponse> = (v): v is SimulateResponse =>
  isObj(v) &&
  isStr(v.sampleId) &&
  (VERDICTS as readonly unknown[]).includes(v.verdict) &&
  isNum(v.confidence) &&
  (v.face === null || isFaceBox(v.face)) &&
  Array.isArray(v.commands) &&
  (v.speech === null || isSpeech(v.speech)) &&
  isObj(v.latencyMs) &&
  isInt(v.latencyMs.total) &&
  isInt(v.latencyMs.search);

const isCommandResponse: Guard<CommandResponse> = (v): v is CommandResponse =>
  isObj(v) && isStr(v.id) && isBool(v.deviceOnline);

const isPhotoRequest: Guard<PhotoRequestResponse> = (v): v is PhotoRequestResponse =>
  isObj(v) && isStr(v.requestId) && isBool(v.deviceOnline);

const isPhotoStatus: Guard<PhotoStatus> = (v): v is PhotoStatus =>
  isObj(v) &&
  (v.status === "pending" || (v.status === "ready" && isStr(v.url) && isStr(v.expiresAt)));

const isFaces: Guard<{ members: FaceMember[] }> = (v): v is { members: FaceMember[] } =>
  isObj(v) &&
  Array.isArray(v.members) &&
  v.members.every(
    (m) =>
      isObj(m) &&
      isStr(m.memberId) &&
      isStr(m.displayName) &&
      isStr(m.createdAt) &&
      isStr(m.consentVersion) &&
      isInt(m.faceCount),
  );

const isUploadTicket: Guard<FaceUploadTicket> = (v): v is FaceUploadTicket =>
  isObj(v) &&
  isStr(v.url) &&
  isObj(v.fields) &&
  Object.values(v.fields).every(isStr) &&
  isStr(v.stagingKey) &&
  isNum(v.expiresInS);

const isRegister: Guard<FaceRegisterResponse> = (v): v is FaceRegisterResponse =>
  isObj(v) && isStr(v.memberId) && isInt(v.faceCount);

const isHosts = (v: unknown): boolean => isObj(v) && isStr(v.http) && isStr(v.realtime);
const isChannels = (v: unknown): boolean => isObj(v) && isStr(v.in) && isStr(v.out) && isStr(v.text);

const isStartConversation: Guard<StartConversationResponse> = (v): v is StartConversationResponse =>
  isObj(v) &&
  isStr(v.sessionId) &&
  isHosts(v.hosts) &&
  isChannels(v.channels) &&
  ((isStr(v.clientToken) && isInt(v.maxSeconds) && isInt(v.silenceSeconds) && isStr(v.expiresAt)) ||
    (isStr(v.observerToken) && isBool(v.deviceOnline)));

// ---- Client --------------------------------------------------------------------------------

const fail = (code: ApiErrorCode, message: string, retryAfterS?: number): Result<never, ApiError> => ({
  ok: false,
  error: retryAfterS === undefined ? { code, message } : { code, message, retryAfterS },
});

const MAX_MESSAGE = 200;

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const base = deps.baseUrl.replace(/\/+$/, "");

  async function call<T>(
    method: string,
    path: string,
    guard: Guard<T> | null,
    body?: unknown,
    keepalive = false,
  ): Promise<ApiResult<T>> {
    const token = deps.getToken();
    if (token === null || token === "") return fail("unauthorized", "Not signed in.");

    const controller = new AbortController();
    let timedOut = false;
    const cancelTimer = deps.setTimer(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (keepalive) init.keepalive = true;
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const res = await deps.fetch(`${base}${path}`, init);

      if (!res.ok) {
        let code: ApiErrorCode = "internal";
        let message = `Request failed (${res.status}).`;
        try {
          const parsed: unknown = await res.json();
          if (isObj(parsed) && isObj(parsed.error)) {
            code = mapErrorCode(parsed.error.code);
            if (isStr(parsed.error.message)) message = parsed.error.message.slice(0, MAX_MESSAGE);
          }
        } catch {
          // Body is not JSON: keep the generic internal error.
        }
        return code === "rate_limited"
          ? fail(code, message, parseRetryAfter(res.headers.get("Retry-After")))
          : fail(code, message);
      }

      if (guard === null) return { ok: true, value: null as T };
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return fail("internal", "The cloud sent an unreadable answer.");
      }
      if (!guard(json)) return fail("internal", "The cloud sent an unexpected answer.");
      return { ok: true, value: json };
    } catch {
      return timedOut ? fail("timeout", "The cloud did not answer in time.") : fail("network", "The cloud is out of reach.");
    } finally {
      cancelTimer();
    }
  }

  const enc = encodeURIComponent;

  return {
    me: () => call("GET", "/me", isMe),
    samples: () => call("GET", "/samples", isSamples),
    encounters: (limit, cursor) =>
      call(
        "GET",
        `/encounters?limit=${enc(String(limit))}${cursor === undefined ? "" : `&cursor=${enc(cursor)}`}`,
        isEncountersPage,
      ),
    encounter: (id) => call("GET", `/encounters/${enc(id)}`, isEncounter),
    deviceStatus: (deviceId) => call("GET", `/device/status?deviceId=${enc(deviceId)}`, isDeviceStatus),
    simulate: (sampleId, generate) => call("POST", "/simulate", isSimulate, { sampleId, generate }),
    command: (deviceId, command) => call("POST", "/commands", isCommandResponse, { deviceId, command }),
    photoRequest: (deviceId) => call("POST", "/photos", isPhotoRequest, { deviceId }),
    photo: (requestId) => call("GET", `/photos/${enc(requestId)}`, isPhotoStatus),
    say: (deviceId, text) => call("POST", "/say", isCommandResponse, { deviceId, text }),
    faces: () => call("GET", "/faces", isFaces),
    faceUpload: () => call("POST", "/faces/upload", isUploadTicket, {}),
    faceRegister: (body) => call("POST", "/faces", isRegister, body),
    faceDelete: (memberId) => call("DELETE", `/faces/${enc(memberId)}`, null),
    startConversation: (body) => call("POST", "/conversations", isStartConversation, body),
    endConversation: (sessionId) => call("DELETE", `/conversations/${enc(sessionId)}`, null, undefined, true),
  };
}
