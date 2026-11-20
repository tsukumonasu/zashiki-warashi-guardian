"""Property 5: Offline reaction (design "Correctness Properties", R2.6, R3.6, R3.7, R9, R29.7).

The doll must never seem broken when the Wi-Fi or the cloud is down. This file checks two
things against the trace of ``step()`` calls:

- Under the R29.7 preconditions, every Encounter started by ``pir.rising`` at ``t`` contains a
  ``PlayLine`` of an ``uncertain`` Voice_Line in the same ``step()`` call as
  ``reaction.performed`` with ``kind: "uncertain"``, the same ``lineId`` and ``offline: true``.
  That call comes by ``t + Offline_Bound_Disconnected`` when the cloud is disconnected at ``t``
  and stays disconnected until the ``PlayLine``, and by ``t + Offline_Bound_Silent`` for any
  connectivity changes.
- For all Event sequences, without those preconditions, every ``TakeSnapshot`` is emitted in a
  call whose argument and returned Machine_State both have the cloud connected (R9.5).

The oracle is written from the requirements. It reads only the trace (Events, Actions, the
``cloud_connected`` flag on both sides of a call) and the Config's derived bounds.

Generators. ``run_offline`` reuses the reactive harness driver (adapter feedback, forced Ticks
at most ``T`` apart, the silent tail) and changes only the Event menu:

- ``judgement.result`` is removed: a drawn one becomes a Tick, which is already the most
  common Event and carries no decision.
- ``mode.set`` with ``mode: "sleep"`` becomes ``mode: "guard"`` while an Encounter is active or
  within Offline_Bound_Silent of the last Encounter start.
- One Tick at the end of the PIR warm-up, then the first ``pir.rising`` within ``T``, so every
  example has at least one Encounter to check. R29.7 bounds Tick gaps only after ``t``, so the
  warm-up needs no forced Ticks.
- The silent tail stops once every Encounter has had Offline_Bound_Silent + ``T``, the end of
  the window the property looks at (the harness tail would run to Encounter_Bound).

Two connectivity sub-strategies are mixed (design): ``disconnected`` turns every drawn
``cloud.connected`` into ``cloud.disconnected``, so the cloud stays disconnected from startup
(R9.1); ``toggled`` may connect at startup and, after each Encounter start, schedules up to
three connectivity flips at the same ``now`` as the ``pir.rising``, just before the waking
deadline, or anywhere in the Offline_Bound_Silent window, on top of the harness's own random
cloud Events.
"""

from __future__ import annotations

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from tests.harness import (
    START_TIME,
    Record,
    Trace,
    _Driver,
    _floats,
    run_reactive,
    split_by_encounter,
)
from tests.strategies import line_sets, valid_configs
from warashi_agent.config import Config
from warashi_agent.messages import ReactionPerformed
from warashi_agent.model import (
    Category,
    CloudConnected,
    CloudDisconnected,
    Event,
    JudgementResult,
    Mode,
    ModeSet,
    PirRising,
    PlayLine,
    PublishEvent,
    TakeSnapshot,
    Tick,
)
from warashi_agent.voice import VoiceLine

TOL = 1e-9
BUDGET = 30
DISCONNECTED = "disconnected"
TOGGLED = "toggled"
TOGGLES_PER_ENCOUNTER_MAX = 3


# --------------------------------------------------------------------------------------------
# Generators
# --------------------------------------------------------------------------------------------


class _OfflineDriver(_Driver):
    """The harness driver with no Verdicts, no early sleep and controlled connectivity."""

    def __init__(
        self,
        data: st.DataObject,
        cfg: Config,
        lines: tuple[VoiceLine, ...],
        connectivity: str,
    ) -> None:
        super().__init__(data, cfg, lines, tick_gap_max=cfg.tick_s)
        self.connectivity = connectivity
        self.scheduled: list[float] = []  # times of pending connectivity flips, sorted

    def feed(self, event: Event, at: float) -> None:
        at = max(at, self.now)
        self._flush_toggles(until=at)
        if self.connectivity == DISCONNECTED and isinstance(event, CloudConnected):
            event = CloudDisconnected()
        started = len(self.encounter_starts)
        super().feed(event, at)
        if self.connectivity == TOGGLED and len(self.encounter_starts) > started:
            self._schedule_toggles(self.encounter_starts[-1])

    def silent_tail(self) -> None:
        """Ticks ``T`` apart until every Encounter has had Offline_Bound_Silent + ``T``.

        The harness tail runs to Encounter_Bound; the property looks no further than
        Offline_Bound_Silent, and the shorter tail keeps each example small. Every pending flip
        lies inside that window, so it is fed first.
        """
        self._flush_toggles(until=math.inf)
        allowance = self.cfg.offline_bound_silent_s + self.cfg.tick_s
        while self.now < max(self.encounter_starts) + allowance:
            self._step(Tick(), max(self.now, self.last_tick + self.cfg.tick_s))

    def _draw_command(self) -> Event:
        command = super()._draw_command()
        if isinstance(command, JudgementResult):
            return Tick()
        if isinstance(command, ModeSet) and command.mode is Mode.SLEEP and self._in_window():
            return ModeSet(ref_id=command.ref_id, mode=Mode.GUARD)
        return command

    def _in_window(self) -> bool:
        """True while a mode.set sleep could fall inside some [t, t + Offline_Bound_Silent]."""
        if self.ms.encounter is not None:
            return True
        last = max(self.encounter_starts, default=-math.inf)
        return self.now <= last + self.cfg.offline_bound_silent_s + TOL

    def _schedule_toggles(self, t: float) -> None:
        """Flips at ``t`` itself, just before the waking deadline, or anywhere in the window."""
        cfg = self.cfg
        waking = cfg.timing.waking_timeout_s
        before_deadline = st.sampled_from((0.0, 1e-6, cfg.tick_s / 2, cfg.tick_s)).map(
            lambda d: max(0.0, waking - d)
        )
        offsets = self.data.draw(
            st.lists(
                st.one_of(st.just(0.0), before_deadline, _floats(0.0, cfg.offline_bound_silent_s)),
                max_size=TOGGLES_PER_ENCOUNTER_MAX,
            ),
            label="toggle offsets",
        )
        self.scheduled = sorted([*self.scheduled, *(t + o for o in offsets)])

    def _flush_toggles(self, until: float) -> None:
        while self.scheduled and self.scheduled[0] <= until:
            when = self.scheduled.pop(0)
            flip = CloudDisconnected() if self.ms.cloud_connected else CloudConnected()
            _Driver.feed(self, flip, when)


def run_offline(
    data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...], connectivity: str
) -> Trace:
    """A reactive trace that meets the R29.7 preconditions, with at least one Encounter."""
    driver = _OfflineDriver(data, cfg, lines, connectivity)
    if connectivity == TOGGLED and data.draw(st.booleans(), label="connected at start"):
        driver.feed(CloudConnected(), START_TIME)
    # R29.7 bounds Tick gaps only after t, so the warm-up is crossed with a single Tick
    # instead of thousands of forced ones; the first pir.rising follows within one T.
    warm = START_TIME + cfg.timing.pir_warmup_s
    driver.tick_gap_max = None
    driver.feed(Tick(), warm)
    driver.tick_gap_max = cfg.tick_s
    late = data.draw(st.one_of(st.just(0.0), _floats(0.0, cfg.tick_s)), label="first pir")
    driver.feed(PirRising(), warm + late)
    for _ in range(data.draw(st.integers(0, BUDGET), label="drawn events")):
        driver.draw_one()
    driver.silent_tail()
    return tuple(driver.records)


# --------------------------------------------------------------------------------------------
# Oracle, written from R9 and R29.7
# --------------------------------------------------------------------------------------------


def _offline_reaction(records: Trace, uncertain_ids: frozenset[str]) -> tuple[int, Record] | None:
    """The first call with an uncertain PlayLine and its matching offline reaction.performed."""
    for index, rec in enumerate(records):
        played = {a.line_id for a in rec.actions if isinstance(a, PlayLine)}
        for action in rec.actions:
            if not (
                isinstance(action, PublishEvent) and isinstance(action.data, ReactionPerformed)
            ):
                continue
            performed = action.data
            if (
                performed.kind is Category.UNCERTAIN
                and performed.offline
                and performed.line_id in uncertain_ids
                and performed.line_id in played
            ):
                return index, rec
    return None


def check_offline_reactions(
    trace: Trace, cfg: Config, lines: tuple[VoiceLine, ...], connectivity: str
) -> int:
    """Assert the main clause for every Encounter that meets R29.7; return how many."""
    uncertain_ids = frozenset(line.id for line in lines if line.category is Category.UNCERTAIN)
    assert uncertain_ids, "precondition: at least one uncertain Available_Line"
    assert not any(isinstance(r.event, JudgementResult) for r in trace), "precondition broken"
    sleep_times = [
        r.now for r in trace if isinstance(r.event, ModeSet) and r.event.mode is Mode.SLEEP
    ]
    silent = cfg.offline_bound_silent_s
    checked = 0
    for enc in split_by_encounter(trace):
        first = enc.records[0]
        if not isinstance(first.event, PirRising):
            continue
        t = enc.start
        if any(t - TOL <= s <= t + silent + TOL for s in sleep_times):
            continue  # outside the R29.7 preconditions
        found = _offline_reaction(enc.records, uncertain_ids)
        assert found is not None, (
            f"Encounter {enc.encounter_id} started at {t} has no uncertain PlayLine with "
            "reaction.performed(uncertain, same lineId, offline: true) in the same call"
        )
        index, rec = found
        disconnected_throughout = not first.before.cloud_connected and not any(
            r.after.cloud_connected for r in enc.records[: index + 1]
        )
        if connectivity == DISCONNECTED:
            assert disconnected_throughout, "R9.1: the cloud never connected"
        if disconnected_throughout:
            bound, name = cfg.offline_bound_disconnected_s, "Offline_Bound_Disconnected"
        else:
            bound, name = silent, "Offline_Bound_Silent"
        assert rec.now - t <= bound + TOL, (
            f"offline reaction at t + {rec.now - t} s, after {name} = {bound} s"
        )
        checked += 1
    return checked


def check_snapshots_only_when_connected(trace: Trace) -> None:
    """R9.5: no TakeSnapshot unless the cloud is connected before and after the call."""
    for rec in trace:
        if any(isinstance(a, TakeSnapshot) for a in rec.actions):
            assert rec.before.cloud_connected and rec.after.cloud_connected, (
                f"TakeSnapshot at {rec.now} on {type(rec.event).__name__} while disconnected"
            )


# --------------------------------------------------------------------------------------------
# The Property 5 test functions
# --------------------------------------------------------------------------------------------


# Feature: device-core-loop, Property 5: Offline reaction
@pytest.mark.timeout(120)
@settings(deadline=None)
@given(
    data=st.data(),
    cfg=valid_configs(),
    lines=line_sets(require=(Category.UNCERTAIN,)),
    connectivity=st.sampled_from((DISCONNECTED, TOGGLED)),
)
def test_offline_reaction_within_bound(
    data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...], connectivity: str
) -> None:
    """**Validates: Requirements 2.6, 3.6, 3.7, 7.5, 9.1, 9.2, 9.3, 9.4, 9.5, 29.7**"""
    trace = run_offline(data, cfg, lines, connectivity)
    checked = check_offline_reactions(trace, cfg, lines, connectivity)
    # The first pir.rising always starts an Encounter that meets the preconditions.
    assert checked >= 1, "no Encounter was checked; the property would hold vacuously"
    check_snapshots_only_when_connected(trace)


# Feature: device-core-loop, Property 5: Offline reaction
@pytest.mark.timeout(120)
@settings(deadline=None)
@given(data=st.data(), cfg=valid_configs(), lines=line_sets())
def test_no_snapshot_while_disconnected(
    data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...]
) -> None:
    """**Validates: Requirements 9.5**"""
    gap = data.draw(st.sampled_from((None, cfg.tick_s)), label="tick gap max")
    trace = run_reactive(data, cfg, lines, tick_gap_max=gap, budget=BUDGET)
    check_snapshots_only_when_connected(trace)
