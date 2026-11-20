"""Smoke tests for the reactive harness (tests/harness.py, task 8.3).

They check the harness itself, not the State_Machine: it returns, time never decreases,
forced Ticks close every gap, and the trace helpers agree with the trace.
"""

from __future__ import annotations

import dataclasses
import itertools
import math

from hypothesis import given, settings
from hypothesis import strategies as st

from tests.harness import (
    Record,
    fixed_one_of,
    longest_stay,
    run_reactive,
    split_by_encounter,
    state_visits,
    time_in_states,
)
from tests.strategies import DEFAULT_CONFIG, line_sets, valid_configs
from warashi_agent.model import PirRising, State, Tick
from warashi_agent.state_machine import Encounter, Waking, initial_state

SMOKE_BUDGET = 25


@settings(max_examples=100, deadline=None)
@given(st.data())
def test_run_reactive_returns_a_well_formed_trace(data: st.DataObject) -> None:
    cfg = data.draw(valid_configs(), label="cfg")
    lines = data.draw(line_sets(), label="lines")
    tick_gap_max = data.draw(st.sampled_from((None, cfg.tick_s)), label="tick_gap_max")

    trace = run_reactive(data, cfg, lines, tick_gap_max=tick_gap_max, budget=SMOKE_BUDGET)

    assert all(isinstance(rec, Record) for rec in trace)
    times = [rec.now for rec in trace]
    assert times == sorted(times)
    for prev, nxt in zip(trace, trace[1:], strict=False):
        assert nxt.before is prev.after  # each step starts from the previous result
    uids = [rec.event.uid for rec in trace]
    assert len(set(uids)) == len(uids)
    assert all(0.0 <= rec.event.rand < 1.0 for rec in trace)

    if tick_gap_max is not None:
        last_tick = 0.0
        for rec in trace:
            # 1e-9 absorbs float rounding of the sum; a real gap violation is far larger.
            assert rec.now <= last_tick + tick_gap_max + 1e-9
            if isinstance(rec.event, Tick):
                last_tick = rec.now

    visits = state_visits(trace)
    if trace:
        total = sum(time_in_states(trace).values())
        assert math.isclose(total, trace[-1].now - trace[0].now, abs_tol=1e-9)
        assert visits[0].entered == trace[0].now and not visits[-1].closed
        assert set(longest_stay(trace)) == {v.state for v in visits}
    else:
        assert visits == [] and time_in_states(trace) == {}
    for part in split_by_encounter(trace):
        assert part.start <= part.end


_fixed_one_of_examples = itertools.count()


def _flood_strategy_cache() -> None:
    """Evict single-use entries from Hypothesis' global strategy cache (1024 entries), as a
    full-suite run does after many tests have drawn Config-dependent bounds."""
    for i in range(1100):
        st.integers(-(10**9), -i)
        st.integers(-(10**9), -i)  # a second hit keeps the entry over newer single-use ones


@settings(max_examples=200, deadline=None, database=None)
@given(st.data())
def test_fixed_one_of_ignores_the_strategy_cache(data: st.DataObject) -> None:
    """Equal bounds give the same branch count whatever the cache holds.

    Regression test for the `FlakyStrategyDefinition` of Properties 3, 9, 17 and 18: with
    `st.one_of` the two `st.floats(0.0, t)` below are one cached object (three branches) or
    two objects (four branches), depending on the cache state, which alternates here between
    examples.
    """
    if next(_fixed_one_of_examples) % 2:
        _flood_strategy_cache()
    t = data.draw(st.sampled_from((0.05, 0.25)), label="t")
    gap = data.draw(
        fixed_one_of(st.just(0.0), st.floats(0.0, t), st.floats(0.0, 10 * t), st.floats(0.0, t)),
        label="gap",
    )
    assert 0.0 <= gap <= 10 * t
    data.draw(st.integers(0, 3), label="after the gap")


def test_trace_helpers_on_a_hand_built_encounter() -> None:
    """split_by_encounter and state_visits on a sleeping -> waking -> sleeping trace."""
    asleep = initial_state(config=DEFAULT_CONFIG, lines=(), agent_version="t", start_time=0.0)
    awake = dataclasses.replace(
        asleep,
        phase=Waking(motion_id="m1", fade_done_at=1.0, deadline=5.0),
        encounter=Encounter(encounter_id="e1"),
    )
    trace = (
        Record(1.0, PirRising(), asleep, awake, ()),
        Record(2.0, Tick(), awake, awake, ()),
        Record(4.0, Tick(), awake, asleep, ()),
        Record(6.0, Tick(), asleep, asleep, ()),
    )

    (part,) = split_by_encounter(trace)
    assert part.encounter_id == "e1" and part.ended
    assert (part.start, part.end, len(part.records)) == (1.0, 4.0, 3)
    assert [(v.state, v.entered, v.left, v.closed) for v in state_visits(trace)] == [
        (State.SLEEPING, 1.0, 1.0, True),
        (State.WAKING, 1.0, 4.0, True),
        (State.SLEEPING, 4.0, 6.0, False),
    ]
    assert time_in_states(trace) == {State.SLEEPING: 2.0, State.WAKING: 3.0}
    assert longest_stay(trace)[State.WAKING] == 3.0
