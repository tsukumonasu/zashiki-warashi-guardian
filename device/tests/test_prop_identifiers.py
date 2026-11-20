"""Property 18: Identifier freshness (design "Correctness Properties").

For a reachable Machine_State `ms`, a `now` and two Events `e1` and `e2` that differ only in
`uid`:

- the new identifiers of `step(ms, e1, now)` and those of `step(ms, e2, now)` are disjoint;
- within one result, the new identifiers of one kind are pairwise distinct;
- an `encounterId` created by the call equals the Event's `uid` (R1.4).

New identifiers are read from the result, not from the id format, so the test does not depend
on how `StepContext.new_id` spells them: the Snapshot_Ids of `TakeSnapshot`, the Motion_Ids of
`GazeTarget`, the Play_Ids of `PlayLine` and `PlayAudioUrl`, and the id of an Encounter that
starts in the call. A string already held anywhere in `ms` is not new.

Reachable states come from traces of two drivers: `run_reactive` (noise and every command
kind) and `_GazeWorld`, which is `_VerdictWorld` from Property 3 (a connected cloud and Verdicts
for the current snapshot, so scans, nods, Reactions and `speak` occur) plus manual `gaze`
commands during an Encounter. Every recorded call that created an identifier, and every
non-Tick call, is stepped again with `e2 = dataclasses.replace(e1, uid=<another UUID v4>)`.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Iterator

import pytest
from hypothesis import event, given, settings
from hypothesis import strategies as st

from tests.harness import Record, Trace, run_reactive
from tests.strategies import line_sets, valid_configs
from tests.test_prop_stranger_safety import _VerdictWorld
from warashi_agent.model import (
    Action,
    Category,
    Gaze,
    GazeTarget,
    PlayAudioUrl,
    PlayLine,
    State,
    TakeSnapshot,
    Tick,
)
from warashi_agent.state_machine import MachineState, step

REACTIVE_BUDGET = 40
WORLD_BUDGET = 60

NewIds = dict[str, list[str]]  # kind -> new identifiers in emission order


# --------------------------------------------------------------------------------------------
# Collecting new identifiers
# --------------------------------------------------------------------------------------------


def _strings_in(value: object) -> Iterator[str]:
    """Every string held anywhere in a Machine_State (dataclasses and containers)."""
    if isinstance(value, str):
        yield value
    elif dataclasses.is_dataclass(value) and not isinstance(value, type):
        for f in dataclasses.fields(value):
            yield from _strings_in(getattr(value, f.name))
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from _strings_in(k)
            yield from _strings_in(v)
    elif isinstance(value, tuple | list | set | frozenset):
        for item in value:
            yield from _strings_in(item)


def _action_ids(actions: tuple[Action, ...]) -> NewIds:
    ids: NewIds = {"snapshot": [], "motion": [], "play": []}
    for action in actions:
        match action:
            case TakeSnapshot(snapshot_id=i):
                ids["snapshot"].append(i)
            case GazeTarget(motion_id=i):
                ids["motion"].append(i)
            case PlayLine(play_id=i) | PlayAudioUrl(play_id=i):
                ids["play"].append(i)
            case _:
                pass
    return ids


def _started_encounter(before: MachineState, after: MachineState) -> str | None:
    """The id of an Encounter that `after` carries and `before` does not."""
    new = after.encounter
    if new is None:
        return None
    old = before.encounter
    if old is not None and old.encounter_id == new.encounter_id:
        return None
    return new.encounter_id


def new_ids(before: MachineState, after: MachineState, actions: tuple[Action, ...]) -> NewIds:
    """New identifiers of one result, by kind; strings already in `before` are excluded."""
    known = set(_strings_in(before))
    ids = {
        kind: [i for i in found if i not in known] for kind, found in _action_ids(actions).items()
    }
    encounter = _started_encounter(before, after)
    ids["encounter"] = [encounter] if encounter is not None and encounter not in known else []
    return ids


def _flat(ids: NewIds) -> set[str]:
    return {i for found in ids.values() for i in found}


# --------------------------------------------------------------------------------------------
# Oracle
# --------------------------------------------------------------------------------------------


def _check_one_result(ids: NewIds, uid: str, label: str) -> None:
    for kind, found in ids.items():
        assert len(found) == len(set(found)), f"{label}: repeated new {kind} ids {found!r}"
    for encounter in ids["encounter"]:
        assert encounter == uid, f"{label}: encounterId {encounter!r} is not the uid {uid!r}"


def check_record(rec: Record, other_uid: str) -> None:
    """Step `rec.event` again with `other_uid` and compare the new identifiers."""
    assert other_uid != rec.event.uid
    ids1 = new_ids(rec.before, rec.after, rec.actions)
    e2 = dataclasses.replace(rec.event, uid=other_uid)
    after2, actions2 = step(rec.before, e2, rec.now)
    ids2 = new_ids(rec.before, after2, actions2)

    _check_one_result(ids1, rec.event.uid, "e1")
    _check_one_result(ids2, other_uid, "e2")
    shared = _flat(ids1) & _flat(ids2)
    assert not shared, (
        f"{type(rec.event).__name__} in {rec.before.state.value}: identifiers {sorted(shared)!r}"
        " come back for a different uid"
    )

    for kind, found in ids1.items():
        if found:
            event(f"new {kind} id")
    if _flat(ids1):
        event(f"creating call: {type(rec.event).__name__} in {rec.before.state.value}")


def _wants_check(rec: Record) -> bool:
    """Calls that created an identifier, and every non-Tick call."""
    return not isinstance(rec.event, Tick) or bool(
        _flat(new_ids(rec.before, rec.after, rec.actions))
    )


# --------------------------------------------------------------------------------------------
# The Property 18 test
# --------------------------------------------------------------------------------------------


class _GazeWorld(_VerdictWorld):
    """`_VerdictWorld` plus manual `gaze` commands during an Encounter.

    `run_reactive` rarely gets past the PIR warm-up with the cloud connected, so manual `gaze`
    (a Motion_Id outside the Reaction flow) would almost never be stepped without this.
    """

    def draw_world_event(self) -> None:
        if (
            self.ms.state in _GAZE_STATES
            and self.data.draw(st.integers(0, 5), label="manual gaze") == 0
        ):
            pan = self.data.draw(st.floats(-90.0, 90.0), label="gaze pan")
            tilt = self.data.draw(st.floats(-45.0, 45.0), label="gaze tilt")
            at = self.now + self.data.draw(self._gaps(), label="gap")
            self.feed(Gaze(ref_id=self.uids(), pan_deg=pan, tilt_deg=tilt), at)
            return
        super().draw_world_event()


_GAZE_STATES = frozenset(State) - {State.SLEEPING, State.COOLDOWN}


def _trace(data: st.DataObject) -> Trace:
    cfg = data.draw(valid_configs(), label="cfg")
    driver = data.draw(st.sampled_from(("world", "world", "world", "reactive")), label="driver")
    if driver == "reactive":
        lines = data.draw(line_sets(), label="lines")
        return run_reactive(data, cfg, lines, tick_gap_max=None, budget=REACTIVE_BUDGET)
    lines = data.draw(line_sets(require=tuple(Category)), label="lines")
    return _GazeWorld(data, cfg, lines).run(WORLD_BUDGET)


# Feature: device-core-loop, Property 18: Identifier freshness
@pytest.mark.timeout(900)
@settings(deadline=None)
@given(data=st.data())
def test_identifier_freshness(data: st.DataObject) -> None:
    """New identifiers depend on the Event `uid` only and never repeat within one call.

    **Validates: Requirements 1.4**
    """
    trace = _trace(data)
    for rec in trace:
        if not _wants_check(rec):
            continue
        uid = rec.event.uid
        other = data.draw(
            st.uuids(version=4).map(str).filter(lambda u, uid=uid: u != uid), label="other uid"
        )
        check_record(rec, other)
