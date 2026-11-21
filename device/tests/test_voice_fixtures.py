"""Tests for the recorded-audio fakes (voice-conversation task 16.5)."""

from __future__ import annotations

import asyncio
import json
from array import array
from typing import Any

from websockets.asyncio.client import connect

from tests.voice_fixtures import (
    MIC_CHUNK_BYTES,
    FakeAppSyncServer,
    RecordedMic,
    RecordedSpeaker,
    ScriptedSession,
    out_audio,
    pcm_base64,
    recorded_chunks,
    reordered_audio,
    silence,
    tone_burst,
)
from warashi_agent.adapters.fakes import ConversationOutcome, FakeConversation
from warashi_agent.conversation import appsync
from warashi_agent.conversation.audio import speech_energy
from warashi_agent.conversation.frames import audio_frame, bye_frame, encode_in, hello_frame
from warashi_agent.conversation.reorder import Reorder
from warashi_agent.model import (
    ConversationFinished,
    Event,
    StartConversation,
    StopConversation,
)
from warashi_agent.timebase import ManualScheduler

TOKEN = "fake-token"


def test_synthetic_audio_is_deterministic_and_in_range() -> None:
    assert tone_burst(3200) == tone_burst(3200)
    assert len(tone_burst(3200)) == 3200
    samples = array("h")
    samples.frombytes(tone_burst(3200, amplitude=40_000))
    assert max(abs(s) for s in samples) <= 32_767
    assert speech_energy(tone_burst(3200)) > 1_000
    assert speech_energy(silence(3200)) == 0.0


def test_recorded_chunks_follow_pattern() -> None:
    chunks = recorded_chunks("TS")
    assert [len(c) for c in chunks] == [MIC_CHUNK_BYTES, MIC_CHUNK_BYTES]
    assert speech_energy(chunks[0]) > 0 and speech_energy(chunks[1]) == 0


def test_recorded_mic_ends_as_scripted() -> None:
    async def run() -> tuple[list[bytes | None], str]:
        mic = RecordedMic(recorded_chunks("TS"), end="eof")
        await mic.start()
        got = [await mic.read(), await mic.read(), await mic.read()]
        failing = RecordedMic([], end="fail")
        try:
            await failing.read()
            outcome = "no error"
        except OSError:
            outcome = "oserror"
        stalled = RecordedMic([], end="stall")
        try:
            await asyncio.wait_for(stalled.read(), 0.05)
        except TimeoutError:
            outcome += "+stall"
        return got, outcome

    got, outcome = asyncio.run(run())
    assert got[0] is not None and got[1] is not None and got[2] is None
    assert outcome == "oserror+stall"


def test_recorded_speaker_collects_and_interrupts() -> None:
    async def run() -> RecordedSpeaker:
        speaker = RecordedSpeaker()
        await speaker.start()
        await speaker.write(b"\x01\x00")
        await speaker.write(b"\x02\x00")
        assert speaker.playing
        speaker.interrupt()
        assert not speaker.playing
        return speaker

    speaker = asyncio.run(run())
    assert speaker.played == b"\x01\x00\x02\x00"
    assert speaker.interrupts == 1 and speaker.bytes_at_interrupt == [4]


async def _open(server: FakeAppSyncServer, token: str = TOKEN, host: str | None = None) -> Any:
    protocols = appsync.subprotocols(host or server.http_host, token)
    return await connect(server.url, subprotocols=protocols)  # type: ignore[arg-type]


async def _recv(ws: Any) -> dict[str, Any]:
    return json.loads(await asyncio.wait_for(ws.recv(), 2))


def test_server_handshake_subscribe_publish_and_scripted_replies() -> None:
    pcm = {0: tone_burst(480), 1: tone_burst(480, freq_hz=880), 2: silence(480)}

    def on_audio(frame: dict[str, Any]) -> list[dict[str, Any]]:
        return [{"t": "interrupt"}] if frame["seq"] == 1 else []

    session = ScriptedSession(
        on_hello=[{"t": "state", "state": "live"}, out_audio(0, pcm[0])],
        on_audio=on_audio,
        on_bye=[{"t": "end", "reason": "user"}],
    )

    async def run() -> FakeAppSyncServer:
        async with FakeAppSyncServer(token=TOKEN, session=session) as server:
            ws = await _open(server)
            await ws.send(appsync.connection_init())
            assert (await _recv(ws))["type"] == "connection_ack"
            for sub_id, channel in (("o", server.channel_out), ("t", server.channel_text)):
                await ws.send(appsync.subscribe(sub_id, channel, server.http_host, TOKEN))
                assert (await _recv(ws))["type"] == "subscribe_success"
            frames = [
                encode_in(hello_frame()),
                encode_in(audio_frame(0, pcm_base64(tone_burst(3200)))),
                encode_in(audio_frame(1, pcm_base64(silence(3200)))),
                encode_in(bye_frame("user")),
            ]
            await ws.send(
                appsync.publish("p1", server.channel_in, frames, server.http_host, TOKEN)
            )
            seen = [await _recv(ws) for _ in range(5)]
            await ws.close()
            kinds = [m["type"] for m in seen]
            assert kinds[0] == "publish_success" and kinds.count("data") == 4
            data = [json.loads(m["event"][0]) for m in seen if m["type"] == "data"]
            assert {d["t"] for d in data} == {"state", "audio", "interrupt", "end"}
            return server

    server = asyncio.run(run())
    assert [f["t"] for f in server.received_in] == ["hello", "audio", "audio", "bye"]
    assert server.handshake_failures == [] and server.rejected == []
    assert server.offered_subprotocols[0][-1] == appsync.SUBPROTOCOL or (
        appsync.SUBPROTOCOL in server.offered_subprotocols[0]
    )


def test_server_rejects_bad_token_without_echoing_it() -> None:
    async def run() -> tuple[FakeAppSyncServer, dict[str, Any]]:
        async with FakeAppSyncServer(token=TOKEN) as server:
            ws = await _open(server, token="wrong-secret-token")
            await ws.send(appsync.connection_init())
            reply = await _recv(ws)
            await ws.close()
            return server, reply

    server, reply = asyncio.run(run())
    assert reply["type"] == "connection_error"
    assert server.handshake_failures == ["wrong token in header subprotocol"]
    assert "wrong-secret-token" not in repr(server.handshake_failures)


def test_server_rejects_wrong_channel_and_sends_out_of_order_and_duplicates() -> None:
    pcm = {i: tone_burst(480, freq_hz=300 + 100 * i) for i in range(3)}

    async def run() -> tuple[FakeAppSyncServer, list[tuple[int, str]]]:
        async with FakeAppSyncServer(token=TOKEN) as server:
            ws = await _open(server)
            await ws.send(appsync.connection_init())
            await _recv(ws)
            await ws.send(appsync.subscribe("bad", "/voice/other/out", server.http_host, TOKEN))
            assert (await _recv(ws))["type"] == "subscribe_error"
            await ws.send(appsync.subscribe("o", server.channel_out, server.http_host, TOKEN))
            await _recv(ws)
            await server.send_out(*reordered_audio(pcm, [0, 2, 1], duplicate=[1]))
            window = Reorder(8)
            delivered: list[tuple[int, str]] = []
            message = await _recv(ws)
            assert len(message["event"]) == 4
            for raw in message["event"]:
                event = json.loads(raw)
                delivered += window.push(event["seq"], event["pcm"])
            await ws.close()
            return server, delivered

    server, delivered = asyncio.run(run())
    assert [seq for seq, _ in delivered] == [0, 1, 2]
    assert server.rejected == ["subscribe '/voice/other/out'"]


def test_fake_conversation_ends_each_session_once() -> None:
    scheduler = ManualScheduler()
    posted: list[Event] = []
    fake = FakeConversation(posted.append, scheduler)
    fake.script(ConversationOutcome(duration_s=5, reason="silence"))
    start = StartConversation(session_id="s1", token="secret", max_s=60, silence_s=10)
    fake.handle(start)
    assert fake.running == "s1" and "secret" not in repr(fake.started)
    fake.handle(StopConversation(session_id="other"))  # stale id changes nothing
    assert fake.running == "s1"
    fake.handle(StopConversation(session_id="s1"))
    fake.handle(StopConversation(session_id="s1"))
    fake.stop()
    scheduler.advance(10)
    assert posted == [ConversationFinished(session_id="s1", reason="user")]
    fake.handle(StartConversation(session_id="s2", token="t", max_s=60, silence_s=10))
    scheduler.advance(61)
    assert posted[-1] == ConversationFinished(session_id="s2", reason="silence")
    assert len(posted) == 2
