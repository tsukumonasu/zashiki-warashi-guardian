"""Unit tests for the Servo_Adapter (device-core-loop task 21.2; R15.3 to R15.8, R15.10 to R15.12).

The real ``ServoAdapter`` runs on a ``FakeServoDeviceFactory`` and a ``ManualScheduler``, so
every creation, write, detach and PWM start is recorded against virtual time and nothing
sleeps. ``GpiozeroServoFactory`` is checked against stand-in ``gpiozero`` / ``lgpio`` modules
placed in ``sys.modules``, so the real ``AngularServo`` arguments are verified without a Pi.

Defaults used throughout: ``glide_step_deg`` 2, ``glide_interval_ms`` 30, ``servo_settle_ms``
300, pan pin 18, tilt pin 13. A glide from 0 to 4 degrees is therefore two writes, at
t0 + 0.03 and t0 + 0.06, and the auto-detach follows at t0 + 0.36.
"""

from __future__ import annotations

import json
import logging
import math
import sys
import types
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pytest

from warashi_agent.adapters.fakes import FakeServoDevice, FakeServoDeviceFactory, ServoCreation
from warashi_agent.adapters.servo import GpiozeroServoFactory, ServoAdapter
from warashi_agent.config import Config, MotionConfig, ServoConfig
from warashi_agent.glide import plan_glide, to_servo_angle
from warashi_agent.model import AdapterError, Axis, Event, GazeTarget, ReleaseServos, ServoArrived
from warashi_agent.timebase import Handle, ManualClock, ManualScheduler

PAN_PIN = 18
TILT_PIN = 13
INTERVAL_S = 0.03
SETTLE_S = 0.3
EPS = 1e-6  # advance this far past (or short of) an exact due time
SERVO_LOGGER = "warashi_agent.adapters.servo"


# --------------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------------


class SkewedScheduler:
    """Delegates to a ManualScheduler but shifts chosen ``call_at`` calls, like a busy Pi.

    ``skews`` maps the 0-based index of a ``call_at`` call to an offset in seconds, so a test
    can make one step callback run early or late.
    """

    def __init__(self, inner: ManualScheduler, skews: dict[int, float]) -> None:
        self.inner = inner
        self._skews = dict(skews)
        self._calls = 0

    def now(self) -> float:
        return self.inner.now()

    def call_later(self, delay: float, callback: Callable[[], None]) -> Handle:
        return self.call_at(self.now() + delay, callback)

    def call_at(self, when: float, callback: Callable[[], None]) -> Handle:
        index = self._calls
        self._calls += 1
        return self.inner.call_at(when + self._skews.get(index, 0.0), callback)


class FailingTiltFactory(FakeServoDeviceFactory):
    """Fake factory whose tilt servo creation raises, to drive the creation failure path."""

    def create(self, pin: int) -> FakeServoDevice:
        if pin == TILT_PIN:
            raise OSError("scripted creation failure")
        return super().create(pin)


@dataclass
class Rig:
    manual: ManualScheduler
    factory: FakeServoDeviceFactory
    adapter: ServoAdapter
    posted: list[Event]
    config: Config
    pose_path: Path

    def advance_to(self, t: float) -> None:
        self.manual.advance(max(0.0, t - self.manual.now()))

    def write_times(self, pin: int) -> list[float]:
        return [w.time for w in self.factory.writes_for(pin)]

    def write_angles(self, pin: int) -> list[float]:
        return [w.angle for w in self.factory.writes_for(pin)]

    def detached_pins_at(self) -> list[tuple[int, float]]:
        return sorted((d.pin, d.time) for d in self.factory.detaches)


def make_rig(
    pose_path: Path,
    *,
    enabled: bool = True,
    fail_at_write: int | None = None,
    skews: dict[int, float] | None = None,
    factory_class: type[FakeServoDeviceFactory] = FakeServoDeviceFactory,
    **servo: object,
) -> Rig:
    manual = ManualScheduler(ManualClock())
    scheduler = SkewedScheduler(manual, skews or {})
    config = Config(
        motion=MotionConfig(motion_enabled=enabled),
        servo=ServoConfig(pose_file=str(pose_path), **servo),  # type: ignore[arg-type]
    )
    factory = factory_class(scheduler, fail_at_write=fail_at_write)
    posted: list[Event] = []
    adapter = ServoAdapter(config, posted.append, scheduler, factory)
    return Rig(manual, factory, adapter, posted, config, pose_path)


@pytest.fixture
def pose_path(tmp_path: Path) -> Path:
    return tmp_path / "last_pose.json"


def read_pose(path: Path) -> dict[str, float]:
    return json.loads(path.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------------------------
# Lazy creation and no pulse at creation (R15.6, R15.10)
# --------------------------------------------------------------------------------------------


def test_nothing_happens_before_the_first_gaze_target(pose_path: Path) -> None:
    rig = make_rig(pose_path)
    rig.adapter.handle(ReleaseServos())
    rig.advance_to(5.0)
    assert rig.factory.creations == []
    assert rig.factory.writes == []
    assert rig.factory.detaches == []
    assert rig.posted == []
    assert rig.manual.pending() == 0
    assert not pose_path.exists()


def test_devices_are_created_once_at_the_first_gaze_target_without_a_pulse(
    pose_path: Path,
) -> None:
    rig = make_rig(pose_path)
    rig.advance_to(0.5)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m1"))
    assert rig.factory.creations == [ServoCreation(0.5, PAN_PIN), ServoCreation(0.5, TILT_PIN)]
    assert rig.factory.writes == []
    assert rig.factory.pwm_starts == []

    rig.advance_to(1.0)
    rig.adapter.handle(GazeTarget(pan_deg=0.0, tilt_deg=0.0, motion_id="m2"))
    rig.advance_to(2.0)
    assert len(rig.factory.creations) == 2


def test_a_non_finite_target_creates_no_device(pose_path: Path) -> None:
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=math.nan, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(1.0)
    assert rig.factory.creations == []
    assert rig.posted == []
    assert rig.manual.pending() == 0


def test_an_empty_first_plan_creates_the_devices_and_arrives_at_once(pose_path: Path) -> None:
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=0.0, tilt_deg=0.0, motion_id="m0"))
    assert len(rig.factory.creations) == 2
    assert rig.posted == [ServoArrived(motion_id="m0")]
    # The head may not be where the pose file says, so the goal is written once, then released.
    assert rig.write_angles(PAN_PIN) == [0.0]
    assert rig.write_angles(TILT_PIN) == [0.0]
    rig.advance_to(SETTLE_S + EPS)
    assert {d.pin for d in rig.factory.detaches} == {PAN_PIN, TILT_PIN}


def test_the_first_pulse_on_each_pin_is_the_first_commanded_angle(pose_path: Path) -> None:
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=-2.0, motion_id="m1"))
    rig.advance_to(1.0)
    starts = [(s.pin, s.time) for s in rig.factory.pwm_starts]
    assert starts == [(PAN_PIN, pytest.approx(0.03)), (TILT_PIN, pytest.approx(0.03))]
    assert rig.write_angles(PAN_PIN)[0] == 2.0
    assert rig.write_angles(TILT_PIN)[0] == -2.0

    # After the auto-detach the next plan's first write starts the pulses again.
    rig.adapter.handle(GazeTarget(pan_deg=6.0, tilt_deg=-2.0, motion_id="m2"))
    rig.advance_to(2.0)
    assert [(s.pin, s.time) for s in rig.factory.pwm_starts[2:]] == [
        (PAN_PIN, pytest.approx(1.03))
    ]


def _install_fake_gpiozero(monkeypatch: pytest.MonkeyPatch) -> types.SimpleNamespace:
    """Put minimal ``gpiozero`` and ``lgpio`` stand-ins into ``sys.modules``.

    Records every ``AngularServo`` call and every pin factory created, so the arguments of the
    real ``GpiozeroServoFactory`` can be checked on a laptop.
    """
    seen = types.SimpleNamespace(servo_calls=[], pin_factories=[])

    class AngularServo:
        def __init__(self, *args: object, **kwargs: object) -> None:
            seen.servo_calls.append((args, kwargs))

    class LGPIOFactory:
        def __init__(self) -> None:
            seen.pin_factories.append(self)

    class LGPIOPin:
        pass

    class PinInvalidState(Exception):  # noqa: N818 - gpiozero's own name
        pass

    lgpio = types.ModuleType("lgpio")
    lgpio.error = RuntimeError  # type: ignore[attr-defined]
    gpiozero = types.ModuleType("gpiozero")
    gpiozero.AngularServo = AngularServo  # type: ignore[attr-defined]
    exc = types.ModuleType("gpiozero.exc")
    exc.PinInvalidState = PinInvalidState  # type: ignore[attr-defined]
    pins = types.ModuleType("gpiozero.pins")
    pins_lgpio = types.ModuleType("gpiozero.pins.lgpio")
    pins_lgpio.LGPIOFactory = LGPIOFactory  # type: ignore[attr-defined]
    pins_lgpio.LGPIOPin = LGPIOPin  # type: ignore[attr-defined]
    for name, module in (
        ("lgpio", lgpio),
        ("gpiozero", gpiozero),
        ("gpiozero.exc", exc),
        ("gpiozero.pins", pins),
        ("gpiozero.pins.lgpio", pins_lgpio),
    ):
        monkeypatch.setitem(sys.modules, name, module)
    seen.lgpio_factory = LGPIOFactory
    seen.lgpio_pin = LGPIOPin
    return seen


def test_gpiozero_factory_creates_angular_servos_with_no_initial_pulse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = _install_fake_gpiozero(monkeypatch)
    factory = GpiozeroServoFactory()
    assert seen.servo_calls == []
    assert seen.pin_factories == []  # no GPIO line is claimed before the first create()

    factory.create(PAN_PIN)
    factory.create(TILT_PIN)

    assert [args for args, _ in seen.servo_calls] == [(PAN_PIN,), (TILT_PIN,)]
    for _, kwargs in seen.servo_calls:
        pin_factory = kwargs.pop("pin_factory")
        assert kwargs == {
            "initial_angle": None,
            "min_angle": -90,
            "max_angle": 90,
            "min_pulse_width": 0.0005,
            "max_pulse_width": 0.0024,
        }
        assert isinstance(pin_factory, seen.lgpio_factory)
        assert issubclass(pin_factory.pin_class, seen.lgpio_pin)
    assert len(seen.pin_factories) == 1  # one pin factory shared by both servos


# --------------------------------------------------------------------------------------------
# Write timing (R15.3) and arrival (R15.4)
# --------------------------------------------------------------------------------------------


def test_writes_follow_the_glide_plan_at_their_scheduled_times(pose_path: Path) -> None:
    rig = make_rig(pose_path)
    rig.advance_to(1.0)
    rig.adapter.handle(GazeTarget(pan_deg=10.0, tilt_deg=-4.0, motion_id="m1"))
    plan = plan_glide((0.0, 0.0), (10.0, -4.0), 1.0, "m1", rig.config)
    assert plan is not None
    pins = {Axis.PAN: PAN_PIN, Axis.TILT: TILT_PIN}
    expected = [
        (pins[e.axis], to_servo_angle(e.axis, e.angle, rig.config.servo)) for e in plan.entries()
    ]

    rig.advance_to(plan.scheduled_time(1) - EPS)
    assert rig.factory.writes == []  # never before the scheduled time
    rig.advance_to(plan.end_time - EPS)
    assert rig.posted == []
    rig.advance_to(plan.end_time + EPS)

    assert [(w.pin, w.angle) for w in rig.factory.writes] == expected
    assert [w.time for w in rig.factory.writes] == pytest.approx([e.t for e in plan.entries()])
    assert rig.posted == [ServoArrived(motion_id="m1")]


def test_a_late_step_pushes_the_next_write_a_full_interval_later(pose_path: Path) -> None:
    # call_at index 1 is step 2: it runs 50 ms late, so step 3 may not follow 10 ms after it.
    rig = make_rig(pose_path, skews={1: 0.05})
    rig.adapter.handle(GazeTarget(pan_deg=8.0, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(1.0)
    times = rig.write_times(PAN_PIN)
    assert times == pytest.approx([0.03, 0.11, 0.14, 0.17])
    assert all(b - a >= INTERVAL_S - 1e-9 for a, b in zip(times, times[1:], strict=False))
    assert rig.write_angles(PAN_PIN) == [2.0, 4.0, 6.0, 8.0]
    assert rig.posted == [ServoArrived(motion_id="m1")]


def test_an_early_callback_does_not_write_before_its_scheduled_time(pose_path: Path) -> None:
    rig = make_rig(pose_path, skews={0: -0.01})  # step 1 is called at 0.02 instead of 0.03
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(1.0)
    assert rig.write_times(PAN_PIN) == pytest.approx([0.03, 0.06])


# --------------------------------------------------------------------------------------------
# Auto-detach (R15.4) and ReleaseServos (R15.5)
# --------------------------------------------------------------------------------------------


def test_both_servos_detach_servo_settle_ms_after_the_last_write(pose_path: Path) -> None:
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m1"))
    last_write = 0.06
    rig.advance_to(last_write + SETTLE_S - EPS)
    assert rig.factory.detaches == []
    rig.advance_to(last_write + SETTLE_S + EPS)
    assert rig.detached_pins_at() == [
        (TILT_PIN, pytest.approx(last_write + SETTLE_S)),
        (PAN_PIN, pytest.approx(last_write + SETTLE_S)),
    ]
    assert rig.manual.pending() == 0


def test_a_new_plan_before_the_settle_time_postpones_the_detach(pose_path: Path) -> None:
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(0.2)
    rig.adapter.handle(GazeTarget(pan_deg=6.0, tilt_deg=0.0, motion_id="m2"))
    rig.advance_to(0.06 + SETTLE_S + 0.05)
    assert rig.factory.detaches == []  # the first plan's detach was cancelled

    rig.advance_to(1.0)
    assert rig.write_angles(PAN_PIN) == [2.0, 4.0, 6.0]  # the second plan starts at 4
    assert [d.time for d in rig.factory.detaches] == pytest.approx([0.23 + SETTLE_S] * 2)
    assert rig.posted == [ServoArrived(motion_id="m1"), ServoArrived(motion_id="m2")]


def test_release_servos_cancels_the_plan_and_detaches_after_the_settle_time(
    pose_path: Path,
) -> None:
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=10.0, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(0.07)  # two of five writes done, the last at 0.06
    rig.adapter.handle(ReleaseServos())
    assert rig.factory.detaches == []  # the servo gets time to reach the last angle
    rig.advance_to(0.06 + SETTLE_S - EPS)
    assert rig.factory.detaches == []
    rig.advance_to(0.06 + SETTLE_S + EPS)
    assert {d.pin for d in rig.factory.detaches} == {PAN_PIN, TILT_PIN}
    assert all(d.time == pytest.approx(0.06 + SETTLE_S) for d in rig.factory.detaches)
    rig.advance_to(2.0)
    assert rig.write_angles(PAN_PIN) == [2.0, 4.0]
    assert rig.posted == []  # a cancelled plan never arrives
    assert rig.manual.pending() == 0
    assert read_pose(pose_path) == {"panDeg": 4.0, "tiltDeg": 0.0}


# --------------------------------------------------------------------------------------------
# Returning to center always moves the head (head drift after a release)
# --------------------------------------------------------------------------------------------
def test_a_release_right_after_arrival_keeps_the_last_pulse_for_the_settle_time(
    pose_path: Path,
) -> None:
    """The State_Machine releases the moment ``servo.arrived`` comes (end of the cooldown)."""
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(0.06 + EPS)
    assert rig.posted == [ServoArrived(motion_id="m1")]
    rig.adapter.handle(ReleaseServos())  # as the State_Machine does on the arrival
    rig.advance_to(0.06 + SETTLE_S / 2)
    assert rig.factory.detaches == []
    rig.advance_to(0.06 + SETTLE_S + EPS)
    assert len(rig.factory.detaches) == 2
    assert rig.write_angles(PAN_PIN)[-1] == 4.0  # the last pulse stayed on the last angle


def test_a_release_after_the_settle_time_detaches_at_once(pose_path: Path) -> None:
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(0.06 + SETTLE_S + EPS)  # already auto-detached
    detached = len(rig.factory.detaches)
    rig.adapter.handle(ReleaseServos())
    assert len(rig.factory.detaches) >= detached  # harmless, no new write
    assert len(rig.write_angles(PAN_PIN)) == 2


def test_a_return_to_the_remembered_pose_still_writes_it_after_a_release(pose_path: Path) -> None:
    """The head may sag while released, so "already there" must not mean "write nothing"."""
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(1.0)  # arrived and auto-detached; the remembered pose is (4, 0)
    assert len(rig.factory.detaches) == 2
    writes_before = len(rig.write_angles(PAN_PIN))
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m2"))
    assert rig.posted[-1] == ServoArrived(motion_id="m2")
    assert rig.write_angles(PAN_PIN)[writes_before:] == [4.0]
    assert rig.write_angles(TILT_PIN)[-1] == 0.0
    rig.advance_to(2.0)
    assert len(rig.factory.detaches) == 4  # released again after the settle time


def test_a_return_to_the_remembered_pose_writes_nothing_while_the_servos_hold(
    pose_path: Path,
) -> None:
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(0.1)  # attached, not yet detached
    writes_before = len(rig.write_angles(PAN_PIN))
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m2"))
    assert len(rig.write_angles(PAN_PIN)) == writes_before
    assert rig.posted[-1] == ServoArrived(motion_id="m2")


def test_the_reseat_uses_the_calibrated_center_and_inversion(pose_path: Path) -> None:
    rig = make_rig(pose_path, pan_center_offset=5.0, pan_invert=True, tilt_center_offset=40.0)
    rig.adapter.handle(GazeTarget(pan_deg=0.0, tilt_deg=0.0, motion_id="m0"))
    assert rig.write_angles(PAN_PIN) == [5.0]
    assert rig.write_angles(TILT_PIN) == [40.0]


def test_motion_disabled_still_writes_nothing_for_an_empty_plan(pose_path: Path) -> None:
    rig = make_rig(pose_path, enabled=False)
    rig.adapter.handle(GazeTarget(pan_deg=0.0, tilt_deg=0.0, motion_id="m0"))
    rig.advance_to(1.0)
    assert rig.factory.creations == []
    assert rig.factory.writes == []
    assert rig.posted == [ServoArrived(motion_id="m0")]


def test_emergency_detach_does_not_wait_for_the_settle_time(pose_path: Path) -> None:
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(0.07)
    rig.adapter.emergency_detach()
    assert len(rig.factory.detaches) == 2
    assert all(d.time == pytest.approx(0.07) for d in rig.factory.detaches)


# --------------------------------------------------------------------------------------------
# Pose file (R15.7, R15.8, R15.12)
# --------------------------------------------------------------------------------------------


def test_pose_file_holds_the_last_commanded_angles_after_detach(pose_path: Path) -> None:
    rig = make_rig(pose_path, pan_center_offset=5.0, pan_invert=True, tilt_center_offset=-3.0)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=2.0, motion_id="m1"))
    rig.advance_to(0.06 + SETTLE_S - EPS)
    assert not pose_path.exists()  # written on detach, not on each write
    rig.advance_to(1.0)

    assert rig.write_angles(PAN_PIN) == [3.0, 1.0]  # 5 - 2, 5 - 4
    assert rig.write_angles(TILT_PIN) == [-1.0]  # -3 + 2
    assert read_pose(pose_path) == {"panDeg": 4.0, "tiltDeg": 2.0}
    assert not pose_path.with_name(pose_path.name + ".tmp").exists()


@pytest.mark.parametrize(
    ("saved", "target", "pan_writes", "tilt_writes"),
    [
        ((10.0, -4.0), (14.0, -4.0), [12.0, 14.0], []),
        ((30.0, -20.0), (26.0, -20.0), [28.0, 26.0], []),  # the limits themselves are valid
        # Already there: an empty plan. The servos are released, so it still drives the goal once.
        ((10.0, -4.0), (10.0, -4.0), [10.0], [-4.0]),
    ],
)
def test_the_first_plan_starts_from_the_saved_pose(
    pose_path: Path,
    saved: tuple[float, float],
    target: tuple[float, float],
    pan_writes: list[float],
    tilt_writes: list[float],
) -> None:
    pose_path.write_text(json.dumps({"panDeg": saved[0], "tiltDeg": saved[1]}), encoding="utf-8")
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=target[0], tilt_deg=target[1], motion_id="m1"))
    rig.advance_to(1.0)
    assert rig.write_angles(PAN_PIN) == pan_writes
    assert rig.write_angles(TILT_PIN) == tilt_writes
    assert rig.posted == [ServoArrived(motion_id="m1")]


@pytest.mark.parametrize(
    "content",
    [
        pytest.param(None, id="missing"),
        pytest.param("directory", id="unreadable-directory"),
        pytest.param(b"\xff\xfe\x00", id="invalid-utf8"),
        pytest.param("", id="empty"),
        pytest.param("not json", id="garbage"),
        pytest.param("[10, -4]", id="not-an-object"),
        pytest.param('{"panDeg": 10}', id="missing-key"),
        pytest.param('{"panDeg": "10", "tiltDeg": 0}', id="string"),
        pytest.param('{"panDeg": true, "tiltDeg": 0}', id="bool"),
        pytest.param('{"panDeg": NaN, "tiltDeg": 0}', id="nan"),
        pytest.param('{"panDeg": 10, "tiltDeg": -Infinity}', id="infinity"),
        pytest.param('{"panDeg": 1e400, "tiltDeg": 0}', id="float-overflow"),
        pytest.param('{"panDeg": 1' + "0" * 400 + ', "tiltDeg": 0}', id="huge-int"),
        pytest.param('{"panDeg": 30.5, "tiltDeg": 0}', id="pan-out-of-range"),
        pytest.param('{"panDeg": 0, "tiltDeg": -21}', id="tilt-out-of-range"),
    ],
)
def test_an_unusable_pose_file_falls_back_to_center(
    pose_path: Path, content: str | bytes | None
) -> None:
    if content == "directory":
        pose_path.mkdir()
    elif isinstance(content, bytes):
        pose_path.write_bytes(content)
    elif content is not None:
        pose_path.write_text(content, encoding="utf-8")
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(0.1)
    assert rig.write_angles(PAN_PIN) == [2.0, 4.0]  # planned from (0, 0)
    assert rig.write_angles(TILT_PIN) == []
    assert rig.posted == [ServoArrived(motion_id="m1")]


def test_a_failed_pose_write_is_logged_and_actions_continue(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger=SERVO_LOGGER)
    pose_path = tmp_path / "no_such_dir" / "last_pose.json"
    rig = make_rig(pose_path)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(1.0)
    assert len(rig.factory.detaches) == 2
    assert any(
        r.levelno == logging.WARNING and "could not write pose file" in r.getMessage()
        for r in caplog.records
    )

    rig.adapter.handle(GazeTarget(pan_deg=0.0, tilt_deg=0.0, motion_id="m2"))
    rig.advance_to(2.0)
    assert rig.write_angles(PAN_PIN) == [2.0, 4.0, 2.0, 0.0]
    assert rig.posted == [ServoArrived(motion_id="m1"), ServoArrived(motion_id="m2")]
    assert len(rig.factory.detaches) == 4
    assert not pose_path.parent.exists()


# --------------------------------------------------------------------------------------------
# Worker exceptions (R15.11)
# --------------------------------------------------------------------------------------------


def test_a_write_exception_cancels_detaches_and_reports_adapter_failed(
    pose_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger=SERVO_LOGGER)
    rig = make_rig(pose_path, fail_at_write=2)  # the third write raises, at t = 0.09
    rig.adapter.handle(GazeTarget(pan_deg=8.0, tilt_deg=0.0, motion_id="m1"))
    rig.advance_to(0.09 + EPS)

    assert rig.detached_pins_at() == [
        (TILT_PIN, pytest.approx(0.09)),
        (PAN_PIN, pytest.approx(0.09)),
    ]
    assert rig.posted == [AdapterError(code="adapter_failed")]
    assert rig.manual.pending() == 0
    rig.advance_to(2.0)
    assert rig.write_angles(PAN_PIN) == [2.0, 4.0]
    assert rig.posted == [AdapterError(code="adapter_failed")]  # no servo.arrived for m1
    assert read_pose(pose_path) == {"panDeg": 4.0, "tiltDeg": 0.0}
    log = caplog.text
    assert "RuntimeError" in log
    assert "scripted servo write failure" not in log  # only the exception type is logged

    # The adapter keeps accepting Actions and continues from the last written angle.
    rig.adapter.handle(GazeTarget(pan_deg=0.0, tilt_deg=0.0, motion_id="m2"))
    rig.advance_to(3.0)
    assert rig.write_angles(PAN_PIN) == [2.0, 4.0, 2.0, 0.0]
    assert rig.posted[-1] == ServoArrived(motion_id="m2")


def test_a_device_creation_failure_reports_and_closes_the_first_device(
    pose_path: Path,
) -> None:
    rig = make_rig(pose_path, factory_class=FailingTiltFactory)
    rig.adapter.handle(GazeTarget(pan_deg=4.0, tilt_deg=0.0, motion_id="m1"))  # must not raise
    assert rig.posted == [AdapterError(code="adapter_failed")]
    assert [d.closed for d in rig.factory.devices] == [True]
    rig.advance_to(1.0)
    assert rig.factory.writes == []
    assert rig.manual.pending() == 0
