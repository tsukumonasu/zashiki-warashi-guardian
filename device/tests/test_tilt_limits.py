"""Per-direction tilt travel: ``tilt_up_limit`` and ``tilt_down_limit``.

The neck of the real doll allows more downward than upward travel. Positive tilt looks up
(docs/schema.md, "Angles"); ``tilt_up_limit`` bounds it, ``tilt_down_limit`` bounds the
downward side. Both default to ``tilt_limit`` and may not exceed it, so an old config.toml
behaves exactly as before and the ±30° neck rule still holds.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from warashi_agent.adapters.fakes import FakeServoDeviceFactory
from warashi_agent.adapters.servo import ServoAdapter
from warashi_agent.config import (
    Config,
    ConfigRejected,
    MotionConfig,
    ServoConfig,
    validate_mapping,
)
from warashi_agent.glide import clamp_gaze, plan_glide, to_servo_angle
from warashi_agent.head_tracker import head_target
from warashi_agent.model import Axis, Event, GazeTarget
from warashi_agent.timebase import ManualClock, ManualScheduler

# The real doll: front at servo +40, tilt inverted, 30 up (servo 10) and 20 down (servo 60).
DOLL = ServoConfig(
    tilt_center_offset=40.0,
    tilt_limit=30.0,
    tilt_up_limit=30.0,
    tilt_down_limit=20.0,
    tilt_invert=True,
)
CFG = Config(servo=DOLL)


def rejected_keys(servo: dict[str, object]) -> set[str]:
    result = validate_mapping({"servo": servo}, check_files=False)
    if not isinstance(result, ConfigRejected):
        return set()
    return {key for v in result.violations for key in v.key.split(", ")}


def test_both_default_to_tilt_limit() -> None:
    s = ServoConfig(tilt_limit=17.0)
    assert (s.tilt_up, s.tilt_down) == (17.0, 17.0)


def test_the_loader_accepts_the_doll_settings() -> None:
    result = validate_mapping(
        {
            "servo": {
                "tilt_center_offset": 40,
                "tilt_limit": 30,
                "tilt_up_limit": 30,
                "tilt_down_limit": 20,
                "tilt_invert": True,
            }
        },
        check_files=False,
    )
    assert isinstance(result, Config), result
    assert (result.servo.tilt_up, result.servo.tilt_down) == (30.0, 20.0)


@pytest.mark.parametrize("key", ["tilt_up_limit", "tilt_down_limit"])
@pytest.mark.parametrize("value", [0, -5, 31, 41])
def test_the_loader_rejects_a_value_outside_0_to_30(key: str, value: float) -> None:
    assert f"servo.{key}" in rejected_keys({"tilt_limit": 30, key: value})


@pytest.mark.parametrize("key", ["tilt_up_limit", "tilt_down_limit"])
def test_the_loader_rejects_a_value_above_tilt_limit(key: str) -> None:
    assert f"servo.{key}" in rejected_keys({"tilt_limit": 20, key: 25})


@pytest.mark.parametrize(
    ("target", "expected"),
    [
        (45.0, 30.0),  # up: clamped at tilt_up_limit
        (-45.0, -20.0),  # down: clamped at tilt_down_limit
        (25.0, 25.0),
        (-15.0, -15.0),
    ],
)
def test_clamp_gaze_uses_the_direction_limit(target: float, expected: float) -> None:
    assert clamp_gaze((0.0, target), CFG) == (0.0, expected)


def test_the_servo_angles_match_the_measured_ends() -> None:
    assert to_servo_angle(Axis.TILT, DOLL.tilt_up, DOLL) == 10.0
    assert to_servo_angle(Axis.TILT, -DOLL.tilt_down, DOLL) == 60.0


def test_a_glide_never_steps_past_either_end() -> None:
    for target in (60.0, -60.0):
        plan = plan_glide((0.0, 0.0), (0.0, target), 0.0, "m", CFG)
        assert plan is not None
        assert all(-20.0 <= a <= 30.0 for a in plan.tilt)
        assert plan.tilt[-1] == (30.0 if target > 0 else -20.0)


def test_the_head_tracker_stays_inside_the_asymmetric_range() -> None:
    from warashi_agent.model import FaceBox

    low_face = FaceBox(left=0.4, top=0.95, width=0.1, height=0.05)
    _, tilt = head_target(low_face, 0.0, -15.0, CFG)
    assert tilt == -20.0


def test_the_servo_adapter_rejects_a_saved_pose_outside_the_down_limit(tmp_path: Path) -> None:
    pose = tmp_path / "pose.json"
    pose.write_text(json.dumps({"panDeg": 0, "tiltDeg": -25}), encoding="utf-8")
    cfg = Config(
        motion=MotionConfig(motion_enabled=True),
        servo=ServoConfig(
            tilt_limit=30.0, tilt_up_limit=30.0, tilt_down_limit=20.0, pose_file=str(pose)
        ),
    )
    scheduler = ManualScheduler(ManualClock())
    factory = FakeServoDeviceFactory(scheduler)
    posted: list[Event] = []
    adapter = ServoAdapter(cfg, posted.append, scheduler, factory)
    adapter.handle(GazeTarget(pan_deg=0.0, tilt_deg=4.0, motion_id="m1"))
    scheduler.advance(1.0)
    # The invalid pose falls back to center, so the glide starts at 0: two 2-degree steps.
    assert [w.angle for w in factory.writes_for(cfg.pins.tilt_pin)] == [2.0, 4.0]
