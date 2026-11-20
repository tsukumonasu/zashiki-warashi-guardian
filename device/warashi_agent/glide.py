"""Pure Glide_Planner: turns a gaze target into slow, clamped servo steps (R14).

Why this module exists and why it is pure:

- The servos sit in the doll's neck, with the camera ribbon and the servo leads running
  through it. Every angle must stay inside the Calibrated_Range, move at most
  ``glide_step_deg`` per step and wait at least ``glide_interval_ms`` between steps
  (hardware.md). Those rules are decided here, in one place, and nowhere else.
- The module reads no clock, touches no pin and holds no mutable state. Times are passed in.
  The Servo_Adapter, its fake and the property tests therefore run exactly the same plans,
  and Hypothesis can check the safety rules over random target sequences (Property 1).
- A plan holds only positional angle targets. There is deliberately no speed, duration or
  "rotate for N ms" API, so time-based spinning of a continuous-rotation servo cannot be
  expressed (R14.8).

Angles here are Commanded_Angles: degrees relative to the calibrated center, the same frame as
``GazeTarget``. ``to_servo_angle`` converts them to the absolute angle of ``AngularServo`` only
at the very end (R14.7).
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass, replace

from warashi_agent.config import Config, ServoConfig
from warashi_agent.model import Axis, GazeTarget, ReleaseServos

# --------------------------------------------------------------------------------------------
# Clamping (shared with head_tracker.py and state_machine.py)
# --------------------------------------------------------------------------------------------


def clamp(value: float, lo: float, hi: float) -> float:
    """Limit ``value`` to the closed range [lo, hi].

    Non-finite input raises instead of clamping: ``min``/``max`` would pass ``nan`` through
    unchanged, and a ``nan`` angle reaching a servo is undefined behaviour. Callers reject
    non-finite numbers before clamping (Glossary "Clamp"), so a raise here marks a bug.
    """
    if not (math.isfinite(value) and math.isfinite(lo) and math.isfinite(hi)):
        raise ValueError("clamp() needs finite numbers")
    if lo > hi:
        raise ValueError("clamp() needs lo <= hi")
    return min(max(value, lo), hi)


def clamp_gaze(target: tuple[float, float], cfg: Config) -> tuple[float, float]:
    """Clamp a (pan, tilt) pair to the Calibrated_Range ``±pan_limit`` / ``±tilt_limit``.

    Every ``GazeTarget`` the State_Machine emits goes through this function (R5.7), and the
    Glide_Planner applies it again before planning (R14.1), so a bug in one layer cannot
    drive the head past the neck limits.
    """
    s = cfg.servo
    return (
        clamp(target[0], -s.pan_limit, s.pan_limit),
        clamp(target[1], -s.tilt_limit, s.tilt_limit),
    )


# --------------------------------------------------------------------------------------------
# Plans
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class GlidePlan:
    """One glide from ``start`` to the Clamped ``goal``, as scheduled Commanded_Angles.

    The k-th entry of ``pan`` and of ``tilt`` (k = 1 … n) is scheduled at
    ``t0 + k × interval_s``. Pan and tilt share ``t0``, so the plan lasts
    ``max(n_pan, n_tilt) × interval_s`` (R14.3). An axis with no entries stays where it is.
    """

    motion_id: str
    t0: float
    start: tuple[float, float]
    goal: tuple[float, float]
    pan: tuple[float, ...]
    tilt: tuple[float, ...]
    interval_s: float

    @property
    def steps(self) -> int:
        """Number of scheduled times: the longer axis decides."""
        return max(len(self.pan), len(self.tilt))

    @property
    def duration_s(self) -> float:
        """Time from ``t0`` to the last Commanded_Angle; 0 for an empty plan (R14.3)."""
        return self.steps * self.interval_s

    def scheduled_time(self, k: int) -> float:
        """Time of the k-th Commanded_Angle.

        Computed as ``t0 + k × interval_s`` instead of by repeated addition, so the times do
        not drift and every caller gets the same float for the same k.
        """
        return self.t0 + k * self.interval_s

    @property
    def end_time(self) -> float:
        """Time at which the plan completes (``t0`` for an empty plan, R15.4)."""
        return self.scheduled_time(self.steps)

    def entries(self, upto_k: int | None = None) -> tuple[WrittenAngle, ...]:
        """Scheduled ``(time, axis, angle)`` entries for k = 1 … ``upto_k`` (all by default).

        Ordered by time, pan before tilt at the same time.
        """
        last = self.steps if upto_k is None else min(upto_k, self.steps)
        out: list[WrittenAngle] = []
        for k in range(1, last + 1):
            t = self.scheduled_time(k)
            if k <= len(self.pan):
                out.append(WrittenAngle(t=t, axis=Axis.PAN, angle=self.pan[k - 1]))
            if k <= len(self.tilt):
                out.append(WrittenAngle(t=t, axis=Axis.TILT, angle=self.tilt[k - 1]))
        return tuple(out)


def _axis_steps(
    a0: float, goal: float, step_deg: float, lo: float, hi: float
) -> tuple[float, ...]:
    """Commanded_Angles of one axis from ``a0`` to ``goal`` in equal steps (R14.2, R14.4).

    ``n = ceil(|d| / step_deg)`` gives steps of ``|d| / n ≤ step_deg``. The loop that raises
    ``n`` only guards against the float quotient rounding below the true one. Every
    intermediate angle is clamped as a last guard (clamping never makes a step larger), and
    the final entry is the goal itself, so a completed plan ends exactly at the target.
    """
    d = goal - a0
    if d == 0:
        return ()
    n = max(1, math.ceil(abs(d) / step_deg))
    while abs(d) / n > step_deg:
        n += 1
    inner = tuple(clamp(a0 + d * k / n, lo, hi) for k in range(1, n))
    return (*inner, goal)


def plan_glide(
    start: tuple[float, float],
    target: tuple[float, float],
    t0: float,
    motion_id: str,
    cfg: Config,
) -> GlidePlan | None:
    """Plan a glide from the last Commanded_Angles ``start`` to ``target``, starting at ``t0``.

    Returns ``None`` for a non-finite target: no plan is made, so the running plan continues
    and no ``servo.arrived`` is posted for ``motion_id`` (R14.9).

    ``start`` must be the last angles actually written (R14.5); the Servo_Adapter guarantees
    they lie inside the Calibrated_Range (R15.8). They are clamped here anyway, which bounds
    the plan length if a caller ever passes a stale out-of-range pose. A non-finite ``start``
    or ``t0`` is a programming error and raises.
    """
    if not (math.isfinite(target[0]) and math.isfinite(target[1])):
        return None
    if not (math.isfinite(start[0]) and math.isfinite(start[1]) and math.isfinite(t0)):
        raise ValueError("plan_glide() needs a finite start and t0")
    s = cfg.servo
    goal = clamp_gaze(target, cfg)
    origin = clamp_gaze(start, cfg)
    return GlidePlan(
        motion_id=motion_id,
        t0=t0,
        start=origin,
        goal=goal,
        pan=_axis_steps(origin[0], goal[0], s.glide_step_deg, -s.pan_limit, s.pan_limit),
        tilt=_axis_steps(origin[1], goal[1], s.glide_step_deg, -s.tilt_limit, s.tilt_limit),
        interval_s=s.glide_interval_ms / 1000,
    )


def _steps_due(plan: GlidePlan, t: float) -> int:
    """Number of scheduled times of ``plan`` at or before ``t``.

    Compares against ``scheduled_time(k)`` exactly, so "scheduled at or before t" means the
    same thing here, in ``commanded_at`` and in the timeline, with no tolerance to tune.
    """
    n = plan.steps
    if n == 0 or t < plan.scheduled_time(1):
        return 0
    if t >= plan.scheduled_time(n):
        return n
    k = min(n, max(0, math.floor((t - plan.t0) / plan.interval_s)))
    while k < n and plan.scheduled_time(k + 1) <= t:
        k += 1
    while k > 0 and plan.scheduled_time(k) > t:
        k -= 1
    return k


def commanded_at(plan: GlidePlan, t: float) -> tuple[float, float]:
    """Last Commanded_Angle per axis scheduled at or before ``t`` (R14.5).

    A new plan that arrives at ``t`` starts from these angles, so the step and interval limits
    also hold across plans.
    """
    k = _steps_due(plan, t)
    pan = plan.pan[min(k, len(plan.pan)) - 1] if k and plan.pan else plan.start[0]
    tilt = plan.tilt[min(k, len(plan.tilt)) - 1] if k and plan.tilt else plan.start[1]
    return pan, tilt


def to_servo_angle(axis: Axis, a: float, s: ServoConfig) -> float:
    """Absolute ``AngularServo`` angle for Commanded_Angle ``a`` (R14.7).

    ``pan_invert`` / ``tilt_invert`` flip the sign for builds where the servo is mounted the
    other way round. The Config_Loader enforces ``|offset| + limit ≤ 90`` (R25.3), so the
    result stays inside the servo's [-90, 90].
    """
    if axis is Axis.PAN:
        return s.pan_center_offset + (-a if s.pan_invert else a)
    return s.tilt_center_offset + (-a if s.tilt_invert else a)


# --------------------------------------------------------------------------------------------
# Timeline: the pure model of what the Servo_Adapter writes over time
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class WrittenAngle:
    """One Commanded_Angle written to one axis at time ``t``."""

    t: float
    axis: Axis
    angle: float


@dataclass(frozen=True, kw_only=True)
class Completion:
    """A plan that ran to its end at ``at``; the adapter posts ``servo.arrived`` (R15.4)."""

    motion_id: str
    at: float


@dataclass(frozen=True, kw_only=True)
class Cancellation:
    """A plan cut short at ``at``; it gets no ``servo.arrived`` (R14.6)."""

    motion_id: str
    at: float


@dataclass(frozen=True, kw_only=True)
class GlideTimeline:
    """Pure reducer over ``(t, GazeTarget | ReleaseServos)`` items (R14.5, R14.6).

    It records the Commanded_Angles that a servo would receive and which plans complete or are
    cancelled. The Servo_Adapter's fake uses it for arrival times, and Property 1 checks the
    merged angles against the safety rules. Rules:

    - Items arrive at non-decreasing times.
    - Before an item at ``t`` is applied, every angle of the running plan scheduled at or
      before ``t`` counts as written, and a plan whose last angle is due completes.
    - ``ReleaseServos``, or a ``GazeTarget`` that yields a plan, cancels the running plan: its
      angles scheduled after ``t`` are dropped and it gets no completion.
    - A non-finite ``GazeTarget`` yields no plan and changes nothing (R14.9).
    - A new plan starts from the last angle written per axis at or before ``t``.
    """

    cfg: Config
    position: tuple[float, float]
    written: tuple[WrittenAngle, ...] = ()
    plan: GlidePlan | None = None
    completed: tuple[Completion, ...] = ()
    cancelled: tuple[Cancellation, ...] = ()
    now: float = -math.inf

    @classmethod
    def begin(cls, start: tuple[float, float], cfg: Config) -> GlideTimeline:
        """An idle timeline whose servos rest at ``start`` (the pose of R15.8)."""
        return cls(cfg=cfg, position=start)

    @property
    def writes(self) -> tuple[WrittenAngle, ...]:
        """Every angle written up to ``now``, including the running plan's due angles."""
        if self.plan is None:
            return self.written
        return self.written + self.plan.entries(_steps_due(self.plan, self.now))

    def angles_at_now(self) -> tuple[float, float]:
        """Last written angle per axis at ``now``: where a new plan would start."""
        if self.plan is None:
            return self.position
        return commanded_at(self.plan, self.now)

    def advance(self, t: float) -> GlideTimeline:
        """Move time to ``t`` and complete the running plan if its last angle is due."""
        if t < self.now:
            raise ValueError("timeline items must arrive at non-decreasing times")
        tl = replace(self, now=t)
        plan = tl.plan
        if plan is None or _steps_due(plan, t) < plan.steps:
            return tl
        return replace(
            tl,
            written=tl.written + plan.entries(),
            position=plan.goal if plan.steps else tl.position,
            plan=None,
            completed=(*tl.completed, Completion(motion_id=plan.motion_id, at=plan.end_time)),
        )

    def _cancel_running(self) -> GlideTimeline:
        """Keep the running plan's angles due by ``now`` and drop the rest (R14.6)."""
        plan = self.plan
        if plan is None:
            return self
        return replace(
            self,
            written=self.written + plan.entries(_steps_due(plan, self.now)),
            position=commanded_at(plan, self.now),
            plan=None,
            cancelled=(*self.cancelled, Cancellation(motion_id=plan.motion_id, at=self.now)),
        )

    def apply(self, t: float, item: GazeTarget | ReleaseServos) -> GlideTimeline:
        """Apply one Action that reaches the Servo_Adapter at time ``t``."""
        tl = self.advance(t)
        if isinstance(item, ReleaseServos):
            return tl._cancel_running()
        if isinstance(item, GazeTarget):
            new = plan_glide(
                tl.angles_at_now(), (item.pan_deg, item.tilt_deg), t, item.motion_id, tl.cfg
            )
            if new is None:
                return tl
            # An empty plan completes when it starts (R15.4), hence the advance.
            return replace(tl._cancel_running(), plan=new).advance(t)
        raise TypeError(f"GlideTimeline cannot apply {type(item).__name__}")


def run_timeline(
    start: tuple[float, float],
    items: Iterable[tuple[float, GazeTarget | ReleaseServos]],
    cfg: Config,
) -> GlideTimeline:
    """Apply ``items`` in order to an idle timeline; a convenience for tests and the fake."""
    tl = GlideTimeline.begin(start, cfg)
    for t, item in items:
        tl = tl.apply(t, item)
    return tl
