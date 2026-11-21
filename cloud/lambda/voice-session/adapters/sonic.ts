/**
 * `SonicClient` over Bedrock `InvokeModelWithBidirectionalStream` (design, "Session Lambda").
 *
 * The call is authorized by the IAM action `bedrock:InvokeModel`; it has no action of its own.
 * It needs HTTP/2, so the client uses `NodeHttp2Handler`. The client lives at module scope so a
 * warm Lambda container reuses its HTTP/2 connection.
 *
 * `parseSonicOutput` is pure: it turns the JSON of one output event into a `SonicEvent`. It keeps
 * the role and generation stage announced by `contentStart`, because `textOutput` carries only the
 * `contentId`. Nothing here stores or logs audio or text.
 */
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  type InvokeModelWithBidirectionalStreamInput,
  type InvokeModelWithBidirectionalStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttp2Handler } from "@smithy/node-http-handler";
import type { SonicClient, SonicEvent, SonicStream } from "../../_shared/voice/ports.js";

/** The Region of the model, from configuration (the Lambda's own Region by default). */
export const SONIC_REGION_ENV = "WARASHI_VOICE_REGION";

type ContentMeta = { role: "USER" | "ASSISTANT" | null; stage: "SPECULATIVE" | "FINAL" | null };

/** Remembers `contentStart` metadata for the text events of one stream. */
export interface SonicParser {
  parse(json: string): SonicEvent | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Reads `generationStage` from the `additionalModelFields` JSON string of a `contentStart`. */
function stageOf(additional: unknown): "SPECULATIVE" | "FINAL" | null {
  const text = str(additional);
  if (text === null) return null;
  try {
    const stage = asRecord(JSON.parse(text))?.["generationStage"];
    return stage === "SPECULATIVE" || stage === "FINAL" ? stage : null;
  } catch {
    return null;
  }
}

export function createSonicParser(): SonicParser {
  const contents = new Map<string, ContentMeta>();
  return {
    parse(json: string): SonicEvent | null {
      let root: unknown;
      try {
        root = JSON.parse(json);
      } catch {
        return null;
      }
      const ev = asRecord(asRecord(root)?.["event"]);
      if (ev === null) return null;

      const start = asRecord(ev["contentStart"]);
      if (start !== null) {
        const id = str(start["contentId"]);
        if (id !== null) {
          const role = start["role"] === "USER" || start["role"] === "ASSISTANT" ? start["role"] : null;
          contents.set(id, { role, stage: stageOf(start["additionalModelFields"]) });
        }
        return null;
      }

      const audio = asRecord(ev["audioOutput"]);
      if (audio !== null) {
        const contentId = str(audio["contentId"]);
        const pcmBase64 = str(audio["content"]);
        return contentId !== null && pcmBase64 !== null ? { kind: "audio", contentId, pcmBase64 } : null;
      }

      const text = asRecord(ev["textOutput"]);
      if (text !== null) {
        const content = str(text["content"]);
        const contentId = str(text["contentId"]) ?? "";
        if (content === null) return null;
        // Barge-in marker, as in the AWS sample: the content is `{ "interrupted" : true }`.
        if (/^\s*\{\s*"interrupted"\s*:\s*true\s*\}\s*$/.test(content)) return { kind: "interrupted" };
        const meta = contents.get(contentId);
        const role = text["role"] === "USER" || text["role"] === "ASSISTANT" ? text["role"] : meta?.role;
        if (role === undefined || role === null) return null;
        return { kind: "text", contentId, role, stage: meta?.stage ?? null, text: content };
      }

      const tool = asRecord(ev["toolUse"]);
      if (tool !== null) {
        const toolUseId = str(tool["toolUseId"]);
        const name = str(tool["toolName"]);
        if (toolUseId === null || name === null) return null;
        return { kind: "toolUse", toolUseId, name, inputJson: str(tool["content"]) ?? "{}" };
      }

      if (ev["completionEnd"] !== undefined) return { kind: "completionEnd" };
      return null;
    },
  };
}

/** Async queue for the request body; `end()` closes the request stream. */
function makeInputQueue(): {
  iterable: AsyncIterable<InvokeModelWithBidirectionalStreamInput>;
  push(json: string): void;
  end(): void;
} {
  const items: InvokeModelWithBidirectionalStreamInput[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const encoder = new TextEncoder();
  return {
    push(json) {
      if (done) return;
      items.push({ chunk: { bytes: encoder.encode(json) } });
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = items.shift();
          if (next !== undefined) {
            yield next;
          } else if (done) {
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

/** Maps a stream failure to an error event. Only the error name leaves this module. */
function errorCode(err: unknown): string {
  return err instanceof Error && err.name !== "" ? err.name : "stream_error";
}

async function* outputEvents(
  body: AsyncIterable<InvokeModelWithBidirectionalStreamOutput>,
): AsyncGenerator<SonicEvent> {
  const parser = createSonicParser();
  const decoder = new TextDecoder();
  try {
    for await (const part of body) {
      if (part.chunk?.bytes !== undefined) {
        const ev = parser.parse(decoder.decode(part.chunk.bytes));
        if (ev !== null) yield ev;
        continue;
      }
      // Any other member is a stream exception (throttling, validation, model error, ...).
      const name = Object.keys(part).find((k) => k !== "chunk" && k !== "$unknown");
      yield { kind: "error", code: name ?? "unknown_member" };
      return;
    }
  } catch (err) {
    yield { kind: "error", code: errorCode(err) };
  }
}

export type SonicBedrock = Pick<BedrockRuntimeClient, "send">;

let defaultClient: BedrockRuntimeClient | undefined;

/** Created on first use, then reused for the life of the container. */
function getDefaultClient(): BedrockRuntimeClient {
  if (defaultClient === undefined) {
    const region = process.env[SONIC_REGION_ENV];
    defaultClient = new BedrockRuntimeClient({
      ...(region !== undefined && region !== "" ? { region } : {}),
      requestHandler: new NodeHttp2Handler({ requestTimeout: 300_000, sessionTimeout: 300_000 }),
    });
  }
  return defaultClient;
}

export function createSonicClient(options: { client?: SonicBedrock } = {}): SonicClient {
  return {
    async open(modelId: string): Promise<SonicStream> {
      const client = options.client ?? getDefaultClient();
      const input = makeInputQueue();
      const response = await client.send(
        new InvokeModelWithBidirectionalStreamCommand({ modelId, body: input.iterable }),
      );
      if (response.body === undefined) {
        input.end();
        throw new Error("Bedrock returned no output stream");
      }
      const body = response.body;
      let closed = false;
      return {
        async send(eventJson: string): Promise<void> {
          if (closed) throw new Error("Sonic stream is closed");
          input.push(eventJson);
        },
        events: () => outputEvents(body),
        async close(): Promise<void> {
          closed = true;
          input.end();
        },
      };
    },
  };
}
