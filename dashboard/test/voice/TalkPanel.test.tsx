import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TalkPanel, disabledReason } from "../../src/components/TalkPanel";
import { COPY } from "../../src/content/copy";
import type { BrowserConversation, VoiceInfo } from "../../src/lib/api";
import type { Role } from "../../src/lib/roles";
import type { AudioIO } from "../../src/voice/browserAudio";
import { FakeVoiceTransport } from "../../src/voice/transport";
import { useVoice } from "../../src/voice/useVoice";

const session: BrowserConversation = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  clientToken: "tok",
  hosts: { http: "h.example.invalid", realtime: "r.example.invalid" },
  channels: { in: "/voice/s/in", out: "/voice/s/out", text: "/voice/s/text" },
  maxSeconds: 60,
  silenceSeconds: 20,
  expiresAt: "2026-11-20T12:34:56.789Z",
};
const VOICE_ON: VoiceInfo = { enabled: true, maxSeconds: 60, remainingToday: 3 };

function fakeAudio(): AudioIO {
  return {
    startCapture: () => Promise.resolve(),
    stopCapture: () => undefined,
    play: () => undefined,
    stopPlayback: () => undefined,
    onPlayback: () => undefined,
    close: () => undefined,
  } as unknown as AudioIO;
}

function rig() {
  const transport = new FakeVoiceTransport();
  const endConversation = vi.fn(() => Promise.resolve({ ok: true as const, value: null }));
  const startConversation = vi.fn(() => Promise.resolve({ ok: true as const, value: session }));
  return {
    transport,
    endConversation,
    startConversation,
    props: {
      api: { startConversation, endConversation },
      deviceId: "warashi-01",
      createTransport: () => transport,
      createAudio: fakeAudio,
    },
  };
}

function text(transport: FakeVoiceTransport, frame: unknown): void {
  act(() => {
    transport.receiveData(transport.subscriptionId("/voice/s/text") as string, JSON.stringify(frame));
  });
}

describe("disabledReason", () => {
  it.each<[Role, VoiceInfo | null | undefined, boolean, string | null]>([
    ["visitor", VOICE_ON, true, COPY.talk.disabled.visitor],
    ["family", VOICE_ON, false, COPY.talk.disabled.offline],
    ["family", null, true, COPY.talk.disabled.unknown],
    ["family", { ...VOICE_ON, enabled: false }, true, COPY.talk.disabled.off],
    ["reviewer", { ...VOICE_ON, remainingToday: 0 }, true, COPY.talk.disabled.none],
    ["family", VOICE_ON, true, null],
  ])("%s, %j, online=%s", (role, voice, online, expected) => {
    expect(disabledReason(role, voice, online)).toBe(expected);
  });
});

describe("TalkPanel", () => {
  it("shows the Bedrock Tokyo notice", () => {
    render(<TalkPanel {...rig().props} role="family" voice={VOICE_ON} />);
    expect(screen.getByText(/Amazon Bedrock in Tokyo/)).toBeTruthy();
  });

  it("disables Talk with the reason when voice is off, used up, or the user is a visitor", () => {
    const { rerender } = render(<TalkPanel {...rig().props} role="family" voice={{ ...VOICE_ON, enabled: false }} />);
    expect((screen.getByRole("button", { name: COPY.talk.talk }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(COPY.talk.disabled.off)).toBeTruthy();

    rerender(<TalkPanel {...rig().props} role="family" voice={{ ...VOICE_ON, remainingToday: 0 }} />);
    expect(screen.getByText(COPY.talk.disabled.none)).toBeTruthy();

    rerender(<TalkPanel {...rig().props} role="visitor" voice={null} />);
    expect(screen.getByText(COPY.talk.disabled.visitor)).toBeTruthy();
  });

  it("offers the real doll button to the family only", () => {
    const { rerender } = render(<TalkPanel {...rig().props} role="family" voice={VOICE_ON} />);
    expect(screen.queryByRole("button", { name: COPY.talk.talkReal })).not.toBeNull();
    rerender(<TalkPanel {...rig().props} role="reviewer" voice={VOICE_ON} />);
    expect(screen.queryByRole("button", { name: COPY.talk.talkReal })).toBeNull();
  });

  it("shows the microphone indicator and Stop while capturing, then the end reason", async () => {
    const r = rig();
    render(<TalkPanel {...r.props} role="family" voice={VOICE_ON} />);
    expect(screen.queryByTestId("talk-mic-on")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: COPY.talk.talk }));
    await waitFor(() => expect(screen.getByTestId("talk-mic-on")).toBeTruthy());
    expect(screen.getByRole("button", { name: COPY.talk.stop })).toBeTruthy();

    text(r.transport, { t: "transcript", role: "assistant", text: "おかえりなさい", final: true });
    expect(screen.getByText("おかえりなさい")).toBeTruthy();
    expect(screen.getByText(`${COPY.talk.doll}:`, { exact: false })).toBeTruthy();
    // No device id or any other identifier appears in the panel.
    expect(document.body.textContent).not.toContain("warashi-01");

    text(r.transport, { t: "end", reason: "silence" });
    await waitFor(() => expect(screen.queryByTestId("talk-mic-on")).toBeNull());
    expect(screen.getByText(COPY.talk.ended.silence)).toBeTruthy();
  });

  it("Stop sends bye, calls DELETE and reports that the user ended it", async () => {
    const r = rig();
    render(<TalkPanel {...r.props} role="family" voice={VOICE_ON} />);
    fireEvent.click(screen.getByRole("button", { name: COPY.talk.talk }));
    await waitFor(() => expect(screen.getByTestId("talk-mic-on")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: COPY.talk.stop }));
    await waitFor(() => expect(r.endConversation).toHaveBeenCalledWith(session.sessionId));
    expect(r.transport.published("/voice/s/in").at(-1)).toEqual({ t: "bye", reason: "user" });
    await waitFor(() => expect(screen.getByText(COPY.talk.ended.user)).toBeTruthy());
  });

  it("shows an error text when the start is refused", async () => {
    const r = rig();
    r.startConversation.mockResolvedValueOnce({
      ok: false,
      error: { code: "session_active", message: "busy" },
    } as never);
    render(<TalkPanel {...r.props} role="family" voice={VOICE_ON} />);
    fireEvent.click(screen.getByRole("button", { name: COPY.talk.talk }));
    await waitFor(() => expect(screen.getByText(COPY.talk.errors.session_active)).toBeTruthy());
  });

  it("a real-doll session shows no microphone indicator of the browser", async () => {
    const r = rig();
    r.startConversation.mockResolvedValueOnce({
      ok: true,
      value: {
        sessionId: session.sessionId,
        observerToken: "obs",
        hosts: session.hosts,
        channels: session.channels,
        deviceOnline: true,
      },
    } as never);
    render(<TalkPanel {...r.props} role="family" voice={VOICE_ON} />);
    fireEvent.click(screen.getByRole("button", { name: COPY.talk.talkReal }));
    await waitFor(() => expect(screen.getByText(COPY.talk.watching)).toBeTruthy());
    expect(screen.queryByTestId("talk-mic-on")).toBeNull();
  });
});

describe("useVoice", () => {
  it("forwards command frames, records subtitles and stops on unmount", async () => {
    const r = rig();
    const onCommand = vi.fn();
    const { result, unmount } = renderHook(() => useVoice({ ...r.props, onCommand }));
    act(() => result.current.start("virtual"));
    await waitFor(() => expect(result.current.state).toBe("listening"));

    const envelope = {
      v: 1,
      id: "a",
      ts: "2026-11-20T12:34:56.789Z",
      deviceId: "warashi-sim",
      encounterId: null,
      type: "gaze",
      data: { panDeg: 5, tiltDeg: 0 },
    };
    act(() => {
      r.transport.receiveData(
        r.transport.subscriptionId("/voice/s/out") as string,
        JSON.stringify({ t: "command", envelope }),
      );
    });
    expect(onCommand).toHaveBeenCalledWith(envelope);

    text(r.transport, { t: "transcript", role: "user", text: "こんにちは", final: false });
    expect(result.current.subtitle).toEqual({ role: "user", text: "こんにちは", final: false });

    unmount();
    await waitFor(() => expect(r.endConversation).toHaveBeenCalledWith(session.sessionId));
  });

  it("answers a snapshot.request with the verdict from lookVerdict", async () => {
    const r = rig();
    const { result } = renderHook(() => useVoice({ ...r.props, lookVerdict: () => "stranger" }));
    act(() => result.current.start("virtual"));
    await waitFor(() => expect(result.current.state).toBe("listening"));
    const envelope = {
      v: 1,
      id: "b",
      ts: "2026-11-20T12:34:56.789Z",
      deviceId: "warashi-sim",
      encounterId: null,
      type: "snapshot.request",
      data: { requestId: "req-9" },
    };
    act(() => {
      r.transport.receiveData(
        r.transport.subscriptionId("/voice/s/out") as string,
        JSON.stringify({ t: "command", envelope }),
      );
    });
    expect(r.transport.published("/voice/s/in").at(-1)).toEqual({
      t: "look.result",
      requestId: "req-9",
      verdict: "stranger",
    });
  });
});
