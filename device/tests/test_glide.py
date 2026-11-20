"""Example-based unit tests for the pure Glide_Planner (device-core-loop task 3.2).

Property 1 (tests/test_prop_servo_safety.py) checks the safety rules over random inputs.
These tests pin a few concrete numbers from requirements.md R14 and design.md, so a change in
the defaults or in the step arithmetic shows up as a readable failure.
"""

import math

import pytest

from warashi_agent.config import Config, ServoConfig
from warashi_agent.glide import plan_glide, to_servo_angle
from warashi_agent.model import Axis

TOL = 1e-9  # R29.2: angles and times are compared with this tolerance


def test_default_full_sweep_takes_0_9_seconds() -> None:
    """Limit to limit on both axes with defaults: 30 pan steps of 2° at 30 ms (R14.2, R14.3)."""
    cfg = Config()
    plan = plan_glide((-30.0, -20.0), (30.0, 20.0), 0.0, "m1", cfg)

    assert plan is not None
    assert len(plan.pan) == 30
    assert len(plan.tilt) == 20
    assert plan.duration_s == pytest.approx(0.9, abs=TOL)
    assert plan.duration_s == pytest.approx(cfg.sweep_time_s, abs=TOL)


def test_steps_are_scheduled_at_k_intervals_after_t0() -> None:
    """The k-th Commanded_Angle of both axes is due at t0 + k × glide_interval_ms (R14.3)."""
    plan = plan_glide((0.0, 0.0), (6.0, -4.0), 10.0, "m1", Config())

    assert plan is not None
    assert plan.steps == 3
    for k in range(1, plan.steps + 1):
        assert plan.scheduled_time(k) == pytest.approx(10.0 + k * 0.030, abs=TOL)
    assert plan.end_time == pytest.approx(10.0 + plan.duration_s, abs=TOL)


@pytest.mark.parametrize(
    ("start", "target"),
    [
        ((5.0, -3.0), (5.0, -3.0)),  # target equals the start
        ((30.0, 20.0), (45.0, 90.0)),  # target beyond the limits clamps to the start
    ],
)
def test_zero_distance_gives_an_empty_plan(
    start: tuple[float, float], target: tuple[float, float]
) -> None:
    """d = 0 on both axes: no Commanded_Angles and duration 0, ending at t0 (R14.2, R14.3)."""
    plan = plan_glide(start, target, 2.5, "m1", Config())

    assert plan is not None
    assert plan.pan == ()
    assert plan.tilt == ()
    assert plan.steps == 0
    assert plan.duration_s == 0
    assert plan.end_time == 2.5
    assert plan.entries() == ()


@pytest.mark.parametrize(
    ("target", "goal"),
    [
        ((7.3, -1.1), (7.3, -1.1)),  # inside the range, not a multiple of the step
        ((100.0, -100.0), (30.0, -20.0)),  # outside the range on both axes
        ((-1e300, 1e300), (-30.0, 20.0)),  # huge finite values
    ],
)
def test_last_step_is_exactly_the_clamped_target(
    target: tuple[float, float], goal: tuple[float, float]
) -> None:
    """The final Commanded_Angle equals the Clamped target exactly, with no float drift (R14.4)."""
    cfg = Config()
    plan = plan_glide((0.3, 0.7), target, 0.0, "m1", cfg)

    assert plan is not None
    assert plan.goal == goal
    assert plan.pan[-1] == goal[0]
    assert plan.tilt[-1] == goal[1]
    for axis_steps, start, limit in (
        (plan.pan, 0.3, cfg.servo.pan_limit),
        (plan.tilt, 0.7, cfg.servo.tilt_limit),
    ):
        previous = start
        for angle in axis_steps:
            assert abs(angle - previous) <= cfg.servo.glide_step_deg + TOL
            assert -limit - TOL <= angle <= limit + TOL
            previous = angle


def test_to_servo_angle_adds_the_center_offset() -> None:
    """Without inversion the absolute angle is offset + a (R14.7)."""
    servo = ServoConfig(pan_center_offset=10.0, tilt_center_offset=-5.0)

    assert to_servo_angle(Axis.PAN, 7.0, servo) == pytest.approx(17.0, abs=TOL)
    assert to_servo_angle(Axis.TILT, 3.0, servo) == pytest.approx(-2.0, abs=TOL)


def test_to_servo_angle_flips_only_the_inverted_axis() -> None:
    """pan_invert / tilt_invert make s = -1 for that axis only (R14.7)."""
    pan_inverted = ServoConfig(pan_center_offset=10.0, tilt_center_offset=-5.0, pan_invert=True)
    tilt_inverted = ServoConfig(pan_center_offset=10.0, tilt_center_offset=-5.0, tilt_invert=True)

    assert to_servo_angle(Axis.PAN, 7.0, pan_inverted) == pytest.approx(3.0, abs=TOL)
    assert to_servo_angle(Axis.TILT, 3.0, pan_inverted) == pytest.approx(-2.0, abs=TOL)
    assert to_servo_angle(Axis.PAN, 7.0, tilt_inverted) == pytest.approx(17.0, abs=TOL)
    assert to_servo_angle(Axis.TILT, 3.0, tilt_inverted) == pytest.approx(-8.0, abs=TOL)


@pytest.mark.parametrize(
    "target",
    [
        (math.nan, 0.0),
        (0.0, math.nan),
        (math.inf, 0.0),
        (0.0, -math.inf),
        (math.nan, math.inf),
    ],
)
def test_non_finite_target_gives_no_plan(target: tuple[float, float]) -> None:
    """A nan or inf on either axis yields None, so the running plan continues (R14.9)."""
    assert plan_glide((0.0, 0.0), target, 0.0, "m1", Config()) is None
