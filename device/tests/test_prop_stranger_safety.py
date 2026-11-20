"""Property 3: Stranger-warning safety (design "Correctness Properties").

For every Encounter of a trace:

- If its Accepted_Verdict is `family`, it contains no `PlayLine` of a `stranger` Voice_Line
  (from a Reaction or a `speak` command) and no `reaction.performed` with `kind: "stranger"`
  (R7.9, R13.4).
- Every `reaction.performed` with `kind: "family"` or `kind: "stranger"` follows, in the same
  Encounter, a Verdict of that kind with `confidence` at or above `family_confidence_min` or
  `stranger_confidence_min` (R4.1 to R4.4, R4.6).
- It contains at most one `reaction.performed` (R7.8).
- Nothing is audible during the stare: while the State is `warning` and `now` is before entry
  + `stare_s`, no `PlayLine`, `PlayAudioUrl` or `reaction.performed` is emitted, and no
  `PlayLine` or `PlayAudioUrl` comes in `warning` before the stranger line starts (R7.3,
  R13.5).

The oracle reads the trace only. The Accepted_Verdict is not on the wire, so it is rebuilt
from the inputs: a `judgement.result` counts as a Verdict when it arrives in `seeking` for the
Current_Snapshot_Id (the snapshot of the attempt in the `before` state) and is the first one
for that Snapshot_Id (R3.3, R3.4, R6.6). The thresholds come from the Config.

`run_reactive` rarely answers the current snapshot, so `_VerdictWorld` below keeps the cloud
connected and answers the current snapshot with Verdicts of every kind. Confidences sit on the
two thresholds (exact, one ulp and 1e-12 either side) and face boxes are present or absent.
`speak` commands, mostly naming `stranger` lines, come often during the stare and the family
greeting. Stale feedback, repeated `pir.rising` and `mode.set` add noise.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import pytest
from hypothesis import event, given, note, settings
from hypothesis import strategies as st

from tests.harness import (
    FAKE_AUDIO_URL,
    FAKE_JPEG,
    START_TIME,
    UNKNOWN_LINE_ID,
    EncounterSlice,
    Record,
    Trace,
    _Driver,
    fixed_one_of,
    split_by_encounter,
)
from tests.strategies import line_sets, valid_configs
from warashi_agent.config import Config
from warashi_agent.messages import ReactionPerformed
from warashi_agent.model import (
    Category,
    CloudConnected,
    FaceBox,
    JudgementResult,
    Mode,
    ModeSet,
    PirRising,
    PlayAudioUrl,
    PlayLine,
    PublishEvent,
    SnapshotFailed,
    SnapshotReady,
    Speak,
    State,
    Tick,
    Verdict,
)
from warashi_agent.voice import VoiceLine

TOL = 1e-9  # time comparisons (R29.2)
WORLD_BUDGET = 60
WORLD_EVENTS_MIN = 10  # fewer drawn Events rarely get past waking
TAIL_TICK_MIN_S = 1.0  # tail Ticks are coarse: Property 3 needs no Tick spacing
TAIL_STEPS_MAX = 1000


# --------------------------------------------------------------------------------------------
# Oracle helpers
# --------------------------------------------------------------------------------------------


def threshold_values(threshold: float) -> tuple[float, ...]:
    """The threshold itself, one ulp and 1e-12 below and above it."""
    return (
        threshold,
        math.nextafter(threshold, -math.inf),
        math.nextafter(threshold, math.inf),
        threshold - 1e-12,
        threshold + 1e-12,
    )


def accepted_kind(verdict: JudgementResult, cfg: Config) -> Verdict:
    """The Accepted_Verdict of one Verdict, from the R4 thresholds."""
    judgement = cfg.judgement
    if verdict.verdict is Verdict.FAMILY:
        ok = verdict.confidence >= judgement.family_confidence_min
        return Verdict.FAMILY if ok else Verdict.UNCERTAIN
    if verdict.verdict is Verdict.STRANGER:
        ok = verdict.confidence >= judgement.stranger_confidence_min
        return Verdict.STRANGER if ok else Verdict.UNCERTAIN
    return verdict.verdict


def _current_snapshot_id(rec: Record) -> str | None:
    enc = rec.before.encounter
    if enc is None or enc.attempt is None:
        return None
    return enc.attempt.snapshot_id


def _reactions(rec: Record) -> list[ReactionPerformed]:
    return [
        a.data
        for a in rec.actions
        if isinstance(a, PublishEvent) and isinstance(a.data, ReactionPerformed)
    ]


def _audio(rec: Record) -> list[PlayLine | PlayAudioUrl]:
    return [a for a in rec.actions if isinstance(a, PlayLine | PlayAudioUrl)]


def check_encounter(part: EncounterSlice, cfg: Config, lines: Sequence[VoiceLine]) -> None:
    """Every clause of Property 3 for one Encounter."""
    by_id = {line.id: line for line in lines}
    judgement = cfg.judgement
    thresholds = {
        Verdict.FAMILY: judgement.family_confidence_min,
        Verdict.STRANGER: judgement.stranger_confidence_min,
    }
    stare_s = cfg.timing.stare_s

    processed: set[str] = set()  # Snapshot_Ids whose Verdict was processed
    accepted: Verdict | None = None  # the Accepted_Verdict once fixed (R4.6)
    qualified: set[Category] = set()  # kinds of Verdicts seen at or above their threshold
    reactions = 0
    stranger_plays: list[str] = []
    stranger_reactions = 0
    warning_entry: float | None = None
    stranger_line_started = False

    for rec in part.records:
        ev = rec.event

        # Verdicts, from the inputs (R3.3, R3.4, R4).
        if isinstance(ev, JudgementResult):
            if processed:
                event("judgement.result after a processed Verdict")
            current = _current_snapshot_id(rec)
            if (
                rec.before.state is State.SEEKING
                and current == ev.snapshot_id
                and ev.snapshot_id not in processed
            ):
                processed.add(ev.snapshot_id)
                kind = accepted_kind(ev, cfg)
                if accepted is None and kind is not Verdict.NO_FACE:
                    accepted = kind
                if kind in (Verdict.FAMILY, Verdict.STRANGER):
                    qualified.add(Category(kind.value))
                if ev.verdict in thresholds and ev.confidence in threshold_values(
                    thresholds[ev.verdict]
                ):
                    event(f"boundary Verdict: {ev.verdict.value} -> {kind.value}")

        # Stare tracking (R7.3, R7.4).
        if rec.after.state is State.WARNING and rec.before.state is not State.WARNING:
            warning_entry = rec.now
        in_warning = State.WARNING in (rec.before.state, rec.after.state)
        reacts = _reactions(rec)
        audio = _audio(rec)
        if in_warning and warning_entry is not None and not stranger_line_started:
            during_stare = rec.now < warning_entry + stare_s - TOL
            if isinstance(ev, Speak) and during_stare:
                event("speak during the stare")
            if during_stare:
                assert not audio, f"audio during the stare at {rec.now!r}: {audio!r}"
                assert not reacts, f"reaction.performed during the stare at {rec.now!r}"
            elif audio or reacts:
                assert reacts and all(r.kind is Category.STRANGER for r in reacts), (
                    f"audio in warning before the stranger line at {rec.now!r}: {audio!r}"
                )
                stranger_line_started = True
        if isinstance(ev, Speak) and rec.before.state is State.GREETING:
            event("speak during the family greeting")

        # Reactions (R4, R7.8).
        for react in reacts:
            reactions += 1
            event(f"reaction: {react.kind.value}, offline={react.offline}")
            if react.kind in (Category.FAMILY, Category.STRANGER):
                assert react.kind in qualified, (
                    f"reaction.performed {react.kind.value} without a Verdict of that kind at"
                    f" or above its threshold (qualified: {sorted(qualified)})"
                )
            if react.kind is Category.STRANGER:
                stranger_reactions += 1

        for play in audio:
            if isinstance(play, PlayLine):
                assert play.line_id in by_id, f"PlayLine of an unknown line {play.line_id!r}"
                if by_id[play.line_id].category is Category.STRANGER:
                    stranger_plays.append(play.line_id)

    note(f"encounter {part.encounter_id}: accepted={accepted}, reactions={reactions}")
    event(f"Accepted_Verdict: {accepted.value if accepted else None}")
    assert reactions <= 1, f"{reactions} reaction.performed events in one Encounter"
    if accepted is Verdict.FAMILY:
        assert not stranger_plays, f"stranger lines {stranger_plays} in a family Encounter"
        assert stranger_reactions == 0, "reaction.performed stranger in a family Encounter"


def check_trace(trace: Sequence[Record], cfg: Config, lines: Sequence[VoiceLine]) -> None:
    for part in split_by_encounter(trace):
        check_encounter(part, cfg, lines)


# --------------------------------------------------------------------------------------------
# Driver: a connected cloud that answers the current snapshot
# --------------------------------------------------------------------------------------------

_VERDICTS = (
    Verdict.FAMILY,
    Verdict.STRANGER,
    Verdict.FAMILY,
    Verdict.STRANGER,
    Verdict.FAMILY,
    Verdict.NO_FACE,
    Verdict.UNCERTAIN,
)
# `mode.set` values: `sleep` ends the Encounter before any Verdict, so it stays rare.
_MODES = (Mode.GUARD, Mode.GUARD, Mode.GUARD, Mode.SLEEP)
# `speak` kinds: mostly stranger lines, then the other Categories, unknown ids and audioUrls.
_SPEAK_KINDS = ("stranger",) * 5 + ("family", "uncertain", "unknown", "url")


def _unit_floats() -> st.SearchStrategy[float]:
    return st.floats(min_value=0.0, max_value=1.0, allow_nan=False)


class _VerdictWorld(_Driver):
    """One connected cloud, Encounters after warm-up, Verdicts for the current snapshot.

    It reuses the harness bookkeeping (stamping, pending feedback, stale ids) and only
    replaces the choice of the next Event. `speak` gets most of the weight in `warning` and
    `greeting`, and `judgement.result` most of it in `seeking`.
    """

    def __init__(self, data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...]) -> None:
        super().__init__(data, cfg, lines, tick_gap_max=None)
        self.ids_by_category = {
            c: [line.id for line in lines if line.category is c] for c in Category
        }
        judgement = cfg.judgement
        family = threshold_values(judgement.family_confidence_min)
        stranger = threshold_values(judgement.stranger_confidence_min)
        # Each verdict kind mostly gets values around its own threshold, sometimes the other's.
        self.boundaries = {
            Verdict.FAMILY: (*family, *family, *stranger, 0.0, 1.0),
            Verdict.STRANGER: (*stranger, *stranger, *family, 0.0, 1.0),
            Verdict.NO_FACE: (*family, *stranger, 0.0, 1.0),
            Verdict.UNCERTAIN: (*family, *stranger, 0.0, 1.0),
        }

    def run(self, budget: int) -> Trace:
        self.feed(CloudConnected(), START_TIME)
        self.feed(PirRising(), START_TIME + self.cfg.timing.pir_warmup_s)
        count = self.data.draw(st.integers(min(WORLD_EVENTS_MIN, budget), budget), label="events")
        for _ in range(count):
            self.draw_world_event()
        self.tail()
        return tuple(self.records)

    # -- drawing -------------------------------------------------------------------------

    def draw_world_event(self) -> None:
        state = self.ms.state
        pending = bool(self.snapshots or self.motions or self.plays)
        weights = {
            "tick": 6,
            "feedback": (12 if state is State.WAKING else 6) if pending else 0,
            "stale": 2,
            "judgement": 16 if state is State.SEEKING else 2,
            "speak": 12 if state in (State.WARNING, State.GREETING) else 4,
            "pir": 2,
            "mode": 1,
        }
        kinds = [k for k, w in weights.items() for _ in range(w)]
        kind = self.data.draw(st.sampled_from(kinds), label="kind")
        gaps = self._seeking_gaps() if state is State.SEEKING else self._gaps()
        at = self.now + self.data.draw(gaps, label="gap")
        match kind:
            case "tick":
                self.feed(Tick(), at)
            case "feedback":
                self._draw_feedback(at)
            case "stale":
                self._draw_stale(at)
            case "judgement":
                self.feed(self._draw_verdict(), at)
            case "speak":
                self.feed(self._draw_speak(), at)
            case "pir":
                self.feed(PirRising(), at)
            case _:
                mode = self.data.draw(st.sampled_from(_MODES), label="mode")
                self.feed(ModeSet(ref_id=self.uids(), mode=mode), at)

    def _gap_branches(self) -> tuple[st.SearchStrategy[float], ...]:
        """Zero, within one Tick, a few Ticks, or up to a quarter of the stare.

        The bounds come from the Config and are often equal (`max(t, stare_s / 4)` is `t`
        whenever `stare_s <= 4t`), so the branches go through `fixed_one_of`, never through
        `st.one_of` (see `fixed_one_of` in the harness for why that makes runs flaky).
        """
        t = self.cfg.tick_s
        return (
            st.just(0.0),
            st.floats(0.0, t),
            st.floats(0.0, 10 * t),
            st.floats(0.0, max(t, self.cfg.timing.stare_s / 4)),
        )

    def _gaps(self) -> st.SearchStrategy[float]:
        return fixed_one_of(*self._gap_branches())

    def _seeking_gaps(self) -> st.SearchStrategy[float]:
        """Mostly inside the attempt deadline, so that Verdicts arrive in time."""
        return fixed_one_of(
            st.just(0.0),
            st.floats(0.0, self.cfg.timing.verdict_timeout_s / 4),
            *self._gap_branches(),
        )

    def _snapshot_result(self, sid: str) -> SnapshotReady | SnapshotFailed:
        """Mostly `snapshot.ready`: a failure ends the attempt before any Verdict (R3.5)."""
        if self.data.draw(st.integers(0, 7), label="snapshot fails") > 0:
            return SnapshotReady(snapshot_id=sid, jpeg=FAKE_JPEG, width=640, height=480)
        code = self.data.draw(st.sampled_from(("camera_failed", "snapshot_too_large")))
        return SnapshotFailed(snapshot_id=sid, code=code)

    def _draw_verdict(self) -> JudgementResult:
        draw = self.data.draw
        candidates = self._snapshot_id_candidates()
        # The Current_Snapshot_Id (first candidate) twice as often as any other id.
        sid = draw(st.sampled_from([candidates[0], *candidates]), label="verdict snapshot")
        verdict = draw(st.sampled_from(_VERDICTS), label="verdict")
        boundaries = st.sampled_from(self.boundaries[verdict])
        # Two thirds on the boundaries. `st.one_of` would drop the repeated branch.
        confidence = draw(fixed_one_of(boundaries, boundaries, _unit_floats()), label="confidence")
        face = draw(
            st.one_of(
                st.none(),
                st.builds(
                    FaceBox,
                    left=_unit_floats(),
                    top=_unit_floats(),
                    width=_unit_floats(),
                    height=_unit_floats(),
                ),
            ),
            label="face",
        )
        return JudgementResult(
            ref_id=self.uids(),
            snapshot_id=sid,
            verdict=verdict,
            confidence=confidence,
            face=face,
        )

    def _draw_speak(self) -> Speak:
        draw = self.data.draw
        kind = draw(st.sampled_from(_SPEAK_KINDS), label="speak kind")
        ref_id = self.uids()
        if kind == "url":
            return Speak(ref_id=ref_id, line_id=None, audio_url=FAKE_AUDIO_URL)
        if kind == "unknown":
            return Speak(ref_id=ref_id, line_id=UNKNOWN_LINE_ID, audio_url=None)
        ids = self.ids_by_category[Category(kind)]
        line_id = draw(st.sampled_from(ids), label="speak line")
        return Speak(ref_id=ref_id, line_id=line_id, audio_url=None)

    # -- tail ----------------------------------------------------------------------------

    def tail(self) -> None:
        """Coarse Ticks until the doll sleeps, so the stare and the reaction lines finish."""
        spacing = max(self.cfg.tick_s, TAIL_TICK_MIN_S)
        steps = 0
        while self.ms.state is not State.SLEEPING and steps < TAIL_STEPS_MAX:
            self._step(Tick(), max(self.now, self.last_tick + spacing))
            steps += 1


def _all_categories() -> st.SearchStrategy[tuple[VoiceLine, ...]]:
    return line_sets(require=tuple(Category))


# --------------------------------------------------------------------------------------------
# The Property 3 test
# --------------------------------------------------------------------------------------------


# Feature: device-core-loop, Property 3: Stranger-warning safety
@pytest.mark.timeout(600)
@settings(deadline=None)
@given(data=st.data())
def test_stranger_warning_safety(data: st.DataObject) -> None:
    """Verdicts on the thresholds and stranger `speak`s during the stare and the greeting.

    **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.6, 7.3, 7.8, 7.9, 13.4, 13.5, 29.5**
    """
    cfg = data.draw(valid_configs(), label="cfg")
    lines = data.draw(_all_categories(), label="lines")
    trace = _VerdictWorld(data, cfg, lines).run(WORLD_BUDGET)
    check_trace(trace, cfg, lines)
