"""Recorded-audio fakes for the voice conversation client (voice-conversation task 16.5).

CI has no microphone, no Pi and no AWS account. Everything here is synthetic: tone bursts and
silence are generated at test time from a fixed formula, so no real voice is committed.

- ``tone_burst`` / ``silence`` / ``recorded_chunks`` build 16 kHz S16LE mono audio.
- ``RecordedMic`` returns those chunks; ``RecordedSpeaker`` collects every byte played.
- ``FakeAppSyncServer`` is a ``websockets`` server on loopback that speaks the AppSync Events
  handshake, checks the subprotocols and the token, relays ``in`` frames to a ``ScriptedSession``
  and sends ``out`` frames, including out-of-order and duplicate ones.

The network guard of ``conftest.py`` allows loopback only, and so does the server (127.0.0.1).
``MicSource`` and ``SpeakerSink`` are the slice of the real ``arecord`` / ``aplay`` wrappers that
the conversation client needs. They are defined in ``conversation/client.py`` and re-exported here.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import json
import math
from array import array
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from websockets.asyncio.server import ServerConnection, serve

from warashi_agent.conversation import appsync
from warashi_agent.conversation.client import MicSource, SpeakerSink  # noqa: F401
from warashi_agent.conversation.frames import Malformed, Valid, decode_in

MIC_RATE_HZ = 16_000
SPEAKER_RATE_HZ = 24_000
#: 100 ms of 16 kHz S16LE mono, the chunk size of the conversation client (schema.md).
MIC_CHUNK_BYTES = 3_200

# --------------------------------------------------------------------------------------------
# Synthetic audio
# --------------------------------------------------------------------------------------------


def silence(n_bytes: int) -> bytes:
    """``n_bytes`` of digital silence (``n_bytes`` is rounded down to a whole sample)."""
    return bytes(n_bytes - n_bytes % 2)


def tone_burst(
    n_bytes: int,
    *,
    freq_hz: float = 440.0,
    amplitude: int = 8_000,
    rate_hz: int = MIC_RATE_HZ,
) -> bytes:
    """A sine tone of ``n_bytes`` bytes (even), deterministic and always within 16-bit range."""
    amplitude = max(0, min(32_767, amplitude))
    samples = array(
        "h",
        (
            round(amplitude * math.sin(2 * math.pi * freq_hz * i / rate_hz))
            for i in range(n_bytes // 2)
        ),
    )
    if array("h", [1]).tobytes() != b"\x01\x00":  # big-endian host
        samples.byteswap()
    return samples.tobytes()


def recorded_chunks(
    pattern: str = "TTSS", *, chunk_bytes: int = MIC_CHUNK_BYTES, amplitude: int = 8_000
) -> list[bytes]:
    """One chunk per letter of ``pattern``: ``T`` is a tone burst, ``S`` is silence."""
    if chunk_bytes <= 0 or chunk_bytes % 2:
        raise ValueError("chunk_bytes must be a positive even number")
    out: list[bytes] = []
    for letter in pattern:
        if letter == "T":
            out.append(tone_burst(chunk_bytes, amplitude=amplitude))
        elif letter == "S":
            out.append(silence(chunk_bytes))
        else:
            raise ValueError(f"unknown pattern letter {letter!r}")
    return out


def pcm_base64(pcm: bytes) -> str:
    return base64.b64encode(pcm).decode("ascii")


# --------------------------------------------------------------------------------------------
# Microphone and speaker
# --------------------------------------------------------------------------------------------


class RecordedMic:
    """MicSource that returns the given chunks in order, then ends as ``end`` says.

    ``end`` is ``"eof"`` (``read`` returns ``None``, like ``arecord`` exiting), ``"stall"``
    (``read`` waits forever, like a microphone that produces no data) or ``"fail"`` (``read``
    raises ``OSError``). ``fail_start`` makes ``start`` raise. ``read`` yields to the event loop
    once per chunk so a test loop can run other tasks.
    """

    def __init__(
        self,
        chunks: list[bytes] | None = None,
        *,
        end: str = "stall",
        fail_start: bool = False,
    ) -> None:
        if end not in ("eof", "stall", "fail"):
            raise ValueError("end must be eof, stall or fail")
        self._chunks = list(recorded_chunks() if chunks is None else chunks)
        self._end = end
        self._fail_start = fail_start
        self.started = False
        self.closed = False
        self.reads = 0

    async def start(self) -> None:
        if self._fail_start:
            raise OSError("recorded mic could not start")
        self.started = True

    async def read(self) -> bytes | None:
        await asyncio.sleep(0)
        if self._chunks:
            self.reads += 1
            return self._chunks.pop(0)
        if self._end == "eof":
            return None
        if self._end == "fail":
            raise OSError("recorded mic failed")
        await asyncio.Event().wait()  # stall until the client cancels the read
        return None

    async def close(self) -> None:
        self.closed = True


class RecordedSpeaker:
    """SpeakerSink that collects every byte played.

    ``played`` is all bytes written, in order, and ``writes`` the individual buffers. ``playing``
    is true from the first write until ``interrupt()`` or ``finish()``. ``interrupt()`` counts
    in ``interrupts`` and records how many bytes had been played at that moment.
    """

    def __init__(self) -> None:
        self.writes: list[bytes] = []
        self.interrupts = 0
        self.bytes_at_interrupt: list[int] = []
        self.started = False
        self.closed = False
        self._playing = False

    @property
    def played(self) -> bytes:
        return b"".join(self.writes)

    @property
    def playing(self) -> bool:
        return self._playing

    async def start(self) -> None:
        self.started = True

    async def write(self, pcm: bytes) -> None:
        self.writes.append(pcm)
        self._playing = True

    def interrupt(self) -> None:
        self.interrupts += 1
        self.bytes_at_interrupt.append(sum(len(w) for w in self.writes))
        self._playing = False

    def finish(self) -> None:
        """The test says the queued audio has been played to the end."""
        self._playing = False

    async def close(self) -> None:
        self.closed = True
        self._playing = False


# --------------------------------------------------------------------------------------------
# Fake AppSync Events server
# --------------------------------------------------------------------------------------------

Frame = dict[str, Any]


@dataclass
class ScriptedSession:
    """What the fake session sends back. Every list holds ``out`` / ``text`` frames (dicts).

    - ``on_hello``: sent once, after the first ``hello``.
    - ``on_audio``: called with each ``in`` ``audio`` frame; returns frames to send.
    - ``on_bye``: sent after a ``bye``.
    ``raw`` frames are sent as given (use them for malformed or unknown frames).
    """

    on_hello: list[Frame] = field(default_factory=list)
    on_audio: Callable[[Frame], list[Frame]] | None = None
    on_bye: list[Frame] = field(default_factory=list)


def out_audio(seq: int, pcm: bytes) -> Frame:
    return {"t": "audio", "seq": seq, "pcm": pcm_base64(pcm)}


def reordered_audio(
    pcm_by_seq: dict[int, bytes], order: list[int], *, duplicate: list[int] | None = None
) -> list[Frame]:
    """``out`` audio frames in the given send ``order``; ``duplicate`` seqs are sent twice."""
    frames = [out_audio(seq, pcm_by_seq[seq]) for seq in order]
    for seq in duplicate or []:
        frames.append(out_audio(seq, pcm_by_seq[seq]))
    return frames


class FakeAppSyncServer:
    """A ``websockets`` server on 127.0.0.1 that plays the AppSync Events API for one session.

    Protocol, as the client of ``appsync.py`` uses it:

    1. The client offers the subprotocols ``header-<b64url>`` and ``aws-appsync-event-ws``. The
       server checks both are offered and that the header carries ``http_host`` and ``token``.
       A mismatch is recorded in ``handshake_failures`` and answered with ``connection_error``
       (``UnauthorizedException``) after ``connection_init``, then the socket closes.
    2. ``connection_init`` gets ``connection_ack``.
    3. ``subscribe`` on ``/voice/<sid>/out`` or ``/voice/<sid>/text`` with the right token gets
       ``subscribe_success``; anything else gets ``subscribe_error``.
    4. ``publish`` to ``/voice/<sid>/in`` with the right token and 1 to 5 events gets
       ``publish_success``; each event is decoded with ``decode_in`` and relayed to the
       ``ScriptedSession``; anything else gets ``publish_error``.

    Use it as ``async with FakeAppSyncServer(session_id=..., token=...) as server`` and connect
    to ``server.url``. Everything the server sees is recorded for assertions.
    """

    def __init__(
        self,
        *,
        session_id: str = "00000000-0000-4000-8000-000000000001",
        token: str = "fake-token",
        http_host: str = "http.fake-appsync.invalid",
        session: ScriptedSession | None = None,
        connection_timeout_ms: int = 300_000,
    ) -> None:
        self.session_id = session_id
        self.token = token
        self.http_host = http_host
        self.session = session if session is not None else ScriptedSession()
        self.connection_timeout_ms = connection_timeout_ms
        self.offered_subprotocols: list[list[str]] = []
        self.handshake_failures: list[str] = []
        self.subscriptions: dict[str, str] = {}  # channel -> subscription id
        self.received_in: list[Frame] = []
        self.malformed_in = 0
        self.publish_count = 0
        self.rejected: list[str] = []
        self._server: Any = None
        self._connection: ServerConnection | None = None
        self._hello_answered = False
        self.port = 0

    # -- lifecycle ----------------------------------------------------------------------

    async def __aenter__(self) -> FakeAppSyncServer:
        self._server = await serve(
            self._handle,
            "127.0.0.1",
            0,
            subprotocols=[appsync.SUBPROTOCOL],  # type: ignore[list-item]
            ping_interval=None,
        )
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        self._server.close()
        await self._server.wait_closed()

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/event/realtime"

    @property
    def channel_in(self) -> str:
        return f"/voice/{self.session_id}/in"

    @property
    def channel_out(self) -> str:
        return f"/voice/{self.session_id}/out"

    @property
    def channel_text(self) -> str:
        return f"/voice/{self.session_id}/text"

    @property
    def connected(self) -> bool:
        return self._connection is not None

    # -- sending to the client ----------------------------------------------------------

    async def send_out(self, *frames: Frame) -> None:
        """Send frames on the ``out`` subscription, in the given order (duplicates allowed)."""
        await self._send_data(
            self.channel_out, [json.dumps(f, separators=(",", ":")) for f in frames]
        )

    async def send_text(self, *frames: Frame) -> None:
        await self._send_data(
            self.channel_text, [json.dumps(f, separators=(",", ":")) for f in frames]
        )

    async def send_out_raw(self, *events: str) -> None:
        """Send events on ``out`` exactly as given, for malformed or unknown frames."""
        await self._send_data(self.channel_out, list(events))

    async def send_ka(self) -> None:
        await self._send_message({"type": "ka"})

    async def drop(self, code: int = 1011) -> None:
        """Close the connection from the server side, as a network drop or server close."""
        if self._connection is not None:
            await self._connection.close(code)

    # -- internals ----------------------------------------------------------------------

    async def _send_message(self, message: dict[str, Any]) -> None:
        if self._connection is not None:
            await self._connection.send(json.dumps(message))

    async def _send_data(self, channel: str, events: list[str]) -> None:
        sub_id = self.subscriptions.get(channel)
        if sub_id is None:
            raise AssertionError(f"the client has not subscribed to {channel}")
        await self._send_message({"type": "data", "id": sub_id, "event": events})

    def _check_handshake(self, connection: ServerConnection) -> str | None:
        """Return a failure text (never containing the token), or None when all is right."""
        header = (
            connection.request.headers.get("Sec-WebSocket-Protocol", "")
            if (connection.request)
            else ""
        )
        offered = [p.strip() for p in header.split(",") if p.strip()]
        self.offered_subprotocols.append(offered)
        if appsync.SUBPROTOCOL not in offered:
            return "missing aws-appsync-event-ws subprotocol"
        headers = [p for p in offered if p.startswith("header-")]
        if len(headers) != 1:
            return "expected exactly one header- subprotocol"
        encoded = headers[0].removeprefix("header-")
        if "=" in encoded:
            return "header subprotocol has padding"
        try:
            auth = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        except (ValueError, binascii.Error):
            return "header subprotocol is not Base64URL JSON"
        if not isinstance(auth, dict) or auth.get("host") != self.http_host:
            return "wrong host in header subprotocol"
        if auth.get("Authorization") != self.token:
            return "wrong token in header subprotocol"
        return None

    def _auth_ok(self, message: dict[str, Any]) -> bool:
        auth = message.get("authorization")
        return (
            isinstance(auth, dict)
            and auth.get("host") == self.http_host
            and auth.get("Authorization") == self.token
        )

    async def _handle(self, connection: ServerConnection) -> None:
        failure = self._check_handshake(connection)
        if failure is not None:
            self.handshake_failures.append(failure)
        self._connection = connection
        self._hello_answered = False
        try:
            async for raw in connection:
                if not await self._on_message(raw, failure):
                    break
        finally:
            self._connection = None

    async def _on_message(self, raw: str | bytes, handshake_failure: str | None) -> bool:
        """Handle one client message. Returns False when the connection should close."""
        try:
            message = json.loads(raw)
        except ValueError:
            self.rejected.append("not JSON")
            return True
        if not isinstance(message, dict):
            return True
        kind = message.get("type")
        if kind == "connection_init":
            if handshake_failure is not None:
                await self._send_message(
                    {
                        "type": "connection_error",
                        "errors": [{"errorType": "UnauthorizedException"}],
                    }
                )
                return False
            await self._send_message(
                {"type": "connection_ack", "connectionTimeoutMs": self.connection_timeout_ms}
            )
        elif kind == "subscribe":
            await self._on_subscribe(message)
        elif kind == "publish":
            await self._on_publish(message)
        return True

    async def _on_subscribe(self, message: dict[str, Any]) -> None:
        channel, sub_id = message.get("channel"), message.get("id")
        allowed = (self.channel_out, self.channel_text)
        if not isinstance(sub_id, str) or channel not in allowed or not self._auth_ok(message):
            self.rejected.append(f"subscribe {channel!r}")
            await self._send_message(
                {
                    "type": "subscribe_error",
                    "id": sub_id,
                    "errors": [{"errorType": "Unauthorized"}],
                }
            )
            return
        self.subscriptions[channel] = sub_id
        await self._send_message({"type": "subscribe_success", "id": sub_id})

    async def _on_publish(self, message: dict[str, Any]) -> None:
        pub_id, events = message.get("id"), message.get("events")
        valid = (
            isinstance(pub_id, str)
            and message.get("channel") == self.channel_in
            and self._auth_ok(message)
            and isinstance(events, list)
            and 1 <= len(events) <= appsync.MAX_EVENTS_PER_PUBLISH
            and all(isinstance(e, str) for e in events)
        )
        if not valid:
            self.rejected.append(f"publish {message.get('channel')!r}")
            await self._send_message(
                {"type": "publish_error", "id": pub_id, "errors": [{"errorType": "Unauthorized"}]}
            )
            return
        self.publish_count += 1
        # Record every frame before anything is sent: the client may close right after its
        # ``bye``, and the acknowledgement and replies then have nowhere to go.
        frames = [f for f in (self._record(e) for e in events) if f is not None]
        with contextlib.suppress(Exception):
            await self._send_message({"type": "publish_success", "id": pub_id})
        for frame in frames:
            with contextlib.suppress(Exception):
                await self._reply(frame)

    def _record(self, event: str) -> Frame | None:
        result = decode_in(event)
        if isinstance(result, Malformed):
            self.malformed_in += 1
            return None
        assert isinstance(result, Valid)
        self.received_in.append(result.frame)
        return result.frame

    async def _reply(self, frame: Frame) -> None:
        replies: list[Frame] = []
        kind = frame["t"]
        if kind == "hello" and not self._hello_answered:
            self._hello_answered = True
            replies = list(self.session.on_hello)
        elif kind == "audio" and self.session.on_audio is not None:
            replies = self.session.on_audio(frame)
        elif kind == "bye":
            replies = list(self.session.on_bye)
        for reply in replies:
            channel = self.channel_text if reply.get("t") in _TEXT_TYPES else self.channel_out
            if channel in self.subscriptions:
                await self._send_data(channel, [json.dumps(reply, separators=(",", ":"))])


_TEXT_TYPES = ("state", "transcript", "end")


def _dump(frame: Frame) -> str:
    return json.dumps(frame, separators=(",", ":"))
