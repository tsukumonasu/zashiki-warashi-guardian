"""Pure Head_Tracker: turns a face box into the gaze target that faces the person (R5).

Why it works on the snapshot angles: the camera sits on the tilt plate inside the head and
looks through a hole under the bangs, so it sees exactly where the doll was looking when the
snapshot was taken (hardware.md). A face at the image center therefore means the doll already
faces that person, and a face off center needs a correction relative to the head angles
recorded with that snapshot (R3.1), not relative to wherever the head is now.

The offset-to-degrees mapping is linear, a small-angle approximation of the rectilinear lens.
Its error is a few degrees at the image edge, which is fine for a slow, character-driven turn.

The module is pure (no clock, no random source, no I/O), so the State_Machine can call it
inside ``step()`` and Property 10 can check it over any face box.
"""

from __future__ import annotations

from warashi_agent.config import Config
from warashi_agent.glide import clamp, clamp_gaze
from warashi_agent.model import FaceBox


def head_target(
    face: FaceBox, snap_pan: float, snap_tilt: float, cfg: Config
) -> tuple[float, float]:
    """Gaze target ``(pan_deg, tilt_deg)`` that turns the head toward ``face``.

    - The box fields are Clamped to [0, 1] first (R5.1). The codec accepts finite
      out-of-range values (R22.11), and clamping here keeps a bad box from pointing the
      head far outside the picture.
    - The center is capped at 1 because a clamped box can still extend past the right or
      bottom edge (for example ``left = 0.9, width = 0.5``) (R5.1).
    - Image x grows to the doll's right, which is positive pan; image y grows downward, so a
      face above center (``cy < 0.5``) gives positive tilt (R5.2, docs/schema.md "Angles").
    - The sum is Clamped to the Calibrated_Range with ``clamp_gaze``, so the result is always
      a safe ``GazeTarget`` (R5.3, R5.7).

    All inputs must be finite: the Message_Codec rejects non-finite numbers before a
    ``judgement.result`` reaches the State_Machine, and ``clamp`` raises on them as a guard.
    """
    left = clamp(face.left, 0.0, 1.0)
    top = clamp(face.top, 0.0, 1.0)
    width = clamp(face.width, 0.0, 1.0)
    height = clamp(face.height, 0.0, 1.0)
    cx = min(1.0, left + width / 2)
    cy = min(1.0, top + height / 2)
    pan_corr = (cx - 0.5) * cfg.camera.camera_hfov_deg
    tilt_corr = (0.5 - cy) * cfg.camera.camera_vfov_deg
    return clamp_gaze((snap_pan + pan_corr, snap_tilt + tilt_corr), cfg)
