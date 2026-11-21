"""Property 11: One end per session, device adapter (voice-conversation task 16.9).

**Validates: Requirements 12.7, 12.8, 12.9, 12.10**

The real ``ConversationAdapter`` runs random sequences of start, stop and short pauses. Nothing
touches a network or an audio device: ``connect`` returns an in-process scripted socket, and the
microphone and speaker are recorded fakes. The server behaviour of a session is chosen per start:

- ``talk``: the session stays open and the server plays audio as soon as it hears ``hello``.
- ``hang``: the session stays open and says nothing (ends only by stop, replacement or shutdown).
- ``clean``: the doll hears no speech and ends by itself with the local silence timer.
- ``drop``: the server drops the connection after ``hello``.
- ``bad_token``: the server answers ``connection_init`` with ``connection_error``.
- ``refuse``: the connection cannot be opened.
- ``no_data``: the microphone produces no data (the stall limit is shortened for the test).
- ``mic_fail``: the microphone read fails.

Checked after every sequence, once the adapter has been stopped and every worker thread has
ended: each started session id has exactly one ``ConversationFinished`` (and no other id has
one), repeated stops add nothing, every microphone and speaker that was created is closed (the
fake of "no ``arecord`` or ``aplay`` left"), and while ``conversation_mute_mic_while_speaking``
is on no microphone chunk is published while the speaker is playing.

The design asks for a manual scheduler. The adapter's worker is a real thread with its own event
loop and the client's timers use real time, so the test keeps every real wait short (a silence
limit of 0, a 50 ms microphone stall limit) instead of faking time.
"""

from __future__ import annotations

import asyncio
import base64
import json
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any
from unittest import mock

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from tests.voice_fixtures import RecordedMic, RecordedSpeaker, tone_burst
from warashi_agent.adapters.conversation import ConversationAdapter
from warashi_agent.config import Config, ConversationConfig
from warashi_agent.conversation import client as client_module
from warashi_agent.model import (
    ConversationFinished,
    Event,
    StartConversation,
    StopConversation,
)

pytestmark = pytest.mark.timeout(300)

SESSION_IDS = ("s0", "s1", "s2")
BEHAVIOURS = ("talk", "hang", "clean", "drop", "bad_token", "refuse", "no_data", "mic_fail")
HTTP_HOST = "http.fake-appsync.invalid"
JOIN_S = 20.0


# -- scripted ends: socket, microphone, speaker ---------------------------------------------


@dataclass
class Bundle:
    """Everything one session uses, so the test can inspect it afterwards."""

    behaviour: str
    mic: RecordedMic
    speaker: RecordedSpeaker
    mute_mic: bool
    violations: int = 0
    audio_published: int = 0
    connected: bool = False


class EndlessMic(RecordedMic):
    """A microphone that delivers one tone chunk every 5 ms, forever."""

    def __init__(self) -> None:
        super().__init__([], end="stall")
        self._chunk = tone_burst(3_200)

    async def read(self) -> bytes | None:
        await asyncio.sleep(0.005)
        return self._chunk


class ScriptedWs:
    """The slice of a websocket the client uses, answering the AppSync handshake in memory."""

    def __init__(self, bundle: Bundle) -> None:
        self._bundle = bundle
        self._queue: asyncio.Queue[str | Exception] = asyncio.Queue()
        self._sub_ids: dict[str, str] = {}

    async def send(self, message: str) -> None:
        # No await before the bookkeeping: the half-duplex check must see the speaker state of
        # the moment the client decided to send.
        data = json.loads(message)
        kind = data["type"]
        if kind == "connection_init":
            if self._bundle.behaviour == "bad_token":
                self._queue.put_nowait(
                    json.dumps(
                        {"type": "connection_error", "errors": [{"errorType": "Unauthorized"}]}
                    )
                )
            else:
                self._queue.put_nowait(
                    json.dumps({"type": "connection_ack", "connectionTimeoutMs": 300_000})
                )
        elif kind == "subscribe":
            self._sub_ids[data["channel"]] = data["id"]
            self._queue.put_nowait(json.dumps({"type": "subscribe_success", "id": data["id"]}))
        elif kind == "publish":
            for raw in data["events"]:
                self._on_frame(json.loads(raw))

    def _on_frame(self, frame: dict[str, Any]) -> None:
        if frame["t"] == "audio":
            self._bundle.audio_published += 1
            if self._bundle.mute_mic and self._bundle.speaker.playing:
                self._bundle.violations += 1
        elif frame["t"] == "hello":
            if self._bundle.behaviour == "drop":
                self._queue.put_nowait(ConnectionResetError("dropped"))
            elif self._bundle.behaviour == "talk":
                out_id = next(v for k, v in self._sub_ids.items() if k.endswith("/out"))
                pcm = base64.b64encode(tone_burst(4_800, rate_hz=24_000)).decode("ascii")
                events = [json.dumps({"t": "audio", "seq": i, "pcm": pcm}) for i in range(3)]
                self._queue.put_nowait(json.dumps({"type": "data", "id": out_id, "event": events}))

    async def recv(self) -> str:
        item = await self._queue.get()
        if isinstance(item, Exception):
            raise item
        return item

    async def close(self) -> None:
        return None


@dataclass
class Rig:
    """The adapter plus everything the factories and ``connect`` created for it."""

    mute_mic: bool
    bundles: dict[str, Bundle] = field(default_factory=dict)
    order: list[Bundle] = field(default_factory=list)
    _next: str = "hang"
    _count: int = 0
    _pending: Bundle | None = None
    posted: list[Event] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def post(self, event: Event) -> None:
        with self._lock:
            self.posted.append(event)

    # factories: called by ``handle`` on the caller's thread, mic first and then speaker
    def mic_factory(self) -> RecordedMic:
        behaviour = self._next
        if behaviour == "no_data":
            mic: RecordedMic = RecordedMic([], end="stall")
        elif behaviour == "mic_fail":
            mic = RecordedMic([], end="fail")
        else:
            mic = EndlessMic()
        speaker = RecordedSpeaker()
        bundle = Bundle(behaviour, mic, speaker, self.mute_mic)
        self.order.append(bundle)
        self._pending = bundle
        return mic

    def speaker_factory(self) -> RecordedSpeaker:
        assert self._pending is not None
        return self._pending.speaker

    def start_action(self, session_id: str, behaviour: str) -> StartConversation:
        self._next = behaviour
        self._count += 1
        token = f"tok{self._count}"
        return StartConversation(
            session_id=session_id,
            token=token,
            max_s=120,
            silence_s=0 if behaviour == "clean" else 30,
        )

    async def connect(self, _url: str, *, subprotocols: list[str]) -> ScriptedWs:
        header = subprotocols[0].removeprefix("header-")
        auth = json.loads(base64.urlsafe_b64decode(header + "=" * (-len(header) % 4)))
        # ``bind`` may not have run yet when a fast worker connects; wait for it briefly.
        deadline = time.monotonic() + 5
        while auth["Authorization"] not in self.bundles and time.monotonic() < deadline:
            await asyncio.sleep(0.001)
        bundle = self.bundles[auth["Authorization"]]
        if bundle.behaviour == "refuse":
            raise OSError("connection refused")
        bundle.connected = True
        return ScriptedWs(bundle)


# -- operations -----------------------------------------------------------------------------

# ("start", session id, behaviour) | ("stop", session id, "") | ("pause", "", "")
Op = tuple[str, str, str]

ops = st.one_of(
    st.tuples(st.just("start"), st.sampled_from(SESSION_IDS), st.sampled_from(BEHAVIOURS)),
    st.tuples(st.just("stop"), st.sampled_from(SESSION_IDS), st.just("")),
    st.tuples(st.just("pause"), st.just(""), st.just("")),
)


def conversation_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name == "warashi-conversation"]


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(sequence=st.lists(ops, min_size=1, max_size=6), mute_mic=st.booleans())
def test_every_session_id_gets_exactly_one_end(sequence: list[Op], mute_mic: bool) -> None:
    rig = Rig(mute_mic=mute_mic)
    config = Config(conversation=ConversationConfig(conversation_mute_mic_while_speaking=mute_mic))
    adapter = ConversationAdapter(
        rig.post,
        config,
        connect=rig.connect,
        mic_factory=rig.mic_factory,
        speaker_factory=rig.speaker_factory,
    )
    started: set[str] = set()

    with mock.patch.object(client_module, "MIC_STALL_S", 0.05):
        for kind, session_id, behaviour in sequence:
            if kind == "start":
                action = rig.start_action(session_id, behaviour)
                before = len(rig.order)
                adapter.handle(action)
                started.add(session_id)
                if len(rig.order) > before:  # a refused start (after stop) builds nothing
                    rig.bundles[action.token] = rig.order[-1]
            elif kind == "stop":
                adapter.handle(StopConversation(session_id=session_id))
                adapter.handle(StopConversation(session_id=session_id))  # idempotent
            else:
                time.sleep(0.02)

        adapter.stop()
        adapter.stop()
        deadline = time.monotonic() + JOIN_S
        for thread in conversation_threads():
            thread.join(max(0.0, deadline - time.monotonic()))

    # No worker is left, so no audio process of a real run would be left either.
    assert conversation_threads() == []
    assert adapter.wait_idle(1)

    ends = Counter(e.session_id for e in rig.posted if isinstance(e, ConversationFinished))
    assert ends == Counter(dict.fromkeys(started, 1))

    # Every microphone and speaker that was built has been closed (arecord and aplay with them).
    for bundle in rig.order:
        assert bundle.mic.closed and bundle.speaker.closed, bundle.behaviour
        # Half-duplex: no microphone chunk reached the wire while the doll was speaking.
        assert bundle.violations == 0

    # Stops after the end add nothing.
    adapter.handle(StopConversation(session_id=SESSION_IDS[0]))
    adapter.stop()
    after = Counter(e.session_id for e in rig.posted if isinstance(e, ConversationFinished))
    assert after == ends
