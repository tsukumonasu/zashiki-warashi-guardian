"""``--selftest``: exercise each adapter once, slowly; PASS, FAIL or SKIP each (R27.5-27.10).

Why this module exists:
- On the real doll the owner needs a way to check the wiring one part at a time, without the
  State_Machine making decisions in between. The steps run in a fixed order and each one is
  bounded by its own timeout, so a dead part is reported and never hangs the run.
- It takes the same ports, Scheduler and Cloud_Link as the Dispatcher, so it runs against the
  real adapters on the Pi and against the fakes with a ``ManualScheduler`` on a laptop.
- Adapters report results as Events through their ``post`` callback. The caller builds the
  adapters with ``inbox.put`` as that callback and passes the same ``inbox`` here; the
  self-test reads it instead of running the Dispatcher.
- Waiting is injected as ``wait(seconds)``: ``time.sleep`` in production, ``scheduler.advance``
  in tests, so tests never sleep (tech.md, "Pure core").

Hardware safety (hardware.md): servos move only when ``motion_enabled`` is true, only to a
+10 degree target clamped to the calibrated limit, and are detached afterwards. Whatever
happens (end, failure, SIGINT or SIGTERM), the servos are detached and the lantern is switched
off at once, without gliding back (R27.10).

Output never carries URLs, image bytes or voice line text. Only the byte size of the snapshot
and the ``id`` of the voice line are printed.
"""

from __future__ import annotations

import queue
import threading
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final

from warashi_agent.adapters.cloud import CloudLink
from warashi_agent.config import Config
from warashi_agent.dispatcher import Adapters
from warashi_agent.messages import Envelope, StatusReport
from warashi_agent.model import (
    AdapterError,
    AudioFailed,
    AudioFinished,
    Category,
    Event,
    GazeTarget,
    LanternFade,
    Mode,
    PirFalling,
    PirRising,
    PlayLine,
    ReleaseServos,
    ServoArrived,
    SnapshotFailed,
    SnapshotReady,
    State,
    TakeSnapshot,
)
from warashi_agent.timebase import Scheduler
from warashi_agent.voice import VoiceLine

EXIT_OK: Final = 0
"""Every step passed or was skipped."""

EXIT_FAILED: Final = 1
"""At least one step failed, or the run was interrupted (R27.6, R27.10)."""

PIR_WINDOW_S: Final = 10.0
"""How long the PIR edges are counted (R27.5)."""

POLL_S: Final = 0.05
"""Granularity of ``wait`` while a result is awaited. Small enough to see an Event promptly."""

LANTERN_LEVEL: Final = 0.5
LANTERN_FADE_MS: Final = 1000
SERVO_TEST_DEG: Final = 10.0

MOTION_HINT: Final = "set motion_enabled = true in config.toml after the servos are calibrated"
BATTERY_HINT: Final = "If the head and lantern did nothing, check the battery rail"

Wait = Callable[[float], None]
Out = Callable[[str], None]


class _InterruptedError(Exception):
    """Raised inside a wait when SIGINT or SIGTERM arrived; never leaves this module."""


class _SkipError(Exception):
    """A step that does not apply; printed as ``SKIP <name>: <reason>``."""


class _StepFailedError(Exception):
    """A step's FAIL reason, printed as ``FAIL <name>: <reason>``."""


def run_selftest(
    *,
    config: Config,
    adapters: Adapters,
    cloud: CloudLink,
    lines: tuple[VoiceLine, ...],
    inbox: queue.SimpleQueue[Event],
    scheduler: Scheduler,
    wait: Wait,
    out: Out,
    agent_version: str,
    interrupt: threading.Event | None = None,
    new_uid: Callable[[], str] | None = None,
    utc_now: Callable[[], datetime] | None = None,
) -> int:
    """Run every step, make the hardware safe, print the summary and return the exit code.

    ``inbox`` is the queue the adapters post into. ``interrupt`` is set by the signal handler
    of the entry point; it is checked on every poll, so the run stops within one poll step.
    Returns ``EXIT_OK`` (0) when no step failed, ``EXIT_FAILED`` (1) otherwise or when
    interrupted. Never raises for an adapter problem.
    """
    run = _Run(
        config=config,
        adapters=adapters,
        cloud=cloud,
        lines=lines,
        inbox=inbox,
        scheduler=scheduler,
        wait=wait,
        out=out,
        agent_version=agent_version,
        interrupt=interrupt if interrupt is not None else threading.Event(),
        new_uid=new_uid if new_uid is not None else lambda: str(uuid.uuid4()),
        utc_now=utc_now if utc_now is not None else lambda: datetime.now(UTC),
    )
    return run.execute()


class _Run:
    """State of one self-test run: the injected parts and the failure count."""

    def __init__(
        self,
        *,
        config: Config,
        adapters: Adapters,
        cloud: CloudLink,
        lines: tuple[VoiceLine, ...],
        inbox: queue.SimpleQueue[Event],
        scheduler: Scheduler,
        wait: Wait,
        out: Out,
        agent_version: str,
        interrupt: threading.Event,
        new_uid: Callable[[], str],
        utc_now: Callable[[], datetime],
    ) -> None:
        self._config = config
        self._adapters = adapters
        self._cloud = cloud
        self._lines = lines
        self._inbox = inbox
        self._scheduler = scheduler
        self._wait = wait
        self._out = out
        self._agent_version = agent_version
        self._interrupt = interrupt
        self._new_uid = new_uid
        self._utc_now = utc_now
        self._failures = 0
        self._interrupted = False

    # ----------------------------------------------------------------------------------------
    # Sequence
    # ----------------------------------------------------------------------------------------

    def execute(self) -> int:
        steps: tuple[tuple[str, Callable[[], str | None], Callable[[], None]], ...] = (
            ("lantern", self._lantern, self._adapters.lantern.off_now),
            ("servos", self._servos, self._adapters.servo.emergency_detach),
            ("pir", self._pir, self._noop),
            ("camera", self._camera, self._adapters.camera.stop),
            ("audio", self._audio, self._adapters.audio.stop),
            ("cloud", self._cloud_publish, self._noop),
        )
        try:
            for name, step, cleanup in steps:
                self._run_step(name, step, cleanup)
        except _InterruptedError:
            self._interrupted = True
        except KeyboardInterrupt:
            self._interrupted = True
        finally:
            # Hardware first, then text: the 1 s bound of R27.10 must not depend on printing.
            self._make_safe()
        if self._interrupted:
            self._print("INTERRUPTED: hardware detached and lantern off")
        self._print(BATTERY_HINT)
        return EXIT_FAILED if self._failures or self._interrupted else EXIT_OK

    def _run_step(
        self, name: str, step: Callable[[], str | None], cleanup: Callable[[], None]
    ) -> None:
        """Run one step and print its line. ``step`` returns a PASS detail or ``None``.

        A failing step makes its own part safe at once (servos detached, lantern off), so a
        later step cannot move hardware that is already misbehaving.
        """
        self._drain()
        try:
            detail = step()
        except (_InterruptedError, KeyboardInterrupt):
            raise
        except _SkipError as skip:
            self._print(f"SKIP {name}: {skip}")
            return
        except _StepFailedError as failure:
            self._fail(name, str(failure), cleanup)
            return
        except Exception as exc:  # noqa: BLE001 - an adapter bug is a FAIL, not a crash
            # Type only: an exception message could repeat event data (R13.6).
            self._fail(name, f"raised {type(exc).__name__}", cleanup)
            return
        self._print(f"PASS {name}" + (f": {detail}" if detail else ""))

    def _fail(self, name: str, reason: str, cleanup: Callable[[], None]) -> None:
        self._failures += 1
        self._print(f"FAIL {name}: {reason}")
        self._guarded(cleanup)

    # ----------------------------------------------------------------------------------------
    # Steps
    # ----------------------------------------------------------------------------------------

    def _lantern(self) -> str | None:
        fade_s = LANTERN_FADE_MS / 1000
        for level in (LANTERN_LEVEL, 0.0):
            self._adapters.lantern.handle(LanternFade(level=level, fade_ms=LANTERN_FADE_MS))
            # Wait for the fade plus one poll; an adapter error aborts early.
            event = self._await(fade_s + POLL_S, lambda e: False)
            if event is not None:  # only an AdapterError ends the wait early
                raise _StepFailedError(self._adapter_error_text(event))
        return None

    def _servos(self) -> str | None:
        if not self._config.motion.motion_enabled:
            raise _SkipError(f"motion_enabled is false; {MOTION_HINT}")
        servo = self._config.servo
        pan = min(SERVO_TEST_DEG, servo.pan_limit)
        tilt = min(SERVO_TEST_DEG, servo.tilt_limit)
        for pan_deg, tilt_deg in ((pan, 0.0), (0.0, 0.0), (0.0, tilt), (0.0, 0.0)):
            self._glide(pan_deg, tilt_deg)
        self._adapters.servo.handle(ReleaseServos())
        return None

    def _glide(self, pan_deg: float, tilt_deg: float) -> None:
        motion_id = self._new_uid()
        self._adapters.servo.handle(
            GazeTarget(pan_deg=pan_deg, tilt_deg=tilt_deg, motion_id=motion_id)
        )
        timeout = self._config.timing.glide_timeout_s
        event = self._await(
            timeout, lambda e: isinstance(e, ServoArrived) and e.motion_id == motion_id
        )
        if event is None:
            raise _StepFailedError(f"no servo.arrived within {timeout:g} s")
        if isinstance(event, AdapterError):
            raise _StepFailedError(self._adapter_error_text(event))

    def _pir(self) -> str | None:
        self._adapters.pir.start()
        edges = 0

        def count(event: Event) -> bool:
            nonlocal edges
            if isinstance(event, PirRising | PirFalling):
                edges += 1
            return False

        event = self._await(PIR_WINDOW_S, count)
        if event is not None:
            raise _StepFailedError(self._adapter_error_text(event))
        return f"{edges} edges in {PIR_WINDOW_S:g} s"

    def _camera(self) -> str | None:
        snapshot_id = self._new_uid()
        self._adapters.camera.handle(TakeSnapshot(snapshot_id=snapshot_id))
        timeout = self._config.timing.camera_timeout_s
        event = self._await(
            timeout,
            lambda e: (
                isinstance(e, SnapshotReady | SnapshotFailed) and e.snapshot_id == snapshot_id
            ),
        )
        if event is None:
            raise _StepFailedError(f"no snapshot result within {timeout:g} s")
        if isinstance(event, SnapshotReady):
            return f"{len(event.jpeg)} bytes"
        if isinstance(event, SnapshotFailed):
            raise _StepFailedError(event.code)
        raise _StepFailedError(self._adapter_error_text(event))

    def _audio(self) -> str | None:
        probe = self._adapters.audio.probe()
        if not probe.ok:
            raise _StepFailedError(
                f"{probe.code}: {probe.hint}" if probe.hint else str(probe.code)
            )
        candidates = [line for line in self._lines if line.category is Category.UNCERTAIN]
        if not candidates:
            raise _StepFailedError("no uncertain voice line is available")
        line = min(candidates, key=lambda candidate: candidate.id)
        play_id = self._new_uid()
        self._adapters.audio.handle(PlayLine(line_id=line.id, play_id=play_id))
        timeout = self._config.timing.audio_timeout_s
        event = self._await(
            timeout,
            lambda e: isinstance(e, AudioFinished | AudioFailed) and e.play_id == play_id,
        )
        if event is None:
            raise _StepFailedError(f"no audio result within {timeout:g} s")
        if isinstance(event, AudioFinished):
            return f"line {line.id}"
        if isinstance(event, AudioFailed):
            raise _StepFailedError(event.code)
        raise _StepFailedError(self._adapter_error_text(event))

    def _cloud_publish(self) -> str | None:
        report = StatusReport(
            state=State.SLEEPING,
            mode=Mode.GUARD,
            pan_deg=0.0,
            tilt_deg=0.0,
            lantern=0.0,
            camera_active=False,
            mic_active=False,
            motion_enabled=self._config.motion.motion_enabled,
            uptime_sec=0,
            agent_version=self._agent_version,
        )
        self._cloud.publish(
            Envelope(
                id=self._new_uid(),
                ts=self._utc_now(),
                device_id=self._config.device.id,
                encounter_id=None,
                data=report,
            )
        )
        return None

    # ----------------------------------------------------------------------------------------
    # Waiting
    # ----------------------------------------------------------------------------------------

    def _await(self, timeout_s: float, match: Callable[[Event], bool]) -> Event | None:
        """Wait up to ``timeout_s`` for an Event that ``match`` accepts.

        Returns that Event, or an ``AdapterError`` as soon as one arrives (the step then
        fails), or ``None`` at the deadline. ``match`` sees every Event, so the PIR step can
        count edges with it. Time comes from the Scheduler, so a ``ManualScheduler`` driven
        by ``wait`` gives exact, sleep-free runs.
        """
        deadline = self._scheduler.now() + timeout_s
        while True:
            self._check_interrupt()
            while True:
                try:
                    event = self._inbox.get_nowait()
                except queue.Empty:
                    break
                if isinstance(event, AdapterError):
                    return event
                if match(event):
                    return event
            remaining = deadline - self._scheduler.now()
            if remaining <= 0:
                return None
            self._wait(min(POLL_S, remaining))

    def _check_interrupt(self) -> None:
        if self._interrupt.is_set():
            raise _InterruptedError

    def _drain(self) -> None:
        """Drop Events left from an earlier step (late results, Ticks, connectivity)."""
        while True:
            try:
                self._inbox.get_nowait()
            except queue.Empty:
                return

    @staticmethod
    def _adapter_error_text(event: Event) -> str:
        code = event.code if isinstance(event, AdapterError) else "unexpected result"
        return f"adapter.error {code}"

    # ----------------------------------------------------------------------------------------
    # Safety and output
    # ----------------------------------------------------------------------------------------

    def _make_safe(self) -> None:
        """Detach the servos and switch the lantern off at once, then stop the rest (R27.10).

        No glide and no fade: each call writes immediately. Each stop is guarded alone so one
        failing adapter cannot keep the lantern from going dark.
        """
        for stop in (
            self._adapters.servo.emergency_detach,
            self._adapters.lantern.off_now,
            self._adapters.pir.close,
            self._adapters.camera.stop,
            self._adapters.audio.stop,
        ):
            self._guarded(stop)

    def _guarded(self, stop: Callable[[], None]) -> None:
        try:
            stop()
        except Exception as exc:  # noqa: BLE001 - shutdown must continue
            self._print(f"FAIL cleanup: raised {type(exc).__name__}")
            self._failures += 1

    @staticmethod
    def _noop() -> None:
        return None

    def _print(self, text: str) -> None:
        self._out(text)
