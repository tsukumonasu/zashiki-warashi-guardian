"""Property 16: Glide arrival time equals the plan duration (design "Correctness Properties").

The State_Machine waits for ``servo.arrived`` before it takes a snapshot or speaks, and the
camera sees exactly where the head looks (hardware.md). An arrival posted before the last
angle is written would let the doll act while the head is still turning. An arrival posted
late, or a missing detach, keeps the servos powered and jittering.

The test has two clauses:

1. Pure: for any start inside the Calibrated_Range and any finite target, the last scheduled
   Commanded_Angle of ``plan_glide`` is at ``t0 + duration_s``, or the plan is empty with
   ``duration_s == 0``.
2. Adapter: the real ``ServoAdapter`` with ``motion_enabled = true``, the
   ``FakeServoDeviceFactory`` and a ``ManualScheduler`` runs one plan, optionally replaced by a
   second ``GazeTarget`` before, at or after the first plan's end. The test builds the
   expected writes, arrivals and detaches from ``plan_glide`` itself and compares them with
   what the fake recorded.

Timing at a tie follows ``ManualScheduler``: callbacks due at or before the time an Action is
handled run first. A step scheduled exactly at the second target's arrival is therefore
written, which matches the "scheduled at or before t counts as written" rule of R14.6.
"""

from __future__ import annotations

import dataclasses
import json
import math
import tempfile
from dataclasses import dataclass
from pathlib import Path

import pytest
from hypothesis import event, given, settings
from hypothesis import strategies as st

from tests.strategies import valid_configs
from warashi_agent.adapters.fakes import FakeServoDeviceFactory
from warashi_agent.adapters.servo import ServoAdapter
from warashi_agent.config import Config
from warashi_agent.glide import GlidePlan, commanded_at, plan_glide, to_servo_angle
from warashi_agent.model import Axis, Event, GazeTarget, ServoArrived
from warashi_agent.timebase import ManualClock, ManualScheduler

TOL = 1e-9  # R29.2: tolerance for time (seconds) and angle (degrees) comparisons
FINITE = {"allow_nan": False, "allow_infinity": False}
AXES = (Axis.PAN, Axis.TILT)


# --------------------------------------------------------------------------------------------
# Generators
# --------------------------------------------------------------------------------------------


def _in_range(limit: float) -> st.SearchStrategy[float]:
    """A start angle inside [-limit, limit], with the edges and center drawn often."""
    return st.one_of(
        st.floats(min_value=-limit, max_value=limit, **FINITE),
        st.sampled_from([-limit, 0.0, limit]),
    )


def _finite_targets(limit: float) -> st.SearchStrategy[float]:
    """One target axis as in Property 1, finite only: in range, edges, out of range."""
    return st.one_of(
        st.floats(min_value=-limit, max_value=limit, **FINITE),
        st.sampled_from([-limit, 0.0, limit]),
        st.floats(min_value=limit, max_value=1e6, exclude_min=True, **FINITE),
        st.floats(min_value=-1e6, max_value=-limit, exclude_max=True, **FINITE),
    )


def _starts(cfg: Config) -> st.SearchStrategy[tuple[float, float]]:
    return st.tuples(_in_range(cfg.servo.pan_limit), _in_range(cfg.servo.tilt_limit))


def _targets(cfg: Config) -> st.SearchStrategy[tuple[float, float]]:
    return st.tuples(_finite_targets(cfg.servo.pan_limit), _finite_targets(cfg.servo.tilt_limit))


def _second_gaps(plan: GlidePlan, settle_s: float) -> st.SearchStrategy[tuple[str, float]]:
    """Gap from the first plan's start to the second target, labelled for ``event()``.

    Covers: before the end (random, or exactly at a step), exactly at the end, between the
    end and the auto-detach, at the auto-detach, and after it.
    """
    d = plan.duration_s
    options: list[st.SearchStrategy[tuple[str, float]]] = [
        st.just(("at end", d)),
        st.just(("at detach", d + settle_s)),
        st.floats(min_value=d + settle_s, max_value=d + settle_s + 2.0, **FINITE).map(
            lambda g: ("after detach", g)
        ),
    ]
    if d + settle_s > d:  # a tiny servo_settle_ms can leave no float in between
        options.append(
            st.floats(min_value=d, max_value=d + settle_s, exclude_min=True, **FINITE).map(
                lambda g: ("before detach", g)
            )
        )
    if plan.steps > 0:
        options.append(
            st.floats(min_value=0.0, max_value=d, exclude_max=True, **FINITE).map(
                lambda g: ("before end", g)
            )
        )
        options.append(
            st.integers(min_value=0, max_value=plan.steps - 1).map(
                lambda k: ("before end, at a step", k * plan.interval_s)
            )
        )
    return st.one_of(options)


# --------------------------------------------------------------------------------------------
# Clause 1: the pure Glide_Planner
# --------------------------------------------------------------------------------------------


def _check_plan_end(plan: GlidePlan, t0: float) -> None:
    entries = plan.entries()
    if plan.steps == 0:
        assert plan.duration_s == 0
        assert entries == ()
        assert abs(plan.end_time - t0) <= TOL
        return
    expected_end = t0 + plan.duration_s
    last_t = max(e.t for e in entries)
    assert abs(entries[-1].t - last_t) <= TOL, "entries are not ordered by time"
    assert abs(last_t - expected_end) <= TOL, "last angle not at t0 + duration_s"
    assert abs(plan.end_time - expected_end) <= TOL, "end_time not at t0 + duration_s"


# --------------------------------------------------------------------------------------------
# Clause 2: the Servo_Adapter with fake devices
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Write:
    """One expected servo write: time, pin, absolute servo angle, and the plan it belongs to."""

    t: float
    pin: int
    angle: float
    plan: int


def _expected_writes(plan: GlidePlan, upto: float, index: int, cfg: Config) -> list[_Write]:
    """Writes of ``plan`` scheduled at or before ``upto``, as absolute servo angles (R14.7)."""
    pins = {Axis.PAN: cfg.pins.pan_pin, Axis.TILT: cfg.pins.tilt_pin}
    return [
        _Write(e.t, pins[e.axis], to_servo_angle(e.axis, e.angle, cfg.servo), index)
        for e in plan.entries()
        if e.t <= upto
    ]


def _reseat_writes(plan: GlidePlan, t: float, index: int, cfg: Config) -> list[_Write]:
    """The write of an empty plan that starts while the servos are released.
    The head may have sagged or been moved since the last write, so the goal is driven once on
    both axes even though the remembered pose says "already there".
    """
    pins = {Axis.PAN: cfg.pins.pan_pin, Axis.TILT: cfg.pins.tilt_pin}
    return [
        _Write(t, pins[axis], to_servo_angle(axis, plan.goal[n], cfg.servo), index)
        for n, axis in enumerate(AXES)
    ]


def _check_adapter(
    cfg: Config,
    data: st.DataObject,
    start: tuple[float, float],
    target: tuple[float, float],
    t0: float,
    tmp: Path,
) -> None:
    settle_s = cfg.servo.servo_settle_ms / 1000
    pose_path = tmp / "pose.json"
    if data.draw(st.booleans(), label="pose file present"):
        pose_path.write_text(json.dumps({"panDeg": start[0], "tiltDeg": start[1]}))
    else:
        start = (0.0, 0.0)  # R15.8: no pose file means the head is assumed at center
    cfg = dataclasses.replace(cfg, servo=dataclasses.replace(cfg.servo, pose_file=str(pose_path)))

    scheduler = ManualScheduler(ManualClock(start=t0))
    factory = FakeServoDeviceFactory(scheduler)
    posts: list[tuple[float, int, Event]] = []  # (scheduler time, writes so far, event)

    def post(ev: Event) -> None:
        posts.append((scheduler.now(), len(factory.writes), ev))

    adapter = ServoAdapter(cfg, post, scheduler, factory)

    plan1 = plan_glide(start, target, t0, "m1", cfg)
    assert plan1 is not None
    plans = [plan1]
    second = data.draw(st.booleans(), label="second target")

    adapter.handle(GazeTarget(pan_deg=target[0], tilt_deg=target[1], motion_id="m1"))
    if second:
        label, gap = data.draw(_second_gaps(plan1, settle_s), label="second gap")
        event(f"second target: {label}")
        scheduler.advance(gap)
        t1 = scheduler.now()
        here = commanded_at(plan1, t1)
        target2 = data.draw(
            st.one_of(_targets(cfg), st.just(target), st.just(here)), label="second target"
        )
        plan2 = plan_glide(here, target2, t1, "m2", cfg)
        assert plan2 is not None
        plans.append(plan2)
        adapter.handle(GazeTarget(pan_deg=target2[0], tilt_deg=target2[1], motion_id="m2"))
    else:
        event("single target")
        t1 = math.inf
    event(f"empty plans: {[p.steps == 0 for p in plans]}")

    final = plans[-1]
    scheduler.advance(max(0.0, final.end_time - scheduler.now()) + settle_s + 1.0)

    # ---- Oracle --------------------------------------------------------------------------
    plan1_done = plan1.end_time <= t1  # every angle scheduled at or before t1 was written
    expected = _expected_writes(plan1, t1, 0, cfg)
    if plan1.steps == 0:
        expected += _reseat_writes(plan1, t0, 0, cfg)  # the first plan starts released
    # Indices of the plans that complete; a cut first plan gets no arrival (R14.6).
    completed = ([0] if plan1_done else []) + ([1] if second else [])

    pins = (cfg.pins.pan_pin, cfg.pins.tilt_pin)
    detach_times: list[float] = []
    writes1 = [w for w in expected if w.plan == 0]
    d1 = plan1.end_time + settle_s  # the adapter's own expression: last write + settle
    plan1_detached = bool(writes1) and plan1_done and (not second or d1 <= t1)
    if plan1_detached:
        detach_times.append(d1)
    if second:
        attached_at_t1 = bool(writes1) and not plan1_detached
        if final.steps > 0:
            detach_times.append(final.end_time + settle_s)
        else:
            if not attached_at_t1:
                expected += _reseat_writes(final, t1, 1, cfg)
            detach_times.append(t1 + settle_s)  # an empty plan arms the detach when it starts
        expected += _expected_writes(final, math.inf, 1, cfg)

    # ---- Writes: every angle at its scheduled time, the last at t0 + duration_s -----------
    actual = factory.writes
    assert len(actual) == len(expected), f"writes {actual!r} != expected {expected!r}"
    for a, e in zip(actual, expected, strict=True):
        assert a.pin == e.pin and abs(a.time - e.t) <= TOL and abs(a.angle - e.angle) <= TOL, (
            f"write {a!r} != expected {e!r}"
        )

    # ---- Arrivals: at end_time, never before the plan's last write ------------------------
    arrivals = [(t, n, ev) for t, n, ev in posts if isinstance(ev, ServoArrived)]
    assert len(arrivals) == len(posts), f"unexpected posts {posts!r}"
    assert [ev.motion_id for _, _, ev in arrivals] == [f"m{i + 1}" for i in completed]
    for (t, writes_before_post, _), i in zip(arrivals, completed, strict=True):
        plan = plans[i]
        assert abs(t - plan.end_time) <= TOL, "servo.arrived not at t0 + duration_s"
        own = [k for k, w in enumerate(expected) if w.plan == i]
        if not own:
            assert plan.steps == 0
            continue
        last = own[-1]
        assert writes_before_post >= last + 1, "servo.arrived posted before the last write"
        assert t >= actual[last].time - TOL
        assert abs(actual[last].time - plan.end_time) <= TOL, "last write not at end_time"
        for n, axis in enumerate(AXES):
            pin = pins[n]
            axis_own = [expected[k] for k in own if expected[k].pin == pin]
            if axis_own:  # the axis that moved ends exactly at its Clamped goal
                goal = to_servo_angle(axis, plan.goal[n], cfg.servo)
                assert abs(axis_own[-1].angle - goal) <= TOL

    # ---- Detaches: both pins, settle time after the last write, unless a new plan came ----
    detaches = factory.detaches
    assert len(detaches) == 2 * len(detach_times), (
        f"detaches {detaches!r}, expected at {detach_times!r}"
    )
    for n, when in enumerate(detach_times):
        pair = detaches[2 * n : 2 * n + 2]
        assert sorted(p.pin for p in pair) == sorted(pins)
        for p in pair:
            assert abs(p.time - when) <= TOL, f"detach at {p.time!r}, expected {when!r}"


# --------------------------------------------------------------------------------------------
# The Property 16 test function
# --------------------------------------------------------------------------------------------


# Feature: device-core-loop, Property 16: Glide arrival time equals the plan duration
@pytest.mark.timeout(120)
@settings(deadline=None)
@given(cfg=valid_configs(motion_enabled=True), data=st.data())
def test_glide_arrival_time(cfg: Config, data: st.DataObject) -> None:
    """The last angle and ``servo.arrived`` come at ``t0 + duration_s``; detach follows.

    **Validates: Requirements 14.3, 15.3, 15.4**
    """
    start = data.draw(_starts(cfg), label="start")
    target = data.draw(_targets(cfg), label="target")
    t0 = data.draw(st.floats(min_value=0.0, max_value=1e4, **FINITE), label="t0")

    plan = plan_glide(start, target, t0, "p", cfg)
    assert plan is not None
    _check_plan_end(plan, t0)

    with tempfile.TemporaryDirectory() as tmp:
        _check_adapter(cfg, data, start, target, t0, Path(tmp))
