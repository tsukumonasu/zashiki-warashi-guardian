"""Example-based unit tests for the pure Head_Tracker (device-core-loop task 3.5).

Property 10 (tests/test_prop_head_tracker.py) checks the general rules over random face
boxes. These tests pin concrete numbers with the default fields of view (54° horizontal,
41.8° vertical), so a sign error or a changed default shows up as a readable failure.
"""

import pytest

from warashi_agent.config import Config, ServoConfig
from warashi_agent.head_tracker import head_target
from warashi_agent.model import FaceBox

TOL = 1e-9  # R29.2: angles are compared with this tolerance

HALF_HFOV = 54.0 / 2  # pan correction for a face at the left or right image edge
HALF_VFOV = 41.8 / 2  # tilt correction for a face at the top or bottom image edge

# Default limits are pan ±30° and tilt ±20°, so a full vertical correction (20.9°) is cut by
# the default tilt limit. A tilt limit of 30° (the largest the Config_Loader allows) lets the
# corner tests see the unclamped tilt correction.
WIDE_TILT = Config(servo=ServoConfig(tilt_limit=30.0))


def box(left: float, top: float, width: float, height: float) -> FaceBox:
    return FaceBox(left=left, top=top, width=width, height=height)


def assert_gaze(actual: tuple[float, float], pan: float, tilt: float) -> None:
    assert actual[0] == pytest.approx(pan, abs=TOL)
    assert actual[1] == pytest.approx(tilt, abs=TOL)


def test_centered_face_returns_the_snapshot_angles() -> None:
    """A face centered in the image means the doll already faces the person (R5.2, R5.3)."""
    centered = box(0.4, 0.3, 0.2, 0.4)  # cx = 0.5, cy = 0.5

    assert_gaze(head_target(centered, 5.0, 3.0, Config()), 5.0, 3.0)
    assert_gaze(head_target(centered, 0.0, 0.0, Config()), 0.0, 0.0)


def test_centered_face_with_out_of_range_snapshot_angles_is_clamped() -> None:
    """The result is Clamped to the Calibrated_Range even when no correction applies (R5.3)."""
    centered = box(0.25, 0.25, 0.5, 0.5)

    assert_gaze(head_target(centered, 40.0, -25.0, Config()), 30.0, -20.0)


@pytest.mark.parametrize(
    ("face", "pan", "tilt"),
    [
        (box(0.0, 0.0, 0.0, 0.0), -HALF_HFOV, HALF_VFOV),  # top left: look left and up
        (box(1.0, 0.0, 0.0, 0.0), HALF_HFOV, HALF_VFOV),  # top right: look right and up
        (box(0.0, 1.0, 0.0, 0.0), -HALF_HFOV, -HALF_VFOV),  # bottom left: look left and down
        (box(1.0, 1.0, 0.0, 0.0), HALF_HFOV, -HALF_VFOV),  # bottom right: look right and down
    ],
    ids=["top-left", "top-right", "bottom-left", "bottom-right"],
)
def test_corner_faces_turn_by_half_the_field_of_view(
    face: FaceBox, pan: float, tilt: float
) -> None:
    """Right of center is positive pan, above center is positive tilt (R5.2)."""
    assert_gaze(head_target(face, 0.0, 0.0, WIDE_TILT), pan, tilt)


def test_corner_faces_with_default_limits_clamp_the_tilt() -> None:
    """With the default tilt limit of 20°, the 20.9° corner correction is Clamped (R5.3)."""
    cfg = Config()

    assert_gaze(head_target(box(0.0, 0.0, 0.0, 0.0), 0.0, 0.0, cfg), -27.0, 20.0)
    assert_gaze(head_target(box(1.0, 1.0, 0.0, 0.0), 0.0, 0.0, cfg), 27.0, -20.0)


def test_correction_is_added_to_the_snapshot_angles() -> None:
    """The correction is relative to the head angles of the snapshot, not to center (R5.3)."""
    # Face at x = 0.75 (pan +13.5°) and y = 0.25 (tilt +10.45°) from snapshot (-10, 2).
    face = box(0.7, 0.2, 0.1, 0.1)

    assert_gaze(head_target(face, -10.0, 2.0, WIDE_TILT), -10.0 + 13.5, 2.0 + 10.45)


def test_correction_past_the_limit_is_clamped() -> None:
    """Snapshot pan 10° plus a right-edge correction of 27° stops at the pan limit (R5.3)."""
    assert_gaze(head_target(box(1.0, 0.5, 0.0, 0.0), 10.0, 0.0, Config()), 30.0, 0.0)


def test_center_is_capped_at_the_right_edge() -> None:
    """left = 0.9, width = 0.5 gives cx = min(1, 1.15) = 1, so pan is 27°, not 30° (R5.1)."""
    assert_gaze(head_target(box(0.9, 0.5, 0.5, 0.0), 0.0, 0.0, Config()), 27.0, 0.0)


def test_center_is_capped_at_the_bottom_edge() -> None:
    """top = 0.8, height = 0.6 gives cy = min(1, 1.1) = 1, so tilt is -20.9° (R5.1)."""
    assert_gaze(head_target(box(0.5, 0.8, 0.0, 0.6), 0.0, 0.0, WIDE_TILT), 0.0, -HALF_VFOV)


def test_box_fields_outside_0_1_are_clamped_first() -> None:
    """Finite out-of-range fields are valid on the wire and Clamped here (R5.1, R22.11)."""
    cfg = Config()

    # Negative fields clamp to 0: cx = 0 and cy = 0.
    assert_gaze(head_target(box(-0.5, -2.0, -1.0, -3.0), 0.0, 0.0, cfg), -27.0, 20.0)
    # Fields above 1 clamp to 1: cx = min(1, 1 + 0.5) = 1, same for cy.
    assert_gaze(head_target(box(2.0, 5.0, 3.0, 4.0), 0.0, 0.0, cfg), 27.0, -20.0)
    # A huge width clamps to 1 and centers a box that starts at the left edge.
    assert_gaze(head_target(box(0.0, 0.0, 1e300, 1e300), 4.0, -6.0, cfg), 4.0, -6.0)
