"""A scripted ``Runner`` for the camera and audio adapter tests (device-core-loop 24.4, 25.2).

Why it exists: the adapters start ``rpicam-still``, ``aplay`` and ``curl``-like children through
the ``Runner`` port. Tests script what each child does (exit code, how long it runs, what it
prints and which files it writes) and read back every argv, ``terminate()`` and ``kill()``.

Time is virtual and nothing sleeps. ``communicate(timeout)`` compares the step's ``duration``
with ``timeout``: a child that needs longer raises ``subprocess.TimeoutExpired`` after
consuming ``timeout`` seconds, otherwise it finishes after ``duration`` seconds. The consumed
seconds are added to the ``ManualScheduler``'s clock, so the adapter sees deadlines approach as
runs follow each other. The adapter's worker is a real thread, so a test calls the adapter and
then ``adapter.wait_idle(...)``; the clock must not be advanced by the test while the worker
runs. A lock keeps the script, the call log and the clock moves consistent across threads.
"""

from __future__ import annotations

import subprocess
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from warashi_agent.adapters.fakes import FAKE_JPEG_1X1
from warashi_agent.timebase import ManualScheduler

OnFinish = Callable[[Sequence[str]], None]
"""Called with the argv when a child finishes normally; writes the files the real tool would."""


@dataclass(frozen=True, kw_only=True)
class Step:
    """What one started child does.

    ``duration`` is the virtual time it needs to exit by itself. ``ignore_terminate`` models a
    child that survives SIGTERM, so only ``kill()`` ends it. ``start_error`` makes the Runner
    itself raise, like a missing executable.
    """

    exit_code: int = 0
    duration: float = 0.0
    stdout: str = ""
    stderr: str = ""
    on_finish: OnFinish | None = None
    ignore_terminate: bool = False
    start_error: OSError | None = None


def writes_file_after(flag: str, data: bytes) -> OnFinish:
    """Write ``data`` to the path that follows ``flag`` in the argv (``-o`` for rpicam-still)."""

    def write(argv: Sequence[str]) -> None:
        Path(argv[list(argv).index(flag) + 1]).write_bytes(data)

    return write


def jpeg_of_size(size: int) -> bytes:
    """A valid JPEG of exactly ``size`` bytes: ``FAKE_JPEG_1X1`` plus COM padding before SOF.

    The padding sits right after SOI, so the SOF header (1x1) stays readable by ``jpeg_size``.
    """
    base = FAKE_JPEG_1X1
    extra = size - len(base)
    if extra != 0 and extra < 4:
        raise ValueError("size must equal the base JPEG or exceed it by at least 4 bytes")
    segments = bytearray()
    while extra > 0:
        # One COM segment carries 2 marker bytes + 2 length bytes + up to 65533 payload bytes.
        chunk = min(extra, 65535 + 2)
        if extra - chunk in (1, 2, 3):
            chunk = extra - 4  # leave room for a last segment of at least 4 bytes
        payload = chunk - 4
        segments += b"\xff\xfe" + (payload + 2).to_bytes(2, "big") + b"\x00" * payload
        extra -= chunk
    return base[:2] + bytes(segments) + base[2:]


class ScriptedProcess:
    """A child process that follows one ``Step`` in virtual time."""

    def __init__(self, runner: ScriptedRunner, argv: list[str], step: Step) -> None:
        self._runner = runner
        self.argv = argv
        self._step = step
        self._returncode: int | None = None
        self._remaining = step.duration  # virtual seconds the child still needs
        self._terminated = False
        self._killed = False
        self.terminate_calls = 0
        self.kill_calls = 0

    @property
    def returncode(self) -> int | None:
        return self._returncode

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        with self._runner.lock:
            if self._returncode is not None:
                return self._step.stdout, self._step.stderr
            if self._killed or (self._terminated and not self._step.ignore_terminate):
                self._returncode = -9 if self._killed else -15
                return "", ""
            if timeout is None or self._remaining <= timeout:
                self._runner.consume(self._remaining)
                self._remaining = 0.0
                if self._step.on_finish is not None:
                    self._step.on_finish(self.argv)
                self._returncode = self._step.exit_code
                return self._step.stdout, self._step.stderr
            self._runner.consume(timeout)
            self._remaining -= timeout
            raise subprocess.TimeoutExpired(self.argv, timeout)

    def wait(self, timeout: float | None = None) -> int:
        self.communicate(timeout)
        assert self._returncode is not None
        return self._returncode

    def terminate(self) -> None:
        with self._runner.lock:
            self.terminate_calls += 1
            self._terminated = True

    def kill(self) -> None:
        with self._runner.lock:
            self.kill_calls += 1
            self._killed = True


@dataclass(eq=False)
class ScriptedRunner:
    """A ``Runner`` that hands out ``ScriptedProcess`` objects following ``steps`` in order.

    ``calls`` holds every argv started, ``processes`` the matching processes (use their
    ``terminate_calls`` and ``kill_calls``). A start with no step left fails the test loudly.
    """

    scheduler: ManualScheduler
    steps: list[Step] = field(default_factory=list)
    calls: list[list[str]] = field(default_factory=list)
    processes: list[ScriptedProcess] = field(default_factory=list)
    lock: threading.RLock = field(default_factory=threading.RLock)

    def __call__(self, argv: Sequence[str], /) -> ScriptedProcess:
        with self.lock:
            self.calls.append(list(argv))
            if not self.steps:
                raise AssertionError(f"no scripted step left for {list(argv)!r}")
            step = self.steps.pop(0)
            if step.start_error is not None:
                raise step.start_error
            proc = ScriptedProcess(self, list(argv), step)
            self.processes.append(proc)
            return proc

    def consume(self, seconds: float) -> None:
        """Move the virtual clock by ``seconds`` (the lock is already held)."""
        if seconds > 0:
            self.scheduler.advance(seconds)


# --------------------------------------------------------------------------------------------
# Scripted URL opener (device-core-loop 25.2, 25.3)
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class OpenStep:
    """What one ``opener.open()`` call does.

    ``error`` is raised by ``open()`` itself (a refused redirect, a DNS failure, a timeout).
    ``body`` is served by ``read(n)`` in pieces of at most ``n`` bytes. ``read_cost`` virtual
    seconds are added to the scheduler's clock by every ``read`` that returns data, which lets a
    test run into the total download deadline without sleeping. ``read_error`` is raised by the
    first ``read``. ``gate`` makes every ``read`` wait for that event (at most
    ``GATE_TIMEOUT_S`` real seconds, so a broken test fails instead of hanging) after setting
    ``entered``; tests use it to hold the adapter's worker inside a download.
    """

    body: bytes = b""
    error: OSError | None = None
    read_error: OSError | None = None
    read_cost: float = 0.0
    gate: threading.Event | None = None
    entered: threading.Event | None = None


GATE_TIMEOUT_S = 5.0


class ScriptedResponse:
    """The response object of one scripted ``open()``: a context manager with ``read(n)``."""

    def __init__(self, opener: ScriptedOpener, step: OpenStep) -> None:
        self._opener = opener
        self._step = step
        self._pos = 0
        self.closed = False

    def read(self, amt: int, /) -> bytes:
        step = self._step
        if step.entered is not None:
            step.entered.set()
        if step.gate is not None and not step.gate.wait(GATE_TIMEOUT_S):
            raise AssertionError("scripted download gate was never released")
        if step.read_error is not None:
            raise step.read_error
        chunk = step.body[self._pos : self._pos + amt]
        with self._opener.lock:
            self._pos += len(chunk)
            self._opener.bytes_served += len(chunk)
            if chunk and step.read_cost > 0 and self._opener.scheduler is not None:
                self._opener.scheduler.advance(step.read_cost)
        return chunk

    def __enter__(self) -> ScriptedResponse:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.closed = True


@dataclass(eq=False)
class ScriptedOpener:
    """A ``UrlOpener`` that follows ``steps`` in order and records what it was asked.

    ``urls`` and ``timeouts`` hold every ``open()`` call, ``bytes_served`` the total number of
    body bytes handed out by ``read``. An ``open()`` with no step left fails the test loudly.
    """

    steps: list[OpenStep] = field(default_factory=list)
    scheduler: ManualScheduler | None = None
    urls: list[str] = field(default_factory=list)
    timeouts: list[float | None] = field(default_factory=list)
    bytes_served: int = 0
    lock: threading.RLock = field(default_factory=threading.RLock)

    def open(
        self, fullurl: str, data: None = None, timeout: float | None = None
    ) -> ScriptedResponse:
        with self.lock:
            self.urls.append(fullurl)
            self.timeouts.append(timeout)
            if not self.steps:
                raise AssertionError(f"no scripted open step left for {fullurl!r}")
            step = self.steps.pop(0)
        if step.error is not None:
            raise step.error
        return ScriptedResponse(self, step)
