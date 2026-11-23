"""Property 1: Servo safety (design "Correctness Properties", R29.3).

The head servos sit in the doll's neck with the camera ribbon and the servo leads running
through it, so every Commanded_Angle must stay inside the Calibrated_Range, move at most
``glide_step_deg`` per step and wait at least ``glide_interval_ms`` between steps
(hardware.md, R14).

This file holds the single ``@given`` function of Property 1. ``_check_glide_timeline``
checks the Glide_Planner clauses 1 to 7 on the pure ``GlideTimeline``.
``_check_step_gaze_targets`` checks the ``step()`` clause: every ``GazeTarget`` in a
``run_reactive`` trace lies inside the Calibrated_Range, written here without ``clamp_gaze``.

The test does not trust the timeline's own bookkeeping. It keeps an independent oracle of
which plan is cut short by which later item, rebuilds the expected merged writes from the
plans, and compares them with what the timeline reports.
"""

from __future__ import annotations

import math
import sys
from dataclasses import dataclass

import pytest
from hypothesis import event, given, settings
from hypothesis import strategies as st

from tests.harness import (
    FAKE_JPEG,
    START_TIME,
    Record,
    Trace,
    _Driver,
    _face_boxes,
    _floats,
    run_reactive,
)
from tests.strategies import line_sets, valid_configs
from warashi_agent.config import Config
from warashi_agent.glide import (
    GlidePlan,
    GlideTimeline,
    WrittenAngle,
    plan_glide,
    to_servo_angle,
)
from warashi_agent.model import (
    Axis,
    CloudConnected,
    Gaze,
    GazeTarget,
    JudgementResult,
    PirRising,
    ReleaseServos,
    SnapshotFailed,
    SnapshotReady,
    State,
    Tick,
    Verdict,
)
from warashi_agent.state_machine import Gazing, Greeting, Seeking
from warashi_agent.voice import VoiceLine

TOL = 1e-9  # R29.2: tolerance for angle (degrees) and time (seconds) comparisons
REACTIVE_BUDGET = 30  # drawn Events per run_reactive trace (the silent tail comes on top)
WARM_DRAWS_MIN = 10  # drawn Events at least after a warm Encounter start

AXES = (Axis.PAN, Axis.TILT)


def _limits(cfg: Config) -> tuple[float, float]:
    """The widest travel per axis (used for drawing wild targets)."""
    return cfg.servo.pan_limit, cfg.servo.tilt_limit


def _ranges(cfg: Config) -> dict[Axis, tuple[float, float]]:
    """The Calibrated_Range per axis: tilt may allow less upward than downward travel."""
    s = cfg.servo
    return {Axis.PAN: (-s.pan_limit, s.pan_limit), Axis.TILT: (-s.tilt_down, s.tilt_up)}


def _clamp_between(value: float, low: float, high: float) -> float:
    """Reference Clamp to [low, high], written independently of glide.clamp."""
    return low if value < low else high if value > high else value


# --------------------------------------------------------------------------------------------
# Generators
# --------------------------------------------------------------------------------------------


def _axis_targets(limit: float) -> st.SearchStrategy[float]:
    """One target axis: in range, the limits and 0, out of range, or non-finite."""
    finite = {"allow_nan": False, "allow_infinity": False}
    return st.one_of(
        st.floats(min_value=-limit, max_value=limit, **finite),
        st.sampled_from([-limit, 0.0, limit]),
        st.floats(min_value=limit, max_value=1e6, exclude_min=True, **finite),
        st.floats(min_value=-1e6, max_value=-limit, exclude_max=True, **finite),
        st.sampled_from([math.nan, math.inf, -math.inf]),
    )


def _gaps(cfg: Config) -> st.SearchStrategy[float]:
    """Gaps in [0, 3 × Sweep_Time], including 0 and exact multiples of the interval."""
    interval_s = cfg.servo.glide_interval_ms / 1000
    span = 3 * cfg.sweep_time_s
    max_k = max(1, math.floor(span / interval_s))
    return st.one_of(
        st.just(0.0),
        st.integers(min_value=1, max_value=max_k).map(lambda k: k * interval_s),
        st.floats(min_value=0.0, max_value=span, allow_nan=False, allow_infinity=False),
    )


@st.composite
def _timeline_scenarios(draw: st.DrawFn, cfg: Config):
    """Start angles in range, a start time, and timed GazeTarget / ReleaseServos items."""
    pan_limit, tilt_limit = _limits(cfg)
    tilt_low, tilt_high = _ranges(cfg)[Axis.TILT]
    finite = {"allow_nan": False, "allow_infinity": False}
    start = (
        draw(st.floats(min_value=-pan_limit, max_value=pan_limit, **finite)),
        draw(st.floats(min_value=tilt_low, max_value=tilt_high, **finite)),
    )
    t = draw(st.floats(min_value=0.0, max_value=1e4, **finite))
    gaze = st.tuples(_axis_targets(pan_limit), _axis_targets(tilt_limit))
    kinds = draw(
        st.lists(
            st.one_of(gaze, st.just(None)),  # None stands for ReleaseServos
            min_size=1,
            max_size=12,
        )
    )
    items: list[tuple[float, GazeTarget | ReleaseServos]] = []
    for n, kind in enumerate(kinds):
        t = t + draw(_gaps(cfg)) if n else t
        if kind is None:
            items.append((t, ReleaseServos()))
        else:
            items.append((t, GazeTarget(pan_deg=kind[0], tilt_deg=kind[1], motion_id=f"m{n}")))
    return start, items


# --------------------------------------------------------------------------------------------
# Glide_Planner clauses 1 to 7
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _PlanRecord:
    """A plan the timeline started, with the test's own view of it."""

    plan: GlidePlan | None  # None: an empty plan, which completes when it starts
    arrived: float
    motion_id: str
    target: tuple[float, float]  # Clamped by the reference Clamp
    cut_at: float  # arrival of the next item that cancels it (math.inf if none)


def _is_finite_gaze(item: GazeTarget | ReleaseServos) -> bool:
    return (
        isinstance(item, GazeTarget)
        and math.isfinite(item.pan_deg)
        and math.isfinite(item.tilt_deg)
    )


def _cuts_plan(item: GazeTarget | ReleaseServos) -> bool:
    """ReleaseServos and every finite GazeTarget cancel the running plan (R14.6, R14.9)."""
    return isinstance(item, ReleaseServos) or _is_finite_gaze(item)


def _last_write_at_or_before(
    writes: tuple[WrittenAngle, ...], axis: Axis, t: float, fallback: float
) -> float:
    angle = fallback
    for w in writes:
        if w.axis is axis and w.t <= t:
            angle = w.angle
    return angle


def _check_glide_timeline(cfg: Config, data: st.DataObject) -> None:
    start, items = data.draw(_timeline_scenarios(cfg), label="start, items")
    ranges = _ranges(cfg)
    interval_s = cfg.servo.glide_interval_ms / 1000

    # Clause 7: a non-finite target gives no plan, and the timeline only advances its clock.
    tl = GlideTimeline.begin(start, cfg)
    records: list[_PlanRecord] = []
    for i, (t, item) in enumerate(items):
        before = tl
        tl = tl.apply(t, item)
        if isinstance(item, GazeTarget) and not _is_finite_gaze(item):
            assert plan_glide((0.0, 0.0), (item.pan_deg, item.tilt_deg), t, "x", cfg) is None
            assert tl == before.advance(t)
            continue
        if isinstance(item, ReleaseServos):
            assert tl.plan is None
            continue
        target = (
            _clamp_between(item.pan_deg, *ranges[Axis.PAN]),
            _clamp_between(item.tilt_deg, *ranges[Axis.TILT]),
        )
        cut_at = next((u for u, later in items[i + 1 :] if _cuts_plan(later)), math.inf)
        plan = tl.plan if tl.plan is not None and tl.plan.motion_id == item.motion_id else None
        if plan is None:
            # An empty plan completes at its arrival (R15.4).
            assert tl.completed and tl.completed[-1].motion_id == item.motion_id
            assert abs(tl.completed[-1].at - t) <= TOL
        records.append(_PlanRecord(plan, t, item.motion_id, target, cut_at))

    # Run past the end of the last plan, so every uncancelled plan completes.
    t_end = items[-1][0] + (tl.plan.duration_s if tl.plan else 0.0) + 1.0
    tl = tl.advance(t_end)
    assert tl.plan is None
    writes = tl.writes
    completed = {c.motion_id: c.at for c in tl.completed}
    cancelled = {c.motion_id: c.at for c in tl.cancelled}

    expected_writes: list[WrittenAngle] = []
    for rec in records:
        # Clause 1: a plan arriving at t starts from the last angle written at or before t.
        origin = tuple(
            _last_write_at_or_before(writes, axis, rec.arrived, start[n])
            for n, axis in enumerate(AXES)
        )
        if rec.plan is None:
            for n in range(2):
                assert abs(origin[n] - rec.target[n]) <= TOL, "empty plan away from target"
            assert rec.motion_id in completed
            continue
        plan = rec.plan
        for n in range(2):
            assert abs(plan.start[n] - origin[n]) <= TOL, "plan does not start at last angle"

        # Clause 2: the k-th angle of both axes is scheduled at t + k × interval.
        assert abs(plan.t0 - rec.arrived) <= TOL
        for k in range(1, plan.steps + 1):
            assert abs(plan.scheduled_time(k) - (rec.arrived + k * interval_s)) <= TOL
        scheduled = plan.entries()
        assert len(scheduled) == len(plan.pan) + len(plan.tilt)

        # Clause 3: angles scheduled after the cancelling item are dropped; a cut plan gets
        # no completion, an uncut one exactly one.
        expected_writes.extend(w for w in scheduled if w.t <= rec.cut_at)
        if rec.cut_at >= plan.end_time:
            assert rec.motion_id in completed and rec.motion_id not in cancelled
            assert abs(completed[rec.motion_id] - plan.end_time) <= TOL
            # Clause 5: a completed plan ends exactly at its Clamped target.
            for n, axis_angles in enumerate((plan.pan, plan.tilt)):
                last = axis_angles[-1] if axis_angles else plan.start[n]
                assert abs(last - rec.target[n]) <= TOL, "completed plan misses its target"
        else:
            assert rec.motion_id in cancelled and rec.motion_id not in completed
            assert abs(cancelled[rec.motion_id] - rec.cut_at) <= TOL

    assert list(writes) == expected_writes, "merged writes differ from the plans"

    # Clause 4: per axis, merged across plans, every written angle is inside the
    # Calibrated_Range, moves at most glide_step_deg and comes at least one interval later.
    # Clause 6: its absolute servo angle lies in [-90, 90] and follows R14.7.
    step_deg = cfg.servo.glide_step_deg
    for n, axis in enumerate(AXES):
        prev_angle, prev_t = start[n], -math.inf
        invert = cfg.servo.pan_invert if axis is Axis.PAN else cfg.servo.tilt_invert
        offset = cfg.servo.pan_center_offset if axis is Axis.PAN else cfg.servo.tilt_center_offset
        for w in (w for w in writes if w.axis is axis):
            low, high = ranges[axis]
            assert low - TOL <= w.angle <= high + TOL, "angle outside the Calibrated_Range"
            assert abs(w.angle - prev_angle) <= step_deg + TOL, "step larger than glide_step"
            assert w.t - prev_t >= interval_s - TOL, "steps closer than glide_interval"
            servo = to_servo_angle(axis, w.angle, cfg.servo)
            assert -90.0 - TOL <= servo <= 90.0 + TOL, "servo angle outside [-90, 90]"
            assert abs(servo - (offset + (-w.angle if invert else w.angle))) <= TOL
            prev_angle, prev_t = w.angle, w.t


# --------------------------------------------------------------------------------------------
# The step() clause: every emitted GazeTarget inside the Calibrated_Range
# --------------------------------------------------------------------------------------------


def _gaze_kind(rec: Record, action: GazeTarget) -> str:
    """Why `step()` emitted this GazeTarget, read from the record (for `event()` only)."""
    after, before = rec.after.phase, rec.before.phase
    mid = action.motion_id
    if isinstance(rec.event, Gaze):
        return "manual"
    if isinstance(after, Greeting):
        if mid == after.nod_motion_id:
            return "nod"
        if isinstance(before, Greeting) and not before.nod_returned and after.nod_returned:
            return "nod return"
    if isinstance(after, Seeking) and after.scan is not None and mid == after.scan.motion_id:
        return "scan"
    if isinstance(after, Gazing) and mid == after.motion_id:
        return "track"
    return "other"


def _wild_angles(limit: float) -> st.SearchStrategy[float]:
    """Finite `gaze` angles biased away from the range: ±1e300, the float extremes, just past
    the limit, and any finite float."""
    finite = {"allow_nan": False, "allow_infinity": False}
    big = sys.float_info.max
    return st.one_of(
        st.sampled_from((1e300, -1e300, big, -big)),
        st.floats(min_value=limit, max_value=limit + 10.0, exclude_min=True, **finite),
        st.floats(min_value=-limit - 10.0, max_value=-limit, exclude_max=True, **finite),
        st.floats(**finite),
    )


# Draw kinds of the biased driver during an Encounter; "harness" is one plain harness draw.
_BIASED_KINDS = ("harness", "feedback", "feedback", "gaze", "verdict", "verdict")
# family (nods) and no_face (scans) twice as often as the Verdicts that end in a line only.
_BIASED_VERDICTS = (
    Verdict.FAMILY,
    Verdict.NO_FACE,
    Verdict.FAMILY,
    Verdict.NO_FACE,
    Verdict.STRANGER,
    Verdict.UNCERTAIN,
)


class _GazeBiasedDriver(_Driver):
    """The harness driver, plus prompt `gaze` commands and Verdicts during an Encounter.

    Plain harness draws have gaps of up to an eighth of Encounter_Bound and few commands, so
    an Encounter often ends before a `gaze` or a matching Verdict arrives. While an Encounter
    is outside `cooldown`, this driver draws, besides the usual harness Event, prompt
    feedback for a pending Action, a `gaze` with mostly out-of-range angles, or a Verdict for
    the Current_Snapshot_Id, within one Tick. The Verdicts lead to scans (`no_face`), nods
    (`family`) and Head_Tracker moves (a face).
    """

    def draw_one(self) -> None:
        enc = self.ms.encounter
        active = enc is not None and self.ms.state is not State.COOLDOWN
        choice = self.data.draw(st.sampled_from(_BIASED_KINDS), label="biased kind")
        attempt = enc.attempt if enc is not None else None
        pending = self.snapshots or self.motions or self.plays
        if (
            not active
            or choice == "harness"
            or (choice == "verdict" and attempt is None)
            or (choice == "feedback" and not pending)
        ):
            super().draw_one()
            return
        at = self.now + self.data.draw(_floats(0.0, self.cfg.tick_s), label="biased gap")
        if choice == "feedback":
            self._draw_feedback(at)  # a glide arrival still waits for the glide to end
            return
        if choice == "gaze":
            self.feed(self._wild_gaze(), at)
            return
        self.feed(
            JudgementResult(
                ref_id=self.uids(),
                snapshot_id=attempt.snapshot_id,
                verdict=self.data.draw(st.sampled_from(_BIASED_VERDICTS), label="biased verdict"),
                confidence=self.data.draw(
                    st.one_of(st.just(1.0), _floats(0.0, 1.0)), label="biased confidence"
                ),
                face=self.data.draw(_face_boxes(), label="biased face"),
            ),
            at,
        )

    def _snapshot_result(self, sid: str) -> SnapshotReady | SnapshotFailed:
        """Three in four snapshots succeed, so more Encounters reach a Verdict."""
        if self.data.draw(st.booleans(), label="biased snapshot ok"):
            return SnapshotReady(snapshot_id=sid, jpeg=FAKE_JPEG, width=640, height=480)
        return super()._snapshot_result(sid)

    def _wild_gaze(self) -> Gaze:
        pan_limit, tilt_limit = _limits(self.cfg)
        return Gaze(
            ref_id=self.uids(),
            pan_deg=self.data.draw(_wild_angles(pan_limit), label="gaze pan"),
            tilt_deg=self.data.draw(_wild_angles(tilt_limit), label="gaze tilt"),
        )


def _run_warm_encounter(
    data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...], gap: float | None
) -> Trace:
    """`run_reactive` with an Encounter started right after the PIR warm-up.

    Plain `run_reactive` rarely gets past `pir_warmup_s` (up to 120 s) with its short gaps, so
    it rarely starts an Encounter, and `gaze` is accepted only inside one (R12.1, R12.3). The
    warm-up is crossed with a single Tick, as in `test_prop_offline.py`, then the usual draw
    loop and silent tail run with the gaze-biased driver.
    """
    driver = _GazeBiasedDriver(data, cfg, lines, gap)
    # Connected, so snapshots and Verdicts can happen; the harness still draws disconnects.
    driver.feed(CloudConnected(), START_TIME)
    warm = START_TIME + cfg.timing.pir_warmup_s
    driver.tick_gap_max = None
    driver.feed(Tick(), warm)
    driver.tick_gap_max = gap
    driver.feed(PirRising(), warm)
    # A few draws at least, or the silent tail times out most Encounters in `seeking`.
    count = data.draw(st.integers(WARM_DRAWS_MIN, REACTIVE_BUDGET), label="drawn events")
    for _ in range(count):
        driver.draw_one()
    driver.silent_tail()
    return tuple(driver.records)


def _check_step_gaze_targets(cfg: Config, data: st.DataObject) -> None:
    """R5.7, R6.1, R7.1, R7.2, R12.1: no GazeTarget from `step()` leaves the range.

    `gaze` commands carry any finite angles, ±1e300 often, and face boxes any finite fields,
    so manual moves, the Head_Tracker, the scan positions and the nod below the last target
    all meet out-of-range inputs. The range check is written here, not taken from
    `clamp_gaze`. `event()` reports which kinds of GazeTarget each trace contained.
    """
    lines = data.draw(line_sets(), label="lines")
    gap = data.draw(st.sampled_from((None, cfg.tick_s)), label="tick gap max")
    # Three in four traces start a warm Encounter; plain run_reactive traces stay in the mix.
    warm = data.draw(st.sampled_from((True, True, True, False)), label="warm encounter")
    if warm:
        trace = _run_warm_encounter(data, cfg, lines, gap)
    else:
        trace = run_reactive(data, cfg, lines, tick_gap_max=gap, budget=REACTIVE_BUDGET)
    event(f"trace: {'warm encounter' if warm else 'plain run_reactive'}")
    pan_limit, tilt_limit = _limits(cfg)

    kinds: set[str] = set()
    for rec in trace:
        if isinstance(rec.event, Gaze):
            cmd = rec.event
            if abs(cmd.pan_deg) >= 1e300 or abs(cmd.tilt_deg) >= 1e300:
                event("gaze command: ±1e300")
            if abs(cmd.pan_deg) > pan_limit or abs(cmd.tilt_deg) > tilt_limit:
                emitted = any(isinstance(a, GazeTarget) for a in rec.actions)
                event(f"gaze command out of range: {'moved' if emitted else 'rejected'}")
        for action in rec.actions:
            if not isinstance(action, GazeTarget):
                continue
            kinds.add(_gaze_kind(rec, action))
            pan, tilt = action.pan_deg, action.tilt_deg
            assert math.isfinite(pan) and math.isfinite(tilt), f"non-finite target {action!r}"
            assert -pan_limit - TOL <= pan <= pan_limit + TOL, f"pan outside range: {action!r}"
            low, high = _ranges(cfg)[Axis.TILT]
            assert low - TOL <= tilt <= high + TOL, f"tilt outside range: {action!r}"
    for kind in sorted(kinds):
        event(f"GazeTarget kind: {kind}")


# --------------------------------------------------------------------------------------------
# The Property 1 test function
# --------------------------------------------------------------------------------------------


# Feature: device-core-loop, Property 1: Servo safety
@pytest.mark.timeout(120)
@settings(deadline=None)  # a reactive trace takes up to ~100 ms; keep slow CI from flaking
@given(cfg=valid_configs(), data=st.data())
def test_servo_safety(cfg: Config, data: st.DataObject) -> None:
    """Every Commanded_Angle is clamped, slow and positional, across any target sequence.

    **Validates: Requirements 5.7, 6.1, 7.1, 7.2, 12.1, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6,
    14.7, 14.8, 14.9, 29.3**

    R14.8 (positional targets only) holds by construction: the timeline has no speed or
    duration input, and the checks above see only angles at scheduled times.
    """
    _check_glide_timeline(cfg, data)
    _check_step_gaze_targets(cfg, data)
