"""Reactive test harness for the State_Machine (design "Shared generators and harness").

`run_reactive(data, cfg, lines, tick_gap_max=..., budget=...)` drives `step()` with Events drawn
from Hypothesis `st.data()` and returns a trace of `Record(now, event, before, after, actions)`.

The harness plays the part of the adapters and the cloud. It answers the Actions that
`step()` emits the way the real adapters would: a `TakeSnapshot` gets a `snapshot.ready` or
`snapshot.failed` with its Snapshot_Id, a `GazeTarget` gets a `servo.arrived` with its
Motion_Id after the glide duration of `glide.plan_glide`, and a `PlayLine` or `PlayAudioUrl`
gets an `audio.finished` or `audio.failed` with its Play_Id. Because feedback is derived from
the emitted Actions only, the harness works against the action/event contract and does not
depend on how the handlers are written.

Like the Dispatcher, the harness stamps `rand` (drawn from `rands()`) and `uid` (from a
per-run `UidCounter`) on every Event with `dataclasses.replace` before `step()` (R1.5, R29.2),
and asserts that every input is a defined Event and every output a defined Action (R1.6).

Every loop is bounded: at most `budget` drawn Events, forced Ticks only to close drawn gaps,
and a silent tail that ends once every Encounter has had Encounter_Bound + `T`. A run can
therefore never hang, whatever the State_Machine does.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Sequence
from typing import NamedTuple

from hypothesis import strategies as st

from tests.strategies import UidCounter, rands
from warashi_agent.config import Config
from warashi_agent.glide import plan_glide
from warashi_agent.model import (
    Action,
    AudioFailed,
    AudioFinished,
    CloudConnected,
    CloudDisconnected,
    Event,
    FaceBox,
    Gaze,
    GazeTarget,
    JudgementResult,
    Lantern,
    Mode,
    ModeSet,
    PirFalling,
    PirRising,
    PlayAudioUrl,
    PlayLine,
    ReleaseServos,
    ServoArrived,
    SnapshotFailed,
    SnapshotReady,
    Speak,
    State,
    TakeSnapshot,
    Tick,
    Verdict,
)
from warashi_agent.state_machine import MachineState, initial_state, step
from warashi_agent.voice import VoiceLine

AGENT_VERSION = "0.0.0-test"
START_TIME = 0.0

# The smallest valid JPEG shape (SOI + EOI). The State_Machine never decodes the bytes.
FAKE_JPEG = b"\xff\xd8\xff\xd9"
FAKE_AUDIO_URL = "https://audio.example.invalid/line.wav?sig=test"
UNKNOWN_LINE_ID = "no_such_line"

# Relative weights of the draw kinds. Ticks and feedback dominate so that Encounters progress;
# the rest add noise that every State must tolerate.
_KIND_WEIGHTS = (
    ("tick", 4),
    ("feedback", 4),
    ("stale", 1),
    ("pir", 2),
    ("cloud", 1),
    ("command", 2),
)


class Record(NamedTuple):
    """One `step()` call: the input, the states on both sides and the emitted Actions."""

    now: float
    event: Event
    before: MachineState
    after: MachineState
    actions: tuple[Action, ...]


Trace = tuple[Record, ...]


# --------------------------------------------------------------------------------------------
# Value strategies
# --------------------------------------------------------------------------------------------


def _floats(lo: float, hi: float) -> st.SearchStrategy[float]:
    return st.floats(min_value=lo, max_value=hi, allow_nan=False, allow_infinity=False)


def fixed_one_of[T](*strategies: st.SearchStrategy[T]) -> st.SearchStrategy[T]:
    """Like `st.one_of`, but every argument is its own branch, chosen with equal weight.

    `st.one_of` drops a branch that is the same object as an earlier one, and `st.floats` or
    `st.integers` with equal arguments return one object from Hypothesis' global strategy cache
    (an LRU cache shared by every test in the process). Whether `st.floats(0.0, a)` and
    `st.floats(0.0, b)` with `a == b` are one branch or two therefore depends on what earlier
    tests put in that cache. The same choice sequence can then pick a different branch, which
    Hypothesis reports as `FlakyStrategyDefinition` in full-suite runs only. Here the branch is
    an index into a tuple of fixed length, so equal bounds drawn from the Config are harmless,
    and passing one strategy twice really doubles its weight.
    """
    if not strategies:
        raise ValueError("fixed_one_of needs at least one strategy")
    return st.sampled_from(strategies).flatmap(lambda strategy: strategy)


def _any_finite() -> st.SearchStrategy[float]:
    """Any finite float, with zero and the ±1e300 extremes of the design drawn often."""
    return st.one_of(
        st.sampled_from((0.0, 1e300, -1e300)),
        _floats(-200.0, 200.0),
        st.floats(allow_nan=False, allow_infinity=False),
    )


def _gaps(cfg: Config) -> st.SearchStrategy[float]:
    """Time between two drawn Events: zero, within one Tick, a few Ticks, or seconds.

    The longest gap is an eighth of Encounter_Bound, so deadlines are crossed often while the
    number of forced Ticks per gap stays small.
    """
    t = cfg.tick_s
    # `fixed_one_of`: the three bounds come from the Config and may be equal.
    return fixed_one_of(
        st.just(0.0),
        _floats(0.0, t),
        _floats(0.0, 10 * t),
        _floats(0.0, cfg.encounter_bound_s / 8),
    )


def _face_boxes() -> st.SearchStrategy[FaceBox | None]:
    return st.one_of(
        st.none(),
        st.builds(
            FaceBox,
            left=st.one_of(_floats(0.0, 1.0), _any_finite()),
            top=st.one_of(_floats(0.0, 1.0), _any_finite()),
            width=st.one_of(_floats(0.0, 1.0), _any_finite()),
            height=st.one_of(_floats(0.0, 1.0), _any_finite()),
        ),
    )


# --------------------------------------------------------------------------------------------
# The driver
# --------------------------------------------------------------------------------------------


class _Driver:
    """Mutable bookkeeping for one `run_reactive` call: time, pending feedback and the trace."""

    def __init__(
        self,
        data: st.DataObject,
        cfg: Config,
        lines: tuple[VoiceLine, ...],
        tick_gap_max: float | None,
    ) -> None:
        self.data = data
        self.cfg = cfg
        self.lines = lines
        self.tick_gap_max = tick_gap_max
        self.uids = UidCounter()
        self.ms = initial_state(
            config=cfg, lines=lines, agent_version=AGENT_VERSION, start_time=START_TIME
        )
        self.now = START_TIME
        self.last_tick = START_TIME
        self.records: list[Record] = []
        self.encounter_starts: list[float] = []
        # Pending feedback, keyed by id, in emission order (dicts keep insertion order).
        self.snapshots: dict[str, float] = {}  # Snapshot_Id -> emit time
        self.motions: dict[str, float] = {}  # Motion_Id -> glide end time
        self.plays: dict[str, float] = {}  # Play_Id -> emit time
        self.answered: list[str] = []  # ids already answered or superseded (stale pool)
        self.last_snapshot_id: str | None = None
        self.pose: tuple[float, float] = (0.0, 0.0)  # goal of the last glide, roughly the head

    # -- stepping ------------------------------------------------------------------------

    def feed(self, event: Event, at: float) -> None:
        """Advance to `at` (forcing Ticks if needed), stamp `event` and step it."""
        at = max(at, self.now)
        if self.tick_gap_max is not None:
            while at > self.last_tick + self.tick_gap_max:
                self._step(Tick(), self.last_tick + self.tick_gap_max)
        self._step(event, at)

    def _step(self, event: Event, at: float) -> None:
        assert at >= self.now, "now must never decrease"
        stamped = dataclasses.replace(event, rand=self.data.draw(rands()), uid=self.uids())
        assert isinstance(stamped, Event), f"undefined input event: {type(stamped).__name__}"
        before = self.ms
        after, actions = step(before, stamped, at)
        for action in actions:
            assert isinstance(action, Action), f"undefined output action: {type(action).__name__}"
        self.now = at
        if isinstance(stamped, Tick):
            self.last_tick = at
        self.records.append(Record(at, stamped, before, after, actions))
        self.ms = after
        self._note_encounter(before, after, at)
        self._note_actions(actions, at)

    def _note_encounter(self, before: MachineState, after: MachineState, at: float) -> None:
        new = after.encounter
        old = before.encounter
        if new is not None and (old is None or old.encounter_id != new.encounter_id):
            self.encounter_starts.append(at)

    def _note_actions(self, actions: tuple[Action, ...], at: float) -> None:
        """Turn emitted Actions into pending feedback, as the adapters would."""
        for action in actions:
            match action:
                case TakeSnapshot(snapshot_id=sid):
                    self.snapshots[sid] = at
                    self.last_snapshot_id = sid
                case GazeTarget(pan_deg=pan, tilt_deg=tilt, motion_id=mid):
                    # A new glide replaces the running one, so its arrival becomes stale.
                    self._supersede(self.motions)
                    plan = plan_glide(self.pose, (pan, tilt), at, mid, self.cfg)
                    if plan is not None:
                        self.motions[mid] = plan.end_time
                        self.pose = plan.goal
                case ReleaseServos():
                    self._supersede(self.motions)
                case PlayLine(play_id=pid) | PlayAudioUrl(play_id=pid):
                    self.plays[pid] = at
                case _:
                    pass

    def _supersede(self, pending: dict[str, float]) -> None:
        self.answered.extend(pending)
        pending.clear()

    # -- drawing -------------------------------------------------------------------------

    def draw_one(self) -> None:
        """Draw one Event of a random kind and feed it."""
        kinds = [k for k, w in _KIND_WEIGHTS for _ in range(w)]
        if not (self.snapshots or self.motions or self.plays):
            kinds = [k for k in kinds if k != "feedback"]
        kind = self.data.draw(st.sampled_from(kinds), label="kind")
        at = self.now + self.data.draw(_gaps(self.cfg), label="gap")
        match kind:
            case "tick":
                self.feed(Tick(), at)
            case "feedback":
                self._draw_feedback(at)
            case "stale":
                self._draw_stale(at)
            case "pir":
                self.feed(self.data.draw(st.sampled_from((PirRising(), PirFalling()))), at)
            case "cloud":
                event = self.data.draw(st.sampled_from((CloudConnected(), CloudDisconnected())))
                self.feed(event, at)
            case _:
                self.feed(self._draw_command(), at)

    def _draw_feedback(self, at: float) -> None:
        """Answer one pending Action with its own id."""
        sources = [
            name
            for name, pending in (
                ("snapshot", self.snapshots),
                ("motion", self.motions),
                ("play", self.plays),
            )
            if pending
        ]
        source = self.data.draw(st.sampled_from(sources), label="feedback")
        if source == "snapshot":
            sid = self.data.draw(st.sampled_from(list(self.snapshots)))
            del self.snapshots[sid]
            event = self._snapshot_result(sid)
        elif source == "motion":
            mid = self.data.draw(st.sampled_from(list(self.motions)))
            at = max(at, self.motions.pop(mid))  # the glide must have ended
            event = ServoArrived(motion_id=mid)
        else:
            pid = self.data.draw(st.sampled_from(list(self.plays)))
            del self.plays[pid]
            event = self._audio_result(pid)
        self.answered.append(_feedback_id(event))
        self.feed(event, at)

    def _draw_stale(self, at: float) -> None:
        """Feedback with an id that was already answered, superseded, or never issued."""
        fresh = self.data.draw(st.integers(0, 2**16).map(lambda n: f"stale-{n}"))
        old_id = self.data.draw(st.sampled_from([fresh, *self.answered]), label="stale id")
        kind = self.data.draw(st.sampled_from(("servo", "audio", "snapshot")), label="stale kind")
        if kind == "servo":
            event: Event = ServoArrived(motion_id=old_id)
        elif kind == "audio":
            event = self._audio_result(old_id)
        else:
            event = self._snapshot_result(old_id)
        self.feed(event, at)

    def _snapshot_result(self, sid: str) -> SnapshotReady | SnapshotFailed:
        if self.data.draw(st.booleans(), label="snapshot ok"):
            return SnapshotReady(snapshot_id=sid, jpeg=FAKE_JPEG, width=640, height=480)
        code = self.data.draw(st.sampled_from(("camera_failed", "snapshot_too_large")))
        return SnapshotFailed(snapshot_id=sid, code=code)

    def _audio_result(self, pid: str) -> AudioFinished | AudioFailed:
        if self.data.draw(st.booleans(), label="audio ok"):
            return AudioFinished(play_id=pid)
        code = self.data.draw(st.sampled_from(("audio_failed", "download_failed", "interrupted")))
        return AudioFailed(play_id=pid, code=code)

    def _draw_command(self) -> Event:
        """A Command_Event as the inbound pipeline would build it from a valid command."""
        ref_id = self.uids()
        kind = self.data.draw(
            st.sampled_from(("judgement", "speak", "gaze", "lantern", "mode")), label="command"
        )
        draw = self.data.draw
        if kind == "judgement":
            return JudgementResult(
                ref_id=ref_id,
                snapshot_id=draw(st.sampled_from(self._snapshot_id_candidates())),
                verdict=draw(st.sampled_from(Verdict)),
                confidence=draw(st.one_of(_floats(0.0, 1.0), _any_finite())),
                face=draw(_face_boxes()),
            )
        if kind == "speak":
            # Exactly one of lineId and audioUrl: the decoder rejects anything else.
            if draw(st.booleans(), label="speak line"):
                ids = [line.id for line in self.lines] + [UNKNOWN_LINE_ID]
                return Speak(ref_id=ref_id, line_id=draw(st.sampled_from(ids)), audio_url=None)
            return Speak(ref_id=ref_id, line_id=None, audio_url=FAKE_AUDIO_URL)
        if kind == "gaze":
            return Gaze(ref_id=ref_id, pan_deg=draw(_any_finite()), tilt_deg=draw(_any_finite()))
        if kind == "lantern":
            return Lantern(
                ref_id=ref_id,
                level=draw(st.one_of(_floats(0.0, 1.0), _any_finite())),
                fade_ms=draw(st.one_of(st.integers(0, 10000), st.integers(-(10**6), 10**6))),
            )
        return ModeSet(ref_id=ref_id, mode=draw(st.sampled_from(Mode)))

    def _snapshot_id_candidates(self) -> list[str]:
        """Current_Snapshot_Id first (so it shrinks toward the matching case), then others."""
        out: list[str] = []
        enc = self.ms.encounter
        if enc is not None and enc.attempt is not None:
            out.append(enc.attempt.snapshot_id)
        if self.last_snapshot_id is not None and self.last_snapshot_id not in out:
            out.append(self.last_snapshot_id)
        out.append(f"stale-{self.data.draw(st.integers(0, 2**16))}")
        return out

    # -- silent tail ---------------------------------------------------------------------

    def silent_tail(self) -> None:
        """Ticks `T` apart until every started Encounter has had Encounter_Bound + `T`.

        Each Tick is spaced from the last Tick, not from `now`: the trace may end with a
        non-Tick Event after the last Tick, and spacing from it would leave a gap of up to
        twice `tick_gap_max`. `last_tick + spacing` is also the same float sum a caller uses to
        check the gap, so float rounding cannot push a Tick past the bound.
        """
        spacing = self.cfg.tick_s
        if self.tick_gap_max is not None:
            spacing = min(spacing, self.tick_gap_max)
        allowance = self.cfg.encounter_bound_s + self.cfg.tick_s
        # `encounter_starts` is read on every pass: a Tick cannot start an Encounter today,
        # but if one ever did, its bound would extend the tail instead of being cut off.
        while self.encounter_starts and self.now < max(self.encounter_starts) + allowance:
            self._step(Tick(), max(self.now, self.last_tick + spacing))


def _feedback_id(event: Event) -> str:
    match event:
        case (
            ServoArrived(motion_id=i)
            | SnapshotReady(snapshot_id=i)
            | SnapshotFailed(snapshot_id=i)
            | AudioFinished(play_id=i)
            | AudioFailed(play_id=i)
        ):
            return i
    raise TypeError(f"not a feedback event: {type(event).__name__}")


def run_reactive(
    data: st.DataObject,
    cfg: Config,
    lines: tuple[VoiceLine, ...],
    *,
    tick_gap_max: float | None,
    budget: int,
) -> Trace:
    """Drive `step()` with up to `budget` drawn Events plus a silent tail; return the trace.

    `now` never decreases. With `tick_gap_max` set, a Tick is forced before any Event whose
    `now` would lie more than `tick_gap_max` after the last Tick (Property 2 passes `T`).
    """
    if tick_gap_max is not None and not tick_gap_max > 0:
        raise ValueError("tick_gap_max must be positive")
    driver = _Driver(data, cfg, lines, tick_gap_max)
    count = data.draw(st.integers(0, budget), label="drawn events")
    for _ in range(count):
        driver.draw_one()
    driver.silent_tail()
    return tuple(driver.records)


# --------------------------------------------------------------------------------------------
# Trace helpers for the properties
# --------------------------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class EncounterSlice:
    """The records of one Encounter, from its starting `pir.rising` to its `sleeping`.

    `records[0]` is the record whose `after` first carries the Encounter. `ended` is true when
    a record's `after` no longer carries it, which is then the last record of the slice.
    """

    encounter_id: str
    records: Trace
    ended: bool

    @property
    def start(self) -> float:
        return self.records[0].now

    @property
    def end(self) -> float:
        return self.records[-1].now


def _encounter_id(ms: MachineState) -> str | None:
    return ms.encounter.encounter_id if ms.encounter is not None else None


def split_by_encounter(trace: Sequence[Record]) -> list[EncounterSlice]:
    """Split a trace into Encounters, in start order.

    A record belongs to an Encounter when its `before` or its `after` carries the Encounter's
    id, so the starting and the ending record are both included. Records outside every
    Encounter are dropped.
    """
    groups: dict[str, list[Record]] = {}
    ended: dict[str, bool] = {}
    for rec in trace:
        old, new = _encounter_id(rec.before), _encounter_id(rec.after)
        for eid in dict.fromkeys(i for i in (old, new) if i is not None):
            groups.setdefault(eid, []).append(rec)
        if old is not None and old != new:
            ended[old] = True
    return [
        EncounterSlice(encounter_id=eid, records=tuple(recs), ended=ended.get(eid, False))
        for eid, recs in groups.items()
    ]


class StateVisit(NamedTuple):
    """One uninterrupted stay in a State. `closed` is false when the trace ends in it."""

    state: State
    entered: float
    left: float
    closed: bool

    @property
    def duration(self) -> float:
        return self.left - self.entered


def state_visits(trace: Sequence[Record]) -> list[StateVisit]:
    """Stays in each State, in order. The first stay starts at the first record's `now`."""
    if not trace:
        return []
    visits: list[StateVisit] = []
    state, entered = trace[0].before.state, trace[0].now
    for rec in trace:
        if rec.after.state != state:
            visits.append(StateVisit(state, entered, rec.now, closed=True))
            state, entered = rec.after.state, rec.now
    visits.append(StateVisit(state, entered, trace[-1].now, closed=False))
    return visits


def time_in_states(trace: Sequence[Record]) -> dict[State, float]:
    """Total time spent in each State over the trace (States never visited are absent)."""
    totals: dict[State, float] = {}
    for visit in state_visits(trace):
        totals[visit.state] = totals.get(visit.state, 0.0) + visit.duration
    return totals


def longest_stay(trace: Sequence[Record]) -> dict[State, float]:
    """Longest single stay per State, the quantity bounded by R10.1 (Property 2)."""
    longest: dict[State, float] = {}
    for visit in state_visits(trace):
        longest[visit.state] = max(longest.get(visit.state, 0.0), visit.duration)
    return longest
