"""Unit tests for remote control from the dashboard (remote-mode M1 to M3, ``docs/schema.md``).

``mode.set remote`` wakes the doll into the State ``remote``: PIR is ignored, look, lantern,
speak and photo commands are accepted, and every accepted command restarts the idle time. A
``mode.set guard`` or ``sleep``, or ``remote_idle_s`` without a command, ends it through
``cooldown``, so the head returns to center, the servos detach and the lantern goes out.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Iterable

from warashi_agent.config import Config
from warashi_agent.messages import (
    EncounterEnded,
    ErrorCode,
    ErrorReported,
    PresenceDetected,
    StateChanged,
)
from warashi_agent.model import (
    Action,
    Category,
    EndReason,
    Gaze,
    GazeTarget,
    Lantern,
    LanternFade,
    Mode,
    ModeRequest,
    ModeSet,
    PirRising,
    PublishEvent,
    Reason,
    ReleaseServos,
    ServoArrived,
    SnapshotRequest,
    Speak,
    State,
    TakeSnapshot,
    Tick,
)
from warashi_agent.state_machine import (
    Conversing,
    Cooldown,
    Encounter,
    MachineState,
    Remote,
    Seeking,
    initial_state,
    step,
)
from warashi_agent.voice import VoiceLine

CONFIG = Config()
IDLE_S = CONFIG.timing.remote_idle_s
START = 1000.0
NOW = START + 90.0
LINES = (
    VoiceLine(id="uncertain", category=Category.UNCERTAIN, ja="x", en="x", wav="uncertain.wav"),
)

_uid = 0


def uid() -> str:
    global _uid
    _uid += 1
    return f"00000000-0000-4000-8000-{_uid:012d}"


def machine(**changes: object) -> MachineState:
    ms = initial_state(config=CONFIG, lines=LINES, agent_version="0.1.0", start_time=START)
    return dataclasses.replace(ms, **{"cloud_connected": True, **changes})


def mode_set(mode: ModeRequest) -> ModeSet:
    return ModeSet(ref_id=f"cmd-{mode.value}", mode=mode, uid=uid())


def published(actions: Iterable[Action]) -> list[object]:
    return [a.data for a in actions if isinstance(a, PublishEvent)]


def of_type[T](items: Iterable[object], cls: type[T]) -> list[T]:
    return [item for item in items if isinstance(item, cls)]


def state_changes(actions: Iterable[Action]) -> list[StateChanged]:
    return of_type(published(actions), StateChanged)


def errors(actions: Iterable[Action]) -> list[ErrorCode]:
    return [e.code for e in of_type(published(actions), ErrorReported)]


def remote(now: float = NOW, **changes: object) -> tuple[MachineState, tuple[Action, ...]]:
    return step(machine(**changes), mode_set(ModeRequest.REMOTE), now)


def phase_of(ms: MachineState) -> Remote:
    assert isinstance(ms.phase, Remote)
    return ms.phase


# ============================================================================================
# Starting
# ============================================================================================


def test_remote_from_sleeping_wakes_the_doll_as_a_manual_encounter() -> None:
    ms, actions = remote()
    assert state_changes(actions) == [
        StateChanged(from_=State.SLEEPING, to=State.REMOTE, reason=Reason.MANUAL)
    ]
    assert PresenceDetected(source="manual") in published(actions)
    (fade,) = of_type(actions, LanternFade)
    assert fade.level == CONFIG.lantern.lantern_wake_level
    (gaze,) = of_type(actions, GazeTarget)
    assert (gaze.pan_deg, gaze.tilt_deg) == (0.0, 0.0)
    assert ms.encounter is not None
    assert phase_of(ms).idle_until == NOW + IDLE_S
    assert ms.mode is Mode.GUARD  # remote is a State, not a Mode


def test_remote_works_in_sleep_mode_and_keeps_it() -> None:
    ms, _ = remote(mode=Mode.SLEEP)
    assert ms.state is State.REMOTE
    assert ms.mode is Mode.SLEEP


def test_remote_during_a_visit_keeps_the_encounter() -> None:
    encounter = Encounter(encounter_id="enc-1")
    ms = machine(phase=Seeking(), encounter=encounter, lantern_level=0.8, servos_released=False)
    nxt, actions = step(ms, mode_set(ModeRequest.REMOTE), NOW)
    assert state_changes(actions) == [
        StateChanged(from_=State.SEEKING, to=State.REMOTE, reason=Reason.MANUAL)
    ]
    assert nxt.encounter is not None and nxt.encounter.encounter_id == "enc-1"
    assert of_type(published(actions), PresenceDetected) == []
    assert of_type(actions, LanternFade) == []  # already lit


def test_remote_from_a_dark_cooldown_lights_the_lantern_again() -> None:
    cooldown = Cooldown(
        motion_id="m", glide_deadline=NOW, until=NOW + 10, released=True, manual=False
    )
    ms = machine(phase=cooldown, encounter=Encounter(encounter_id="enc-1"), lantern_level=0.0)
    nxt, actions = step(ms, mode_set(ModeRequest.REMOTE), NOW)
    assert nxt.state is State.REMOTE
    (fade,) = of_type(actions, LanternFade)
    assert fade.level == CONFIG.lantern.lantern_wake_level


def test_remote_is_refused_while_conversing() -> None:
    ms = machine(
        phase=Conversing(session_id="s", deadline=NOW + 100), encounter=Encounter(encounter_id="e")
    )
    nxt, actions = step(ms, mode_set(ModeRequest.REMOTE), NOW)
    assert nxt is ms
    assert errors(actions) == [ErrorCode.COMMAND_REJECTED_STATE]


def test_remote_again_restarts_the_idle_time() -> None:
    ms, _ = remote()
    nxt, actions = step(ms, mode_set(ModeRequest.REMOTE), NOW + 50)
    assert state_changes(actions) == []
    assert phase_of(nxt).idle_until == NOW + 50 + IDLE_S


# ============================================================================================
# While remote
# ============================================================================================


def test_look_and_lantern_are_accepted_and_restart_the_idle_time() -> None:
    ms, _ = remote()
    ms, actions = step(ms, Gaze(ref_id="g", pan_deg=-20.0, tilt_deg=0.0, uid=uid()), NOW + 10)
    (gaze,) = of_type(actions, GazeTarget)
    assert gaze.pan_deg == -20.0
    assert phase_of(ms).idle_until == NOW + 10 + IDLE_S
    ms, actions = step(ms, Lantern(ref_id="l", level=0.3, fade_ms=500, uid=uid()), NOW + 20)
    (fade,) = of_type(actions, LanternFade)
    assert fade.level == 0.3
    assert phase_of(ms).idle_until == NOW + 20 + IDLE_S
    assert errors(actions) == []


def test_a_look_is_clamped_to_the_calibrated_range() -> None:
    ms, _ = remote()
    _, actions = step(ms, Gaze(ref_id="g", pan_deg=500.0, tilt_deg=0.0, uid=uid()), NOW + 1)
    (gaze,) = of_type(actions, GazeTarget)
    assert gaze.pan_deg == CONFIG.servo.pan_limit


def test_a_refused_command_does_not_restart_the_idle_time() -> None:
    ms, _ = remote()
    speak = Speak(ref_id="s", line_id="no-such-line", audio_url=None, uid=uid())
    nxt, actions = step(ms, speak, NOW + 30)
    assert errors(actions) == [ErrorCode.UNKNOWN_LINE]
    assert phase_of(nxt).idle_until == NOW + IDLE_S


def test_pir_is_ignored_while_remote() -> None:
    ms, _ = remote()
    nxt, actions = step(ms, PirRising(uid=uid()), NOW + 5)
    assert actions == ()
    assert nxt.state is State.REMOTE
    assert nxt.pir_high is True


def test_a_photo_is_taken_in_place() -> None:
    ms, _ = remote()
    request = SnapshotRequest(ref_id="p", request_id="req-1", purpose="photo", uid=uid())
    nxt, actions = step(ms, request, NOW + 5)
    assert len(of_type(actions, TakeSnapshot)) == 1
    assert nxt.state is State.REMOTE
    assert nxt.photo is not None
    assert phase_of(nxt).idle_until == NOW + 5 + IDLE_S


# ============================================================================================
# Ending
# ============================================================================================


def test_guard_ends_remote_through_cooldown_and_the_encounter_ends_manual() -> None:
    ms, _ = remote()
    ms, _ = step(ms, Gaze(ref_id="g", pan_deg=-20.0, tilt_deg=0.0, uid=uid()), NOW + 1)
    ms, actions = step(ms, mode_set(ModeRequest.GUARD), NOW + 5)
    assert state_changes(actions) == [
        StateChanged(from_=State.REMOTE, to=State.COOLDOWN, reason=Reason.MANUAL)
    ]
    (back,) = of_type(actions, GazeTarget)
    assert (back.pan_deg, back.tilt_deg) == (0.0, 0.0)
    cooldown = ms.phase
    assert isinstance(cooldown, Cooldown)
    ms, actions = step(ms, ServoArrived(motion_id=back.motion_id, uid=uid()), NOW + 6)
    assert of_type(actions, ReleaseServos)
    assert [f.level for f in of_type(actions, LanternFade)] == [0.0]
    ms, actions = step(ms, Tick(uid=uid()), cooldown.until)
    assert ms.state is State.SLEEPING
    assert of_type(published(actions), EncounterEnded) == [EncounterEnded(reason=EndReason.MANUAL)]


def test_sleep_ends_remote_and_sets_the_mode() -> None:
    ms, _ = remote()
    nxt, actions = step(ms, mode_set(ModeRequest.SLEEP), NOW + 5)
    assert nxt.state is State.COOLDOWN
    assert nxt.mode is Mode.SLEEP


def test_remote_ends_by_itself_after_the_idle_time() -> None:
    ms, _ = remote()
    before, actions = step(ms, Tick(uid=uid()), NOW + IDLE_S - 0.01)
    assert before.state is State.REMOTE
    assert state_changes(actions) == []
    after, actions = step(before, Tick(uid=uid()), NOW + IDLE_S)
    assert state_changes(actions) == [
        StateChanged(from_=State.REMOTE, to=State.COOLDOWN, reason=Reason.TIMEOUT)
    ]
    cooldown = after.phase
    assert isinstance(cooldown, Cooldown)
    assert cooldown.manual is False
