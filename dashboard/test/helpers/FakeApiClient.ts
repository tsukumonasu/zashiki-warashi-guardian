import type { ApiClient, ApiError, ApiResult } from "../../src/lib/api";

type Method = keyof ApiClient;

export interface RecordedCall {
  method: Method;
  args: unknown[];
}

const NOT_SCRIPTED: ApiError = { code: "internal", message: "FakeApiClient: no response scripted." };

/**
 * Scripted ApiClient for component tests. Script a method with a result or a function;
 * every call is recorded in `calls`. An unscripted method returns an `internal` error.
 */
export class FakeApiClient implements ApiClient {
  readonly calls: RecordedCall[] = [];
  private readonly scripts = new Map<Method, unknown>();

  /** Sets the answer of `method`: a fixed Result, or a function of the call arguments. */
  script<M extends Method>(
    method: M,
    answer:
      | Awaited<ReturnType<ApiClient[M]>>
      | ((...args: Parameters<ApiClient[M]>) => ReturnType<ApiClient[M]> | Awaited<ReturnType<ApiClient[M]>>),
  ): this {
    this.scripts.set(method, answer);
    return this;
  }

  callsOf(method: Method): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  private async run<T>(method: Method, args: unknown[]): Promise<ApiResult<T>> {
    this.calls.push({ method, args });
    const s = this.scripts.get(method);
    if (s === undefined) return { ok: false, error: NOT_SCRIPTED };
    const out = typeof s === "function" ? (s as (...a: unknown[]) => unknown)(...args) : s;
    return (await out) as ApiResult<T>;
  }

  me: ApiClient["me"] = () => this.run("me", []);
  samples: ApiClient["samples"] = () => this.run("samples", []);
  encounters: ApiClient["encounters"] = (limit, cursor) => this.run("encounters", [limit, cursor]);
  encounter: ApiClient["encounter"] = (id) => this.run("encounter", [id]);
  deviceStatus: ApiClient["deviceStatus"] = (id) => this.run("deviceStatus", [id]);
  simulate: ApiClient["simulate"] = (sampleId, generate) => this.run("simulate", [sampleId, generate]);
  command: ApiClient["command"] = (deviceId, command) => this.run("command", [deviceId, command]);
  photoRequest: ApiClient["photoRequest"] = (deviceId) => this.run("photoRequest", [deviceId]);
  photo: ApiClient["photo"] = (requestId) => this.run("photo", [requestId]);
  say: ApiClient["say"] = (deviceId, text) => this.run("say", [deviceId, text]);
  faces: ApiClient["faces"] = () => this.run("faces", []);
  faceUpload: ApiClient["faceUpload"] = () => this.run("faceUpload", []);
  faceRegister: ApiClient["faceRegister"] = (body) => this.run("faceRegister", [body]);
  faceDelete: ApiClient["faceDelete"] = (memberId) => this.run("faceDelete", [memberId]);
  startConversation: ApiClient["startConversation"] = (body) => this.run("startConversation", [body]);
  endConversation: ApiClient["endConversation"] = (sessionId) => this.run("endConversation", [sessionId]);
}
