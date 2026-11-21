/**
 * Shared harness of the voice handler tests (`handlers.test.ts`, `log-privacy.test.ts`).
 *
 * The handlers build their clients at module scope, so each test file mocks the adapter modules
 * with factories that read from `holder`. A test fills `holder` and sets the environment, then
 * imports the handler fresh (`vi.resetModules()` first). Nothing here touches AWS.
 */

import { vi } from "vitest";

import type { SessionInvoker } from "../../lambda/voice-grant/voice-grant-core.js";
import type { HealthState, HealthStore } from "../../lambda/voice-start/voice-start-core.js";
import { FakeDollBus } from "./fake-stream.js";
import { FakeVoiceStore } from "./voice-store-fake.js";

export class MemoryHealth implements HealthStore {
  state: HealthState | null = null;
  async read(): Promise<HealthState | null> {
    return this.state;
  }
  async write(state: HealthState): Promise<void> {
    this.state = state;
  }
}

export class RecordingInvoker implements SessionInvoker {
  readonly payloads: unknown[] = [];
  fail = false;
  async invoke(payload: unknown): Promise<void> {
    if (this.fail) throw new Error("invoke failed");
    this.payloads.push(payload);
  }
}

export interface Holder {
  store: FakeVoiceStore;
  bus: FakeDollBus;
  invoker: RecordingInvoker;
  health: MemoryHealth;
  online: boolean;
  runSession: ReturnType<typeof vi.fn>;
}

// Kept on globalThis: `vi.resetModules()` would otherwise give the mock factories a second copy.
const G = globalThis as unknown as { __voiceHolder?: Holder };
export const holder: Holder = (G.__voiceHolder ??= freshHolder());

function freshHolder(): Holder {
  return {
    store: new FakeVoiceStore(Date.now()),
    bus: new FakeDollBus(),
    invoker: new RecordingInvoker(),
    health: new MemoryHealth(),
    online: true,
    runSession: vi.fn(async () => undefined),
  };
}

/** Replaces every fake with a new one. Call in `beforeEach`. */
export function resetHolder(): void {
  Object.assign(holder, freshHolder());
}

export const BASE_ENV: Readonly<Record<string, string>> = {
  WARASHI_TABLE_NAME: "table",
  WARASHI_VOICE_SESSION_FUNCTION_NAME: "voice-session-fn",
  WARASHI_VOICE_HTTP_HOST: "http.example.invalid",
  WARASHI_VOICE_REALTIME_HOST: "rt.example.invalid",
  WARASHI_WEB_ORIGIN: "https://dash.example.invalid",
  AWS_REGION: "ap-northeast-1",
  WARASHI_VOICE_ENABLED: "true",
};

const TOUCHED = new Set<string>();

/** Sets the environment for the next import; `undefined` removes a variable. */
export function setEnv(extra: Record<string, string | undefined> = {}): void {
  clearEnv();
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...extra })) {
    TOUCHED.add(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

export function clearEnv(): void {
  for (const k of TOUCHED) delete process.env[k];
  TOUCHED.clear();
}

export const ORIGIN = "https://dash.example.invalid";

/** An API Gateway v2 event for the voice routes. */
export function apiEvent(opts: {
  route: string;
  sub?: string | null;
  groups?: string[];
  body?: unknown;
  rawBody?: string;
  sessionId?: string;
  origin?: string;
}): Record<string, unknown> {
  const [method, path] = opts.route.split(" ") as [string, string];
  const claims: Record<string, unknown> = {};
  if (opts.sub !== null) claims["sub"] = opts.sub ?? "sub-family";
  claims["cognito:groups"] = opts.groups ?? ["family"];
  return {
    routeKey: opts.route,
    rawPath: path,
    headers: { origin: opts.origin ?? ORIGIN, "content-type": "application/json" },
    pathParameters: opts.sessionId === undefined ? undefined : { sessionId: opts.sessionId },
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    requestContext: { http: { method, path }, authorizer: { jwt: { claims } } },
  };
}

export function header(headers: Record<string, unknown> | undefined, name: string): unknown {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name.toLowerCase()) return v;
  return undefined;
}
