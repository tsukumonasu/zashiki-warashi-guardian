"""Audio_Adapter: cached lines and downloaded WAVs through ``aplay``, and the audio probe (R19).

Why it is built this way:

- ``handle()`` only enqueues a job and returns. One worker thread runs the jobs one at a time,
  because playback (``aplay``) and downloads (``urllib``) block for seconds, and the main loop
  must keep processing Ticks meanwhile (R20.2, R20.3, hardware.md). One worker, not one per
  job, because a second ``aplay`` cannot open the speakerphone while the first still holds it.
- A new request interrupts the running and the queued ones (R19.4): the old process gets
  SIGTERM at once and SIGKILL 0.5 s later through the ``Scheduler``, and the old Play_Id gets
  ``audio.failed(interrupted)``. Every result goes through ``OnceResult``, so an interruption
  racing a finishing worker still gives each Play_Id exactly one result (R19.9).
- Every blocking call has a bound: ``aplay`` waits at most ``audio_timeout_s``, the probe at
  most ``probe_timeout_s``, a download at most ``download_timeout_s`` in total with each socket
  read bounded by 2 s (R19.1, R19.5, R19.7).
- Downloads accept only ``https`` and refuse a redirect to anything else, because the default
  ``urllib`` redirect handler follows ``http`` targets (R19.5). A short-lived URL carries its
  token in the query string, so URLs reach a log line only through ``redact_url`` and
  exceptions are logged by type only (R13.6).
- Process output is read only with ``communicate()``, which drains both pipes (see ``Process``
  in ``ports.py``).
- Child processes and URLs come from an injected ``Runner`` and opener, so tests script exit
  codes, durations and downloads without ``aplay`` or a network (tech.md).

Importing this module or constructing the adapter starts nothing: the worker thread starts
with the first request.
"""

from __future__ import annotations

import http.client
import logging
import os
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

from warashi_agent.adapters.ports import OnceResult, ProbeResult, Process, Runner, popen_runner
from warashi_agent.config import Config
from warashi_agent.model import (
    AdapterError,
    AudioFailed,
    AudioFinished,
    Event,
    PlayAudioUrl,
    PlayLine,
)
from warashi_agent.redact import one_line, redact_url
from warashi_agent.timebase import Scheduler
from warashi_agent.voice import VoiceLine

_log = logging.getLogger(__name__)

Post = Callable[[Event], None]
"""Hands an Event to the Dispatcher queue; safe to call from any thread."""

VOICE_DIR = Path(__file__).resolve().parent.parent / "voice"
"""Directory of ``lines.toml`` and the cached WAV files (``voice/<wav>``, R19.1)."""

DOWNLOAD_MAX_BYTES = 2_000_000
"""Largest accepted ``audioUrl`` body (docs/schema.md, ``speak.audioUrl``; R19.5)."""

READ_TIMEOUT_MAX_S = 2.0
"""Upper bound of one blocking socket operation, so cancel and the total deadline are seen."""

CHUNK_BYTES = 16_384
KILL_GRACE_S = 0.5
"""Time a process gets between SIGTERM and SIGKILL."""

AUDIO_DEVICE_HINT = (
    "Audio device not found: the USB cable and the power cable may be swapped between the PWR "
    "and USB ports"
)

FailCode = Literal["audio_failed", "download_failed"]


# --------------------------------------------------------------------------------------------
# Download (R19.5, R19.6)
# --------------------------------------------------------------------------------------------


class HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    """Refuses a redirect whose target is not ``https``.

    ``HTTPRedirectHandler`` follows redirects to ``http`` URLs by default, which would let a
    signed ``https`` URL bounce the device to a plain-text download (R19.5).
    """

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> urllib.request.Request | None:
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise urllib.error.URLError("redirect to a non-https URL")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class UrlResponse(Protocol):
    """The part of an ``urllib`` response that ``download`` uses."""

    def read(self, amt: int, /) -> bytes: ...

    def __enter__(self) -> UrlResponse: ...

    def __exit__(self, *exc_info: object) -> object: ...


class UrlOpener(Protocol):
    """The part of ``urllib.request.OpenerDirector`` that ``download`` uses.

    Tests inject a scripted opener; production uses ``build_https_opener()``.
    """

    def open(self, fullurl: str, data: None = None, timeout: float = ...) -> UrlResponse: ...


def build_https_opener() -> urllib.request.OpenerDirector:
    """The production opener: the stdlib handlers with ``HttpsOnlyRedirect`` in place."""
    return urllib.request.build_opener(HttpsOnlyRedirect)


def is_pcm16_wav(path: Path) -> bool:
    """True when ``path`` is a readable 16-bit uncompressed PCM WAV (R19.5).

    Unlike the cached lines (``voice.is_pcm16_mono_wav``), downloaded audio may be stereo:
    ``plughw`` converts the channel count, and the contract only asks for 16-bit PCM WAV.
    """
    try:
        with wave.open(str(path), "rb") as wav:
            return wav.getsampwidth() == 2 and wav.getcomptype() == "NONE"
    except Exception:  # noqa: BLE001 - any parse failure of untrusted bytes means "not a WAV"
        return False


def download(
    url: str,
    dest: Path,
    timeout_s: float,
    cancel: threading.Event,
    *,
    opener: UrlOpener | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """Download ``url`` into ``dest`` and return True only for an acceptable WAV (R19.5).

    Returns False, with ``dest`` deleted, for a non-``https`` URL, a refused redirect, any
    ``urllib`` or socket error, more than ``DOWNLOAD_MAX_BYTES``, a total time above
    ``timeout_s``, ``cancel`` being set, or a body that is not 16-bit PCM WAV (R19.6). Each
    blocking socket operation is bounded by ``min(timeout_s, 2 s)``, so the loop notices the
    total deadline and ``cancel`` at least that often. Reads ask for at most one byte beyond
    the limit, so an oversized body is cut without reading it.
    """
    ok = False
    try:
        if urllib.parse.urlsplit(url).scheme != "https":
            return False
        end = clock() + timeout_s
        if cancel.is_set():
            return False
        active = opener if opener is not None else build_https_opener()
        with (
            active.open(url, timeout=min(timeout_s, READ_TIMEOUT_MAX_S)) as resp,
            dest.open("wb") as out,
        ):
            total = 0
            while chunk := resp.read(min(CHUNK_BYTES, DOWNLOAD_MAX_BYTES + 1 - total)):
                total += len(chunk)
                if total > DOWNLOAD_MAX_BYTES or clock() > end or cancel.is_set():
                    return False
                out.write(chunk)
        ok = clock() <= end and not cancel.is_set() and is_pcm16_wav(dest)
        return ok
    except (OSError, ValueError, http.client.HTTPException):
        # URLError, HTTPError, timeouts and TLS errors are OSError; an unparsable URL is a
        # ValueError; a truncated body is an HTTPException. All mean "download failed".
        return False
    finally:
        if not ok:
            _unlink(dest)


# --------------------------------------------------------------------------------------------
# Probe (R19.7)
# --------------------------------------------------------------------------------------------


def pcm_names(listing: str) -> tuple[str, ...]:
    """PCM names in ``aplay -L`` output: the non-empty lines without leading whitespace.

    ``aplay -L`` prints each name on its own line, followed by indented description lines.
    """
    return tuple(
        line.rstrip() for line in listing.splitlines() if line.strip() and not line[0].isspace()
    )


# --------------------------------------------------------------------------------------------
# Adapter
# --------------------------------------------------------------------------------------------


@dataclass(eq=False)
class _Job:
    """One play request on its way through the worker.

    ``lock`` guards ``proc`` against the interrupting thread: the worker publishes the process
    under it, and the interrupter sets ``cancel`` and reads ``proc`` under it, so a process
    started during an interruption is always seen by one of the two and terminated.
    """

    play_id: str
    line_id: str | None = None
    url: str | None = field(default=None, repr=False)  # may hold a token (R13.6)
    fail_code: FailCode = "audio_failed"
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    proc: Process | None = None
    proc_exited: threading.Event = field(default_factory=threading.Event)

    @classmethod
    def from_action(cls, action: PlayLine | PlayAudioUrl) -> _Job:
        if isinstance(action, PlayLine):
            return cls(play_id=action.play_id, line_id=action.line_id)
        return cls(play_id=action.play_id, url=action.url, fail_code="download_failed")


class AudioAdapter:
    """AudioPort on ``aplay`` and ``urllib`` (R19.1 to R19.7, R19.9).

    ``lines`` are the Available_Lines of the Voice_Manifest; a ``PlayLine`` plays
    ``voice_dir / <wav>`` of its line. ``download_dir`` holds downloaded WAVs while they play
    (the system temporary directory by default); each file is deleted after playback, failure
    or interruption (R19.5).
    """

    def __init__(
        self,
        post: Post,
        scheduler: Scheduler,
        config: Config,
        lines: Iterable[VoiceLine],
        *,
        voice_dir: Path = VOICE_DIR,
        runner: Runner = popen_runner,
        opener: UrlOpener | None = None,
        download_dir: Path | None = None,
    ) -> None:
        self._post = post
        self._scheduler = scheduler
        self._device = config.audio.audio_device
        self._audio_timeout_s = config.timing.audio_timeout_s
        self._download_timeout_s = config.timing.download_timeout_s
        self._probe_timeout_s = config.timing.probe_timeout_s
        self._wavs = {line.id: line.wav for line in lines}
        self._voice_dir = voice_dir
        self._runner = runner
        self._opener = opener
        self._download_dir = download_dir
        self._once = OnceResult()
        self._cond = threading.Condition()
        self._jobs: deque[_Job] = deque()
        self._current: _Job | None = None
        self._thread: threading.Thread | None = None
        self._stopped = False

    # -- AudioPort ------------------------------------------------------------------------

    def handle(self, action: PlayLine | PlayAudioUrl) -> None:
        """Interrupt earlier requests and queue this one; never blocks and never raises."""
        try:
            job = _Job.from_action(action)
            with self._cond:
                stopped = self._stopped
                old = self._take_unfinished_locked()
            for earlier in old:
                self._interrupt(earlier, schedule_kill=True)
            if stopped:
                # Shutting down: nothing plays any more. ``interrupted`` gives the Play_Id its
                # one result without reporting an error for a request nobody can hear.
                self._result(job.play_id, AudioFailed(play_id=job.play_id, code="interrupted"))
                return
            with self._cond:
                self._jobs.append(job)
                self._ensure_worker_locked()
                self._cond.notify_all()
        except Exception as exc:  # noqa: BLE001 - handle() must never raise into the loop
            _log.error("audio request failed: %s", type(exc).__name__)
            self._post(AdapterError(code="adapter_failed"))
            code: FailCode = "audio_failed" if isinstance(action, PlayLine) else "download_failed"
            self._result(action.play_id, AudioFailed(play_id=action.play_id, code=code))

    def probe(self) -> ProbeResult:
        """Check that ``aplay -L`` lists ``audio_device`` within ``probe_timeout_s`` (R19.7).

        The startup sequence logs the hint and publishes the code; the agent keeps running
        with lantern and gaze either way.
        """
        failed = ProbeResult.failed("audio_device_missing", AUDIO_DEVICE_HINT)
        try:
            proc = self._runner(["aplay", "-L"])
        except OSError as exc:
            _log.warning("aplay -L could not start: %s", type(exc).__name__)
            return failed
        try:
            try:
                stdout, _ = proc.communicate(timeout=self._probe_timeout_s)
            except subprocess.TimeoutExpired:
                _log.warning("aplay -L did not finish within %.1f s", self._probe_timeout_s)
                _terminate_and_reap(proc)
                return failed
            if proc.returncode != 0:
                _log.warning("aplay -L exited with code %s", proc.returncode)
                return failed
            if self._device not in pcm_names(stdout or ""):
                _log.warning("aplay -L does not list %s", one_line(repr(self._device)))
                return failed
            return ProbeResult.passed()
        except Exception as exc:  # noqa: BLE001 - a probe reports; it never stops startup
            _log.error("audio probe raised %s", type(exc).__name__)
            return failed

    def stop(self) -> None:
        """Stop playback and downloads for shutdown (R20.7).

        Does not rely on the Scheduler, which may already be shut down: it sends SIGTERM,
        waits at most ``KILL_GRACE_S`` per process and then sends SIGKILL. Later requests get
        ``audio.failed(interrupted)`` without playing.
        """
        with self._cond:
            self._stopped = True
            current = self._current
            old = self._take_unfinished_locked()
            self._cond.notify_all()
        for job in old:
            self._interrupt(job, schedule_kill=False)
        # An earlier interruption may still wait for its scheduled SIGKILL; do not rely on it.
        running = old if current is None or current in old else [current, *old]
        for job in running:
            with job.lock:
                proc = job.proc
            if proc is not None and not job.proc_exited.wait(KILL_GRACE_S):
                _signal(proc, "kill")

    # -- Test support ---------------------------------------------------------------------

    def wait_idle(self, timeout: float) -> bool:
        """Wait until no job is queued or running; True if that happened within ``timeout``.

        Tests call this after advancing the scheduler past every deadline, because results
        come from the worker thread.
        """
        with self._cond:
            return self._cond.wait_for(
                lambda: not self._jobs and self._current is None, timeout=timeout
            )

    # -- Interruption ---------------------------------------------------------------------

    def _take_unfinished_locked(self) -> list[_Job]:
        """Return the running job and every queued one, and empty the queue (lock held).

        The running job stays ``_current`` until the worker has finished its cleanup, so
        ``wait_idle`` also waits for the old process to exit and its download to be deleted.
        A running job that was already interrupted is not returned a second time.
        """
        current = self._current
        old = [current] if current is not None and not current.cancel.is_set() else []
        old.extend(self._jobs)
        self._jobs.clear()
        return old

    def _interrupt(self, job: _Job, *, schedule_kill: bool) -> None:
        """Stop ``job`` and give its Play_Id ``audio.failed(interrupted)`` (R19.4).

        SIGTERM goes out at once; a SIGKILL follows ``KILL_GRACE_S`` later through the
        Scheduler, so the caller (the main loop) never waits for the process to exit.
        """
        with job.lock:
            job.cancel.set()
            proc = job.proc
        if proc is not None and not job.proc_exited.is_set():
            _signal(proc, "terminate")
            if schedule_kill:
                self._scheduler.call_later(KILL_GRACE_S, lambda: self._kill_if_running(job))
        self._result(job.play_id, AudioFailed(play_id=job.play_id, code="interrupted"))

    @staticmethod
    def _kill_if_running(job: _Job) -> None:
        with job.lock:
            proc = job.proc
        if proc is not None and not job.proc_exited.is_set():
            _signal(proc, "kill")

    def _result(self, play_id: str, event: AudioFinished | AudioFailed) -> None:
        """Post ``event`` unless ``play_id`` already has its one result (R19.9)."""
        if self._once.claim(play_id):
            self._post(event)

    # -- Worker ---------------------------------------------------------------------------

    def _ensure_worker_locked(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._worker, name="warashi-audio", daemon=True)
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
                if not job.cancel.is_set():
                    self._run_job(job)
            except Exception as exc:  # noqa: BLE001 - R20.10: report and keep accepting work
                _log.error("audio worker raised %s", type(exc).__name__)
                self._post(AdapterError(code="adapter_failed"))
                self._result(job.play_id, AudioFailed(play_id=job.play_id, code=job.fail_code))
            finally:
                job.proc_exited.set()
                with self._cond:
                    if self._current is job:
                        self._current = None
                    self._cond.notify_all()

    def _run_job(self, job: _Job) -> None:
        if job.url is not None:
            self._run_download(job, job.url)
        else:
            self._run_line(job, job.line_id or "")

    def _run_line(self, job: _Job, line_id: str) -> None:
        wav = self._wavs.get(line_id)
        path = self._voice_dir / wav if wav is not None else None
        if path is None or not path.is_file():
            # The file can disappear after the startup check, for example on a bad deploy.
            _log.warning("voice line %s has no WAV file", one_line(repr(line_id)))
            self._result(job.play_id, AudioFailed(play_id=job.play_id, code="audio_failed"))
            return
        _log.info("playing voice line %s", one_line(repr(line_id)))
        self._play(job, path)

    def _run_download(self, job: _Job, url: str) -> None:
        shown = redact_url(url)
        try:
            fd, name = tempfile.mkstemp(
                prefix="warashi-dl-", suffix=".wav", dir=self._download_dir
            )
            os.close(fd)
        except OSError as exc:
            _log.warning("no space for the download of %s: %s", shown, type(exc).__name__)
            self._result(job.play_id, AudioFailed(play_id=job.play_id, code="download_failed"))
            return
        dest = Path(name)
        try:
            _log.info("downloading %s", shown)
            ok = download(
                url,
                dest,
                self._download_timeout_s,
                job.cancel,
                opener=self._opener,
                clock=self._scheduler.now,
            )
            if job.cancel.is_set():
                return  # interrupted: the interrupter posted the result
            if not ok:
                _log.warning("download of %s failed or is not a 16-bit PCM WAV", shown)
                self._result(job.play_id, AudioFailed(play_id=job.play_id, code="download_failed"))
                return
            job.fail_code = "audio_failed"
            self._play(job, dest)
        finally:
            _unlink(dest)  # after playback, failure or interruption (R19.5)

    def _play(self, job: _Job, path: Path) -> None:
        """Run ``aplay -q -D <audio_device> <file>`` bounded by ``audio_timeout_s`` (R19.1)."""
        argv = ["aplay", "-q", "-D", self._device, str(path)]
        try:
            proc = self._runner(argv)
        except OSError as exc:
            _log.warning("aplay could not start: %s", type(exc).__name__)
            self._result(job.play_id, AudioFailed(play_id=job.play_id, code="audio_failed"))
            return
        with job.lock:
            job.proc = proc
            cancelled = job.cancel.is_set()
        if cancelled:
            # Interrupted while the process was starting; the interrupter saw no process.
            _terminate_and_reap(proc)
            return
        timed_out = False
        try:
            proc.communicate(timeout=self._audio_timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            _log.warning("aplay still running after %.1f s, stopping it", self._audio_timeout_s)
            _terminate_and_reap(proc)
        job.proc_exited.set()
        if timed_out or proc.returncode != 0:
            if not timed_out and not job.cancel.is_set():
                _log.warning("aplay exited with code %s", proc.returncode)
            self._result(job.play_id, AudioFailed(play_id=job.play_id, code="audio_failed"))
        else:
            self._result(job.play_id, AudioFinished(play_id=job.play_id))


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
        _log.error("child process did not exit after SIGKILL")


def _unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        _log.warning("could not delete a downloaded file: %s", type(exc).__name__)
