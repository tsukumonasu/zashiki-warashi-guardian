"""Fake hardware for tests and ``--fake`` mode (R15.9, R16.5, R17.4, R18.7, R19.8).

Why this module exists:
- ``make test`` must pass on a laptop and in CI with no Raspberry Pi (tech.md, "Hardware-free
  tests"), and ``--fake`` mode must run the full loop on a laptop. Both use these fakes.
- Two kinds of fake live here. Device fakes (``FakeServoDeviceFactory``, ``FakePwmDevice``,
  ``FakeInputDevice``) stand in for gpiozero objects and are injected into the *real*
  adapters, so tests exercise the adapters' own timing and clamping logic. Port fakes
  (``FakePir``, ``FakeCamera``, ``FakeAudio``) replace a whole adapter behind its port.
- Fakes never sleep. Delayed results are callbacks on a ``Scheduler``: a ``ManualScheduler``
  in tests, so time moves only on ``advance(dt)``, and a ``ThreadScheduler`` in ``--fake``.
- The camera and audio fakes claim each id through ``OnceResult`` before posting, so an
  interruption and a finishing playback can never both report the same Play_Id (R18.8, R19.9).

This module imports only the standard library and the package's own modules. It never imports
``gpiozero`` or ``lgpio``, so it works where those packages are missing.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from warashi_agent.adapters.cloud import CloudPost, InboundRaw
from warashi_agent.adapters.ports import OnceResult, ProbeResult
from warashi_agent.messages import CommandData, Envelope, encode
from warashi_agent.model import (
    AudioFailed,
    AudioFinished,
    CloudConnected,
    CloudDisconnected,
    Event,
    PirFalling,
    PirRising,
    PlayAudioUrl,
    PlayLine,
    SnapshotFailed,
    SnapshotReady,
    TakeSnapshot,
)
from warashi_agent.timebase import Handle, Scheduler

Post = Callable[[Event], None]

_log = logging.getLogger(__name__)

# --------------------------------------------------------------------------------------------
# A fixed 1x1 JPEG
# --------------------------------------------------------------------------------------------

# A complete baseline JPEG of one grey pixel, built by hand so no image library is needed.
# It lives in the package, not in the tests, because ``--fake`` mode runs FakeCamera outside
# the test suite. The SOF0 segment declares height 1 and width 1, so a SOF parser such as
# ``jpeg_size`` reads (1, 1). Each Huffman table has one 1-bit code ("0"); the scan holds one
# block with DC difference 0 and an immediate end-of-block, i.e. the bits "00" padded with 1s.
FAKE_JPEG_1X1: bytes = (
    b"\xff\xd8"  # SOI
    + b"\xff\xdb\x00\x43\x00" + b"\x01" * 64  # DQT: table 0, 8-bit, all ones
    + b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"  # SOF0: 8-bit, 1x1, 1 component
    + b"\xff\xc4\x00\x14\x00\x01" + b"\x00" * 15 + b"\x00"  # DHT: DC table 0, symbol 0
    + b"\xff\xc4\x00\x14\x10\x01" + b"\x00" * 15 + b"\x00"  # DHT: AC table 0, EOB
    + b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00"  # SOS: 1 component, spectral 0..63
    + b"\x3f"  # entropy-coded data: "00" + padding
    + b"\xff\xd9"  # EOI
)  # fmt: skip
FAKE_JPEG_WIDTH = 1
FAKE_JPEG_HEIGHT = 1


# --------------------------------------------------------------------------------------------
# Servo devices (injected into the real Servo_Adapter)
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ServoCreation:
    """One servo output device creation (R15.6): when, and on which pin."""

    time: float
    pin: int


@dataclass(frozen=True)
class ServoWrite:
    """One Commanded_Angle written to a servo (R15.3), with the scheduler time of the write."""

    time: float
    pin: int
    angle: float


@dataclass(frozen=True)
class ServoPinEvent:
    """A detach or a PWM start on one pin."""

    time: float
    pin: int


class FakeServoDevice:
    """Stands in for one gpiozero ``AngularServo``; every observation goes to its factory.

    The device starts with no pulse, like ``AngularServo(initial_angle=None)`` (R15.10). The
    first angle written after creation or after a detach is recorded as a PWM start, because
    that is the moment the real servo starts receiving pulses. Writing ``None`` to ``angle``
    detaches, as it does in gpiozero.
    """

    def __init__(self, factory: FakeServoDeviceFactory, pin: int) -> None:
        self._factory = factory
        self.pin = pin
        self._angle: float | None = None
        self.closed = False

    @property
    def angle(self) -> float | None:
        return self._angle

    @angle.setter
    def angle(self, value: float | None) -> None:
        if value is None:
            self.detach()
            return
        self._factory._record_write(self, float(value))
        self._angle = float(value)

    def detach(self) -> None:
        self._factory._record_detach(self)
        self._angle = None

    def close(self) -> None:
        self._angle = None
        self.closed = True


class FakeServoDeviceFactory:
    """Records servo device creations, angle writes, detaches and PWM starts (R15.9).

    The real Servo_Adapter receives this factory in place of the gpiozero one, so its lazy
    creation, write timing and auto-detach can be checked against scheduler time. Times come
    from ``scheduler.now()``, which is the virtual clock in tests.

    ``fail_at_write`` makes the n-th angle write (0-based, over all pins) raise
    ``RuntimeError``, so tests can drive the adapter's worker failure path (R15.11).
    """

    def __init__(self, scheduler: Scheduler, *, fail_at_write: int | None = None) -> None:
        self._scheduler = scheduler
        self._fail_at_write = fail_at_write
        self._lock = threading.Lock()
        self._write_count = 0
        self.devices: list[FakeServoDevice] = []
        self.creations: list[ServoCreation] = []
        self.writes: list[ServoWrite] = []
        self.detaches: list[ServoPinEvent] = []
        self.pwm_starts: list[ServoPinEvent] = []

    def create(self, pin: int) -> FakeServoDevice:
        """Create a fake servo on ``pin``; sends no pulse, like ``initial_angle=None``."""
        device = FakeServoDevice(self, pin)
        with self._lock:
            self.devices.append(device)
            self.creations.append(ServoCreation(self._scheduler.now(), pin))
        return device

    __call__ = create

    def writes_for(self, pin: int) -> list[ServoWrite]:
        """The angle writes on one pin, in order."""
        with self._lock:
            return [w for w in self.writes if w.pin == pin]

    def _record_write(self, device: FakeServoDevice, angle: float) -> None:
        now = self._scheduler.now()
        with self._lock:
            index = self._write_count
            self._write_count += 1
            if index == self._fail_at_write:
                raise RuntimeError("scripted servo write failure")
            if device.angle is None:
                self.pwm_starts.append(ServoPinEvent(now, device.pin))
            self.writes.append(ServoWrite(now, device.pin, angle))

    def _record_detach(self, device: FakeServoDevice) -> None:
        with self._lock:
            self.detaches.append(ServoPinEvent(self._scheduler.now(), device.pin))


# --------------------------------------------------------------------------------------------
# Lantern PWM device (injected into the real Lantern_Adapter)
# --------------------------------------------------------------------------------------------


class FakePwmDevice:
    """Stands in for gpiozero ``PWMLED``; records ``(time, level)`` for every write (R16.5).

    ``PWMLED(initial_value=0)`` drives the pin at creation, so the initial value is recorded as
    the first write. Fade tests can then check every level the LED actually showed.
    """

    def __init__(self, scheduler: Scheduler, initial_value: float = 0.0) -> None:
        self._scheduler = scheduler
        self._lock = threading.Lock()
        self._value = float(initial_value)
        self.closed = False
        self.writes: list[tuple[float, float]] = [(scheduler.now(), self._value)]

    @property
    def value(self) -> float:
        return self._value

    @value.setter
    def value(self, level: float) -> None:
        level = float(level)
        with self._lock:
            self._value = level
            self.writes.append((self._scheduler.now(), level))

    def off(self) -> None:
        self.value = 0.0

    def close(self) -> None:
        self.closed = True

    @property
    def levels(self) -> list[float]:
        """The written levels without their times."""
        with self._lock:
            return [level for _, level in self.writes]


# --------------------------------------------------------------------------------------------
# PIR input device (injected into the real PIR_Adapter)
# --------------------------------------------------------------------------------------------


class FakeInputDevice:
    """Stands in for gpiozero ``DigitalInputDevice``; a test drives the input level.

    Like gpiozero, it calls ``when_activated`` / ``when_deactivated`` only when the level
    changes. An input that is already high when the adapter attaches its callbacks therefore
    fires nothing until it goes low and high again (R17.5).
    """

    def __init__(self, initial: bool = False) -> None:
        self._active = bool(initial)
        self.when_activated: Callable[[], None] | None = None
        self.when_deactivated: Callable[[], None] | None = None
        self.closed = False

    @property
    def value(self) -> int:
        return int(self._active)

    @property
    def is_active(self) -> bool:
        return self._active

    def drive_high(self) -> None:
        self._set(True)

    def drive_low(self) -> None:
        self._set(False)

    def close(self) -> None:
        self.closed = True
        self.when_activated = None
        self.when_deactivated = None

    def _set(self, active: bool) -> None:
        if active == self._active:
            return
        self._active = active
        callback = self.when_activated if active else self.when_deactivated
        if callback is not None and not self.closed:
            callback()


# --------------------------------------------------------------------------------------------
# PIR port
# --------------------------------------------------------------------------------------------

Edge = Literal["rise", "fall"]


class FakePir:
    """PirPort that posts typed or scripted edges (R17.4).

    The ``--fake`` keyboard calls ``rise()`` for ``p`` and ``fall()`` for ``u``. Tests can also
    script edges at given scheduler times with ``script()``. Edges are posted only between
    ``start()`` and ``close()``, as the real adapter has no callbacks outside that window, and
    they are posted in the order they happen with no debounce (R17.3).
    """

    def __init__(self, post: Post, scheduler: Scheduler) -> None:
        self._post = post
        self._scheduler = scheduler
        self._lock = threading.Lock()
        self._started = False
        self._handles: list[Handle] = []
        self.edges: list[tuple[float, Edge]] = []

    def start(self) -> None:
        with self._lock:
            self._started = True

    def close(self) -> None:
        with self._lock:
            self._started = False
            handles, self._handles = self._handles, []
        for handle in handles:
            handle.cancel()

    def rise(self) -> None:
        self._edge("rise")

    def fall(self) -> None:
        self._edge("fall")

    def script(self, edges: Iterable[tuple[float, Edge]]) -> None:
        """Post each ``(time, edge)`` at that scheduler time."""
        for when, edge in edges:
            handle = self._scheduler.call_at(when, lambda e=edge: self._edge(e))
            with self._lock:
                self._handles.append(handle)

    def _edge(self, edge: Edge) -> None:
        with self._lock:
            if not self._started:
                return
            self.edges.append((self._scheduler.now(), edge))
        self._post(PirRising() if edge == "rise" else PirFalling())


# --------------------------------------------------------------------------------------------
# Camera port
# --------------------------------------------------------------------------------------------

CameraFailure = Literal["camera_failed", "snapshot_too_large"]


@dataclass(frozen=True)
class CameraOutcome:
    """The scripted result of one ``TakeSnapshot``: delay, then the JPEG or a failure."""

    delay_s: float = 0.2
    failure: CameraFailure | None = None


class FakeCamera:
    """CameraPort that answers each ``TakeSnapshot`` with one scripted result (R18.7, R18.8).

    Outcomes queued with ``script()`` are used in order; once the queue is empty every
    snapshot succeeds after ``default_delay_s`` with ``FAKE_JPEG_1X1``. ``stop()`` posts
    ``camera_failed`` for snapshots still in flight, as the real adapter does when it
    terminates ``rpicam-still``, so every id still gets exactly one result.
    """

    def __init__(
        self,
        post: Post,
        scheduler: Scheduler,
        *,
        default_delay_s: float = 0.2,
        probe_result: ProbeResult | None = None,
    ) -> None:
        self._post = post
        self._scheduler = scheduler
        self._default = CameraOutcome(delay_s=default_delay_s)
        self._probe_result = probe_result if probe_result is not None else ProbeResult.passed()
        self._lock = threading.Lock()
        self._script: deque[CameraOutcome] = deque()
        self._pending: dict[str, Handle] = {}
        self._once = OnceResult()
        self.requests: list[TakeSnapshot] = []

    def script(self, *outcomes: CameraOutcome) -> None:
        with self._lock:
            self._script.extend(outcomes)

    def handle(self, action: TakeSnapshot) -> None:
        with self._lock:
            self.requests.append(action)
            outcome = self._script.popleft() if self._script else self._default
        handle = self._scheduler.call_later(
            outcome.delay_s, lambda: self._finish(action.snapshot_id, outcome.failure)
        )
        with self._lock:
            self._pending[action.snapshot_id] = handle

    def probe(self) -> ProbeResult:
        return self._probe_result

    def stop(self) -> None:
        with self._lock:
            pending, self._pending = self._pending, {}
        for snapshot_id, handle in pending.items():
            handle.cancel()
            self._finish(snapshot_id, "camera_failed")

    def _finish(self, snapshot_id: str, failure: CameraFailure | None) -> None:
        with self._lock:
            self._pending.pop(snapshot_id, None)
        if not self._once.claim(snapshot_id):
            return
        if failure is None:
            self._post(
                SnapshotReady(
                    snapshot_id=snapshot_id,
                    jpeg=FAKE_JPEG_1X1,
                    width=FAKE_JPEG_WIDTH,
                    height=FAKE_JPEG_HEIGHT,
                )
            )
        else:
            self._post(SnapshotFailed(snapshot_id=snapshot_id, code=failure))


# --------------------------------------------------------------------------------------------
# Audio port
# --------------------------------------------------------------------------------------------

AudioFailure = Literal["audio_failed", "download_failed"]


@dataclass(frozen=True)
class AudioOutcome:
    """The scripted result of one play request: after ``duration_s``, finish or fail."""

    duration_s: float = 1.0
    failure: AudioFailure | None = None


class FakeAudio:
    """AudioPort that records each play request and posts one scripted result (R19.8, R19.9).

    Outcomes queued with ``script()`` are used in order; once the queue is empty every request
    finishes after ``default_duration_s``. A new request while one is still playing interrupts
    it: the old Play_Id gets ``audio.failed(interrupted)`` at once, as in R19.4. ``stop()``
    interrupts the running request the same way. ``OnceResult`` ensures a Play_Id never gets
    both its scripted result and ``interrupted``.
    """

    def __init__(
        self,
        post: Post,
        scheduler: Scheduler,
        *,
        default_duration_s: float = 1.0,
        probe_result: ProbeResult | None = None,
    ) -> None:
        self._post = post
        self._scheduler = scheduler
        self._default = AudioOutcome(duration_s=default_duration_s)
        self._probe_result = probe_result if probe_result is not None else ProbeResult.passed()
        self._lock = threading.Lock()
        self._script: deque[AudioOutcome] = deque()
        self._current: tuple[str, Handle] | None = None
        self._once = OnceResult()
        self.requests: list[PlayLine | PlayAudioUrl] = []

    def script(self, *outcomes: AudioOutcome) -> None:
        with self._lock:
            self._script.extend(outcomes)

    @property
    def playing(self) -> str | None:
        """The Play_Id of the request still in progress, if any."""
        with self._lock:
            return self._current[0] if self._current is not None else None

    def handle(self, action: PlayLine | PlayAudioUrl) -> None:
        self._interrupt_current()
        with self._lock:
            self.requests.append(action)
            outcome = self._script.popleft() if self._script else self._default
        play_id = action.play_id
        handle = self._scheduler.call_later(
            outcome.duration_s, lambda: self._finish(play_id, outcome.failure)
        )
        with self._lock:
            self._current = (play_id, handle)

    def probe(self) -> ProbeResult:
        return self._probe_result

    def stop(self) -> None:
        self._interrupt_current()

    def _interrupt_current(self) -> None:
        with self._lock:
            current, self._current = self._current, None
        if current is None:
            return
        play_id, handle = current
        handle.cancel()
        if self._once.claim(play_id):
            self._post(AudioFailed(play_id=play_id, code="interrupted"))

    def _finish(self, play_id: str, failure: AudioFailure | None) -> None:
        with self._lock:
            if self._current is not None and self._current[0] == play_id:
                self._current = None
        if not self._once.claim(play_id):
            return
        if failure is None:
            self._post(AudioFinished(play_id=play_id))
        else:
            self._post(AudioFailed(play_id=play_id, code=failure))


# --------------------------------------------------------------------------------------------
# Cloud link
# --------------------------------------------------------------------------------------------

_Inbound = InboundRaw | CloudConnected | CloudDisconnected


class FakeCloudLink:
    """CloudLink that records what the device publishes and plays back a script (R21.6).

    Why: Dispatcher tests need to see every published envelope in order, feed in encoded
    commands as if they came from the broker, and flip connectivity, all on the test clock.

    - Published envelopes are kept as objects and in their encoded form, in publish order.
      An envelope that cannot be encoded is kept with ``None`` as its encoded form.
    - ``type_command`` and ``script_raw`` put ``InboundRaw`` on the Dispatcher's queue, and
      ``go_online`` / ``go_offline`` put ``CloudConnected`` / ``CloudDisconnected``, through
      the ``post`` given to ``start()``, now or at a Scheduler time. Nothing is delivered
      before ``start()`` or after ``stop()``.
    - ``stop()`` cancels every scripted item that has not run yet.
    - Like the real link, ``publish`` never waits and never raises.
    """

    def __init__(self, scheduler: Scheduler, device_id: str = "warashi-01") -> None:
        self._scheduler = scheduler
        self.device_id = device_id
        self._lock = threading.Lock()
        self._post: CloudPost | None = None
        self._pending: list[Handle] = []
        self._published: list[tuple[Envelope, bytes | None]] = []

    # -- CloudLink ----------------------------------------------------------------------

    def start(self, post: CloudPost) -> None:
        with self._lock:
            self._post = post

    def publish(self, envelope: Envelope) -> None:
        try:
            encoded: bytes | None = encode(envelope)
        except Exception as exc:  # the contract says publish never raises
            # Type name only: the exception text may quote payload content.
            _log.warning("fake cloud link could not encode an envelope (%s)", type(exc).__name__)
            encoded = None
        with self._lock:
            self._published.append((envelope, encoded))

    def stop(self) -> None:
        with self._lock:
            pending, self._pending = self._pending, []
            self._post = None
        for handle in pending:
            handle.cancel()

    # -- Recording ----------------------------------------------------------------------

    @property
    def published(self) -> list[tuple[Envelope, bytes | None]]:
        """A copy of the ``(envelope, encoded)`` pairs in publish order."""
        with self._lock:
            return list(self._published)

    @property
    def envelopes(self) -> list[Envelope]:
        """The published envelopes in publish order."""
        return [envelope for envelope, _ in self.published]

    @property
    def encoded(self) -> list[bytes]:
        """The encoded form of every envelope that could be encoded, in publish order."""
        return [raw for _, raw in self.published if raw is not None]

    # -- Scripting ----------------------------------------------------------------------

    def type_command(
        self,
        data: CommandData,
        *,
        at: float | None = None,
        message_id: str | None = None,
        encounter_id: str | None = None,
        device_id: str | None = None,
        v: int = 1,
    ) -> bytes:
        """Encode a command envelope for this device and post it as ``InboundRaw``.

        ``at`` is a Scheduler time; ``None`` posts at once. ``message_id`` defaults to a fresh
        UUID, so pass the same one twice to test the Deduplicator; ``device_id`` defaults to
        the link's own id, so pass another to test ``wrong_device``. Returns the encoded bytes.
        """
        envelope = Envelope(
            v=v,
            id=message_id if message_id is not None else str(uuid.uuid4()),
            ts=datetime.now(UTC),
            device_id=device_id if device_id is not None else self.device_id,
            encounter_id=encounter_id,
            data=data,
        )
        raw = encode(envelope)
        self.script_raw(raw, at=at)
        return raw

    def script_raw(self, payload: bytes, *, at: float | None = None) -> None:
        """Deliver arbitrary bytes as one inbound message, for example malformed JSON."""
        self._deliver(InboundRaw(payload=payload), at)

    def go_online(self, *, at: float | None = None) -> None:
        """Post ``cloud.connected``, now or at a Scheduler time."""
        self._deliver(CloudConnected(), at)

    def go_offline(self, *, at: float | None = None) -> None:
        """Post ``cloud.disconnected``, now or at a Scheduler time."""
        self._deliver(CloudDisconnected(), at)

    def _deliver(self, item: _Inbound, at: float | None) -> None:
        if at is None:
            self._post_now(item)
            return
        handle = self._scheduler.call_at(at, lambda: self._post_now(item))
        with self._lock:
            self._pending.append(handle)

    def _post_now(self, item: _Inbound) -> None:
        with self._lock:
            post = self._post
        if post is not None:
            post(item)
