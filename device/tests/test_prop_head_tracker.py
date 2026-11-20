"""Property 10: Head_Tracker (design "Correctness Properties", R29.12).

The camera sits on the tilt plate and sees exactly where the doll looks (hardware.md), so the
Head_Tracker adds a face-offset correction to the head angles recorded with the snapshot and
Clamps the sum to the Calibrated_Range (R5). This file checks, for any valid Config, any
finite face box (also outside [0, 1]) and any finite snapshot angles (also far outside the
Calibrated_Range):

- the result lies inside the Calibrated_Range;
- a face whose computed center is exactly (0.5, 0.5) gives the Clamped snapshot angles;
- pan is >= the Clamped snapshot pan when the face is right of center and <= when it is
  left of center; tilt is >= the Clamped snapshot tilt when the face is above center and
  <= when it is below;
- the result equals the R5.1 to R5.3 formula, computed by an oracle written in this file
  without calling ``glide.clamp`` or ``glide.clamp_gaze``.

Box fields and angles are finite only: the Message_Codec rejects non-finite numbers before a
``judgement.result`` reaches the State_Machine (R22.6).
"""

from __future__ import annotations

from dataclasses import dataclass

from hypothesis import given
from hypothesis import strategies as st

from tests.strategies import valid_configs
from warashi_agent.config import Config
from warashi_agent.head_tracker import head_target
from warashi_agent.model import FaceBox

TOL = 1e-9  # R29.2: tolerance for angle comparisons (degrees)

_FINITE = {"allow_nan": False, "allow_infinity": False}


# --------------------------------------------------------------------------------------------
# Oracle, written from R5 only
# --------------------------------------------------------------------------------------------


def _clamp_ref(value: float, lo: float, hi: float) -> float:
    """Reference Clamp to [lo, hi], independent of glide.clamp."""
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def _center_ref(face: FaceBox) -> tuple[float, float]:
    """R5.1: Clamp each box field to [0, 1], then cx, cy capped at 1."""
    left = _clamp_ref(face.left, 0.0, 1.0)
    top = _clamp_ref(face.top, 0.0, 1.0)
    width = _clamp_ref(face.width, 0.0, 1.0)
    height = _clamp_ref(face.height, 0.0, 1.0)
    return min(1.0, left + width / 2), min(1.0, top + height / 2)


def _expected_ref(
    face: FaceBox, snap_pan: float, snap_tilt: float, cfg: Config
) -> tuple[float, float]:
    """R5.2 and R5.3: correction from the center offset, added to the snapshot angles,
    each axis Clamped to the Calibrated_Range."""
    cx, cy = _center_ref(face)
    pan = snap_pan + (cx - 0.5) * cfg.camera.camera_hfov_deg
    tilt = snap_tilt + (0.5 - cy) * cfg.camera.camera_vfov_deg
    pan_limit, tilt_limit = cfg.servo.pan_limit, cfg.servo.tilt_limit
    return _clamp_ref(pan, -pan_limit, pan_limit), _clamp_ref(tilt, -tilt_limit, tilt_limit)


# --------------------------------------------------------------------------------------------
# Generators
# --------------------------------------------------------------------------------------------


def _box_fields() -> st.SearchStrategy[float]:
    """One box field: inside [0, 1], an edge, or a finite value outside [0, 1] (R22.11)."""
    return st.one_of(
        st.floats(min_value=0.0, max_value=1.0, **_FINITE),
        st.sampled_from([0.0, 0.5, 1.0, -0.0]),
        st.floats(min_value=-10.0, max_value=10.0, **_FINITE),
    )


# Dyadic sizes k / 1024 make 0.5 - size / 2 + size / 2 exactly 0.5 in floating point, so the
# centered clause is reached often instead of almost never.
_DYADIC_SIZES = st.integers(min_value=0, max_value=1024).map(lambda k: k / 1024)


@st.composite
def _faces(draw: st.DrawFn) -> FaceBox:
    """Free boxes (any finite fields) mixed with boxes centered exactly on each axis."""
    kind = draw(st.sampled_from(["free", "centered", "centered_x", "centered_y"]))
    if kind == "free":
        return FaceBox(
            left=draw(_box_fields()),
            top=draw(_box_fields()),
            width=draw(_box_fields()),
            height=draw(_box_fields()),
        )
    width = draw(_DYADIC_SIZES)
    height = draw(_DYADIC_SIZES)
    left = 0.5 - width / 2 if kind in ("centered", "centered_x") else draw(_box_fields())
    top = 0.5 - height / 2 if kind in ("centered", "centered_y") else draw(_box_fields())
    return FaceBox(left=left, top=top, width=width, height=height)


def _snap_angles(limit: float) -> st.SearchStrategy[float]:
    """A snapshot angle inside the Calibrated_Range, on its edges, or far beyond it."""
    return st.one_of(
        st.floats(min_value=-limit, max_value=limit, **_FINITE),
        st.sampled_from([-limit, 0.0, limit]),
        st.floats(min_value=-1e6, max_value=1e6, **_FINITE),
    )


@dataclass(frozen=True)
class Case:
    cfg: Config
    face: FaceBox
    snap_pan: float
    snap_tilt: float


@st.composite
def _cases(draw: st.DrawFn) -> Case:
    cfg = draw(valid_configs())
    return Case(
        cfg=cfg,
        face=draw(_faces()),
        snap_pan=draw(_snap_angles(cfg.servo.pan_limit)),
        snap_tilt=draw(_snap_angles(cfg.servo.tilt_limit)),
    )


# --------------------------------------------------------------------------------------------
# Property
# --------------------------------------------------------------------------------------------


# Feature: device-core-loop, Property 10: Head_Tracker
@given(case=_cases())
def test_head_tracker(case: Case) -> None:
    """**Validates: Requirements 5.1, 5.2, 5.3, 5.7, 29.12**"""
    cfg = case.cfg
    pan_limit, tilt_limit = cfg.servo.pan_limit, cfg.servo.tilt_limit
    p = _clamp_ref(case.snap_pan, -pan_limit, pan_limit)
    q = _clamp_ref(case.snap_tilt, -tilt_limit, tilt_limit)
    cx, cy = _center_ref(case.face)

    gp, gt = head_target(case.face, case.snap_pan, case.snap_tilt, cfg)

    # Inside the Calibrated_Range (R5.3, R5.7).
    assert -pan_limit - TOL <= gp <= pan_limit + TOL, (gp, pan_limit)
    assert -tilt_limit - TOL <= gt <= tilt_limit + TOL, (gt, tilt_limit)

    # A centered face gives the Clamped snapshot angles (R5.2, R5.3).
    if cx == 0.5 and cy == 0.5:
        assert abs(gp - p) <= TOL, (gp, p)
        assert abs(gt - q) <= TOL, (gt, q)

    # Face right of center turns right (positive pan); left of center turns left (R5.2).
    if cx > 0.5:
        assert gp >= p - TOL, (gp, p, cx)
    elif cx < 0.5:
        assert gp <= p + TOL, (gp, p, cx)

    # Image y grows downward: a face above center looks up (positive tilt) (R5.2).
    if cy < 0.5:
        assert gt >= q - TOL, (gt, q, cy)
    elif cy > 0.5:
        assert gt <= q + TOL, (gt, q, cy)

    # The result is exactly the R5.1 to R5.3 formula.
    ep, et = _expected_ref(case.face, case.snap_pan, case.snap_tilt, cfg)
    assert abs(gp - ep) <= TOL, (gp, ep)
    assert abs(gt - et) <= TOL, (gt, et)
