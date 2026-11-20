"""Property 2: Liveness (design "Correctness Properties", R10.1, R10.2, R29.4).

With no interval longer than `T` after the starting `pir.rising` without a Tick, every
Encounter

- stays in each State no longer than the R10.1 bound of that State,
- enters `sleeping` within Encounter_Bound of its starting `pir.rising` (R10.2),
- has, at its entry into `sleeping`, at least one `ReleaseServos`, no `GazeTarget` after the
  last one, and a last `LanternFade` of level 0 (R8.4),
- emits at most `scan_attempts_max` scan `GazeTarget`s, at the positions of
  `scan_pan_positions_deg` in order and Clamped to the Calibrated_Range (R6.1, R6.5).

The bounds are computed here from the requirement formulas (R10.1 table, Glossary
Encounter_Bound), not taken from the State_Machine.

Two drivers feed the same oracle:

- `run_reactive` (tests/harness.py) with `tick_gap_max = T`: random Events of every kind,
  including stale feedback, connectivity changes and commands.
- `_LateWorld` below: a connected cloud that answers each snapshot as late as it may. The
  Verdict arrives at the first Tick at or after the attempt deadline and is processed before
  that Tick (R3.3, R10.3); servos and audio tend never to report back, so every wait runs to
  its deadline. This reaches the worst-case `seeking` route of the design's "Path to
  sleeping" table, which random draws almost never hit.
"""

from __future__ import annotations

import dataclasses
import heapq
from collections.abc import Sequence

import pytest
from hypothesis import event, given, note, settings, target
from hypothesis import strategies as st

from tests.harness import (
    AGENT_VERSION,
    FAKE_JPEG,
    START_TIME,
    EncounterSlice,
    Record,
    Trace,
    run_reactive,
    split_by_encounter,
    state_visits,
)
from tests.strategies import UidCounter, line_sets, rands, valid_configs
from warashi_agent.config import Config
from warashi_agent.model import (
    Action,
    AudioFailed,
    AudioFinished,
    CloudConnected,
    Event,
    FaceBox,
    GazeTarget,
    JudgementResult,
    LanternFade,
    PirRising,
    PlayAudioUrl,
    PlayLine,
    ReleaseServos,
    ServoArrived,
    SnapshotReady,
    State,
    TakeSnapshot,
    Tick,
    Verdict,
)
from warashi_agent.state_machine import MachineState, initial_state, step
from warashi_agent.voice import VoiceLine

TOL = 1e-9  # time and angle comparisons; float sums of Tick times drift far less than this
REACTIVE_BUDGET = 40


# --------------------------------------------------------------------------------------------
# Bounds, from the requirement formulas
# --------------------------------------------------------------------------------------------


def dwell_bounds(cfg: Config) -> dict[State, float]:
    """Maximum time in each State outside `sleeping` (R10.1 table)."""
    t, tm, n = cfg.tick_s, cfg.timing, cfg.camera.scan_attempts_max
    return {
        State.WAKING: tm.waking_timeout_s + t,
        State.SEEKING: (n + 1) * tm.verdict_timeout_s + n * tm.glide_timeout_s + (2 * n + 1) * t,
        State.GAZING: tm.glide_timeout_s + t,
        State.GREETING: tm.audio_timeout_s + t,
        State.WARNING: tm.stare_s + tm.audio_timeout_s + 2 * t,
        State.UNCERTAIN: tm.audio_timeout_s + t,
        State.COOLDOWN: tm.cooldown_s + t,
    }


def encounter_bound(cfg: Config) -> float:
    """Encounter_Bound L (Glossary)."""
    t, tm, n = cfg.tick_s, cfg.timing, cfg.camera.scan_attempts_max
    return (
        tm.waking_timeout_s
        + (n + 1) * (tm.verdict_timeout_s + tm.glide_timeout_s)
        + tm.stare_s
        + tm.audio_timeout_s
        + tm.cooldown_s
        + (2 * n + 6) * t
    )


def _clamp(value: float, limit: float) -> float:
    return max(-limit, min(limit, value))


# --------------------------------------------------------------------------------------------
# The oracle
# --------------------------------------------------------------------------------------------


def _check_tick_gaps(part: EncounterSlice, t: float) -> None:
    """The precondition of R29.4: no interval longer than `T` without a Tick after the start.

    A failure here is a driver bug, not a State_Machine bug.
    """
    last_tick = part.start
    for rec in part.records[1:]:
        assert rec.now <= last_tick + t + TOL, "driver broke the Tick spacing precondition"
        if isinstance(rec.event, Tick):
            last_tick = rec.now


def _is_scan_step(rec: Record) -> bool:
    """A Verdict in `seeking` that keeps `seeking` and moves the head is a scan move (R6.1)."""
    return (
        isinstance(rec.event, JudgementResult)
        and rec.before.state is State.SEEKING
        and rec.after.state is State.SEEKING
    )


def _route(part: EncounterSlice) -> str:
    return ">".join(v.state.value for v in state_visits(part.records))


def check_liveness(part: EncounterSlice, cfg: Config) -> None:
    """Every clause of Property 2 for one Encounter."""
    t = cfg.tick_s
    note(f"encounter {part.encounter_id} from {part.start!r} to {part.end!r}, ended={part.ended}")
    note(f"visits: {[(v.state.value, v.entered, v.left) for v in state_visits(part.records)]}")
    _check_tick_gaps(part, t)

    # R10.2: the Encounter reaches sleeping within Encounter_Bound.
    assert part.ended, "Encounter never left its States (no sleeping)"
    assert part.records[-1].after.state is State.SLEEPING, "Encounter ended outside sleeping"
    assert part.end - part.start <= encounter_bound(cfg) + TOL, "Encounter_Bound exceeded"

    # R10.1: each stay is within its bound.
    bounds = dwell_bounds(cfg)
    for visit in state_visits(part.records):
        if visit.state is State.SLEEPING:
            continue
        assert visit.state in bounds, f"State {visit.state} has no R10.1 bound"
        assert visit.duration <= bounds[visit.state] + TOL, (
            f"{visit.state} lasted {visit.duration!r} > {bounds[visit.state]!r}"
        )

    # R8.4: the doll rests at the entry into sleeping.
    actions: list[Action] = [a for rec in part.records for a in rec.actions]
    releases = [i for i, a in enumerate(actions) if isinstance(a, ReleaseServos)]
    assert releases, "no ReleaseServos in the Encounter"
    after_release = actions[releases[-1] + 1 :]
    assert not any(isinstance(a, GazeTarget) for a in after_release), (
        "GazeTarget after the last ReleaseServos"
    )
    fades = [a for a in actions if isinstance(a, LanternFade)]
    assert fades and fades[-1].level == 0, "last LanternFade is not level 0"

    # R6.1, R6.5: scan moves in order, at most scan_attempts_max.
    camera, servo = cfg.camera, cfg.servo
    scans = [
        a
        for rec in part.records
        if _is_scan_step(rec)
        for a in rec.actions
        if isinstance(a, GazeTarget)
    ]
    assert len(scans) <= camera.scan_attempts_max, "more scan moves than scan_attempts_max"
    for k, gaze in enumerate(scans):
        expected = _clamp(camera.scan_pan_positions_deg[k], servo.pan_limit)
        assert abs(gaze.pan_deg - expected) <= TOL, f"scan {k + 1} at pan {gaze.pan_deg!r}"
        assert abs(gaze.tilt_deg) <= TOL, f"scan {k + 1} at tilt {gaze.tilt_deg!r}"

    event(f"route: {_route(part)}")
    event(f"scan moves: {len(scans)}")


def check_trace(trace: Sequence[Record], cfg: Config) -> list[EncounterSlice]:
    """Check every Encounter of a trace and steer the search toward long Encounters."""
    parts = split_by_encounter(trace)
    event(f"encounters: {min(len(parts), 3)}{'+' if len(parts) > 3 else ''}")
    for part in parts:
        check_liveness(part, cfg)
    if parts:
        longest = max(p.end - p.start for p in parts)
        target(longest / encounter_bound(cfg), label="longest encounter / L")
    return parts


# --------------------------------------------------------------------------------------------
# Driver for the late-cloud worst case
# --------------------------------------------------------------------------------------------

_VERDICT_POOL = (Verdict.NO_FACE, Verdict.STRANGER, Verdict.FAMILY, Verdict.UNCERTAIN)
_LATE_FACE = FaceBox(left=0.4, top=0.4, width=0.2, height=0.2)


class _LateWorld:
    """One Encounter with a connected cloud that answers as late as the rules still allow.

    Ticks are exactly `gap` apart (`gap <= T`) from the `pir.rising`. Feedback is scheduled
    when its Action is emitted and is stepped before a Tick at the same time, so a Verdict
    scheduled at the observing Tick is the latest Verdict that is still processed.

    With `worst` set, the cloud answers `no_face` until the scans are used up and then
    `stranger` with a face, and no servo or audio feedback ever arrives: the worst route of
    the design's "Path to sleeping" table. Otherwise each answer is drawn, with the late or
    missing options first so that shrinking moves toward the worst case.
    """

    def __init__(
        self,
        data: st.DataObject,
        cfg: Config,
        lines: tuple[VoiceLine, ...],
        *,
        gap: float,
        worst: bool,
    ) -> None:
        self.data = data
        self.cfg = cfg
        self.gap = gap
        self.worst = worst
        self.rand = data.draw(rands(), label="rand")
        self.uids = UidCounter()
        self.ms: MachineState = initial_state(
            config=cfg, lines=lines, agent_version=AGENT_VERSION, start_time=START_TIME
        )
        self.now = START_TIME
        self.next_tick = START_TIME
        self.pending: list[tuple[float, int, Event]] = []
        self.seq = 0
        self.verdicts_sent = 0
        self.records: list[Record] = []

    def run(self) -> Trace:
        self._step(CloudConnected(), START_TIME)
        start = START_TIME + self.cfg.timing.pir_warmup_s
        self._step(PirRising(), start)
        self.next_tick = start + self.gap
        end = start + encounter_bound(self.cfg) + self.cfg.tick_s
        while self.now < end:
            if self.pending and self.pending[0][0] <= self.next_tick:
                at, _, ev = heapq.heappop(self.pending)
                self._step(ev, at)
            else:
                self._step(Tick(), self.next_tick)
                self.next_tick = self.next_tick + self.gap
        return tuple(self.records)

    # -- stepping ------------------------------------------------------------------------

    def _step(self, ev: Event, at: float) -> None:
        stamped = dataclasses.replace(ev, rand=self.rand, uid=self.uids())
        before = self.ms
        after, actions = step(before, stamped, at)
        self.records.append(Record(at, stamped, before, after, actions))
        self.ms, self.now = after, at
        for action in actions:
            self._answer(action)

    def _schedule(self, at: float, ev: Event) -> None:
        self.seq += 1
        heapq.heappush(self.pending, (max(at, self.now), self.seq, ev))

    def _observing_tick(self, deadline: float) -> float:
        """The first Tick at or after `deadline`, with the same float sums as `run`."""
        t = self.next_tick
        while t < deadline:
            t = t + self.gap
        return t

    # -- answers -------------------------------------------------------------------------

    def _answer(self, action: Action) -> None:
        match action:
            case TakeSnapshot(snapshot_id=sid):
                ready = SnapshotReady(snapshot_id=sid, jpeg=FAKE_JPEG, width=640, height=480)
                self._schedule(self.now, ready)
                self._answer_snapshot(sid)
            case GazeTarget(motion_id=mid):
                # Every glide ends within Sweep_Time; "never" makes the wait hit its deadline.
                if self.worst or self._draw_choice(("never", "glide_end"), "arrival") == "never":
                    return
                self._schedule(self.now + self.cfg.sweep_time_s, ServoArrived(motion_id=mid))
            case PlayLine(play_id=pid) | PlayAudioUrl(play_id=pid):
                if self.worst:
                    return
                outcome = self._draw_choice(("never", "finished", "failed"), "audio")
                if outcome == "never":
                    return
                at = self.now + self.data.draw(
                    st.floats(0.0, self.cfg.timing.audio_timeout_s), label="audio length"
                )
                ev: Event = (
                    AudioFinished(play_id=pid)
                    if outcome == "finished"
                    else AudioFailed(play_id=pid, code="audio_failed")
                )
                self._schedule(at, ev)
            case _:
                pass

    def _answer_snapshot(self, sid: str) -> None:
        deadline = self.now + self.cfg.timing.verdict_timeout_s
        timing = "observing_tick"
        if not self.worst:
            options = ("observing_tick", "before_deadline", "never")
            timing = self._draw_choice(options, "verdict timing")
        if timing == "never":
            return
        if timing == "observing_tick":
            at = self._observing_tick(deadline)
        else:
            at = self.now + self.data.draw(
                st.floats(0.0, self.cfg.timing.verdict_timeout_s), label="verdict delay"
            )
        self._schedule(at, self._verdict(sid))

    def _verdict(self, sid: str) -> JudgementResult:
        ref_id = self.uids()
        if self.worst:
            no_face = self.verdicts_sent < self.cfg.camera.scan_attempts_max
            self.verdicts_sent += 1
            return JudgementResult(
                ref_id=ref_id,
                snapshot_id=sid,
                verdict=Verdict.NO_FACE if no_face else Verdict.STRANGER,
                confidence=1.0,
                face=None if no_face else _LATE_FACE,
            )
        draw = self.data.draw
        return JudgementResult(
            ref_id=ref_id,
            snapshot_id=sid,
            verdict=draw(st.sampled_from(_VERDICT_POOL), label="verdict"),
            confidence=draw(st.one_of(st.just(1.0), st.floats(0.0, 1.0)), label="confidence"),
            face=draw(st.one_of(st.just(_LATE_FACE), st.none()), label="face"),
        )

    def _draw_choice(self, options: tuple[str, ...], label: str) -> str:
        return self.data.draw(st.sampled_from(options), label=label)


# --------------------------------------------------------------------------------------------
# The Property 2 test functions
# --------------------------------------------------------------------------------------------


# Feature: device-core-loop, Property 2: Liveness
@pytest.mark.timeout(300)
@settings(deadline=None)
@given(data=st.data())
def test_liveness_with_random_events(data: st.DataObject) -> None:
    """Random Events of every kind, Ticks at most `T` apart: every Encounter sleeps in time.

    **Validates: Requirements 2.4, 3.6, 5.6, 6.5, 7.6, 7.10, 8.1, 8.2, 8.3, 8.4, 10.1, 10.2, 29.4**
    """
    cfg = data.draw(valid_configs(), label="cfg")
    lines = data.draw(line_sets(), label="lines")
    trace = run_reactive(data, cfg, lines, tick_gap_max=cfg.tick_s, budget=REACTIVE_BUDGET)
    check_trace(trace, cfg)


# Feature: device-core-loop, Property 2: Liveness
@pytest.mark.timeout(300)
@settings(deadline=None)
@given(data=st.data())
def test_liveness_with_late_verdicts(data: st.DataObject) -> None:
    """Verdicts just before the observing Tick and silent servos and audio: the worst route.

    **Validates: Requirements 2.4, 3.6, 5.6, 6.5, 7.6, 7.10, 8.1, 8.2, 8.3, 8.4, 10.1, 10.2, 29.4**
    """
    cfg = data.draw(valid_configs(), label="cfg")
    lines = data.draw(line_sets(), label="lines")
    t = cfg.tick_s
    gap = data.draw(st.one_of(st.just(t), st.floats(t / 2, t)), label="tick gap")
    worst = data.draw(st.booleans(), label="worst route")
    trace = _LateWorld(data, cfg, lines, gap=gap, worst=worst).run()

    parts = check_trace(trace, cfg)
    assert len(parts) == 1, "the pir.rising after warm-up must start exactly one Encounter"
    if worst:
        ratio = (parts[0].end - parts[0].start) / encounter_bound(cfg)
        event(f"worst route length / L: {ratio:.1f}")
