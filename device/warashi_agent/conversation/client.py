"""Audio client of a voice session on the doll (voice-conversation R12, design "Device").

``ConversationClient.run`` connects to the AppSync Events API, subscribes to ``out``, says
``hello``, then pumps microphone chunks to ``in`` and model audio from ``out`` to the speaker. It
returns exactly one ``ConversationOutcome`` and never raises (``asyncio.CancelledError`` of the
caller's own task aside).

Why it is written this way:

- Everything the client touches sits behind a small seam: ``MicSource`` and ``SpeakerSink`` for
  ``arecord`` / ``aplay``, ``connect`` for the WebSocket, ``Clock`` for the silence timer. Tests
  use the fakes of ``device/tests/voice_fixtures.py`` and a loopback server; CI needs no Pi.
- The token is a secret (R13.6). It is read from ``start`` inside ``run`` only, passed to the
  ``appsync`` builders and nowhere else. It is never stored on ``self``, never logged and never
  part of a ``repr``. Log lines carry only exception type names and short codes.
- The state machine owns the hard deadline of ``conversing``. This client's own exits (silence,
  failures, ``request_stop``) are an optimisation, never the only way out.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from warashi_agent.config import ConversationConfig
from warashi_agent.conversation import appsync
from warashi_agent.conversation.audio import apply_gain, speech_energy, split_chunks
from warashi_agent.conversation.frames import (
    Valid,
    audio_frame,
    bye_frame,
    decode_out,
    encode_in,
    hello_frame,
)
from warashi_agent.conversation.reorder import Reorder
from warashi_agent.model import StartConversation
from warashi_agent.timebase import Clock

#: Microphone chunks that carry less mean absolute amplitude (after gain) than this are silence
#: for the local silence timer. About 1.5 % of full scale: above idle noise, below speech.
SPEECH_ENERGY_MIN = 500.0
#: R12.11: no microphone data for this long means the microphone is broken.
MIC_STALL_S = 2.0
#: How many audio frames the reorder window holds while it waits for a missing ``seq``.
REORDER_WINDOW = 8
#: Real-time period of the watchdog that checks silence and the server keep-alive.
TICK_S = 0.1
#: Best-effort limit for sending ``bye`` and closing the socket at the end.
CLOSE_TIMEOUT_S = 1.0

MIC_BYTES_PER_MS = 32  # 16 kHz * 2 bytes / 1000


class MicSource(Protocol):
    """The microphone as the conversation client sees it (16 kHz S16LE mono)."""

    async def start(self) -> None: ...

    async def read(self) -> bytes | None:
        """The next chunk, or ``None`` when the source has ended (``arecord`` exited)."""
        ...

    async def close(self) -> None: ...


class SpeakerSink(Protocol):
    """The speaker as the conversation client sees it (24 kHz S16LE mono)."""

    async def start(self) -> None: ...

    async def write(self, pcm: bytes) -> None: ...

    def interrupt(self) -> None:
        """Drop queued audio and stop playing now (barge-in)."""
        ...

    @property
    def playing(self) -> bool: ...

    async def close(self) -> None: ...


class WsLike(Protocol):
    """The slice of a ``websockets`` connection that the client uses."""

    async def send(self, message: str) -> None: ...

    async def recv(self) -> str | bytes: ...

    async def close(self) -> Any: ...


Connect = Callable[..., Awaitable[WsLike]]


@dataclass(frozen=True)
class AppSyncHosts:
    """The two AppSync Events host names from ``[aws]`` of ``config.toml``."""

    realtime: str
    http: str

    @property
    def url(self) -> str:
        return f"wss://{self.realtime}/event/realtime"


@dataclass(frozen=True)
class ConversationOutcome:
    """How a session ended: a ``ConversationEndReason`` wire value and an optional error code.

    ``error_code`` is ``"microphone_failed"`` or ``"conversation_failed"`` when the client wants
    the caller to publish ``error.reported`` (R12.11, R12.12); otherwise ``None``.
    """

    reason: str
    error_code: str | None = None


class _Failure(Exception):  # noqa: N818 - internal control flow, not a public error type
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ConversationClient:
    """One voice session. Create one per session; ``run`` is called once."""

    def __init__(
        self,
        cfg: ConversationConfig,
        hosts: AppSyncHosts,
        mic: MicSource,
        speaker: SpeakerSink,
        connect: Connect,
        clock: Clock,
        log: logging.Logger,
    ) -> None:
        self._cfg = cfg
        self._hosts = hosts
        self._mic = mic
        self._speaker = speaker
        self._connect = connect
        self._clock = clock
        self._log = log
        self._outcome: ConversationOutcome | None = None
        self._done: asyncio.Event | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._pending_stop: str | None = None
        self._ws: WsLike | None = None
        # Publishes to ``in``. A closure, so the token is held here without being an attribute.
        self._send_in: Callable[[list[str]], Awaitable[None]] | None = None
        self._hello_sent = False
        self._last_activity = 0.0
        self._last_message = 0.0
        self._keepalive_ms: int | None = None

    def __repr__(self) -> str:
        return f"<ConversationClient finished={self._outcome is not None}>"

    # -- public ------------------------------------------------------------------------

    def request_stop(self, reason: str) -> None:
        """Ask the session to end with ``reason``. Thread-safe and idempotent."""
        loop = self._loop
        if loop is None:
            self._pending_stop = self._pending_stop or reason
            return
        with contextlib.suppress(RuntimeError):  # loop already closed: the session is over
            loop.call_soon_threadsafe(self._finish, reason, None)

    async def run(self, start: StartConversation) -> ConversationOutcome:
        """Connect, say hello, pump audio both ways, and return how the session ended."""
        self._loop = asyncio.get_running_loop()
        self._done = asyncio.Event()
        if self._pending_stop is not None:
            self._finish(self._pending_stop, None)
        tasks: list[asyncio.Task[None]] = []
        try:
            if self._outcome is None:
                tasks = [
                    asyncio.create_task(self._work(start)),
                    asyncio.create_task(self._wait_done()),
                ]
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            self._finish("error", "conversation_failed")  # the worker ended on its own: no-op
        except asyncio.CancelledError:
            self._finish("error", None)
            raise
        except Exception as exc:  # noqa: BLE001 - run() never raises
            self._log.error("conversation client failed: %s", type(exc).__name__)
            self._finish("error", "conversation_failed")
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self._teardown()
        assert self._outcome is not None
        return self._outcome

    # -- session -----------------------------------------------------------------------

    def _finish(self, reason: str, error_code: str | None) -> None:
        """Record the first outcome. Later calls change nothing."""
        if self._outcome is None:
            self._outcome = ConversationOutcome(reason, error_code)
            if self._done is not None:
                self._done.set()

    async def _wait_done(self) -> None:
        assert self._done is not None
        await self._done.wait()

    async def _work(self, start: StartConversation) -> None:
        sid, token = start.session_id, start.token
        self._send_in = self._make_sender(sid, token)
        try:
            async with asyncio.timeout(self._cfg.conversation_connect_timeout_s):
                await self._handshake(sid, token)
        except _Failure as exc:
            self._fail(exc.code)
            return
        except Exception as exc:  # noqa: BLE001 - any connect problem
            self._log.warning("conversation connect failed: %s", type(exc).__name__)
            self._fail("conversation_failed")
            return
        try:
            await self._mic.start()
            await self._speaker.start()
        except Exception as exc:  # noqa: BLE001
            self._log.warning("conversation audio start failed: %s", type(exc).__name__)
            self._fail("microphone_failed")
            return
        try:
            await self._publish([encode_in(hello_frame())])
        except Exception as exc:  # noqa: BLE001
            self._log.warning("conversation hello failed: %s", type(exc).__name__)
            self._fail("conversation_failed")
            return
        self._hello_sent = True
        self._last_activity = self._clock.now()
        await asyncio.gather(
            self._receive_loop(),
            self._mic_loop(),
            self._watchdog_loop(start.silence_s),
        )

    def _fail(self, code: str) -> None:
        self._finish("error", code)

    async def _handshake(self, sid: str, token: str) -> None:
        """Open the socket, ``connection_init``, wait for ack, subscribe to ``out``."""
        ws = await self._connect(
            self._hosts.url, subprotocols=appsync.subprotocols(self._hosts.http, token)
        )
        self._ws = ws
        await ws.send(appsync.connection_init())
        ack = await self._expect(appsync.ConnectionAck)
        assert isinstance(ack, appsync.ConnectionAck)
        self._keepalive_ms = ack.timeout_ms
        sub_id = str(uuid.uuid4())
        await ws.send(appsync.subscribe(sub_id, f"/voice/{sid}/out", self._hosts.http, token))
        while True:
            message = await self._expect(appsync.SubscribeSuccess)
            if isinstance(message, appsync.SubscribeSuccess) and message.id == sub_id:
                return

    async def _expect(self, kind: type) -> appsync.ServerMessage:
        """Read messages until one of ``kind`` arrives; a rejection is a failure."""
        assert self._ws is not None
        while True:
            message = appsync.parse_server_message(await self._ws.recv())
            self._last_message = self._clock.now()
            if isinstance(message, appsync.Rejected):
                self._log.warning("appsync rejected: %s %s", message.type, message.code)
                raise _Failure("conversation_failed")
            if isinstance(message, kind):
                return message

    def _make_sender(self, sid: str, token: str) -> Callable[[list[str]], Awaitable[None]]:
        async def send(frames: list[str]) -> None:
            assert self._ws is not None
            await self._ws.send(
                appsync.publish(
                    str(uuid.uuid4()), f"/voice/{sid}/in", frames, self._hosts.http, token
                )
            )

        return send

    async def _publish(self, frames: list[str]) -> None:
        assert self._send_in is not None
        await self._send_in(frames)

    # -- loops -------------------------------------------------------------------------

    async def _receive_loop(self) -> None:
        assert self._ws is not None
        reorder = Reorder(REORDER_WINDOW)
        try:
            while True:
                message = appsync.parse_server_message(await self._ws.recv())
                self._last_message = self._clock.now()
                if isinstance(message, appsync.Rejected):
                    self._log.warning("appsync rejected: %s %s", message.type, message.code)
                    self._fail("conversation_failed")
                    return
                if isinstance(message, appsync.Data):
                    for event in message.events:
                        await self._on_out_event(event, reorder)
        except Exception as exc:  # noqa: BLE001 - socket closed, speaker failed, ...
            self._log.warning("conversation receive ended: %s", type(exc).__name__)
            self._fail("conversation_failed")

    async def _on_out_event(self, event: str, reorder: Reorder) -> None:
        decoded = decode_out(event)
        if not isinstance(decoded, Valid):
            return  # malformed and unknown frames are ignored (R5)
        frame = decoded.frame
        if frame["t"] == "interrupt":
            self._speaker.interrupt()
        elif frame["t"] == "audio":
            for _seq, pcm_b64 in reorder.push(frame["seq"], frame["pcm"]):
                try:
                    pcm = base64.b64decode(pcm_b64, validate=True)
                except (binascii.Error, ValueError):
                    continue
                self._last_activity = self._clock.now()
                await self._speaker.write(pcm)

    async def _mic_loop(self) -> None:
        chunk_bytes = self._cfg.conversation_chunk_ms * MIC_BYTES_PER_MS
        buffer = b""
        seq = 0
        try:
            while True:
                try:
                    data = await asyncio.wait_for(self._mic.read(), MIC_STALL_S)
                except TimeoutError:
                    data = None
                except Exception as exc:  # noqa: BLE001
                    self._log.warning("microphone failed: %s", type(exc).__name__)
                    data = None
                if data is None:
                    self._fail("microphone_failed")
                    return
                if self._cfg.conversation_mute_mic_while_speaking and self._speaker.playing:
                    buffer = b""  # half-duplex: drop what the mic heard while the doll talks
                    continue
                chunks, buffer = split_chunks(
                    buffer + data[: len(data) - len(data) % 2], chunk_bytes
                )
                for chunk in chunks:
                    gained = apply_gain(chunk, self._cfg.conversation_mic_gain)
                    if speech_energy(gained) >= SPEECH_ENERGY_MIN:
                        self._last_activity = self._clock.now()
                    pcm_b64 = base64.b64encode(gained).decode("ascii")
                    await self._publish([encode_in(audio_frame(seq, pcm_b64))])
                    seq += 1
        except Exception as exc:  # noqa: BLE001 - the send failed: transport problem
            self._log.warning("conversation send ended: %s", type(exc).__name__)
            self._fail("conversation_failed")

    async def _watchdog_loop(self, silence_s: float) -> None:
        """End on local silence (R12.13) or when the server's keep-alive stops."""
        while True:
            await asyncio.sleep(TICK_S)
            now = self._clock.now()
            if self._speaker.playing:
                self._last_activity = now
            if now - self._last_activity >= silence_s:
                self._finish("silence", None)
                return
            if appsync.keepalive_expired(now, self._last_message, self._keepalive_ms):
                self._fail("conversation_failed")
                return

    # -- end ---------------------------------------------------------------------------

    async def _teardown(self) -> None:
        """Say bye (when the link works), stop audio, close everything. Never raises."""
        outcome = self._outcome
        with contextlib.suppress(Exception):
            self._speaker.interrupt()
        broken = outcome is not None and outcome.error_code == "conversation_failed"
        if self._ws is not None and self._hello_sent and not broken:
            await self._best_effort(self._send_bye(outcome))
        for closer in (self._mic.close, self._speaker.close):
            await self._best_effort(closer())
        if self._ws is not None:
            await self._best_effort(self._ws.close())

    async def _send_bye(self, outcome: ConversationOutcome | None) -> None:
        # The ``bye`` reasons of the contract are user, silence, limit and error.
        reason = outcome.reason if outcome is not None else "error"
        if reason not in ("silence", "limit", "error"):
            reason = "user"
        await self._publish([encode_in(bye_frame(reason))])

    async def _best_effort(self, awaitable: Awaitable[Any]) -> None:
        try:
            await asyncio.wait_for(awaitable, CLOSE_TIMEOUT_S)
        except Exception as exc:  # noqa: BLE001
            self._log.debug("conversation cleanup step failed: %s", type(exc).__name__)
