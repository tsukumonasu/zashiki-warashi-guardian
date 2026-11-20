"""Camera_Adapter (rpicam-still), the camera probe and the pure JPEG size parser (R18).

Why it is built this way:

- ``handle()`` only enqueues a job and returns. One worker thread runs the jobs one at a time,
  because ``rpicam-still`` blocks for about a second and the main loop must keep processing
  Ticks meanwhile (R20.2, R20.3, hardware.md). The worker starts with the first request;
  importing this module or constructing the adapter starts nothing.
- One deadline covers the whole snapshot, retries included: ``camera_timeout_s`` after the
  Action arrived (R18.1). Every run gets only the time that is left. A run that overruns gets
  SIGTERM, and SIGKILL 0.5 s later if it is still alive.
- Quality steps 80, 60, 40 keep the JPEG under ``jpeg_max_bytes`` so the whole MQTT message
  fits the broker limit (R18.2). Every JPEG lives in a ``TemporaryDirectory`` that is gone
  before the result is posted, so a result never leaves files behind (R18.6).
- Each Snapshot_Id gets exactly one result through ``OnceResult`` (R18.8), also when
  ``stop()`` races a finishing worker.
- Process output is read only through ``communicate()``, which drains both pipes (see
  ``Process`` in ``ports.py``). Image bytes are never logged (R13.6); exceptions are logged
  by type only.

``jpeg_size`` is pure: ``snapshot.captured`` must report the real ``width`` and ``height`` of
the JPEG that leaves the device (R18.3), and reading them from the SOF header costs a few
hundred bytes of work instead of an image library that the Pi Zero W cannot afford.
"""

from __future__ import annotations

import logging
import re
import subprocess
import tempfile
import threading
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from warashi_agent.adapters.ports import OnceResult, ProbeResult, Process, Runner, popen_runner
from warashi_agent.config import Config
from warashi_agent.model import AdapterError, Event, SnapshotFailed, SnapshotReady, TakeSnapshot
from warashi_agent.timebase import Scheduler

_log = logging.getLogger(__name__)

Post = Callable[[Event], None]
"""Hands an Event to the Dispatcher queue; safe to call from any thread."""

QUALITIES = (80, 60, 40)
"""JPEG quality steps, tried in order until the file fits (R18.2)."""

KILL_GRACE_S = 0.5
"""Time a process gets between SIGTERM and SIGKILL."""

CAMERA_HINT = "Camera not found: check the camera ribbon cable"

_CAMERA_LINE = re.compile(r"^\s*\d+\s*:\s*\S", re.MULTILINE)
"""A line of ``rpicam-still --list-cameras`` such as ``0 : ov5647 [2592x1944 ...]``."""

_SOI = 0xD8
_EOI = 0xD9
_SOS = 0xDA
_TEM = 0x01
_RST_FIRST = 0xD0
_RST_LAST = 0xD7
# Baseline and progressive DCT, the only frame types rpicam-still writes.
_SOF_MARKERS = frozenset({0xC0, 0xC2})
# Length field (2) + precision (1) + height (2) + width (2) + component count (1).
_SOF_MIN_LENGTH = 8


def _u16(data: bytes | bytearray | memoryview, offset: int) -> int:
    """Read a big-endian 16-bit integer; the caller has already checked the bounds."""
    return (data[offset] << 8) | data[offset + 1]


def jpeg_size(data: bytes | bytearray | memoryview) -> tuple[int, int] | None:
    """Return ``(width, height)`` from the SOF0 or SOF2 segment of a JPEG, or ``None``.

    Walks the marker segments from SOI and stops at SOS or EOI, since the frame header always
    precedes the first scan. Fill bytes (``0xFF``) before a marker are skipped and standalone
    markers (TEM, RST0..RST7) have no length field. Every read is bounds-checked and anything
    unexpected (no SOI, garbage between segments, a length below 2, a segment that runs past
    the end, a zero dimension) gives ``None``. The function never raises, because the caller
    falls back to the requested capture size instead of failing a snapshot over its header.
    """
    if not isinstance(data, bytes | bytearray | memoryview):
        return None
    n = len(data)
    if n < 4 or data[0] != 0xFF or data[1] != _SOI:
        return None
    i = 2
    while i < n:
        if data[i] != 0xFF:
            return None  # every segment must start with a marker
        while i < n and data[i] == 0xFF:
            i += 1  # fill bytes may pad any marker
        if i >= n:
            return None
        marker = data[i]
        i += 1
        if marker == _TEM or _RST_FIRST <= marker <= _RST_LAST:
            continue  # standalone marker, no length field
        if marker in (0x00, _SOI, _EOI, _SOS):
            return None  # stuffed byte, second SOI, or end/scan reached without a frame header
        if i + 2 > n:
            return None
        length = _u16(data, i)
        if length < 2 or i + length > n:
            return None
        if marker in _SOF_MARKERS:
            if length < _SOF_MIN_LENGTH:
                return None
            height = _u16(data, i + 3)
            width = _u16(data, i + 5)
            if width > 0 and height > 0:
                return width, height
            return None  # height 0 means a DNL marker defines it later; not supported
        i += length
    return None


# --------------------------------------------------------------------------------------------
# Adapter
# --------------------------------------------------------------------------------------------


def _failed(snapshot_id: str) -> SnapshotFailed:
    return SnapshotFailed(snapshot_id=snapshot_id, code="camera_failed")


@dataclass(eq=False)
class _Job:
    """One snapshot request on its way through the worker.

    ``deadline`` is fixed when the Action arrives, so time spent in the queue counts against
    ``camera_timeout_s`` (R18.1). ``lock`` guards ``proc`` against ``stop()``: the worker
    publishes the process under it, and ``stop()`` sets ``cancel`` and reads ``proc`` under it,
    so a process started during a stop is always seen by one of the two and terminated.
    """

    snapshot_id: str
    deadline: float
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    proc: Process | None = None
    proc_exited: threading.Event = field(default_factory=threading.Event)


class CameraAdapter:
    """CameraPort on ``rpicam-still`` (R18.1 to R18.6, R18.8).

    The adapter returns bytes, width and height only. The head angles of the snapshot are
    recorded by the State_Machine when it emits ``TakeSnapshot`` and joined to
    ``snapshot.ready`` there, so the adapter needs no pose information.
    """

    def __init__(
        self,
        post: Post,
        scheduler: Scheduler,
        config: Config,
        *,
        runner: Runner = popen_runner,
    ) -> None:
        self._post = post
        self._scheduler = scheduler
        self._timeout_s = config.timing.camera_timeout_s
        self._probe_timeout_s = config.timing.probe_timeout_s
        self._max_bytes = config.camera.jpeg_max_bytes
        self._runner = runner
        self._once = OnceResult()
        self._cond = threading.Condition()
        self._jobs: deque[_Job] = deque()
        self._current: _Job | None = None
        self._thread: threading.Thread | None = None
        self._stopped = False

    # -- CameraPort -----------------------------------------------------------------------

    def handle(self, action: TakeSnapshot) -> None:
        """Queue the snapshot; never blocks and never raises (R20.2)."""
        try:
            job = _Job(
                snapshot_id=action.snapshot_id,
                deadline=self._scheduler.now() + self._timeout_s,
            )
            with self._cond:
                if not self._stopped:
                    self._jobs.append(job)
                    self._ensure_worker_locked()
                    self._cond.notify_all()
                    return
            # Shutting down: the Snapshot_Id still gets its one result.
            self._result(job.snapshot_id, _failed(job.snapshot_id))
        except Exception as exc:  # noqa: BLE001 - handle() must never raise into the loop
            _log.error("camera request failed: %s", type(exc).__name__)
            self._post(AdapterError(code="adapter_failed"))
            self._result(action.snapshot_id, _failed(action.snapshot_id))

    def probe(self) -> ProbeResult:
        """Check that ``rpicam-still --list-cameras`` lists a camera within ``probe_timeout_s``.

        The startup sequence logs the hint and publishes the code; the agent keeps running
        with lantern and gaze either way (R18.5).
        """
        failed = ProbeResult.failed("camera_missing", CAMERA_HINT)
        try:
            proc = self._runner(["rpicam-still", "--list-cameras"])
        except OSError as exc:
            _log.warning("rpicam-still could not start: %s", type(exc).__name__)
            return failed
        try:
            try:
                stdout, _ = proc.communicate(timeout=self._probe_timeout_s)
            except subprocess.TimeoutExpired:
                _log.warning("camera probe did not finish within %.1f s", self._probe_timeout_s)
                _terminate_and_reap(proc)
                return failed
            if proc.returncode != 0:
                _log.warning("camera probe exited with code %s", proc.returncode)
                return failed
            if _CAMERA_LINE.search(stdout or "") is None:
                _log.warning("camera probe lists no camera")
                return failed
            return ProbeResult.passed()
        except Exception as exc:  # noqa: BLE001 - a probe reports; it never stops startup
            _log.error("camera probe raised %s", type(exc).__name__)
            return failed

    def stop(self) -> None:
        """Stop the running capture and fail the queued ones for shutdown (R20.7).

        Does not rely on the Scheduler, which may already be shut down: it sends SIGTERM,
        waits at most ``KILL_GRACE_S`` and then sends SIGKILL. Each queued Snapshot_Id gets
        ``snapshot.failed(camera_failed)``, as the fake does; the running one gets it from
        the worker when its process ends.
        """
        with self._cond:
            self._stopped = True
            current = self._current
            queued = list(self._jobs)
            self._jobs.clear()
            self._cond.notify_all()
        for job in queued:
            self._result(job.snapshot_id, _failed(job.snapshot_id))
        if current is None:
            return
        with current.lock:
            current.cancel.set()
            proc = current.proc
        if proc is not None and not current.proc_exited.is_set():
            _signal(proc, "terminate")
            if not current.proc_exited.wait(KILL_GRACE_S):
                _signal(proc, "kill")

    # -- Test support ---------------------------------------------------------------------

    def wait_idle(self, timeout: float) -> bool:
        """Wait until no job is queued or running; True if that happened within ``timeout``.

        Results come from the worker thread, so tests call this before checking them.
        """
        with self._cond:
            return self._cond.wait_for(
                lambda: not self._jobs and self._current is None, timeout=timeout
            )

    # -- Worker ---------------------------------------------------------------------------

    def _result(self, snapshot_id: str, event: SnapshotReady | SnapshotFailed) -> None:
        """Post ``event`` unless ``snapshot_id`` already has its one result (R18.8)."""
        if self._once.claim(snapshot_id):
            self._post(event)

    def _ensure_worker_locked(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(
                target=self._worker, name="warashi-camera", daemon=True
            )
            self._thread.start()

    def _worker(self) -> None:
        while True:
            with self._cond:
                while not self._jobs and not self._stopped:
                    self._cond.wait()
                if not self._jobs:
                    self._thread = None
                    return
                job = self._jobs.popleft()
                self._current = job
            try:
                self._result(job.snapshot_id, self._snapshot(job))
            except Exception as exc:  # noqa: BLE001 - R20.10: report and keep accepting work
                _log.error("camera worker raised %s", type(exc).__name__)
                self._post(AdapterError(code="adapter_failed"))
                self._result(job.snapshot_id, _failed(job.snapshot_id))
            finally:
                job.proc_exited.set()
                with self._cond:
                    if self._current is job:
                        self._current = None
                    self._cond.notify_all()

    def _snapshot(self, job: _Job) -> SnapshotReady | SnapshotFailed:
        """Capture at qualities 80, 60, 40 until the JPEG fits; return the result to post.

        The result is returned, not posted, so the temporary directory is already deleted
        when the State_Machine sees it (R18.6).
        """
        fail = _failed(job.snapshot_id)
        with tempfile.TemporaryDirectory(prefix="warashi-snap-") as tmp:
            for quality in QUALITIES:
                path = Path(tmp) / f"q{quality}.jpg"
                argv = [
                    "rpicam-still", "-n", "-t", "500", "--width", "640", "--height", "480",
                    "-q", str(quality), "-o", str(path),
                ]  # fmt: skip
                if not self._run(job, argv):
                    return fail
                try:
                    data = path.read_bytes() if path.is_file() else b""
                except OSError as exc:
                    _log.warning("could not read the snapshot file: %s", type(exc).__name__)
                    return fail
                if not data:
                    _log.warning("rpicam-still wrote no JPEG at quality %d", quality)
                    return fail
                if len(data) <= self._max_bytes:
                    size = jpeg_size(data)
                    if size is None:
                        _log.warning("the snapshot JPEG has no readable size header")
                        return fail
                    return SnapshotReady(
                        snapshot_id=job.snapshot_id, jpeg=data, width=size[0], height=size[1]
                    )
                _log.info("snapshot is %d bytes at quality %d, over the limit", len(data), quality)
        return SnapshotFailed(snapshot_id=job.snapshot_id, code="snapshot_too_large")

    def _run(self, job: _Job, argv: list[str]) -> bool:
        """Run ``argv`` within the job's deadline; True only for a clean exit code 0.

        On timeout the process gets SIGTERM and, 0.5 s later, SIGKILL (R18.1). A stop
        request counts as a failure.
        """
        remaining = job.deadline - self._scheduler.now()
        if remaining <= 0 or job.cancel.is_set():
            return False
        try:
            proc = self._runner(argv)
        except OSError as exc:
            _log.warning("rpicam-still could not start: %s", type(exc).__name__)
            return False
        with job.lock:
            job.proc_exited.clear()  # each quality step is a new process
            job.proc = proc
            cancelled = job.cancel.is_set()
        if cancelled:
            # stop() ran while the process was starting and saw no process to terminate.
            _terminate_and_reap(proc)
            return False
        try:
            proc.communicate(timeout=remaining)
        except subprocess.TimeoutExpired:
            _log.warning("rpicam-still still running at the deadline, stopping it")
            _terminate_and_reap(proc)
            return False
        finally:
            job.proc_exited.set()
        if proc.returncode != 0:
            _log.warning("rpicam-still exited with code %s", proc.returncode)
            return False
        return not job.cancel.is_set()


# --------------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------------


def _signal(proc: Process, how: Literal["terminate", "kill"]) -> None:
    """Send SIGTERM or SIGKILL, ignoring a process that has already gone."""
    try:
        if how == "terminate":
            proc.terminate()
        else:
            proc.kill()
    except OSError:
        pass


def _terminate_and_reap(proc: Process) -> None:
    """SIGTERM, wait ``KILL_GRACE_S``, then SIGKILL and wait once more; never waits longer."""
    _signal(proc, "terminate")
    try:
        proc.communicate(timeout=KILL_GRACE_S)
        return
    except subprocess.TimeoutExpired:
        pass
    _signal(proc, "kill")
    try:
        proc.communicate(timeout=KILL_GRACE_S)
    except subprocess.TimeoutExpired:
        _log.error("rpicam-still did not exit after SIGKILL")
