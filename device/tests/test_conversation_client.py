"""Tests for the conversation audio client (voice-conversation task 16.7).

The client runs against the loopback ``FakeAppSyncServer``, ``RecordedMic`` and
``RecordedSpeaker`` of ``voice_fixtures.py``. Time is the real monotonic clock with short silence
and keep-alive limits, so every test finishes within a few seconds; pytest-timeout fails a test
that blocks.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections.abc import Callable
from typing import Any

import pytest
from websockets.asyncio.client import connect as ws_connect

from tests.voice_fixtures import (
    MIC_CHUNK_BYTES,
    FakeAppSyncServer,
    RecordedMic,
    RecordedSpeaker,
    ScriptedSession,
    out_audio,
    recorded_chunks,
    tone_burst,
)
from warashi_agent.config import ConversationConfig
from warashi_agent.conversation.audio import apply_gain
from warashi_agent.conversation.client import (
    AppSyncHosts,
    ConversationClient,
    ConversationOutcome,
)
from warashi_agent.model import StartConversation
from warashi_agent.timebase import MonotonicClock

TOKEN = "SECRET-token-0123456789"
SID = "00000000-0000-4000-8000-000000000001"
HOSTS = AppSyncHosts(realtime="realtime.fake-appsync.invalid", http="http.fake-appsync.invalid")


def make_start(*, silence_s: int = 30, token: str = TOKEN) -> StartConversation:
    return StartConversation(session_id=SID, token=token, max_s=120, silence_s=silence_s)


def make_server(**kwargs: Any) -> FakeAppSyncServer:
    kwargs.setdefault("session_id", SID)
    kwargs.setdefault("token", TOKEN)
    kwargs.setdefault("http_host", HOSTS.http)
    return FakeAppSyncServer(**kwargs)


def make_connect(server: FakeAppSyncServer) -> Callable[..., Any]:
    """Connect to the loopback server, keeping the subprotocols the client offers."""

    async def connect(_url: str, *, subprotocols: list[str]) -> Any:
        return await ws_connect(server.url, subprotocols=subprotocols)  # type: ignore[arg-type]

    return connect


def make_client(
    server: FakeAppSyncServer,
    mic: RecordedMic,
    speaker: RecordedSpeaker,
    *,
    connect: Callable[..., Any] | None = None,
    log: logging.Logger | None = None,
    **cfg: Any,
) -> ConversationClient:
    return ConversationClient(
        ConversationConfig(**cfg),
        HOSTS,
        mic,
        speaker,
        connect if connect is not None else make_connect(server),
        MonotonicClock(),
        log if log is not None else logging.getLogger("test.conversation"),
    )


async def until(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.01)


async def run_until(
    client: ConversationClient,
    start: StartConversation,
    predicate: Callable[[], bool] | None = None,
    *,
    stop_reason: str = "user",
) -> ConversationOutcome:
    """Run the client; when ``predicate`` holds, ask it to stop. Returns its outcome."""
    task = asyncio.create_task(client.run(start))
    if predicate is not None:
        try:
            await until(predicate)
        finally:
            client.request_stop(stop_reason)
    return await asyncio.wait_for(task, 10)


def frames_of(server: FakeAppSyncServer, kind: str) -> list[dict[str, Any]]:
    return [f for f in server.received_in if f["t"] == kind]


class GatedMic(RecordedMic):
    """A ``RecordedMic`` that returns nothing until ``gate`` is set."""

    def __init__(self, chunks: list[bytes], gate: asyncio.Event) -> None:
        super().__init__(chunks, end="stall")
        self._gate = gate

    async def read(self) -> bytes | None:
        await self._gate.wait()
        return await super().read()


class SilentMic(RecordedMic):
    """A microphone that delivers one silent 100 ms chunk every 100 ms, forever."""

    async def read(self) -> bytes | None:
        await asyncio.sleep(0.1)
        return recorded_chunks("S")[0]


# -- connect, subscribe, hello, audio both ways ---------------------------------------------


def test_connect_subscribe_hello_and_audio_both_ways() -> None:
    pcm = tone_burst(4800, rate_hz=24_000)
    session = ScriptedSession(on_hello=[out_audio(0, pcm)])
    chunks = recorded_chunks("TT")

    async def scenario() -> None:
        async with make_server(session=session) as server:
            mic, speaker = RecordedMic(chunks), RecordedSpeaker()
            client = make_client(server, mic, speaker)
            outcome = await run_until(
                client,
                make_start(),
                lambda: len(frames_of(server, "audio")) >= 2 and speaker.played == pcm,
            )
            assert outcome == ConversationOutcome("user", None)
            # subscribed to out, with the offered subprotocols accepted
            assert server.channel_out in server.subscriptions
            assert server.handshake_failures == []
            assert any(p.startswith("header-") for p in server.offered_subprotocols[0])
            # hello comes first, then audio with increasing seq and the gain applied
            assert server.received_in[0] == {"t": "hello", "client": "device", "v": 1}
            audio = frames_of(server, "audio")
            assert [f["seq"] for f in audio] == [0, 1]
            import base64

            assert base64.b64decode(audio[0]["pcm"]) == apply_gain(chunks[0], 4.0)
            # a clean stop says bye and releases both audio devices
            assert frames_of(server, "bye") == [{"t": "bye", "reason": "user"}]
            assert mic.started and mic.closed and speaker.started and speaker.closed

    asyncio.run(scenario())


def test_out_audio_is_played_in_order_without_duplicates() -> None:
    parts = {i: tone_burst(480, freq_hz=200.0 + 100 * i, rate_hz=24_000) for i in range(3)}
    session = ScriptedSession(
        on_hello=[
            out_audio(0, parts[0]),
            out_audio(2, parts[2]),
            out_audio(1, parts[1]),
            out_audio(1, parts[1]),
            out_audio(0, parts[0]),
        ]
    )

    async def scenario() -> None:
        async with make_server(session=session) as server:
            speaker = RecordedSpeaker()
            client = make_client(server, RecordedMic([]), speaker)
            outcome = await run_until(client, make_start(), lambda: len(speaker.writes) >= 3)
            await asyncio.sleep(0.1)
            assert outcome.reason == "user"
            assert speaker.writes == [parts[0], parts[1], parts[2]]

    asyncio.run(scenario())


def test_malformed_and_unknown_out_frames_are_ignored() -> None:
    pcm = tone_burst(480, rate_hz=24_000)

    async def scenario() -> None:
        async with make_server() as server:
            speaker = RecordedSpeaker()
            client = make_client(server, RecordedMic([]), speaker)
            task = asyncio.create_task(client.run(make_start()))
            await until(lambda: SID in "".join(server.subscriptions))
            await until(lambda: len(server.received_in) >= 1)
            await server.send_out_raw(
                "not json", '{"t":"mystery"}', '{"t":"audio","seq":0,"pcm":"***"}'
            )
            await server.send_out(out_audio(0, pcm))
            await until(lambda: speaker.played == pcm)
            client.request_stop("user")
            assert (await asyncio.wait_for(task, 5)).reason == "user"

    asyncio.run(scenario())


def test_interrupt_stops_playback() -> None:
    pcm = tone_burst(4800, rate_hz=24_000)

    async def scenario() -> None:
        async with make_server(session=ScriptedSession(on_hello=[out_audio(0, pcm)])) as server:
            speaker = RecordedSpeaker()
            client = make_client(server, RecordedMic([]), speaker)
            task = asyncio.create_task(client.run(make_start()))
            await until(lambda: speaker.playing)
            assert speaker.interrupts == 0
            await server.send_out({"t": "interrupt"})
            await until(lambda: speaker.interrupts == 1)
            assert not speaker.playing
            assert speaker.bytes_at_interrupt == [len(pcm)]
            client.request_stop("user")
            await asyncio.wait_for(task, 5)

    asyncio.run(scenario())


# -- half-duplex -----------------------------------------------------------------------------


@pytest.mark.parametrize("mute", [True, False])
def test_half_duplex_sends_no_chunk_while_playing(mute: bool) -> None:
    pcm = tone_burst(4800, rate_hz=24_000)

    async def scenario() -> None:
        async with make_server(session=ScriptedSession(on_hello=[out_audio(0, pcm)])) as server:
            gate = asyncio.Event()
            mic = GatedMic(recorded_chunks("TTT"), gate)
            speaker = RecordedSpeaker()
            client = make_client(server, mic, speaker, conversation_mute_mic_while_speaking=mute)
            task = asyncio.create_task(client.run(make_start()))
            await until(lambda: speaker.playing)  # the doll is talking before the mic delivers
            gate.set()
            await until(lambda: mic.reads == 3)
            await asyncio.sleep(0.2)
            sent = len(frames_of(server, "audio"))
            client.request_stop("user")
            await asyncio.wait_for(task, 5)
            assert sent == (0 if mute else 3)

    asyncio.run(scenario())


def test_half_duplex_resumes_after_playback_finishes() -> None:
    pcm = tone_burst(4800, rate_hz=24_000)

    async def scenario() -> None:
        async with make_server(session=ScriptedSession(on_hello=[out_audio(0, pcm)])) as server:
            gate = asyncio.Event()
            mic = GatedMic(recorded_chunks("T"), gate)
            speaker = RecordedSpeaker()
            client = make_client(server, mic, speaker, conversation_mute_mic_while_speaking=True)
            task = asyncio.create_task(client.run(make_start()))
            await until(lambda: speaker.playing)
            speaker.finish()
            gate.set()
            await until(lambda: len(frames_of(server, "audio")) == 1)
            client.request_stop("user")
            await asyncio.wait_for(task, 5)

    asyncio.run(scenario())


# -- failure paths ---------------------------------------------------------------------------


def test_server_drop_is_conversation_failed() -> None:
    async def scenario() -> None:
        async with make_server() as server:
            mic, speaker = RecordedMic([]), RecordedSpeaker()
            client = make_client(server, mic, speaker)
            task = asyncio.create_task(client.run(make_start()))
            await until(lambda: len(server.received_in) >= 1)
            await server.drop()
            outcome = await asyncio.wait_for(task, 5)
            assert outcome == ConversationOutcome("error", "conversation_failed")
            assert frames_of(server, "bye") == []  # the link is broken: no bye attempt
            assert mic.closed and speaker.closed

    asyncio.run(scenario())


def test_bad_token_is_conversation_failed_and_starts_no_audio() -> None:
    async def scenario() -> None:
        async with make_server() as server:
            mic, speaker = RecordedMic(), RecordedSpeaker()
            client = make_client(server, mic, speaker)
            outcome = await asyncio.wait_for(client.run(make_start(token="WRONG-token")), 5)
            assert outcome == ConversationOutcome("error", "conversation_failed")
            assert server.handshake_failures
            assert server.received_in == []
            assert not mic.started and not speaker.started
            assert mic.closed and speaker.closed  # cleanup still runs

    asyncio.run(scenario())


def test_connect_failure_and_timeout_are_conversation_failed() -> None:
    async def refuse(_url: str, **_kw: Any) -> Any:
        raise OSError("connection refused")

    async def hang(_url: str, **_kw: Any) -> Any:
        await asyncio.Event().wait()

    async def scenario() -> None:
        server = make_server()
        for connect, cfg in ((refuse, {}), (hang, {"conversation_connect_timeout_s": 0.2})):
            client = make_client(server, RecordedMic(), RecordedSpeaker(), connect=connect, **cfg)
            outcome = await asyncio.wait_for(client.run(make_start()), 5)
            assert outcome == ConversationOutcome("error", "conversation_failed")

    asyncio.run(scenario())


def test_silent_server_connection_is_dropped_after_keepalive_timeout() -> None:
    async def scenario() -> None:
        async with make_server(connection_timeout_ms=300) as server:
            client = make_client(server, RecordedMic([]), RecordedSpeaker())
            outcome = await asyncio.wait_for(client.run(make_start()), 5)
            assert outcome == ConversationOutcome("error", "conversation_failed")

    asyncio.run(scenario())


@pytest.mark.parametrize("end", ["eof", "fail", "stall"])
def test_microphone_ending_is_microphone_failed(end: str) -> None:
    async def scenario() -> None:
        async with make_server() as server:
            mic, speaker = RecordedMic(recorded_chunks("T"), end=end), RecordedSpeaker()
            client = make_client(server, mic, speaker)
            started = time.monotonic()
            outcome = await asyncio.wait_for(client.run(make_start()), 10)
            assert outcome == ConversationOutcome("error", "microphone_failed")
            if end == "stall":  # no data for MIC_STALL_S (2 s) ends the session
                assert 1.5 <= time.monotonic() - started < 6
            # the link is fine, so the client says goodbye with reason "error"
            assert frames_of(server, "bye") == [{"t": "bye", "reason": "error"}]
            assert mic.closed and speaker.closed

    asyncio.run(scenario())


def test_microphone_that_cannot_start_is_microphone_failed() -> None:
    async def scenario() -> None:
        async with make_server() as server:
            mic = RecordedMic(fail_start=True)
            client = make_client(server, mic, RecordedSpeaker())
            outcome = await asyncio.wait_for(client.run(make_start()), 5)
            assert outcome == ConversationOutcome("error", "microphone_failed")
            assert frames_of(server, "hello") == []

    asyncio.run(scenario())


# -- silence and stop ------------------------------------------------------------------------


def test_local_silence_ends_the_session() -> None:
    async def scenario() -> None:
        async with make_server() as server:
            client = make_client(server, RecordedMic(recorded_chunks("SSSS")), RecordedSpeaker())
            started = time.monotonic()
            outcome = await asyncio.wait_for(client.run(make_start(silence_s=1)), 10)
            assert outcome == ConversationOutcome("silence", None)
            assert 0.9 <= time.monotonic() - started < 5
            assert frames_of(server, "bye") == [{"t": "bye", "reason": "silence"}]

    asyncio.run(scenario())


def test_playback_keeps_the_silence_timer_from_firing() -> None:
    pcm = tone_burst(4800, rate_hz=24_000)

    async def scenario() -> None:
        async with make_server(session=ScriptedSession(on_hello=[out_audio(0, pcm)])) as server:
            speaker = RecordedSpeaker()  # stays "playing" until finish()
            client = make_client(server, SilentMic(), speaker)
            task = asyncio.create_task(client.run(make_start(silence_s=1)))
            await asyncio.sleep(1.6)
            assert not task.done()
            speaker.finish()
            outcome = await asyncio.wait_for(task, 5)
            assert outcome.reason == "silence"

    asyncio.run(scenario())


def test_speech_resets_the_silence_timer() -> None:
    async def scenario() -> None:
        async with make_server() as server:
            gate = asyncio.Event()
            mic = GatedMic(recorded_chunks("T"), gate)
            client = make_client(server, mic, RecordedSpeaker())
            started = time.monotonic()
            task = asyncio.create_task(client.run(make_start(silence_s=1)))
            await asyncio.sleep(0.7)
            gate.set()  # speech arrives 0.7 s in, so silence ends at about 1.7 s
            outcome = await asyncio.wait_for(task, 10)
            assert outcome.reason == "silence"
            assert time.monotonic() - started >= 1.5

    asyncio.run(scenario())


def test_request_stop_ends_with_that_reason_and_first_reason_wins() -> None:
    async def scenario() -> None:
        async with make_server() as server:
            client = make_client(server, RecordedMic([]), RecordedSpeaker())
            task = asyncio.create_task(client.run(make_start()))
            await until(lambda: len(server.received_in) >= 1)
            # from another thread, twice: the first reason wins and nothing breaks
            threading.Thread(target=client.request_stop, args=("limit",)).start()
            await asyncio.sleep(0.05)
            client.request_stop("user")
            outcome = await asyncio.wait_for(task, 5)
            assert outcome == ConversationOutcome("limit", None)
            assert frames_of(server, "bye") == [{"t": "bye", "reason": "limit"}]
            client.request_stop("user")  # after the end: a harmless no-op

    asyncio.run(scenario())


def test_stop_before_run_never_connects() -> None:
    async def scenario() -> None:
        async with make_server() as server:
            mic, speaker = RecordedMic(), RecordedSpeaker()
            client = make_client(server, mic, speaker)
            client.request_stop("user")
            outcome = await asyncio.wait_for(client.run(make_start()), 5)
            assert outcome == ConversationOutcome("user", None)
            assert server.offered_subprotocols == []
            assert not mic.started
            assert mic.closed and speaker.closed

    asyncio.run(scenario())


def test_cancelling_run_still_releases_audio() -> None:
    async def scenario() -> None:
        async with make_server() as server:
            mic, speaker = RecordedMic([]), RecordedSpeaker()
            client = make_client(server, mic, speaker)
            task = asyncio.create_task(client.run(make_start()))
            await until(lambda: len(server.received_in) >= 1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert mic.closed and speaker.closed

    asyncio.run(scenario())


# -- the token is a secret -------------------------------------------------------------------


def test_token_never_appears_in_logs_or_repr(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    log = logging.getLogger("test.conversation.secret")
    start = make_start()
    wrong = make_start(token="OTHER-secret-token")

    async def scenario() -> list[ConversationClient]:
        clients: list[ConversationClient] = []
        async with make_server() as server:
            # a clean session, a rejected token, a refused connection and a server drop
            ok = make_client(server, RecordedMic(recorded_chunks("T")), RecordedSpeaker(), log=log)
            clients.append(ok)
            await run_until(ok, start, lambda: len(frames_of(server, "audio")) >= 1)

            bad = make_client(server, RecordedMic(), RecordedSpeaker(), log=log)
            clients.append(bad)
            await asyncio.wait_for(bad.run(wrong), 5)

            async def refuse(_url: str, **kw: Any) -> Any:
                raise OSError(f"refused {kw}")  # the exception text itself carries the token

            refused = make_client(
                server, RecordedMic(), RecordedSpeaker(), connect=refuse, log=log
            )
            clients.append(refused)
            await asyncio.wait_for(refused.run(start), 5)

            dropped = make_client(server, RecordedMic([]), RecordedSpeaker(), log=log)
            clients.append(dropped)
            task = asyncio.create_task(dropped.run(start))
            await until(lambda: len(server.received_in) >= 1)
            await server.drop()
            await asyncio.wait_for(task, 5)
        return clients

    clients = asyncio.run(scenario())
    assert caplog.records, "the failure paths should have logged something"
    for secret in (TOKEN, "OTHER-secret-token"):
        assert secret not in caplog.text
        assert secret not in repr(start) + repr(wrong)
        for client in clients:
            assert secret not in repr(client)
            assert secret not in repr(vars(client))


def test_idle_chunk_size_matches_config() -> None:
    """With ``conversation_chunk_ms=50`` the client sends 1,600-byte chunks."""

    async def scenario() -> None:
        async with make_server() as server:
            big = tone_burst(MIC_CHUNK_BYTES)
            client = make_client(
                server, RecordedMic([big]), RecordedSpeaker(), conversation_chunk_ms=50
            )
            await run_until(client, make_start(), lambda: len(frames_of(server, "audio")) >= 2)
            import base64

            audio = frames_of(server, "audio")
            assert all(len(base64.b64decode(f["pcm"])) == 1600 for f in audio[:2])

    asyncio.run(scenario())
