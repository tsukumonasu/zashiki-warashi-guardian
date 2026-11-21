"""Conversation_Adapter: one voice session at a time on a worker thread (voice-conversation R12).

Why it is built this way:

- ``handle()`` only creates a session and starts its thread, then returns. The main loop keeps
  processing Ticks while the session talks to the cloud (R20.2, R20.3). Each session gets its
  own thread with its own asyncio loop, because ``ConversationClient.run`` is one coroutine
  that owns two subprocesses and a WebSocket; a thread per session (one at a time) is the
  simplest way to give all of that a clean end.
- A session id gets exactly one ``ConversationFinished`` (R12.8). Every end path (clean end,
  failure, stop, a new start that replaces the session, shutdown) goes through ``OnceResult``.
- ``StopConversation`` and ``stop()`` are safe to repeat and safe for an unknown session
  (R12.9). ``stop()`` also kills ``arecord`` and ``aplay`` itself if the client has not closed
  them within the grace, so no audio process outlives the agent (R12.10).
- The token is a secret (R13.6). It travels from ``StartConversation`` into the client only. It
  is never stored on the adapter, never logged and never part of a ``repr``. Log lines carry
  exception type names and short codes.
- The client's failures (``microphone_failed``, ``conversation_failed``) reach the dispatcher as
  ``adapter.error(code)`` followed by ``ConversationFinished(adapter_failed)``.
- ``websockets`` is imported on first connect, not at import time: importing this module opens
  nothing and starts no thread.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import threading
from collections.abc import Callable
from typing import Any

from warashi_agent.adapters.ports import OnceResult
from warashi_agent.config import Config
from warashi_agent.conversation.client import (
    AppSyncHosts,
    Connect,
    ConversationClient,
    ConversationOutcome,
    MicSource,
    SpeakerSink,
)
from warashi_agent.model import (
    AdapterError,
    ConversationFinished,
    Event,
    StartConversation,
    StopConversation,
)
from warashi_agent.timebase import Clock, MonotonicClock

_log = logging.getLogger(__name__)

Post = Callable[[Event], None]
"""Hands an Event to the Dispatcher queue; safe to call from any thread."""

MIC_READ_BYTES = 3_200  # 100 ms of 16 kHz S16LE mono
SPEAKER_BYTES_PER_S = 48_000  # 24 kHz * 2 bytes
PROCESS_GRACE_S = 0.4
"""Time an audio process gets between SIGTERM and SIGKILL when the client closes it."""
STOP_GRACE_S = 0.5
"""``stop()`` waits this long for the session to end by itself, then kills the processes."""
PREVIOUS_SESSION_WAIT_S = 2.0
"""A new session waits at most this long for the previous one to release the audio device."""


# --------------------------------------------------------------------------------------------
# Real audio: arecord and aplay
# --------------------------------------------------------------------------------------------


class _ProcessRegistry:
    """Pids of the live audio processes, so ``stop()`` can kill them from another thread."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pids: set[int] = set()

    def add(self, pid: int) -> None:
        with self._lock:
            self._pids.add(pid)

    def discard(self, pid: int) -> None:
        with self._lock:
            self._pids.discard(pid)

    def kill_all(self) -> None:
        with self._lock:
            pids = list(self._pids)
            self._pids.clear()
        for pid in pids:
            with contextlib.suppress(OSError):  # already gone
                os.kill(pid, signal.SIGKILL)


async def _reap(proc: asyncio.subprocess.Process, registry: _ProcessRegistry) -> None:
    """Stop ``proc``: SIGTERM, a short wait, then SIGKILL. Never raises."""
    try:
        if proc.stdin is not None:
            with contextlib.suppress(Exception):
                proc.stdin.close()
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), PROCESS_GRACE_S)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(proc.wait(), PROCESS_GRACE_S)
    finally:
        registry.discard(proc.pid)


class ArecordMic:
    """MicSource on ``arecord``: 16 kHz S16LE mono raw PCM from the card named in config.

    The card is selected by name (``plughw:CARD=Device,DEV=0``), never by number, because card
    numbers change (hardware.md).
    """

    def __init__(self, device: str, registry: _ProcessRegistry) -> None:
        self._device = device
        self._registry = registry
        self._proc: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            "arecord", "-q", "-D", self._device,
            "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )  # fmt: skip
        self._registry.add(self._proc.pid)

    async def read(self) -> bytes | None:
        """The next chunk, or ``None`` when ``arecord`` has exited."""
        proc = self._proc
        if proc is None or proc.stdout is None:
            return None
        data = await proc.stdout.read(MIC_READ_BYTES)
        return data or None

    async def close(self) -> None:
        if self._proc is not None:
            await _reap(self._proc, self._registry)


class AplaySpeaker:
    """SpeakerSink on ``aplay``: 24 kHz S16LE mono raw PCM written to its standard input.

    ``interrupt`` kills the player, because ``aplay`` has no way to drop what it has already
    buffered; the next ``write`` starts a fresh one. ``playing`` is an estimate from the bytes
    written, since ``aplay`` reports nothing: audio is playing until the written duration has
    elapsed on the loop clock.
    """

    def __init__(self, device: str, registry: _ProcessRegistry) -> None:
        self._device = device
        self._registry = registry
        self._proc: asyncio.subprocess.Process | None = None
        self._dying: list[asyncio.subprocess.Process] = []
        self._busy_until = 0.0

    async def start(self) -> None:
        await self._spawn()

    async def _spawn(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            "aplay", "-q", "-D", self._device,
            "-f", "S16_LE", "-r", "24000", "-c", "1", "-t", "raw",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )  # fmt: skip
        self._registry.add(self._proc.pid)

    async def write(self, pcm: bytes) -> None:
        if self._proc is None or self._proc.returncode is not None:
            await self._spawn()
        proc = self._proc
        assert proc is not None and proc.stdin is not None
        proc.stdin.write(pcm)
        await proc.stdin.drain()
        loop_now = asyncio.get_running_loop().time()
        self._busy_until = max(loop_now, self._busy_until) + len(pcm) / SPEAKER_BYTES_PER_S

    def interrupt(self) -> None:
        proc, self._proc = self._proc, None
        self._busy_until = 0.0
        if proc is not None:
            with contextlib.suppress(ProcessLookupError):
                proc.terminate()
            self._dying.append(proc)

    @property
    def playing(self) -> bool:
        try:
            now = asyncio.get_running_loop().time()
        except RuntimeError:
            return False
        return now < self._busy_until

    async def close(self) -> None:
        procs = [*self._dying, *([self._proc] if self._proc is not None else [])]
        self._dying.clear()
        self._proc = None
        self._busy_until = 0.0
        for proc in procs:
            await _reap(proc, self._registry)


async def _ws_connect(url: str, *, subprotocols: list[str]) -> Any:
    """Open the AppSync Events WebSocket (``websockets`` comes from apt on the Pi)."""
    from websockets.asyncio.client import connect  # noqa: PLC0415 - lazy: see module docstring

    return await connect(url, subprotocols=subprotocols)  # type: ignore[arg-type]


# --------------------------------------------------------------------------------------------
# Adapter
# --------------------------------------------------------------------------------------------


class _Session:
    """One running session: its id, its client and its thread."""

    def __init__(self, session_id: str, client: ConversationClient) -> None:
        self.session_id = session_id
        self.client = client
        self.thread: threading.Thread | None = None

    def __repr__(self) -> str:  # no token here, by construction
        return f"<_Session {self.session_id}>"


class ConversationAdapter:
    """ConversationPort on ``ConversationClient`` (R12.8 to R12.10).

    ``mic_factory`` and ``speaker_factory`` build the audio ends of one session; they default
    to the real ``arecord`` and ``aplay`` wrappers and are replaced by recorded fakes in tests,
    together with ``connect``. A factory must not start anything: the client starts the audio
    on its own loop.
    """

    def __init__(
        self,
        post: Post,
        config: Config,
        *,
        hosts: AppSyncHosts | None = None,
        connect: Connect = _ws_connect,
        mic_factory: Callable[[], MicSource] | None = None,
        speaker_factory: Callable[[], SpeakerSink] | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._post = post
        self._cfg = config.conversation
        self._hosts = hosts or AppSyncHosts(
            realtime=config.aws.appsync_realtime_host, http=config.aws.appsync_http_host
        )
        self._connect = connect
        self._registry = _ProcessRegistry()
        device = config.audio.audio_device
        self._mic_factory = mic_factory or (lambda: ArecordMic(device, self._registry))
        self._speaker_factory = speaker_factory or (lambda: AplaySpeaker(device, self._registry))
        self._clock: Clock = clock if clock is not None else MonotonicClock()
        self._once = OnceResult()
        self._lock = threading.Lock()
        self._current: _Session | None = None
        self._stopped = False

    # -- ConversationPort -----------------------------------------------------------------

    def handle(self, action: StartConversation | StopConversation) -> None:
        """Start or stop a session. Enqueues work and never raises (R12.8, R12.9)."""
        try:
            if isinstance(action, StartConversation):
                self._start(action)
            else:
                self._stop_session(action.session_id)
        except Exception as exc:  # noqa: BLE001 - handle() must never raise into the loop
            _log.error("conversation request failed: %s", type(exc).__name__)
            self._post(AdapterError(code="adapter_failed"))
            if isinstance(action, StartConversation):
                self._emit(action.session_id, "adapter_failed")

    def stop(self) -> None:
        """End the session for shutdown; idempotent. Audio processes die within 1 s (R12.10)."""
        with self._lock:
            self._stopped = True
            session = self._current
        if session is None:
            return
        session.client.request_stop("user")
        thread = session.thread
        if thread is not None:
            thread.join(STOP_GRACE_S)
            if thread.is_alive():
                self._registry.kill_all()
                thread.join(STOP_GRACE_S)

    # -- Test support ---------------------------------------------------------------------

    def wait_idle(self, timeout: float) -> bool:
        """Wait until no session runs; True if that happened within ``timeout`` seconds."""
        with self._lock:
            session = self._current
        thread = session.thread if session is not None else None
        if thread is not None:
            thread.join(timeout)
        with self._lock:
            return self._current is None

    # -- Sessions -------------------------------------------------------------------------

    def _start(self, action: StartConversation) -> None:
        with self._lock:
            if self._stopped:
                refuse = True
                previous = None
            else:
                refuse = False
                previous = self._current
                client = ConversationClient(
                    self._cfg,
                    self._hosts,
                    self._mic_factory(),
                    self._speaker_factory(),
                    self._connect,
                    self._clock,
                    _log,
                )
                session = _Session(action.session_id, client)
                self._current = session
        if refuse:
            self._emit(action.session_id, "error")
            return
        if previous is not None:
            # A new start replaces the old session, which ends with "error" (like the fake).
            previous.client.request_stop("error")
        thread = threading.Thread(
            target=self._run,
            args=(session, action, previous),
            name="warashi-conversation",
            daemon=True,
        )
        session.thread = thread
        thread.start()

    def _stop_session(self, session_id: str) -> None:
        with self._lock:
            session = self._current
        if session is not None and session.session_id == session_id:
            session.client.request_stop("user")

    def _run(self, session: _Session, start: StartConversation, previous: _Session | None) -> None:
        outcome: ConversationOutcome | None = None
        try:
            if previous is not None and previous.thread is not None:
                # Both sessions need the speakerphone; wait until the old one has let go.
                previous.thread.join(PREVIOUS_SESSION_WAIT_S)
            outcome = asyncio.run(session.client.run(start))
        except BaseException as exc:  # noqa: BLE001 - the thread must always report an end
            _log.error("conversation worker raised %s", type(exc).__name__)
        finally:
            with self._lock:
                if self._current is session:
                    self._current = None
            self._finish(session.session_id, outcome)

    def _finish(self, session_id: str, outcome: ConversationOutcome | None) -> None:
        """Post the one end of ``session_id``; an adapter-level failure adds ``adapter.error``."""
        if outcome is None:
            if self._once.claim(session_id):
                self._post(AdapterError(code="adapter_failed"))
                self._post(ConversationFinished(session_id=session_id, reason="adapter_failed"))
            return
        if outcome.error_code is not None:
            if self._once.claim(session_id):
                self._post(AdapterError(code=outcome.error_code))
                self._post(ConversationFinished(session_id=session_id, reason="adapter_failed"))
            return
        self._emit(session_id, outcome.reason)

    def _emit(self, session_id: str, reason: str) -> None:
        if self._once.claim(session_id):
            self._post(ConversationFinished(session_id=session_id, reason=reason))
