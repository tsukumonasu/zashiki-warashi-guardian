"""Ports: the small interfaces between the Dispatcher and the hardware adapters.

Why this module exists:
- The Dispatcher, the ``--fake`` CLI and the tests depend only on these Protocols, never on a
  concrete adapter. A real adapter and its fake are therefore interchangeable, and
  ``make test`` runs without a Raspberry Pi (tech.md, "Hardware-free tests").
- Each port takes the Action types of ``model.py`` unchanged. ``handle()`` only enqueues work
  and returns at once; the result comes back later as an Internal_Event through the adapter's
  ``post`` callback (R20.2). Adapters make no decisions; the State_Machine does.
- ``OnceResult`` and ``Runner`` are shared by the camera and audio adapters, so the "exactly
  one result per id" rule (R18.8, R19.9) and the subprocess stand-in exist in one place.

This module imports only the standard library and ``model.py``. It must never import
``gpiozero``, ``lgpio`` or ``paho``: importing it touches no pin and opens no connection.
"""

from __future__ import annotations

import subprocess
import threading
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

from warashi_agent.model import (
    GazeTarget,
    LanternFade,
    PlayAudioUrl,
    PlayLine,
    ReleaseServos,
    StartConversation,
    StopConversation,
    TakeSnapshot,
)

# --------------------------------------------------------------------------------------------
# Hardware ports
# --------------------------------------------------------------------------------------------


class ServoPort(Protocol):
    """The head servos (R15). ``handle()`` never blocks on a glide."""

    def handle(self, action: GazeTarget | ReleaseServos) -> None: ...

    def emergency_detach(self) -> None:
        """Cancel the plan and detach both servos at once, without gliding (R20.6)."""
        ...


class LanternPort(Protocol):
    """The lantern LED (R16)."""

    def handle(self, action: LanternFade) -> None: ...

    def off_now(self) -> None:
        """Cancel any fade and write level 0 at once (R16.4, R20.6)."""
        ...


class PirPort(Protocol):
    """The PIR sensor (R17). It only posts edges; it has no Actions to handle."""

    def start(self) -> None: ...

    def close(self) -> None: ...


class CameraPort(Protocol):
    """The camera (R18). Posts exactly one result per ``TakeSnapshot`` (R18.8)."""

    def handle(self, action: TakeSnapshot) -> None: ...

    def probe(self) -> ProbeResult: ...

    def stop(self) -> None:
        """Terminate a running capture, then kill it after a short grace (R20.7)."""
        ...


class AudioPort(Protocol):
    """The speaker (R19). Posts exactly one result per Play_Id (R19.9)."""

    def handle(self, action: PlayLine | PlayAudioUrl) -> None: ...

    def probe(self) -> ProbeResult: ...

    def stop(self) -> None:
        """Terminate a running playback or download, then kill it after a short grace."""
        ...


class ConversationPort(Protocol):
    """The voice session (voice-conversation R12.8 to R12.10).

    Posts exactly one ``ConversationFinished`` per session id. ``handle`` never blocks and
    never raises; a stale or repeated ``StopConversation`` changes nothing.
    """

    def handle(self, action: StartConversation | StopConversation) -> None: ...

    def stop(self) -> None:
        """End the running session and its audio processes for shutdown; idempotent."""
        ...


# --------------------------------------------------------------------------------------------
# Startup probe result
# --------------------------------------------------------------------------------------------

ProbeCode = Literal["camera_missing", "audio_device_missing"]


@dataclass(frozen=True, kw_only=True)
class ProbeResult:
    """Outcome of a startup probe (R18.5, R19.7).

    The probe only reports. The startup sequence logs ``hint`` and publishes ``code`` as
    ``error.reported``, and the agent keeps running either way, because a missing camera or
    speaker must not stop the lantern and the gaze. ``hint`` is a short, owner-facing sentence
    such as "Camera not found: check the camera ribbon cable"; it holds no secrets.
    """

    ok: bool
    code: ProbeCode | None = None
    hint: str = ""

    def __post_init__(self) -> None:
        # A passing probe with a code, or a failing one without, would publish nonsense.
        if self.ok != (self.code is None):
            raise ValueError("ProbeResult: code must be set exactly when ok is False")

    @classmethod
    def passed(cls) -> ProbeResult:
        return cls(ok=True)

    @classmethod
    def failed(cls, code: ProbeCode, hint: str) -> ProbeResult:
        return cls(ok=False, code=code, hint=hint)


# --------------------------------------------------------------------------------------------
# One result per id
# --------------------------------------------------------------------------------------------


class OnceResult:
    """Lets each Snapshot_Id or Play_Id get one result only (R18.8, R19.9).

    An interruption (``audio.failed(interrupted)``) and the worker that just finished the same
    playback can race on two threads. Both call ``claim(id)`` before posting; only the first
    gets ``True``, so the State_Machine never sees two results for one id.

    Memory is bounded: only the last ``capacity`` claimed ids are remembered. Ids are fresh
    UUIDs and a race lasts at most one timeout, so an id that old is never claimed again. An
    unbounded set would grow for as long as the doll runs.
    """

    def __init__(self, capacity: int = 1024) -> None:
        if capacity < 1:
            raise ValueError("OnceResult capacity must be at least 1")
        self._lock = threading.Lock()
        self._order: deque[str] = deque()
        self._claimed: set[str] = set()
        self._capacity = capacity

    def claim(self, key: str) -> bool:
        """Return ``True`` the first time ``key`` is claimed, ``False`` every later time."""
        with self._lock:
            if key in self._claimed:
                return False
            self._claimed.add(key)
            self._order.append(key)
            if len(self._order) > self._capacity:
                self._claimed.discard(self._order.popleft())
            return True


# --------------------------------------------------------------------------------------------
# Subprocess stand-in
# --------------------------------------------------------------------------------------------


class Process(Protocol):
    """The part of ``subprocess.Popen`` that the camera and audio adapters use.

    Adapters read output only through ``communicate()``, which drains both pipes. Calling
    ``wait()`` alone while output is piped can deadlock once ``rpicam-still`` fills the pipe
    with log lines.
    """

    @property
    def returncode(self) -> int | None: ...

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        """Wait for exit and return (stdout, stderr); raise ``subprocess.TimeoutExpired``."""
        ...

    def wait(self, timeout: float | None = None) -> int: ...

    def terminate(self) -> None: ...

    def kill(self) -> None: ...


class Runner(Protocol):
    """Starts a child process; ``popen_runner`` in production, a scripted fake in tests.

    The scripted fake controls exit codes, durations and written files, so the adapters'
    timeout, retry and cleanup paths are tested without ``rpicam-still`` or ``aplay``.
    """

    def __call__(self, argv: Sequence[str], /) -> Process: ...


def popen_runner(argv: Sequence[str], /) -> Process:
    """The production Runner: ``Popen`` with no stdin and text pipes for stdout and stderr.

    ``errors="replace"`` keeps a stray non-UTF-8 byte in a tool's output from raising inside
    an adapter worker.
    """
    return subprocess.Popen(
        list(argv),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
