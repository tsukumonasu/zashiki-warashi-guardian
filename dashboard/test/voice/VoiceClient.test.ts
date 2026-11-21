import { describe, expect, it, vi } from "vitest";
import type { BrowserConversation, DeviceConversation } from "../../src/lib/api";
import type { AudioIO } from "../../src/voice/browserAudio";
import { FakeVoiceTransport } from "../../src/voice/transport";
import { VoiceClient } from "../../src/voice/VoiceClient";
import { pcm16ToBase64 } from "../../src/voice/audio";

const browserSession: BrowserConversation = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  clientToken: "tok",
  hosts: { http: "h.example.invalid", realtime: "r.example.invalid" },
  channels: { in: "/voice/s/in", out: "/voice/s/out", text: "/voice/s/text" },
  maxSeconds: 60,
  silenceSeconds: 20,
  expiresAt: "2026-11-20T12:34:56.789Z",
};
const deviceSession: DeviceConversation = {
  sessionId: browserSession.sessionId,
  observerToken: "obs",
  hosts: browserSession.hosts,
  channels: browserSession.channels,
  deviceOnline: true,
};

function fakeAudio() {
  let onChunk: (pcm: Int16Array) => void = () => undefined;
  const audio = {
    played: [] as Int16Array[],
    stopped: 0,
    closed: 0,
    startCapture: vi.fn((cb: (pcm: Int16Array) => void) => {
      onChunk = cb;
      return Promise.resolve();
    }),
    stopCapture: vi.fn(),
    play: (pcm: Int16Array) => void audio.played.push(pcm),
    stopPlayback: () => void audio.stopped++,
    onPlayback: vi.fn(),
    close: () => void audio.closed++,
    chunk: (pcm: Int16Array) => onChunk(pcm),
  };
  return audio satisfies AudioIO & Record<string, unknown>;
}

function setup(session: BrowserConversation | DeviceConversation) {
  const transport = new FakeVoiceTransport();
  const audio = fakeAudio();
  const endConversation = vi.fn(() => Promise.resolve({ ok: true as const, value: null }));
  const startConversation = vi.fn(() => Promise.resolve({ ok: true as const, value: session }));
  const client = new VoiceClient({
    api: { startConversation, endConversation },
    transport,
    createAudio: () => audio,
    deviceId: "warashi-01",
    lookVerdict: () => "family",
  });
  return { transport, audio, client, startConversation, endConversation };
}

describe("VoiceClient", () => {
  it("connects, says hello, streams microphone audio and plays model speech", async () => {
    const { transport, audio, client } = setup(browserSession);
    await client.start({ target: "virtual" });
    expect(client.state).toBe("listening");
    expect(transport.url).toBe("wss://r.example.invalid/event/realtime");
    expect(transport.published("/voice/s/in")[0]).toEqual({ t: "hello", client: "browser", v: 1 });

    audio.chunk(new Int16Array(1600));
    expect(transport.published("/voice/s/in")[1]).toMatchObject({ t: "audio", seq: 0 });

    const out = transport.subscriptionId("/voice/s/out") as string;
    const pcm = new Int16Array([1, 2, 3]);
    transport.receiveData(out, JSON.stringify({ t: "audio", seq: 0, pcm: pcm16ToBase64(pcm) }));
    expect(audio.played).toEqual([pcm]);
    transport.receiveData(out, JSON.stringify({ t: "interrupt" }));
    expect(audio.stopped).toBe(1);
  });

  it("passes command frames on and answers a snapshot.request with look.result", async () => {
    const { transport, client } = setup(browserSession);
    const seen: string[] = [];
    client.onCommand((e) => seen.push(e.type));
    await client.start({ target: "virtual" });
    const envelope = {
      v: 1,
      id: "a",
      ts: "2026-11-20T12:34:56.789Z",
      deviceId: "warashi-sim",
      encounterId: null,
      type: "snapshot.request",
      data: { requestId: "req-1" },
    };
    const out = transport.subscriptionId("/voice/s/out") as string;
    transport.receiveData(out, JSON.stringify({ t: "command", envelope }));
    expect(seen).toEqual(["snapshot.request"]);
    expect(transport.published("/voice/s/in").at(-1)).toEqual({
      t: "look.result",
      requestId: "req-1",
      verdict: "family",
    });
  });

  it("stop sends bye, closes everything and calls DELETE", async () => {
    const { transport, audio, client, endConversation } = setup(browserSession);
    await client.start({ target: "virtual" });
    await client.stop();
    expect(transport.published("/voice/s/in").at(-1)).toEqual({ t: "bye", reason: "user" });
    expect(transport.closed).toBe(true);
    expect(audio.closed).toBe(1);
    expect(endConversation).toHaveBeenCalledWith(browserSession.sessionId);
    expect(client.state).toBe("idle");
  });

  it("a doll session subscribes text only with the observer token and never captures", async () => {
    const { transport, audio, client } = setup(deviceSession);
    const transcripts: string[] = [];
    client.onTranscript((_r, text) => transcripts.push(text));
    await client.start({ target: "real" });
    expect(transport.subscriptionId("/voice/s/out")).toBeNull();
    expect(audio.startCapture).not.toHaveBeenCalled();
    const text = transport.subscriptionId("/voice/s/text") as string;
    transport.receiveData(text, JSON.stringify({ t: "transcript", role: "assistant", text: "hi", final: true }));
    expect(transcripts).toEqual(["hi"]);
    const ends: string[] = [];
    client.onEnd((r) => ends.push(r));
    transport.receiveData(text, JSON.stringify({ t: "end", reason: "silence" }));
    expect(ends).toEqual(["silence"]);
    expect(client.state).toBe("idle");
  });

  it("fails with the API error code when the start is refused", async () => {
    const transport = new FakeVoiceTransport();
    const client = new VoiceClient({
      api: {
        startConversation: () =>
          Promise.resolve({ ok: false as const, error: { code: "session_active" as const, message: "busy" } }),
        endConversation: () => Promise.resolve({ ok: true as const, value: null }),
      },
      transport,
      createAudio: fakeAudio,
      deviceId: "warashi-01",
    });
    await client.start({ target: "virtual" });
    expect(client.state).toBe("failed");
    expect(client.error).toBe("session_active");
  });
});
