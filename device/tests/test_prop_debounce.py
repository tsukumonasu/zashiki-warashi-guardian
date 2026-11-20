"""Property 6: PIR debounce (design "Correctness Properties", R2.1, R11, R12.9, R29.8).

The HC-SR501 output stays high for seconds and retriggers, so the doll sees storms of PIR
edges. Whatever the edges, this file checks against the trace of ``step()`` calls that:

- each Encounter has at most one ``reaction.performed`` and at most one ``presence.detected``;
- every ``presence.detected`` is emitted in the call of a ``pir.rising`` that arrived in
  ``sleeping``, with Mode ``guard``, and with ``now - Start_Time >= pir_warmup_s``;
- the ``now`` values of consecutive ``presence.detected`` are at least ``cooldown_s`` apart;
- no Encounter starts in a call that enters ``sleeping``.

The oracle reads only the trace: the ``before`` State, Mode and Start_Time of each call, the
Event type, and the ``presence.detected``, ``reaction.performed`` and ``state.changed`` events
the call publishes. Mode is taken from ``before``, so the oracle stays right once ``mode.set``
changes the Mode (task 16.1).

Generators. ``run_debounce`` reuses the reactive harness driver (adapter feedback, stale
feedback, cloud and command noise) without forced Ticks, and biases the Event menu:

- PIR edge storms before the warm-up ends, including an edge just before its end;
- a guaranteed Encounter: a ``pir.rising`` at or just after the end of the warm-up, so no
  example is vacuous;
- storms of rising and falling edges close together, often at equal ``now``;
- edges around the end of ``cooldown``, and a PIR that goes high in ``cooldown`` and stays
  high while ``cooldown`` ends;
- ``mode.set`` toggles;
- a short tail of coarse Ticks, optionally with the PIR held high, so most Encounters run
  through ``cooldown`` back to ``sleeping``.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from hypothesis import event, given, settings
from hypothesis import strategies as st

from tests.harness import (
    START_TIME,
    Record,
    Trace,
    _Driver,
    _floats,
    split_by_encounter,
)
from tests.strategies import line_sets, valid_configs
from warashi_agent.config import Config
from warashi_agent.messages import PresenceDetected, ReactionPerformed, StateChanged
from warashi_agent.model import (
    CloudConnected,
    Event,
    Mode,
    ModeSet,
    PirFalling,
    PirRising,
    PublishEvent,
    State,
    Tick,
)
from warashi_agent.state_machine import MachineState
from warashi_agent.voice import VoiceLine

TOL = 1e-9
BUDGET = 20
STORM_EDGES_MAX = 6
PRE_WARMUP_STORMS_MAX = 2
TAIL_TICKS_MAX = 200
TAIL_STEPS_PER_BOUND = 64  # tail Tick spacing is Encounter_Bound / this (or T if larger)

# Relative weights of the biased draw kinds.
_KINDS = (
    ("harness", 4),
    ("storm", 3),
    ("cooldown", 3),
    ("mode", 1),
)


# --------------------------------------------------------------------------------------------
# Generators
# --------------------------------------------------------------------------------------------


class _DebounceDriver(_Driver):
    """The harness driver with an Event menu weighted toward PIR edges."""

    def __init__(self, data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...]) -> None:
        # No forced Ticks: the warm-up can last 120 s, and debounce needs no Tick bound.
        super().__init__(data, cfg, lines, tick_gap_max=None)

    def _close_gaps(self) -> st.SearchStrategy[float]:
        """Gaps inside a storm: equal now, a hair apart, or within one Tick."""
        return st.one_of(st.sampled_from((0.0, 1e-6)), _floats(0.0, self.cfg.tick_s))

    def _edge(self) -> Event:
        return self.data.draw(st.sampled_from((PirRising(), PirFalling())), label="edge")

    def storm(self) -> None:
        """Several rising and falling edges close together."""
        count = self.data.draw(st.integers(2, STORM_EDGES_MAX), label="storm edges")
        for _ in range(count):
            self.feed(self._edge(), self.now + self.data.draw(self._close_gaps(), label="gap"))

    def pre_warmup(self) -> None:
        """Edge storms before the warm-up ends; none of them may start an Encounter."""
        warm = START_TIME + self.cfg.timing.pir_warmup_s
        if warm <= START_TIME:
            return
        times = self.data.draw(
            st.lists(
                st.one_of(
                    st.just(max(START_TIME, warm - 1e-6)),
                    _floats(START_TIME, warm).filter(lambda t: t < warm),
                ),
                max_size=PRE_WARMUP_STORMS_MAX,
            ),
            label="pre-warmup storms",
        )
        for at in sorted(times):
            self.feed(self._edge(), at)
            for _ in range(self.data.draw(st.integers(0, 3), label="pre-warmup edges")):
                gap = self.data.draw(st.sampled_from((0.0, 1e-9)), label="gap")
                if self.now + gap < warm:
                    self.feed(self._edge(), self.now + gap)

    def first_encounter(self) -> None:
        """A pir.rising at or just after the warm-up end, with the PIR low before it."""
        warm = START_TIME + self.cfg.timing.pir_warmup_s
        if self.data.draw(st.booleans(), label="tick at warm-up end"):
            self.feed(Tick(), warm)
        late = self.data.draw(
            st.one_of(st.just(0.0), _floats(0.0, self.cfg.tick_s)), label="first pir"
        )
        if self.ms.pir_high:
            self.feed(PirFalling(), warm + late)
        self.feed(PirRising(), warm + late)

    def cooldown_edges(self) -> None:
        """Edges around the end of cooldown, or the PIR held high across it.

        An active Encounter is first run forward with coarse Ticks until it reaches
        cooldown, so that edges near the end of cooldown and later Encounters are common.
        """
        if self.ms.encounter is not None:
            self._coarse_ticks(lambda: self.ms.state in (State.COOLDOWN, State.SLEEPING))
        if self.ms.state is not State.COOLDOWN:
            self.storm()
            return
        until: float = self.ms.phase.until  # type: ignore[attr-defined]
        t = self.cfg.tick_s
        near = st.sampled_from((-t, -1e-6, 0.0, 1e-6, t)).map(lambda d: until + d)
        if self.data.draw(st.booleans(), label="hold across cooldown end"):
            # High inside cooldown, then Ticks across its end with no falling edge.
            if not self.ms.pir_high:
                self.feed(PirRising(), self.data.draw(_floats(self.now, max(self.now, until))))
            ticks = self.data.draw(st.lists(near, min_size=1, max_size=4), label="hold ticks")
            for at in sorted(ticks):
                self.feed(Tick(), at)
            event("held high across cooldown end")
            return
        steps = self.data.draw(
            st.lists(
                st.tuples(near, st.sampled_from(("rising", "falling", "tick"))),
                min_size=1,
                max_size=5,
            ),
            label="cooldown-end edges",
        )
        for at, kind in sorted(steps, key=lambda s: s[0]):
            ev: Event = {"rising": PirRising(), "falling": PirFalling(), "tick": Tick()}[kind]
            self.feed(ev, at)

    def toggle_mode(self) -> None:
        mode = self.data.draw(st.sampled_from(Mode), label="mode")
        self.feed(ModeSet(ref_id=self.uids(), mode=mode), self.now)

    def draw_biased(self) -> None:
        kinds = [k for k, w in _KINDS for _ in range(w)]
        match self.data.draw(st.sampled_from(kinds), label="biased kind"):
            case "harness":
                self.draw_one()
            case "storm":
                self.storm()
            case "cooldown":
                self.cooldown_edges()
            case _:
                self.toggle_mode()

    def coarse_tail(self) -> None:
        """Coarse Ticks until the doll sleeps again, bounded by TAIL_TICKS_MAX."""
        if self.data.draw(st.booleans(), label="hold pir in tail") and not self.ms.pir_high:
            self.feed(PirRising(), self.now)
        self._coarse_ticks(lambda: self.ms.state is State.SLEEPING and self.ms.encounter is None)

    def _coarse_ticks(self, done: Callable[[], bool]) -> None:
        """Ticks Encounter_Bound / TAIL_STEPS_PER_BOUND apart until `done()`, at most a cap."""
        spacing = max(self.cfg.tick_s, self.cfg.encounter_bound_s / TAIL_STEPS_PER_BOUND)
        for _ in range(TAIL_TICKS_MAX):
            if done():
                return
            self.feed(Tick(), self.now + spacing)


def run_debounce(data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...]) -> Trace:
    """A trace weighted toward PIR edges, with at least one Encounter after the warm-up."""
    driver = _DebounceDriver(data, cfg, lines)
    if data.draw(st.booleans(), label="connected at start"):
        driver.feed(CloudConnected(), START_TIME)
    driver.pre_warmup()
    driver.first_encounter()
    for _ in range(data.draw(st.integers(0, BUDGET), label="drawn kinds")):
        driver.draw_biased()
    driver.coarse_tail()
    return tuple(driver.records)


# --------------------------------------------------------------------------------------------
# Oracle, written from R2.1, R11, R12.9 and R29.8
# --------------------------------------------------------------------------------------------


def _published(rec: Record, kind: type) -> list:
    return [
        a.data for a in rec.actions if isinstance(a, PublishEvent) and isinstance(a.data, kind)
    ]


def _encounter_id(ms: MachineState) -> str | None:
    return ms.encounter.encounter_id if ms.encounter is not None else None


def _enters_sleeping(rec: Record) -> bool:
    by_state = rec.before.state is not State.SLEEPING and rec.after.state is State.SLEEPING
    by_event = any(c.to is State.SLEEPING for c in _published(rec, StateChanged))
    return by_state or by_event


def check_debounce(trace: Trace, cfg: Config) -> int:
    """Assert Property 6 on `trace`; return the number of presence.detected events."""
    presence_times: list[float] = []
    for rec in trace:
        presences = _published(rec, PresenceDetected)
        assert len(presences) <= 1, f"several presence.detected in one call at {rec.now}"
        if presences:
            assert isinstance(rec.event, PirRising), (
                f"presence.detected from {type(rec.event).__name__} at {rec.now}"
            )
            assert rec.before.state is State.SLEEPING, (
                f"presence.detected in {rec.before.state} at {rec.now}"
            )
            assert rec.before.mode is Mode.GUARD, f"presence.detected in Mode {rec.before.mode}"
            elapsed = rec.now - rec.before.start_time
            assert elapsed >= cfg.timing.pir_warmup_s - TOL, (
                f"presence.detected {elapsed} s after start, warm-up {cfg.timing.pir_warmup_s} s"
            )
            presence_times.append(rec.now)
        if _enters_sleeping(rec):
            assert not presences, f"presence.detected in a call that enters sleeping at {rec.now}"
            new = _encounter_id(rec.after)
            assert new is None or new == _encounter_id(rec.before), (
                f"Encounter started in a call that enters sleeping at {rec.now}"
            )

    for earlier, later in zip(presence_times, presence_times[1:], strict=False):
        assert later - earlier >= cfg.timing.cooldown_s - TOL, (
            f"presence.detected at {earlier} and {later}, cooldown_s {cfg.timing.cooldown_s}"
        )

    for enc in split_by_encounter(trace):
        presences = sum(len(_published(r, PresenceDetected)) for r in enc.records)
        reactions = sum(len(_published(r, ReactionPerformed)) for r in enc.records)
        assert presences <= 1, f"Encounter {enc.encounter_id}: {presences} presence.detected"
        assert reactions <= 1, f"Encounter {enc.encounter_id}: {reactions} reaction.performed"
    return len(presence_times)


def _bucket(n: int) -> str:
    return str(n) if n < 3 else "3+"


# Feature: device-core-loop, Property 6: PIR debounce
@pytest.mark.timeout(300)
@settings(deadline=None)
@given(data=st.data(), cfg=valid_configs(), lines=line_sets())
def test_pir_debounce(data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...]) -> None:
    """**Validates: Requirements 2.1, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 12.9, 29.8**"""
    trace = run_debounce(data, cfg, lines)
    presences = check_debounce(trace, cfg)

    ignored = sum(
        1 for r in trace if isinstance(r.event, PirRising) and not _published(r, PresenceDetected)
    )
    high_at_cooldown_end = sum(
        1
        for r in trace
        if r.before.state is State.COOLDOWN
        and r.after.state is State.SLEEPING
        and r.after.pir_high
    )
    event(f"encounters: {_bucket(len(split_by_encounter(trace)))}")
    event(f"ignored pir.rising: {_bucket(ignored)}")
    event(f"pir high when cooldown ends: {high_at_cooldown_end > 0}")

    # The guaranteed rising edge after the warm-up must start an Encounter (R11.1).
    assert presences >= 1, "no presence.detected: the run is vacuous"
