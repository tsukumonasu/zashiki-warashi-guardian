"""Property 19: Line choice (design "Correctness Properties", R1.3, R7.1, R7.4, R7.5).

The doll must not repeat itself predictably, yet ``step()`` must stay deterministic, so the
random value of a line choice comes from the Event (R1.3). This file checks two things:

- ``choose_line`` returns ``None`` exactly when the Category has no line, and otherwise the
  line at index ``floor(rand × n)`` of the Category's lines sorted by ``id`` in code-point
  order. The oracle computes the floor exactly with ``fractions.Fraction``, so a
  floating-point product that rounds up to the next integer is caught.
- Every Reaction ``PlayLine`` that ``step()`` emits names the oracle's line for the
  ``rand`` of the Event of that call, and ``reaction.performed`` carries the same ``lineId``
  (``null`` when the Category is empty).

The second test reaches each Reaction through the public ``step()`` API only: a scripted
Encounter (cloud connected, ``pir.rising``, the waking arrival, a Verdict, and where needed
the gazing arrival or deadline, scan moves and the end of the stare) whose every Event gets
its own drawn ``rand``. It does not use ``run_reactive``: until task 14.1 implements the
offline branch of ``waking``, random traces reach a Reaction too rarely to test this.

Rands are drawn from ``rands()`` and from a boundary generator that sits within a few ulps
of ``k / n`` for the pool sizes of the drawn lines.
"""

from __future__ import annotations

import dataclasses
import math
from fractions import Fraction

from hypothesis import example, given
from hypothesis import strategies as st

from tests.strategies import (
    RAND_EDGES,
    UidCounter,
    line_sets,
    rands,
    valid_configs,
)
from warashi_agent.config import Config
from warashi_agent.messages import ReactionPerformed
from warashi_agent.model import (
    Action,
    Category,
    CloudConnected,
    Event,
    FaceBox,
    GazeTarget,
    JudgementResult,
    PirRising,
    PlayLine,
    PublishEvent,
    ServoArrived,
    State,
    TakeSnapshot,
    Tick,
    Verdict,
)
from warashi_agent.state_machine import MachineState, initial_state, step
from warashi_agent.voice import VoiceLine, choose_line

AGENT_VERSION = "0.0.0-test"
START_TIME = 0.0
ULPS_AROUND_BOUNDARY = 3

REACTION_STATE = {
    Category.FAMILY: State.GREETING,
    Category.STRANGER: State.WARNING,
    Category.UNCERTAIN: State.UNCERTAIN,
}


# --------------------------------------------------------------------------------------------
# Oracle, written from R1.3 only
# --------------------------------------------------------------------------------------------


def expected_line(
    lines: tuple[VoiceLine, ...], category: Category, rand: float
) -> VoiceLine | None:
    """The R1.3 choice: index ``floor(rand × n)`` with exact rational arithmetic.

    The pool is sorted by the list of code points of each id, which states the code-point
    order explicitly instead of relying on how ``str`` compares.
    """
    pool = sorted(
        (line for line in lines if line.category is category),
        key=lambda line: [ord(ch) for ch in line.id],
    )
    if not pool:
        return None
    index = math.floor(Fraction(rand) * len(pool))
    assert 0 <= index < len(pool), "rand in [0, 1) must give an index inside the pool"
    return pool[index]


# --------------------------------------------------------------------------------------------
# Generators
# --------------------------------------------------------------------------------------------


@st.composite
def _boundary_rands(draw: st.DrawFn, sizes: tuple[int, ...]) -> float:
    """A float within a few ulps of ``k / n`` for a pool size ``n`` in ``sizes``.

    ``floor(rand × n)`` changes value at ``k / n``, and the float ``k / n`` itself may lie just
    below the exact fraction (``1 / 3`` does), so the exact float is drawn most often.
    """
    n = draw(st.sampled_from(sizes))
    k = draw(st.integers(1, n - 1))
    value = k / n
    offset = draw(st.one_of(st.just(0), st.integers(-ULPS_AROUND_BOUNDARY, ULPS_AROUND_BOUNDARY)))
    toward = 0.0 if offset < 0 else 1.0
    for _ in range(abs(offset)):
        value = math.nextafter(value, toward)
    return value


def _choice_rands(lines: tuple[VoiceLine, ...]) -> st.SearchStrategy[float]:
    """``rands()``, or a boundary of one of the pools of ``lines`` with two or more lines."""
    counts = (sum(line.category is c for line in lines) for c in Category)
    sizes = tuple(sorted({n for n in counts if n >= 2}))
    if not sizes:
        return rands()
    return st.one_of(rands(), _boundary_rands(sizes))


@st.composite
def _choice_cases(draw: st.DrawFn) -> tuple[tuple[VoiceLine, ...], Category, float]:
    """Lines in any order, a Category and a rand aimed at the pool boundaries of ``lines``."""
    lines = draw(_shuffled_line_sets())
    return lines, draw(st.sampled_from(Category)), draw(_choice_rands(lines))


def _shuffled_line_sets() -> st.SearchStrategy[tuple[VoiceLine, ...]]:
    """Available_Lines in any order: ``choose_line`` must not rely on the caller's sort."""
    return line_sets().flatmap(st.permutations).map(tuple)


def _line(line_id: str, category: Category) -> VoiceLine:
    return VoiceLine(
        id=line_id, category=category, ja="おかえり。", en="Welcome home.", wav=f"{line_id}.wav"
    )


# "a1" < "a_1" < "b" in code-point order ('1' is U+0031, '_' is U+005F).
_THREE_FAMILY_LINES = (
    _line("b", Category.FAMILY),
    _line("a_1", Category.FAMILY),
    _line("a1", Category.FAMILY),
)
_ONE_LINE_EACH = tuple(_line(f"{c.value[0]}0", c) for c in Category)


# --------------------------------------------------------------------------------------------
# Clause 1: choose_line itself
# --------------------------------------------------------------------------------------------


# Feature: device-core-loop, Property 19: Line choice
@given(case=_choice_cases())
@example(case=((), Category.FAMILY, 0.0))
@example(case=(_ONE_LINE_EACH, Category.STRANGER, RAND_EDGES[1]))
@example(case=(_THREE_FAMILY_LINES, Category.FAMILY, RAND_EDGES[0]))
@example(case=(_THREE_FAMILY_LINES, Category.FAMILY, RAND_EDGES[1]))
@example(case=(_THREE_FAMILY_LINES, Category.FAMILY, 1 / 3))
@example(case=(_THREE_FAMILY_LINES, Category.FAMILY, 2 / 3))
@example(case=(_THREE_FAMILY_LINES, Category.STRANGER, 0.5))
def test_choose_line_picks_the_exact_floor_index(
    case: tuple[tuple[VoiceLine, ...], Category, float],
) -> None:
    """**Validates: Requirements 1.3, 7.1, 7.4, 7.5**"""
    lines, category, rand = case
    expected = expected_line(lines, category, rand)
    chosen = choose_line(lines, category, rand)
    if expected is None:
        assert chosen is None
    else:
        assert chosen is not None
        assert chosen.id == expected.id, (
            f"rand={rand.hex()} n={sum(line.category is category for line in lines)}: "
            f"chose {chosen.id!r}, R1.3 picks {expected.id!r}"
        )
        assert chosen == expected


# --------------------------------------------------------------------------------------------
# Clause 2: Reaction PlayLines emitted by step()
# --------------------------------------------------------------------------------------------


class _Script:
    """Steps a scripted Encounter through ``step()``, stamping each Event like the Dispatcher.

    Every Event gets a fresh uid and its own drawn ``rand``, so the property can tell which
    call's ``rand`` the Reaction used.
    """

    def __init__(self, data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...]) -> None:
        self.data = data
        self.cfg = cfg
        self.uids = UidCounter()
        self.rands = _choice_rands(lines)
        self.ms: MachineState = initial_state(
            config=cfg, lines=lines, agent_version=AGENT_VERSION, start_time=START_TIME
        )
        self.now = START_TIME
        self.records: list[tuple[Event, tuple[Action, ...]]] = []

    def feed(self, event: Event, at: float | None = None) -> tuple[Action, ...]:
        if at is not None:
            assert at >= self.now, "now must never decrease"
            self.now = at
        rand = self.data.draw(self.rands, label="rand")
        stamped = dataclasses.replace(event, rand=rand, uid=self.uids())
        self.ms, actions = step(self.ms, stamped, self.now)
        self.records.append((stamped, actions))
        return actions

    def judge(
        self, snapshot_id: str, verdict: Verdict, confidence: float, face: FaceBox | None
    ) -> tuple[Action, ...]:
        """Step a ``judgement.result`` as the inbound pipeline would build it."""
        event = JudgementResult(
            ref_id=self.uids(),
            snapshot_id=snapshot_id,
            verdict=verdict,
            confidence=confidence,
            face=face,
        )
        return self.feed(event)


def _last[T](actions: tuple[Action, ...], cls: type[T]) -> T:
    found = [a for a in actions if isinstance(a, cls)]
    assert found, f"expected a {cls.__name__} in {actions!r}"
    return found[-1]


def _face_boxes() -> st.SearchStrategy[FaceBox]:
    unit = st.floats(min_value=0.0, max_value=1.0, allow_nan=False)
    return st.builds(FaceBox, left=unit, top=unit, width=unit, height=unit)


def _run_to_seeking(script: _Script) -> str:
    """Cloud connected, presence, waking arrival with the fade-in over; returns the snapshot id."""
    cfg = script.cfg
    script.feed(CloudConnected(), START_TIME)
    pir_at = START_TIME + cfg.timing.pir_warmup_s
    wake = _last(script.feed(PirRising(), pir_at), GazeTarget)
    arrive_at = pir_at + cfg.lantern.lantern_fade_in_ms / 1000
    snap = _last(script.feed(ServoArrived(motion_id=wake.motion_id), arrive_at), TakeSnapshot)
    assert script.ms.state is State.SEEKING
    return snap.snapshot_id


def _react_with_face_verdict(script: _Script, kind: Category, snapshot_id: str) -> None:
    """``family`` or ``stranger`` with full confidence, directly or through ``gazing``."""
    data, cfg = script.data, script.cfg
    verdict = Verdict(kind.value)
    route = data.draw(st.sampled_from(("no_face_box", "gaze_arrived", "gaze_timeout")))
    if route == "no_face_box":
        script.judge(snapshot_id, verdict, 1.0, None)  # R5.5
    else:
        gaze_at = script.now
        motion = _last(
            script.judge(snapshot_id, verdict, 1.0, data.draw(_face_boxes())), GazeTarget
        )
        assert script.ms.state is State.GAZING
        if route == "gaze_arrived":
            script.feed(ServoArrived(motion_id=motion.motion_id))
        else:
            script.feed(Tick(), gaze_at + cfg.timing.glide_timeout_s)
    if kind is Category.STRANGER:
        # The silent stare: a Tick halfway through, then the first Tick at or after its end.
        stare_from = script.now
        script.feed(Tick(), stare_from + cfg.timing.stare_s / 2)
        late = data.draw(st.sampled_from((0.0, cfg.tick_s)), label="tick lateness")
        script.feed(Tick(), stare_from + cfg.timing.stare_s + late)


def _react_uncertain(script: _Script, snapshot_id: str) -> None:
    """``uncertain`` through each Verdict path: uncertain, low confidence, or no face left."""
    data, cfg = script.data, script.cfg
    route = data.draw(st.sampled_from(("uncertain", "low_confidence", "no_face")))
    if route == "uncertain":
        confidence = data.draw(st.floats(min_value=0.0, max_value=1.0), label="confidence")
        script.judge(snapshot_id, Verdict.UNCERTAIN, confidence, None)
    elif route == "low_confidence":
        # Every threshold is > 0 (R25), so 0.0 is always below it (R4.3).
        verdict = data.draw(st.sampled_from((Verdict.FAMILY, Verdict.STRANGER)))
        script.judge(snapshot_id, verdict, 0.0, None)
    else:
        for _ in range(cfg.camera.scan_attempts_max):
            scan = _last(script.judge(snapshot_id, Verdict.NO_FACE, 0.0, None), GazeTarget)
            arrived = script.feed(ServoArrived(motion_id=scan.motion_id))
            snapshot_id = _last(arrived, TakeSnapshot).snapshot_id
        script.judge(snapshot_id, Verdict.NO_FACE, 0.0, None)


# Feature: device-core-loop, Property 19: Line choice
@given(
    data=st.data(),
    cfg=valid_configs(),
    lines=_shuffled_line_sets(),
    kind=st.sampled_from(Category),
)
def test_reaction_play_line_uses_the_rand_of_its_event(
    data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...], kind: Category
) -> None:
    """**Validates: Requirements 1.3, 7.1, 7.4, 7.5**"""
    script = _Script(data, cfg, lines)
    snapshot_id = _run_to_seeking(script)
    if kind is Category.UNCERTAIN:
        _react_uncertain(script, snapshot_id)
    else:
        _react_with_face_verdict(script, kind, snapshot_id)

    # The script must actually reach the Reaction, or the property would hold vacuously.
    assert script.ms.state is REACTION_STATE[kind]
    reactions = [
        (event, a.data)
        for event, actions in script.records
        for a in actions
        if isinstance(a, PublishEvent) and isinstance(a.data, ReactionPerformed)
    ]
    assert len(reactions) == 1, f"expected one reaction.performed, got {reactions!r}"
    assert reactions[0][1].kind is kind

    for event, actions in script.records:
        plays = [a.line_id for a in actions if isinstance(a, PlayLine)]
        performed = [
            a.data
            for a in actions
            if isinstance(a, PublishEvent) and isinstance(a.data, ReactionPerformed)
        ]
        if not performed:
            # No speak command is sent, so only the Reaction call may play a line.
            assert plays == [], f"{type(event).__name__} played {plays!r} outside the Reaction"
            continue
        expected = expected_line(lines, performed[0].kind, event.rand)
        expected_id = expected.id if expected is not None else None
        assert performed[0].line_id == expected_id, (
            f"rand={event.rand.hex()}: reaction.performed names {performed[0].line_id!r}, "
            f"R1.3 picks {expected_id!r}"
        )
        assert plays == ([expected_id] if expected_id is not None else [])
