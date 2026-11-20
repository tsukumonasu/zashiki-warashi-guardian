"""Property 9: Determinism (design "Correctness Properties").

For all reachable Machine_States `ms`, all Events `e` and all values `now` at or after the
`now` that produced `ms`, two calls `step(ms, e, now)` return equal Machine_States and equal
Action tuples, and neither call changes `ms`: it compares equal to a `copy.deepcopy` taken
before the calls (R1.1, R1.2, R29.11).

Reachable states come from traces of two worlds:

- `plain`: `run_reactive` as it is, with random Ticks, feedback, stale ids and commands.
- `every_state`: `_EveryStateWorld` below, which keeps Encounters going (a connected or a
  disconnected cloud, Verdicts of every kind for the current snapshot, feedback for pending
  Actions), so that `gazing`, `greeting`, `warning`, `uncertain` and `cooldown` are reached.

Two checks per example:

- Replay: for one sampled record per State seen in the trace, plus a few random records,
  `step(before, event, now)` is called twice. Both results must equal the recorded
  `(after, actions)`, and `before` must equal its deep copy afterwards.
- Fresh Events: on one sampled `after` state per State seen, a few random ones and the
  initial state, Events drawn from
  the full menu (Ticks, PIR edges, cloud changes, feedback with current, stale or never-issued
  ids, every command) at `now` = the record's `now` plus a gap in [0, 2 × Encounter_Bound]
  are stepped twice with the same checks.

`conversing` (P1) is never entered in this spec, so it is never sampled.
"""

from __future__ import annotations

import copy
import dataclasses
import uuid
from collections.abc import Sequence

import pytest
from hypothesis import event, given, note, settings
from hypothesis import strategies as st

from tests.harness import (
    AGENT_VERSION,
    FAKE_AUDIO_URL,
    FAKE_JPEG,
    START_TIME,
    UNKNOWN_LINE_ID,
    Record,
    Trace,
    _any_finite,
    _Driver,
    _face_boxes,
    _floats,
    fixed_one_of,
    run_reactive,
)
from tests.strategies import line_sets, rands, valid_configs
from warashi_agent.config import Config
from warashi_agent.model import (
    AudioFailed,
    AudioFinished,
    Category,
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

PLAIN_BUDGET = 30
WORLD_BUDGET = 40  # drawn Events per Encounter
WORLD_ENCOUNTERS_MAX = 3
WORLD_EVENTS_MIN = 10  # fewer drawn Events rarely get past waking
TAIL_TICK_MIN_S = 1.0  # coarse tail Ticks: determinism needs no Tick spacing
TAIL_STEPS_MAX = 1000
EXTRA_REPLAYS_MAX = 6  # random records replayed on top of one per State
EXTRA_FRESH_STATES_MAX = 2  # random `after` states with fresh Events, on top of one per State
FRESH_EVENTS_MAX = 3  # fresh Events per sampled state

# Fresh uids live far above the per-example UidCounter (k < 2**61 in practice), so they never
# collide with the uids of the trace.
_FRESH_UID_BASE = 1 << 61

# Verdict kinds for `_EveryStateWorld`: family and stranger lead to gazing, greeting and
# warning; no_face and uncertain lead to scanning and uncertain.
_VERDICTS = (
    Verdict.FAMILY,
    Verdict.STRANGER,
    Verdict.FAMILY,
    Verdict.STRANGER,
    Verdict.NO_FACE,
    Verdict.UNCERTAIN,
)


# --------------------------------------------------------------------------------------------
# Driver: Encounters that reach every State
# --------------------------------------------------------------------------------------------


class _EveryStateWorld(_Driver):
    """Encounters after warm-up, with Verdicts of every kind for the current snapshot.

    It reuses the harness bookkeeping (stamping, pending feedback, stale ids, commands) and
    only replaces the choice of the next Event. The cloud starts connected in most examples
    and disconnected in the rest, so the offline path into `uncertain` is reached as well.
    """

    def __init__(self, data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...]) -> None:
        super().__init__(data, cfg, lines, tick_gap_max=None)
        judgement = cfg.judgement
        # Mostly above both thresholds, so that family and stranger Verdicts are accepted.
        self.confidences = (
            1.0,
            1.0,
            1.0,
            max(judgement.family_confidence_min, judgement.stranger_confidence_min),
            judgement.family_confidence_min,
            judgement.stranger_confidence_min,
            0.0,
        )

    def run(self, budget: int) -> Trace:
        if self.data.draw(st.integers(0, 3), label="starts online") > 0:
            self.feed(CloudConnected(), START_TIME)
        encounters = self.data.draw(st.integers(1, WORLD_ENCOUNTERS_MAX), label="encounters")
        for _ in range(encounters):
            if self.ms.mode is Mode.SLEEP:
                self.feed(ModeSet(ref_id=self.uids(), mode=Mode.GUARD), self.now)
            self.feed(PirRising(), max(self.now, START_TIME + self.cfg.timing.pir_warmup_s))
            count = self.data.draw(
                st.integers(min(WORLD_EVENTS_MIN, budget), budget), label="events"
            )
            for _ in range(count):
                self.draw_world_event()
            self.tail()
        return tuple(self.records)

    def draw_world_event(self) -> None:
        state = self.ms.state
        pending = bool(self.snapshots or self.motions or self.plays)
        early = state in (State.WAKING, State.SEEKING)
        weights = {
            "tick": 6,
            "feedback": 8 if pending else 0,
            "judgement": 14 if state is State.SEEKING else 1,
            # Commands include `mode.set` sleep, which would end most Encounters early.
            "command": 0 if early else 2,
            "stale": 1,
            "pir": 1,
        }
        kinds = [k for k, w in weights.items() for _ in range(w)]
        kind = self.data.draw(st.sampled_from(kinds), label="kind")
        at = self.now + self.data.draw(self._gaps(state), label="gap")
        match kind:
            case "tick":
                self.feed(Tick(), at)
            case "feedback":
                self._draw_feedback(at)
            case "judgement":
                self.feed(self._draw_verdict(), at)
            case "command":
                self.feed(self._draw_command(), at)
            case "stale":
                self._draw_stale(at)
            case _:
                self.feed(PirRising(), at)

    def _gaps(self, state: State) -> st.SearchStrategy[float]:
        """Short gaps in `seeking` (Verdicts arrive in time), up to a quarter stare elsewhere."""
        t = self.cfg.tick_s
        if state is State.SEEKING:
            return st.one_of(st.just(0.0), _floats(0.0, self.cfg.timing.verdict_timeout_s / 4))
        # `fixed_one_of`: `max(t, stare_s / 4)` is `t` whenever `stare_s <= 4t`, and
        # `st.one_of` would make the branch count depend on Hypothesis' strategy cache.
        return fixed_one_of(
            st.just(0.0),
            _floats(0.0, t),
            _floats(0.0, 10 * t),
            _floats(0.0, max(t, self.cfg.timing.stare_s / 4)),
        )

    def _snapshot_result(self, sid: str) -> SnapshotReady | SnapshotFailed:
        """Mostly `snapshot.ready`: a failure ends the attempt before any Verdict."""
        if self.data.draw(st.integers(0, 7), label="snapshot fails") > 0:
            return SnapshotReady(snapshot_id=sid, jpeg=FAKE_JPEG, width=640, height=480)
        code = self.data.draw(st.sampled_from(("camera_failed", "snapshot_too_large")))
        return SnapshotFailed(snapshot_id=sid, code=code)

    def _draw_verdict(self) -> JudgementResult:
        draw = self.data.draw
        candidates = self._snapshot_id_candidates()
        # The Current_Snapshot_Id (first candidate) twice as often as any other id.
        sid = draw(st.sampled_from([candidates[0], *candidates]), label="verdict snapshot")
        unit = _floats(0.0, 1.0)
        box = st.builds(FaceBox, left=unit, top=unit, width=unit, height=unit)
        # Two thirds with a face. `st.one_of` would drop the repeated branch.
        face = draw(fixed_one_of(st.none(), box, box), label="face")
        return JudgementResult(
            ref_id=self.uids(),
            snapshot_id=sid,
            verdict=draw(st.sampled_from(_VERDICTS), label="verdict"),
            confidence=draw(st.one_of(st.sampled_from(self.confidences), unit), label="conf"),
            face=face,
        )

    def tail(self) -> None:
        """Coarse Ticks until the doll sleeps, so cooldown and the return to sleep are seen."""
        spacing = max(self.cfg.tick_s, TAIL_TICK_MIN_S)
        steps = 0
        while self.ms.state is not State.SLEEPING and steps < TAIL_STEPS_MAX:
            self._step(Tick(), max(self.now, self.last_tick + spacing))
            steps += 1


# --------------------------------------------------------------------------------------------
# Fresh Events from the full menu
# --------------------------------------------------------------------------------------------


def issued_ids(records: Sequence[Record]) -> list[str]:
    """Snapshot, Motion and Play ids emitted by `records`, in emission order."""
    out: list[str] = []
    for rec in records:
        for action in rec.actions:
            match action:
                case TakeSnapshot(snapshot_id=i) | GazeTarget(motion_id=i):
                    out.append(i)
                case PlayLine(play_id=i) | PlayAudioUrl(play_id=i):
                    out.append(i)
                case _:
                    pass
    return out


_FRESH_KINDS = (
    "tick",
    "tick",
    "pir.rising",
    "pir.falling",
    "cloud.connected",
    "cloud.disconnected",
    "servo.arrived",
    "snapshot.ready",
    "snapshot.failed",
    "audio.finished",
    "audio.failed",
    "judgement.result",
    "speak",
    "gaze",
    "lantern",
    "mode.set",
)


def draw_fresh_event(
    data: st.DataObject,
    ms: MachineState,
    ids: Sequence[str],
    lines: Sequence[VoiceLine],
    serial: int,
) -> Event:
    """One stamped Event of any kind; feedback ids are current, stale or never issued."""
    draw = data.draw
    kind = draw(st.sampled_from(_FRESH_KINDS), label="fresh kind")
    never = f"never-issued-{draw(st.integers(0, 2**16))}"
    # Ids of the trace newest first, so shrinking moves toward the current ones.
    some_id = draw(st.sampled_from([*reversed(ids), never]), label="fresh id")
    ref_id = str(uuid.UUID(int=_FRESH_UID_BASE + 2 * serial, version=4))
    ev: Event
    match kind:
        case "tick":
            ev = Tick()
        case "pir.rising":
            ev = PirRising()
        case "pir.falling":
            ev = PirFalling()
        case "cloud.connected":
            ev = CloudConnected()
        case "cloud.disconnected":
            ev = CloudDisconnected()
        case "servo.arrived":
            ev = ServoArrived(motion_id=some_id)
        case "snapshot.ready":
            ev = SnapshotReady(snapshot_id=some_id, jpeg=FAKE_JPEG, width=640, height=480)
        case "snapshot.failed":
            code = draw(st.sampled_from(("camera_failed", "snapshot_too_large")))
            ev = SnapshotFailed(snapshot_id=some_id, code=code)
        case "audio.finished":
            ev = AudioFinished(play_id=some_id)
        case "audio.failed":
            code = draw(st.sampled_from(("audio_failed", "download_failed", "interrupted")))
            ev = AudioFailed(play_id=some_id, code=code)
        case "judgement.result":
            enc = ms.encounter
            current = [enc.attempt.snapshot_id] if enc is not None and enc.attempt else []
            ev = JudgementResult(
                ref_id=ref_id,
                snapshot_id=draw(st.sampled_from([*current, some_id])),
                verdict=draw(st.sampled_from(Verdict)),
                confidence=draw(st.one_of(_floats(0.0, 1.0), _any_finite())),
                face=draw(_face_boxes()),
            )
        case "speak":
            if draw(st.booleans(), label="speak line"):
                line_ids = [line.id for line in lines] + [UNKNOWN_LINE_ID]
                ev = Speak(ref_id=ref_id, line_id=draw(st.sampled_from(line_ids)), audio_url=None)
            else:
                ev = Speak(ref_id=ref_id, line_id=None, audio_url=FAKE_AUDIO_URL)
        case "gaze":
            ev = Gaze(ref_id=ref_id, pan_deg=draw(_any_finite()), tilt_deg=draw(_any_finite()))
        case "lantern":
            ev = Lantern(
                ref_id=ref_id,
                level=draw(st.one_of(_floats(0.0, 1.0), _any_finite())),
                fade_ms=draw(st.integers(-(10**6), 10**6)),
            )
        case _:
            ev = ModeSet(ref_id=ref_id, mode=draw(st.sampled_from(Mode)))
    event(f"fresh event: {kind}")
    uid = str(uuid.UUID(int=_FRESH_UID_BASE + 2 * serial + 1, version=4))
    return dataclasses.replace(ev, rand=draw(rands(), label="fresh rand"), uid=uid)


# --------------------------------------------------------------------------------------------
# The check
# --------------------------------------------------------------------------------------------


def check_twice(
    ms: MachineState,
    ev: Event,
    now: float,
    expected: tuple[MachineState, tuple[object, ...]] | None = None,
) -> None:
    """Step `ms` twice with the same arguments; results agree and `ms` is not changed."""
    before = copy.deepcopy(ms)
    assert before == ms, "a deep copy of the Machine_State must compare equal to it"
    first = step(ms, ev, now)
    second = step(ms, ev, now)
    assert ms == before, f"step() changed its Machine_State for {ev!r} at {now!r}"
    assert first[0] == second[0], f"two step() calls returned different states for {ev!r}"
    assert first[1] == second[1], (
        f"two step() calls returned different actions for {ev!r}: {first[1]!r} != {second[1]!r}"
    )
    if expected is not None:
        assert first[0] == expected[0], f"replay of {ev!r} at {now!r} gave a different state"
        assert first[1] == expected[1], (
            f"replay of {ev!r} at {now!r} gave {first[1]!r}, the trace has {expected[1]!r}"
        )


def per_state_indices(
    data: st.DataObject, states: Sequence[State], extra_max: int, label: str
) -> list[int]:
    """One index per distinct State in `states`, plus up to `extra_max` random indices.

    Most records of a trace are Ticks in `sleeping` or `cooldown`; sampling per State keeps
    the rarer States (gazing, greeting, warning) in every example that reaches them.
    """
    by_state: dict[State, list[int]] = {}
    for i, state in enumerate(states):
        by_state.setdefault(state, []).append(i)
    chosen = [
        data.draw(st.sampled_from(idx), label=f"{label} {state.value}")
        for state, idx in by_state.items()
    ]
    if states:
        extra = st.lists(st.integers(0, len(states) - 1), max_size=extra_max)
        chosen.extend(data.draw(extra, label=f"{label} extra"))
    return chosen


# Feature: device-core-loop, Property 9: Determinism
@pytest.mark.timeout(600)
@settings(deadline=None)
@given(data=st.data())
def test_step_is_deterministic(data: st.DataObject) -> None:
    """Replayed and fresh `step()` calls on reachable states agree and mutate nothing.

    **Validates: Requirements 1.1, 1.2, 29.11**
    """
    cfg = data.draw(valid_configs(), label="cfg")
    lines = data.draw(line_sets(require=tuple(Category)), label="lines")
    # Two thirds `every_state`: the plain harness rarely gets past `seeking`.
    world = data.draw(st.sampled_from(("every_state", "every_state", "plain")), label="world")
    event(f"world: {world}")
    if world == "plain":
        trace = run_reactive(data, cfg, lines, tick_gap_max=None, budget=PLAIN_BUDGET)
    else:
        trace = _EveryStateWorld(data, cfg, lines).run(WORLD_BUDGET)
    note(f"trace of {len(trace)} records")

    # Replay recorded steps.
    replays = per_state_indices(
        data, [rec.before.state for rec in trace], EXTRA_REPLAYS_MAX, "replay"
    )
    for i in replays:
        rec = trace[i]
        event(f"replayed state: {rec.before.state.value}")
        check_twice(rec.before, rec.event, rec.now, expected=(rec.after, rec.actions))

    # Fresh Events on the initial state and on sampled `after` states.
    start = initial_state(
        config=cfg, lines=lines, agent_version=AGENT_VERSION, start_time=START_TIME
    )
    candidates: list[tuple[MachineState, float, int]] = [(start, START_TIME, 0)]
    picks = per_state_indices(
        data, [rec.after.state for rec in trace], EXTRA_FRESH_STATES_MAX, "fresh"
    )
    candidates.extend((trace[i].after, trace[i].now, i + 1) for i in picks)
    gap = _floats(0.0, 2 * cfg.encounter_bound_s)
    serial = 0
    for ms, produced_at, prefix in candidates:
        ids = issued_ids(trace[:prefix])
        event(f"fresh state: {ms.state.value}")
        for _ in range(data.draw(st.integers(1, FRESH_EVENTS_MAX), label="fresh count")):
            ev = draw_fresh_event(data, ms, ids, lines, serial)
            serial += 1
            now = produced_at + data.draw(st.one_of(st.just(0.0), gap), label="fresh gap")
            check_twice(ms, ev, now)
