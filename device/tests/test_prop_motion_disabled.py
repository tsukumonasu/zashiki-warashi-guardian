"""Property 7: `motion_enabled` false never drives a servo (design "Correctness Properties").

An uncalibrated doll runs with ``motion_enabled = false`` (hardware.md). The real
Servo_Adapter then runs the same glide schedule, but only logs each step: it creates no servo
output device, starts no PWM and leaves ``pose_file`` alone, while ``servo.arrived`` still comes
at the planned time so the rest of the loop behaves the same (R15.1, R15.2, R15.6).

The test drives the real ``ServoAdapter`` with ``FakeServoDeviceFactory`` on a
``ManualScheduler``. It keeps its own oracle of the plans: a plan starts when its GazeTarget is
handled, a later finite GazeTarget or ReleaseServos before its end cancels it, and a non-finite
target makes no plan and leaves the running plan alone (R14.6, R14.9). ``plan_glide`` is used
only to get each plan's ``duration_s`` and the angles a cancelled plan had reached, which the
next plan starts from.
"""

from __future__ import annotations

import dataclasses
import json
import math
import tempfile
from dataclasses import dataclass
from pathlib import Path

from hypothesis import event, given, settings
from hypothesis import strategies as st

from tests.strategies import valid_configs
from warashi_agent.adapters.fakes import FakeServoDeviceFactory
from warashi_agent.adapters.servo import ServoAdapter
from warashi_agent.config import Config
from warashi_agent.glide import GlidePlan, plan_glide
from warashi_agent.model import Event, GazeTarget, ReleaseServos, ServoArrived
from warashi_agent.timebase import ManualClock, ManualScheduler

TOL = 1e-9  # R29.2: tolerance for time comparisons (seconds)
POSE_NAME = "last_pose.json"

_FINITE = {"allow_nan": False, "allow_infinity": False}


# --------------------------------------------------------------------------------------------
# Generators
# --------------------------------------------------------------------------------------------


def _axis_targets(limit: float) -> st.SearchStrategy[float]:
    """One target axis: in range, the limits and 0, out of range, or non-finite."""
    return st.one_of(
        st.floats(min_value=-limit, max_value=limit, **_FINITE),
        st.sampled_from([-limit, 0.0, limit]),
        st.floats(min_value=limit, max_value=1e6, exclude_min=True, **_FINITE),
        st.floats(min_value=-1e6, max_value=-limit, exclude_max=True, **_FINITE),
        st.sampled_from([math.nan, math.inf, -math.inf]),
    )


def _gaps(cfg: Config) -> st.SearchStrategy[float]:
    """Gaps in [0, 2 × Sweep_Time]: 0, whole glide intervals, and any float in between.

    Plans last from 0 to Sweep_Time, so the gaps fall both inside and after a running plan,
    and whole intervals often land exactly on a step or on the end of a plan.
    """
    interval_s = cfg.servo.glide_interval_ms / 1000
    span = 2 * cfg.sweep_time_s
    max_k = max(1, math.floor(span / interval_s))
    return st.one_of(
        st.just(0.0),
        st.integers(min_value=1, max_value=max_k).map(lambda k: k * interval_s),
        st.floats(min_value=0.0, max_value=span, **_FINITE),
    )


@dataclass(frozen=True)
class _Pose:
    """Pose file content (None: absent) and the start angles the adapter must derive from it."""

    content: bytes | None
    start: tuple[float, float]
    kind: str


@st.composite
def _poses(draw: st.DrawFn, cfg: Config) -> _Pose:
    """An absent, valid or garbage pose file (R15.8)."""
    pan_limit, tilt_limit = cfg.servo.pan_limit, cfg.servo.tilt_limit
    kind = draw(st.sampled_from(["absent", "valid", "not_utf8", "out_of_range", "not_object"]))
    if kind == "absent":
        return _Pose(None, (0.0, 0.0), kind)
    if kind == "valid":
        pan = draw(st.floats(min_value=-pan_limit, max_value=pan_limit, **_FINITE))
        tilt = draw(st.floats(min_value=-tilt_limit, max_value=tilt_limit, **_FINITE))
        text = json.dumps({"panDeg": pan, "tiltDeg": tilt})
        return _Pose(text.encode("utf-8"), (pan, tilt), kind)
    if kind == "not_utf8":
        # 0xFF never occurs in UTF-8, so reading the file fails whatever follows.
        return _Pose(b"\xff" + draw(st.binary(max_size=32)), (0.0, 0.0), kind)
    if kind == "out_of_range":
        text = json.dumps({"panDeg": 2 * pan_limit + 1.0, "tiltDeg": 0.0})
        return _Pose(text.encode("utf-8"), (0.0, 0.0), kind)
    return _Pose(b"[1, 2]", (0.0, 0.0), kind)


@st.composite
def _items(draw: st.DrawFn, cfg: Config) -> list[tuple[float, GazeTarget | ReleaseServos]]:
    """Timed ``(gap, GazeTarget | ReleaseServos)`` items with unique motion ids."""
    gaze = st.tuples(_axis_targets(cfg.servo.pan_limit), _axis_targets(cfg.servo.tilt_limit))
    kinds = draw(st.lists(st.one_of(gaze, gaze, st.just(None)), min_size=1, max_size=10))
    items: list[tuple[float, GazeTarget | ReleaseServos]] = []
    for n, kind in enumerate(kinds):
        gap = draw(_gaps(cfg))
        if kind is None:
            items.append((gap, ReleaseServos()))
        else:
            items.append((gap, GazeTarget(pan_deg=kind[0], tilt_deg=kind[1], motion_id=f"m{n}")))
    return items


# --------------------------------------------------------------------------------------------
# Oracle
# --------------------------------------------------------------------------------------------


def _reached(plan: GlidePlan, now: float) -> tuple[float, float]:
    """Angles a plan has reached at ``now``: its last steps scheduled at or before ``now``."""
    k = sum(1 for j in range(1, plan.steps + 1) if plan.t0 + j * plan.interval_s <= now)
    pan = plan.pan[min(k, len(plan.pan)) - 1] if k and plan.pan else plan.start[0]
    tilt = plan.tilt[min(k, len(plan.tilt)) - 1] if k and plan.tilt else plan.start[1]
    return pan, tilt


@dataclass
class _Oracle:
    """Expected ``servo.arrived`` times and cancelled plans, kept apart from the adapter."""

    cfg: Config
    position: tuple[float, float]
    running: GlidePlan | None = None
    arrivals: list[tuple[str, float]] = dataclasses.field(default_factory=list)
    cancelled: list[str] = dataclasses.field(default_factory=list)

    def advance(self, now: float) -> None:
        """The running plan completes once its last step is due (step and end coincide)."""
        plan = self.running
        if plan is not None and plan.end_time <= now:
            self.arrivals.append((plan.motion_id, plan.t0 + plan.duration_s))
            self.position = plan.goal
            self.running = None

    def _cancel(self, now: float) -> None:
        if self.running is not None:
            self.position = _reached(self.running, now)
            self.cancelled.append(self.running.motion_id)
            self.running = None

    def apply(self, now: float, item: GazeTarget | ReleaseServos) -> None:
        self.advance(now)
        if isinstance(item, ReleaseServos):
            self._cancel(now)
            return
        if not (math.isfinite(item.pan_deg) and math.isfinite(item.tilt_deg)):
            return  # no plan; the running plan continues and never hears of this target
        start = _reached(self.running, now) if self.running is not None else self.position
        plan = plan_glide(start, (item.pan_deg, item.tilt_deg), now, item.motion_id, self.cfg)
        assert plan is not None
        self._cancel(now)
        if plan.steps == 0:
            self.arrivals.append((plan.motion_id, plan.t0 + plan.duration_s))
        else:
            self.running = plan


# --------------------------------------------------------------------------------------------
# The Property 7 test function
# --------------------------------------------------------------------------------------------


# Feature: device-core-loop, Property 7: motion_enabled false never drives a servo
@settings(deadline=None)
@given(cfg=valid_configs(motion_enabled=False), data=st.data())
def test_motion_disabled_never_drives_a_servo(cfg: Config, data: st.DataObject) -> None:
    """No device, no PWM, no pose write; ``servo.arrived`` exactly for uncancelled plans.

    **Validates: Requirements 14.6, 15.1, 15.2, 15.6, 29.9**
    """
    assert cfg.motion.motion_enabled is False
    pose = data.draw(_poses(cfg), label="pose")
    items = data.draw(_items(cfg), label="items")
    t_start = data.draw(st.floats(min_value=0.0, max_value=1e3, **_FINITE), label="t_start")
    event(f"pose file: {pose.kind}")

    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        pose_path = directory / POSE_NAME
        if pose.content is not None:
            pose_path.write_bytes(pose.content)
        cfg = dataclasses.replace(
            cfg, servo=dataclasses.replace(cfg.servo, pose_file=str(pose_path))
        )

        scheduler = ManualScheduler(ManualClock(start=t_start))
        factory = FakeServoDeviceFactory(scheduler)
        posted: list[tuple[Event, float]] = []
        adapter = ServoAdapter(
            cfg, lambda e: posted.append((e, scheduler.now())), scheduler, factory
        )
        oracle = _Oracle(cfg=cfg, position=pose.start)

        for gap, item in items:
            scheduler.advance(gap)
            now = scheduler.now()
            oracle.apply(now, item)
            adapter.handle(item)

        # Run past the end of the last plan, then shut down as the agent does on SIGTERM.
        tail = oracle.running.duration_s if oracle.running is not None else 0.0
        scheduler.advance(tail + 1.0)
        oracle.advance(scheduler.now())
        assert oracle.running is None
        adapter.emergency_detach()
        scheduler.advance(1.0)

        # No servo was driven in any way (R15.1, R15.6).
        assert factory.creations == []
        assert factory.pwm_starts == []
        assert factory.writes == []
        assert factory.devices == []
        assert scheduler.pending() == 0

        # pose_file unchanged: same bytes, or still absent; no temporary file left (R15.2).
        if pose.content is None:
            assert not pose_path.exists()
        else:
            assert pose_path.read_bytes() == pose.content
        assert sorted(p.name for p in directory.iterdir()) == (
            [] if pose.content is None else [POSE_NAME]
        )

    # Exactly one servo.arrived per uncancelled plan at plan start + duration_s, none for
    # cancelled plans, and nothing else posted (R14.6, R15.1).
    assert all(isinstance(e, ServoArrived) for e, _ in posted), posted
    got = [(e.motion_id, at) for e, at in posted if isinstance(e, ServoArrived)]
    expected = oracle.arrivals
    assert [m for m, _ in got] == [m for m, _ in expected], (got, expected)
    for (motion_id, at), (_, want) in zip(got, expected, strict=True):
        assert abs(at - want) <= TOL, f"{motion_id} arrived at {at}, expected {want}"
    assert not set(oracle.cancelled) & {m for m, _ in got}
    event(f"cancelled plans: {_bucket(len(oracle.cancelled))}")
    event(f"arrivals: {_bucket(len(expected))}")


def _bucket(n: int) -> str:
    """Count label for ``event()`` statistics: 0, 1, 2 or 3+."""
    return str(n) if n < 3 else "3+"
