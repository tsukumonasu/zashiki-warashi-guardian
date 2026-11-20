"""Property 17: State changes are announced with the R24.4 reason (design, "Correctness").

For every step `(before, event, now) -> (after, actions)` of a reactive trace:

- **`state.changed`.** When `after.state != before.state`, the actions hold exactly one
  `state.changed` with `from = before.state`, `to = after.state` and the reason that the
  transcription of the `docs/schema.md` "Reason mapping" table below assigns (first matching
  row wins). When the State is unchanged, the actions hold no `state.changed` (R1.8, R24.4).
- **`PublishStatus`.** At most one, as the last Action, exactly when the State changed,
  `cameraActive` changed, the event is the first Tick, or the event is a Tick at least
  `status_interval_s` after the last `PublishStatus`. Its data is rebuilt from the trace:
  the last emitted `GazeTarget` and `LanternFade`, the camera indicator, `micActive` false,
  `motionEnabled`, `uptimeSec` and `agentVersion` (R23).
- **`encounterId`.** Every `PublishEvent` carries the call's Encounter: the new one when an
  Encounter starts, the ending one when the call enters `sleeping`, null outside an
  Encounter (R1.8, R8.5).
- **No side effects.** Cloud events (except `cloud.disconnected` in `seeking`), PIR edges
  outside `sleeping` (and `pir.falling` anywhere), stale feedback and accepted `gaze`,
  `lantern` and `speak` commands leave the State, the phase with its deadlines and the
  Encounter unchanged (R1.9, R2.7, R9.7, R10.4, R10.6, R11.1 to R11.3, R12.1, R12.2, R12.4).

The oracle reads the trace, the Config and the `before` side of each record (the phase
deadlines and the awaited ids). It never calls the State_Machine's own helpers.

Left out: the row "any state other than `sleeping` -> `sleeping`, restart after an internal
error -> `error`". That `state.changed` is published by the Dispatcher main loop (R10.5,
task 20.3), never by `step()`, so no `step()` record can match it.

Generators. One driver per example, drawn from: the plain harness (`run_reactive`, with and
without forced Ticks), the Property 3 world (`_VerdictWorld`: connected cloud, Verdicts of
every kind for the current snapshot), a sparse variant of it (`_SparseWorld`: Categories may
lack lines, more early `mode.set` sleeps) and the Property 5 offline driver (`run_offline`:
disconnected or toggled cloud during the Encounter). Together they reach every reason that
`step()` can assign; `hypothesis.event()` labels each transition with its reason.
"""

from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass, field

import pytest
from hypothesis import event, given, settings
from hypothesis import strategies as st

from tests.harness import (
    AGENT_VERSION,
    START_TIME,
    UNKNOWN_LINE_ID,
    Record,
    Trace,
    run_reactive,
)
from tests.strategies import line_sets, valid_configs
from tests.test_prop_offline import DISCONNECTED, TOGGLED, run_offline
from tests.test_prop_stranger_safety import WORLD_BUDGET, _VerdictWorld
from warashi_agent.config import Config
from warashi_agent.messages import ErrorReported, ReactionPerformed, StateChanged, StatusReport
from warashi_agent.model import (
    AudioFailed,
    AudioFinished,
    Category,
    CloudConnected,
    CloudDisconnected,
    Gaze,
    GazeTarget,
    JudgementResult,
    Lantern,
    LanternFade,
    Mode,
    ModeSet,
    PirFalling,
    PirRising,
    PublishEvent,
    PublishStatus,
    Reason,
    ServoArrived,
    SnapshotFailed,
    SnapshotReady,
    Speak,
    State,
    TakeSnapshot,
    Tick,
    Verdict,
)
from warashi_agent.state_machine import (
    Cooldown,
    Gazing,
    Greeting,
    MachineState,
    Seeking,
    Uncertain,
    Waking,
    WarningPhase,
)
from warashi_agent.voice import VoiceLine

TOL = 1e-9  # time comparisons (R29.2)
BUDGET = 30

S = State
ACTIVE = frozenset({S.WAKING, S.SEEKING, S.GAZING, S.GREETING, S.WARNING, S.UNCERTAIN})
REACTION = frozenset({S.GREETING, S.WARNING, S.UNCERTAIN})
_DRIVERS = ("reactive", "reactive_tick_gap", "verdict_world", "sparse_world", "offline")
EARLY_SLEEP_ODDS = 39  # one `mode.set` sleep per 40 draws in an active State (_SparseWorld)


# --------------------------------------------------------------------------------------------
# The R24.4 "Reason mapping" table of docs/schema.md, transcribed by hand
# --------------------------------------------------------------------------------------------


def expected_reason(rec: Record, line_missing: bool) -> Reason | None:
    """The reason of the first table row whose transition and cause both match `rec`.

    `line_missing` is true when this Encounter already published `reaction.performed` with
    `lineId: null` (R7.7), the cause of the row "no voice line of the needed category".
    Returns None when no row matches, which the caller reports as an unexpected transition.
    """
    before, ev, now = rec.before, rec.event, rec.now
    frm, to = before.state, rec.after.state
    phase = before.phase
    tick = isinstance(ev, Tick)

    # sleeping -> waking | pir.rising | presence
    if frm is S.SLEEPING and to is S.WAKING and isinstance(ev, PirRising):
        return Reason.PRESENCE
    # any state other than sleeping -> sleeping | restart after an internal error | error
    #   (left out: published by the Dispatcher, never by step(); see the module docstring)
    # cooldown -> sleeping | cooldown deadline | cooldown_done
    if frm is S.COOLDOWN and to is S.SLEEPING and tick:
        assert isinstance(phase, Cooldown)
        if now >= phase.until:
            return Reason.COOLDOWN_DONE
    # waking .. uncertain -> cooldown | mode.set sleep | manual
    if frm in ACTIVE and to is S.COOLDOWN and isinstance(ev, ModeSet) and ev.mode is Mode.SLEEP:
        return Reason.MANUAL
    # waking -> uncertain | cloud disconnected when leaving waking, any cause | offline
    if frm is S.WAKING and to is S.UNCERTAIN and not rec.after.cloud_connected:
        return Reason.OFFLINE
    if frm is S.WAKING and to is S.SEEKING:
        assert isinstance(phase, Waking)
        arrival = (isinstance(ev, ServoArrived) and ev.motion_id == phase.motion_id) or (
            tick and phase.arrived
        )
        # waking -> seeking | servo.arrived and lantern fade-in elapsed | arrived
        if arrival and now >= phase.fade_done_at:
            return Reason.ARRIVED
        # waking -> seeking | waking deadline | timeout
        if tick and now >= phase.deadline:
            return Reason.TIMEOUT
    if frm is S.SEEKING and to is S.UNCERTAIN:
        assert before.encounter is not None
        attempt = before.encounter.attempt
        current = attempt.snapshot_id if attempt is not None else None
        # seeking -> uncertain | cloud.disconnected | offline
        if isinstance(ev, CloudDisconnected):
            return Reason.OFFLINE
        # seeking -> uncertain | snapshot.failed | error
        if isinstance(ev, SnapshotFailed) and ev.snapshot_id == current:
            return Reason.ERROR
        # seeking -> uncertain | snapshot attempt deadline | timeout
        if tick and attempt is not None and now >= attempt.deadline:
            return Reason.TIMEOUT
        # seeking -> uncertain | scan attempts used up with no_face | no_face
        if isinstance(ev, JudgementResult) and ev.verdict is Verdict.NO_FACE:
            return Reason.NO_FACE
    # seeking -> gazing, greeting, warning or uncertain | verdict | verdict
    if (
        frm is S.SEEKING
        and to in (S.GAZING, S.GREETING, S.WARNING, S.UNCERTAIN)
        and isinstance(ev, JudgementResult)
    ):
        return Reason.VERDICT
    if frm is S.GAZING and to in (S.GREETING, S.WARNING):
        assert isinstance(phase, Gazing)
        # gazing -> greeting or warning | servo.arrived | arrived
        if isinstance(ev, ServoArrived) and ev.motion_id == phase.motion_id:
            return Reason.ARRIVED
        # gazing -> greeting or warning | gazing deadline | timeout
        if tick and now >= phase.deadline:
            return Reason.TIMEOUT
    if frm in REACTION and to is S.COOLDOWN:
        assert isinstance(phase, Greeting | WarningPhase | Uncertain)
        line = phase.line
        # greeting, warning or uncertain -> cooldown | no voice line of the category | error
        if line_missing and tick:
            return Reason.ERROR
        # greeting, warning or uncertain -> cooldown | audio.finished or audio.failed | audio_done
        if (
            isinstance(ev, AudioFinished | AudioFailed)
            and line is not None
            and line.play_id is not None
            and ev.play_id == line.play_id
        ):
            return Reason.AUDIO_DONE
        # greeting, warning or uncertain -> cooldown | audio deadline | timeout
        if tick and line is not None and line.deadline is not None and now >= line.deadline:
            return Reason.TIMEOUT
    return None


# --------------------------------------------------------------------------------------------
# Stale feedback (R5.8, R10.6)
# --------------------------------------------------------------------------------------------


def _awaited_motions(ms: MachineState) -> set[str]:
    """Motion_Ids whose `servo.arrived` the phase still waits for."""
    phase = ms.phase
    match phase:
        case Waking(motion_id=mid):
            # R2.3 has no "not yet received" guard: a repeated arrival for the waking
            # Motion_Id after the fade-in still leaves waking, so it is never stale.
            return {mid}
        case Seeking(scan=scan) if scan is not None:
            return {scan.motion_id}
        case Gazing(motion_id=mid):
            return {mid}
        case Greeting(nod_motion_id=mid, nod_returned=False):
            return {mid}
        case Cooldown(motion_id=mid, released=False):
            return {mid}
    return set()


def _reaction_play_id(ms: MachineState) -> str | None:
    phase = ms.phase
    if isinstance(phase, Greeting | WarningPhase | Uncertain) and phase.line is not None:
        return phase.line.play_id
    return None


def _current_snapshot(ms: MachineState) -> str | None:
    if ms.state is not S.SEEKING or ms.encounter is None or ms.encounter.attempt is None:
        return None
    return ms.encounter.attempt.snapshot_id


def is_stale_feedback(rec: Record) -> bool:
    match rec.event:
        case ServoArrived(motion_id=mid):
            return mid not in _awaited_motions(rec.before)
        case AudioFinished(play_id=pid) | AudioFailed(play_id=pid):
            return pid != _reaction_play_id(rec.before)
        case SnapshotReady(snapshot_id=sid) | SnapshotFailed(snapshot_id=sid):
            return sid != _current_snapshot(rec.before)
    return False


# --------------------------------------------------------------------------------------------
# The oracle
# --------------------------------------------------------------------------------------------


@dataclass
class _Observed:
    """What the trace has emitted so far, rebuilt without reading the State_Machine."""

    gaze: tuple[float, float] = (0.0, 0.0)
    lantern: float = 0.0
    camera: tuple[str, float] | None = None  # (Snapshot_Id, attempt deadline)
    ticked: bool = False
    last_status: float | None = None
    missing_line: set[str] = field(default_factory=set)  # Encounters with lineId null


def _events(rec: Record) -> list[PublishEvent]:
    return [a for a in rec.actions if isinstance(a, PublishEvent)]


def _encounter_id(ms: MachineState) -> str | None:
    return ms.encounter.encounter_id if ms.encounter is not None else None


def _next_camera(
    rec: Record, cfg: Config, camera: tuple[str, float] | None
) -> tuple[str, float] | None:
    """R23.2: on from TakeSnapshot until its result is handled in seeking or the deadline Tick."""
    ev = rec.event
    if camera is not None:
        sid, deadline = camera
        handled = (
            isinstance(ev, SnapshotReady | SnapshotFailed)
            and rec.before.state is S.SEEKING
            and ev.snapshot_id == sid
        )
        if handled or (isinstance(ev, Tick) and rec.now >= deadline):
            camera = None
    for action in rec.actions:
        if isinstance(action, TakeSnapshot):
            camera = (action.snapshot_id, rec.now + cfg.timing.verdict_timeout_s)
    return camera


def check_state_changed(rec: Record, obs: _Observed) -> None:
    changes = [p.data for p in _events(rec) if isinstance(p.data, StateChanged)]
    frm, to = rec.before.state, rec.after.state
    if frm is to:
        assert not changes, f"state.changed without a State change at {rec.now}: {changes!r}"
        return
    assert len(changes) == 1, f"{len(changes)} state.changed for {frm} -> {to} at {rec.now}"
    change = changes[0]
    assert (change.from_, change.to) == (frm, to), f"state.changed {change!r} for {frm} -> {to}"
    eid = _encounter_id(rec.before)
    line_missing = eid is not None and eid in obs.missing_line
    want = expected_reason(rec, line_missing)
    assert want is not None, (
        f"no R24.4 row matches {frm} -> {to} on {type(rec.event).__name__} at {rec.now}"
    )
    assert change.reason is want, (
        f"{frm} -> {to} on {type(rec.event).__name__} at {rec.now}: reason"
        f" {change.reason.value}, R24.4 assigns {want.value}"
    )
    event(f"{frm.value} -> {to.value}: {want.value}")


def check_status(
    rec: Record, cfg: Config, obs: _Observed, camera_after: tuple[str, float] | None
) -> None:
    """R23.1 to R23.5. `obs.camera` is still the indicator before the call."""
    statuses = [a for a in rec.actions if isinstance(a, PublishStatus)]
    assert len(statuses) <= 1, f"{len(statuses)} PublishStatus in one call at {rec.now}"
    tick = isinstance(rec.event, Tick)
    state_changed = rec.before.state is not rec.after.state
    camera_changed = (obs.camera is None) is not (camera_after is None)
    first_tick = tick and not obs.ticked
    due = ambiguous = False
    if tick and obs.last_status is not None:
        at = obs.last_status + cfg.timing.status_interval_s
        due = rec.now >= at
        ambiguous = abs(rec.now - at) <= TOL
    required = state_changed or camera_changed or first_tick or due
    if not (ambiguous and not (state_changed or camera_changed or first_tick)):
        assert bool(statuses) is required, (
            f"PublishStatus {'missing' if required else 'unexpected'} at {rec.now}"
            f" on {type(rec.event).__name__} (state_changed={state_changed},"
            f" camera_changed={camera_changed}, first_tick={first_tick}, interval_due={due})"
        )
    if not statuses:
        return
    assert rec.actions[-1] is statuses[0], "PublishStatus is not the last Action"
    want = StatusReport(
        state=rec.after.state,
        mode=rec.after.mode,
        pan_deg=obs.gaze[0],
        tilt_deg=obs.gaze[1],
        lantern=obs.lantern,
        camera_active=camera_after is not None,
        mic_active=False,
        motion_enabled=cfg.motion.motion_enabled,
        uptime_sec=math.floor(rec.now - START_TIME),
        agent_version=AGENT_VERSION,
    )
    assert statuses[0].data == want, f"status.report {statuses[0].data!r}, expected {want!r}"
    if camera_changed:
        event(f"status: cameraActive -> {camera_after is not None}")
    if due and not (state_changed or camera_changed or first_tick):
        event("status: interval report")


def check_encounter_ids(rec: Record) -> None:
    want = _encounter_id(rec.after) or _encounter_id(rec.before)
    for publish in _events(rec):
        assert publish.encounter_id == want, (
            f"{publish.type} at {rec.now} carries encounterId {publish.encounter_id!r},"
            f" expected {want!r}"
        )


def _unchanged(rec: Record, what: str) -> None:
    b, a = rec.before, rec.after
    detail = f"at {rec.now}: {rec.event!r}; phase {b.phase!r} -> {a.phase!r}"
    assert a.state is b.state, f"{what} changed the State {b.state} -> {a.state} {detail}"
    assert a.phase == b.phase, f"{what} changed the phase or a deadline {detail}"
    assert a.encounter == b.encounter, f"{what} changed the Encounter {detail}"
    event(f"no side effect: {what}")


def check_no_side_effects(rec: Record) -> None:
    ev, before = rec.event, rec.before
    if isinstance(ev, CloudConnected) or (
        isinstance(ev, CloudDisconnected) and before.state is not S.SEEKING
    ):
        _unchanged(rec, "cloud event")
        assert rec.actions == (), f"cloud event emitted {rec.actions!r} (R9.7)"
    elif isinstance(ev, PirFalling) or (
        isinstance(ev, PirRising) and before.state is not S.SLEEPING
    ):
        _unchanged(rec, "PIR edge")
        assert rec.actions == (), f"PIR edge emitted {rec.actions!r} (R11.1 to R11.3)"
    elif is_stale_feedback(rec):
        _unchanged(rec, f"stale {type(ev).__name__}")
        others = [
            a
            for a in rec.actions
            if not (isinstance(a, PublishEvent) and isinstance(a.data, ErrorReported))
        ]
        assert not others, f"stale feedback emitted {others!r} (R10.6)"
        if not isinstance(ev, SnapshotFailed | AudioFailed):
            assert rec.actions == (), f"stale feedback emitted {rec.actions!r} (R10.6)"
    elif isinstance(ev, Gaze | Lantern | Speak):
        rejected = any(isinstance(p.data, ErrorReported) for p in _events(rec))
        if not rejected:
            _unchanged(rec, f"accepted {type(ev).__name__}")


def _note_outputs(rec: Record, obs: _Observed) -> None:
    """The last emitted GazeTarget and LanternFade, including those of this call (R23.4)."""
    for action in rec.actions:
        if isinstance(action, GazeTarget):
            obs.gaze = (action.pan_deg, action.tilt_deg)
        elif isinstance(action, LanternFade):
            obs.lantern = action.level


def check_trace(trace: Trace, cfg: Config) -> None:
    obs = _Observed()
    for rec in trace:
        check_state_changed(rec, obs)
        camera_after = _next_camera(rec, cfg, obs.camera)
        _note_outputs(rec, obs)  # the status data reflects the end of the call (R23.5)
        check_status(rec, cfg, obs, camera_after)
        obs.camera = camera_after
        check_encounter_ids(rec)
        check_no_side_effects(rec)
        for publish in _events(rec):
            data = publish.data
            if isinstance(data, ReactionPerformed) and data.line_id is None:
                assert publish.encounter_id is not None
                obs.missing_line.add(publish.encounter_id)
                event(f"reaction without a voice line: {data.kind.value}")
        if isinstance(rec.event, Tick):
            obs.ticked = True
        if any(isinstance(a, PublishStatus) for a in rec.actions):
            obs.last_status = rec.now


# --------------------------------------------------------------------------------------------
# The Property 17 test
# --------------------------------------------------------------------------------------------


class _SparseWorld(_VerdictWorld):
    """The Property 3 world with Categories that may lack lines, and more early sleeps.

    Missing Categories reach the "no voice line" row from `greeting` and `warning`, which the
    other drivers rarely enter; the extra `mode.set` sleep reaches `manual` from every State,
    and the extra `no_face` Verdicts use up the scan attempts.
    """

    def __init__(self, data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...]) -> None:
        super().__init__(data, cfg, lines)
        # `speak` for a Category without lines names an unknown line instead (rejected).
        for category, ids in self.ids_by_category.items():
            if not ids:
                self.ids_by_category[category] = [UNKNOWN_LINE_ID]

    def _draw_verdict(self) -> JudgementResult:
        """Most Verdicts are `no_face`, so that scans run out (reason `no_face`)."""
        verdict = super()._draw_verdict()
        if self.data.draw(st.integers(0, 3), label="force no_face") > 0:
            return dataclasses.replace(verdict, verdict=Verdict.NO_FACE)
        return verdict

    def draw_world_event(self) -> None:
        early_sleep = self.ms.state in ACTIVE and (
            self.data.draw(st.integers(0, EARLY_SLEEP_ODDS), label="early sleep") == 0
        )
        if early_sleep:
            self.feed(ModeSet(ref_id=self.uids(), mode=Mode.SLEEP), self.now)
        else:
            super().draw_world_event()


def _trace(data: st.DataObject, cfg: Config) -> Trace:
    """A trace from one of the drivers; each one reaches different R24.4 rows."""
    driver = data.draw(st.sampled_from(_DRIVERS), label="driver")
    event(f"driver: {driver}")
    if driver == "verdict_world":
        # The Property 3 world draws `speak` lines of every Category, so it needs all three.
        lines = data.draw(line_sets(require=tuple(Category)), label="lines")
        return _VerdictWorld(data, cfg, lines).run(WORLD_BUDGET)
    if driver == "sparse_world":
        lines = data.draw(line_sets(), label="lines")
        return _SparseWorld(data, cfg, lines).run(WORLD_BUDGET)
    # Line sets that may lack a Category reach the "no voice line" row.
    lines = data.draw(line_sets(), label="lines")
    if driver == "offline":
        connectivity = data.draw(st.sampled_from((DISCONNECTED, TOGGLED)), label="connectivity")
        return run_offline(data, cfg, lines, connectivity)
    gap = cfg.tick_s if driver == "reactive_tick_gap" else None
    return run_reactive(data, cfg, lines, tick_gap_max=gap, budget=BUDGET)


# Feature: device-core-loop, Property 17: State changes are announced with the R24.4 reason
@pytest.mark.timeout(900)
@settings(deadline=None)
@given(data=st.data(), cfg=valid_configs())
def test_state_changes_announced_with_reason(data: st.DataObject, cfg: Config) -> None:
    """**Validates: Requirements 1.8, 1.9, 2.7, 8.5, 9.7, 9.8, 10.3, 10.4, 10.6, 23.1, 23.2,
    23.3, 23.4, 23.5, 24.4**
    """
    check_trace(_trace(data, cfg), cfg)
