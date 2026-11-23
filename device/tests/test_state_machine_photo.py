"""Unit tests for the remote photo and the remote ``speak`` (remote-actions R2, R3; F1).

A remote photo is a short manual Encounter: ``sleeping`` -> ``waking`` -> ``seeking`` ->
``cooldown`` -> ``sleeping``. It publishes ``presence.detected`` with ``source: "manual"``, one
``snapshot.captured`` with ``purpose: "photo"``, and never a reaction or a voice line.
States are driven through ``step`` from a hand-built sleeping doll, like the other
state-machine tests.
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
    ReactionPerformed,
    SnapshotCaptured,
    StateChanged,
)
from warashi_agent.model import (
    Action,
    Category,
    CloudDisconnected,
    GazeTarget,
    LanternFade,
    Mode,
    PirRising,
    PlayAudioUrl,
    PublishEvent,
    PublishStatus,
    Reason,
    ServoArrived,
    SnapshotFailed,
    SnapshotReady,
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
    Seeking,
    Waking,
    initial_state,
    step,
)
from warashi_agent.voice import VoiceLine

CONFIG = Config()
START = 1000.0
NOW = START + 90.0
UID = "00000000-0000-4000-8000-00000000000a"
REQUEST_ID = "photo-request-1"
WAV_URL = "https://example.invalid/say.wav"
LINES = (
    VoiceLine(id="uncertain", category=Category.UNCERTAIN, ja="x", en="x", wav="uncertain.wav"),
)


def machine(**changes: object) -> MachineState:
    ms = initial_state(config=CONFIG, lines=LINES, agent_version="0.1.0", start_time=START)
    return dataclasses.replace(ms, **{"cloud_connected": True, **changes})


def photo_request(uid: str = UID, purpose: str = "photo") -> SnapshotRequest:
    return SnapshotRequest(ref_id="cmd-photo", request_id=REQUEST_ID, purpose=purpose, uid=uid)


def published(actions: Iterable[Action]) -> list[object]:
    return [a.data for a in actions if isinstance(a, PublishEvent)]


def of_type[T](items: Iterable[object], cls: type[T]) -> list[T]:
    return [item for item in items if isinstance(item, cls)]


def state_changes(actions: Iterable[Action]) -> list[StateChanged]:
    return of_type(published(actions), StateChanged)


def start_photo(now: float = NOW, **changes: object) -> tuple[MachineState, tuple[Action, ...]]:
    return step(machine(**changes), photo_request(), now)


def seeking_photo() -> tuple[MachineState, TakeSnapshot]:
    """A photo Encounter that has left ``waking`` and asked the camera for its picture."""
    ms, actions = start_photo()
    waking = ms.phase
    assert isinstance(waking, Waking)
    arrive_at = NOW + CONFIG.lantern.lantern_fade_in_ms / 1000 + 0.1
    ms, actions = step(ms, ServoArrived(motion_id=waking.motion_id, uid="u2"), arrive_at)
    (take,) = of_type(actions, TakeSnapshot)
    assert isinstance(ms.phase, Seeking)
    return ms, take


# ============================================================================================
# The photo flow
# ============================================================================================


def test_photo_request_wakes_a_sleeping_doll_as_a_manual_encounter() -> None:
    ms, actions = start_photo()
    assert state_changes(actions) == [
        StateChanged(from_=State.SLEEPING, to=State.WAKING, reason=Reason.MANUAL)
    ]
    assert PresenceDetected(source="manual") in published(actions)
    (fade,) = of_type(actions, LanternFade)
    assert fade.level == CONFIG.lantern.lantern_wake_level
    (gaze,) = of_type(actions, GazeTarget)
    assert (gaze.pan_deg, gaze.tilt_deg) == (0.0, 0.0)
    assert isinstance(ms.phase, Waking)
    assert ms.encounter is not None
    assert ms.encounter.photo_request_id == REQUEST_ID
    assert ms.encounter.encounter_id == UID


def test_photo_request_works_in_sleep_mode_too() -> None:
    ms, actions = start_photo(mode=Mode.SLEEP)
    assert isinstance(ms.phase, Waking)
    assert state_changes(actions)[0].to is State.WAKING


def test_leaving_waking_takes_the_snapshot_without_asking_for_a_verdict() -> None:
    ms, take = seeking_photo()
    assert ms.encounter is not None
    assert ms.encounter.attempt is not None
    assert ms.encounter.attempt.snapshot_id == take.snapshot_id


def test_photo_snapshot_is_published_as_a_photo_and_the_doll_rests() -> None:
    ms, take = seeking_photo()
    jpeg = b"\xff\xd8\xff" + b"0" * 20
    nxt, actions = step(
        ms,
        SnapshotReady(snapshot_id=take.snapshot_id, jpeg=jpeg, width=640, height=480, uid="u3"),
        NOW + 5,
    )
    (captured,) = of_type(published(actions), SnapshotCaptured)
    assert captured.request_id == REQUEST_ID
    assert captured.purpose == "photo"
    assert state_changes(actions) == [
        StateChanged(from_=State.SEEKING, to=State.COOLDOWN, reason=Reason.PHOTO_DONE)
    ]
    assert isinstance(nxt.phase, Cooldown)
    assert of_type(published(actions), ReactionPerformed) == []


def test_photo_encounter_ends_through_cooldown_back_to_sleeping() -> None:
    ms, take = seeking_photo()
    ms, _ = step(
        ms,
        SnapshotReady(
            snapshot_id=take.snapshot_id, jpeg=b"\xff\xd8\xff", width=1, height=1, uid="u3"
        ),
        NOW + 5,
    )
    cooldown = ms.phase
    assert isinstance(cooldown, Cooldown)
    ms, actions = step(ms, Tick(uid="u4"), cooldown.until + 0.1)
    assert ms.phase.state is State.SLEEPING
    assert ms.encounter is None
    assert state_changes(actions)[-1] == StateChanged(
        from_=State.COOLDOWN, to=State.SLEEPING, reason=Reason.COOLDOWN_DONE
    )
    assert of_type(published(actions), EncounterEnded)


def test_a_failed_photo_snapshot_goes_back_to_rest_with_reason_error() -> None:
    ms, take = seeking_photo()
    nxt, actions = step(
        ms, SnapshotFailed(snapshot_id=take.snapshot_id, code="camera_failed", uid="u3"), NOW + 5
    )
    assert state_changes(actions) == [
        StateChanged(from_=State.SEEKING, to=State.COOLDOWN, reason=Reason.ERROR)
    ]
    assert [e.code for e in of_type(published(actions), ErrorReported)] == [
        ErrorCode.CAMERA_FAILED
    ]
    assert isinstance(nxt.phase, Cooldown)


def test_a_photo_without_a_snapshot_times_out_into_cooldown() -> None:
    ms, _ = seeking_photo()
    assert ms.encounter is not None and ms.encounter.attempt is not None
    nxt, actions = step(ms, Tick(uid="u3"), ms.encounter.attempt.deadline + 0.1)
    assert state_changes(actions) == [
        StateChanged(from_=State.SEEKING, to=State.COOLDOWN, reason=Reason.TIMEOUT)
    ]
    assert isinstance(nxt.phase, Cooldown)


def test_losing_the_cloud_while_seeking_a_photo_goes_back_to_rest() -> None:
    ms, _ = seeking_photo()
    nxt, actions = step(ms, CloudDisconnected(uid="u3"), NOW + 5)
    assert state_changes(actions) == [
        StateChanged(from_=State.SEEKING, to=State.COOLDOWN, reason=Reason.OFFLINE)
    ]
    assert of_type(published(actions), ReactionPerformed) == []
    assert isinstance(nxt.phase, Cooldown)


def test_leaving_waking_without_the_cloud_skips_the_picture() -> None:
    ms, _ = start_photo()
    ms = dataclasses.replace(ms, cloud_connected=False)
    waking = ms.phase
    assert isinstance(waking, Waking)
    nxt, actions = step(ms, Tick(uid="u2"), waking.deadline + 0.1)
    assert state_changes(actions) == [
        StateChanged(from_=State.WAKING, to=State.COOLDOWN, reason=Reason.OFFLINE)
    ]
    assert of_type(actions, TakeSnapshot) == []
    assert isinstance(nxt.phase, Cooldown)


# ============================================================================================
# Rejected photo requests
# ============================================================================================


def _rejection_codes(actions: Iterable[Action]) -> list[ErrorCode]:
    return [e.code for e in of_type(published(actions), ErrorReported)]


def test_a_look_in_sleeping_is_still_rejected() -> None:
    ms = machine()
    nxt, actions = step(ms, photo_request(purpose="look"), NOW)
    assert nxt is ms
    assert _rejection_codes(actions) == [ErrorCode.COMMAND_REJECTED_STATE]


def test_a_second_photo_during_a_photo_encounter_is_rejected() -> None:
    busy, _ = start_photo()
    nxt, actions = step(busy, photo_request(uid="u9"), NOW + 1)
    assert nxt is busy
    assert _rejection_codes(actions) == [ErrorCode.COMMAND_REJECTED_STATE]


def test_a_photo_in_conversing_is_rejected() -> None:
    ms = machine(
        phase=Conversing(session_id="sess-1", deadline=NOW + 100),
        encounter=Encounter(encounter_id="e1"),
    )
    nxt, actions = step(ms, photo_request(), NOW)
    assert nxt is ms
    assert _rejection_codes(actions) == [ErrorCode.COMMAND_REJECTED_STATE]


# ============================================================================================
# A photo during a visit (remote-feedback F1)
# ============================================================================================


JPEG = b"\xff\xd8\xff" + b"0" * 20


def pir_seeking() -> tuple[MachineState, TakeSnapshot]:
    """A PIR visit in ``seeking`` that waits for its first scan snapshot."""
    ms, _ = step(machine(), PirRising(uid="pir-1"), NOW)
    waking = ms.phase
    assert isinstance(waking, Waking)
    arrive_at = NOW + CONFIG.lantern.lantern_fade_in_ms / 1000 + 0.1
    ms, actions = step(ms, ServoArrived(motion_id=waking.motion_id, uid="u2"), arrive_at)
    (take,) = of_type(actions, TakeSnapshot)
    assert isinstance(ms.phase, Seeking)
    return ms, take


def photo_in_visit() -> tuple[MachineState, TakeSnapshot, tuple[Action, ...]]:
    ms, _ = pir_seeking()
    nxt, actions = step(ms, photo_request(uid="u5"), NOW + 3)
    (take,) = of_type(actions, TakeSnapshot)
    return nxt, take, actions


def test_a_photo_during_a_visit_takes_one_picture_and_changes_nothing_else() -> None:
    ms, _ = pir_seeking()
    nxt, take, actions = photo_in_visit()
    assert state_changes(actions) == []
    assert _rejection_codes(actions) == []
    assert of_type(actions, GazeTarget) == [] and of_type(actions, LanternFade) == []
    assert nxt.phase == ms.phase
    assert nxt.encounter == ms.encounter
    assert nxt.photo is not None
    assert nxt.photo.request_id == REQUEST_ID
    assert nxt.photo.snapshot_id == take.snapshot_id
    assert nxt.camera is not None


def test_the_photo_is_published_with_its_request_id_and_the_visit_goes_on() -> None:
    ms, take, _ = photo_in_visit()
    ready = SnapshotReady(snapshot_id=take.snapshot_id, jpeg=JPEG, width=640, height=480, uid="u6")
    nxt, actions = step(ms, ready, NOW + 4)
    (captured,) = of_type(published(actions), SnapshotCaptured)
    assert (captured.request_id, captured.purpose) == (REQUEST_ID, "photo")
    assert captured.snapshot_id == take.snapshot_id
    assert state_changes(actions) == []
    assert nxt.phase == ms.phase
    assert nxt.encounter == ms.encounter
    assert nxt.photo is None
    # The scan snapshot is still awaited, as before the photo.
    assert ms.encounter is not None and nxt.encounter is not None
    assert nxt.encounter.attempt == ms.encounter.attempt


def test_the_scan_snapshot_is_still_judged_after_a_photo() -> None:
    ms, scan = pir_seeking()
    ms, _ = step(ms, photo_request(uid="u5"), NOW + 3)
    ready = SnapshotReady(snapshot_id=scan.snapshot_id, jpeg=JPEG, width=640, height=480, uid="u6")
    nxt, actions = step(ms, ready, NOW + 4)
    (captured,) = of_type(published(actions), SnapshotCaptured)
    assert captured.snapshot_id == scan.snapshot_id
    assert captured.purpose is None and captured.request_id is None
    assert nxt.photo == ms.photo


def test_a_photo_that_finishes_after_the_visit_ended_is_still_published() -> None:
    ms, take, _ = photo_in_visit()
    ms = dataclasses.replace(ms, phase=machine().phase, encounter=None)
    ready = SnapshotReady(snapshot_id=take.snapshot_id, jpeg=JPEG, width=640, height=480, uid="u6")
    nxt, actions = step(ms, ready, NOW + 4)
    (captured,) = of_type(published(actions), SnapshotCaptured)
    assert captured.request_id == REQUEST_ID
    assert nxt.photo is None
    assert nxt.camera is None


def test_a_second_photo_while_one_is_outstanding_is_rejected() -> None:
    ms, _, _ = photo_in_visit()
    nxt, actions = step(ms, photo_request(uid="u7"), NOW + 3.5)
    assert nxt is ms
    assert _rejection_codes(actions) == [ErrorCode.COMMAND_REJECTED_STATE]
    assert of_type(actions, TakeSnapshot) == []


def test_a_failed_photo_is_reported_and_allows_the_next_one() -> None:
    ms, take, _ = photo_in_visit()
    failed = SnapshotFailed(snapshot_id=take.snapshot_id, code="camera_failed", uid="u6")
    nxt, actions = step(ms, failed, NOW + 4)
    assert _rejection_codes(actions) == [ErrorCode.CAMERA_FAILED]
    assert state_changes(actions) == []
    assert nxt.phase == ms.phase
    assert nxt.photo is None


def test_a_lost_photo_result_expires_at_its_deadline() -> None:
    ms, _, _ = photo_in_visit()
    assert ms.photo is not None
    before, _ = step(ms, Tick(uid="u6"), ms.photo.deadline - 0.01)
    assert before.photo == ms.photo
    after, _ = step(before, Tick(uid="u7"), ms.photo.deadline)
    assert after.photo is None


def test_a_photo_in_cooldown_is_rejected() -> None:
    ms = machine(
        phase=Cooldown(motion_id="m", glide_deadline=NOW + 3, until=NOW + 20, manual=False),
        encounter=Encounter(encounter_id="e1"),
    )
    nxt, actions = step(ms, photo_request(), NOW)
    assert nxt is ms
    assert _rejection_codes(actions) == [ErrorCode.COMMAND_REJECTED_STATE]


def test_a_look_during_a_visit_is_rejected() -> None:
    ms, _ = pir_seeking()
    nxt, actions = step(ms, photo_request(purpose="look"), NOW + 3)
    assert nxt is ms
    assert _rejection_codes(actions) == [ErrorCode.COMMAND_REJECTED_STATE]


# ============================================================================================
# Remote speak
# ============================================================================================


def speak(*, remote: bool, url: str | None = WAV_URL) -> Speak:
    return Speak(ref_id="cmd-say", line_id=None, audio_url=url, remote=remote, uid=UID)


def test_a_remote_speak_plays_the_wav_in_sleeping() -> None:
    ms = machine()
    nxt, actions = step(ms, speak(remote=True), NOW)
    (play,) = of_type(actions, PlayAudioUrl)
    assert play.url == WAV_URL
    assert nxt.phase.state is State.SLEEPING
    assert _rejection_codes(actions) == []


def test_a_speak_with_a_url_that_is_not_remote_is_still_rejected_without_a_family_verdict() -> (
    None
):
    ms = machine()
    nxt, actions = step(ms, speak(remote=False), NOW)
    assert nxt is ms
    assert _rejection_codes(actions) == [ErrorCode.SPEAK_REJECTED]
    assert of_type(actions, PlayAudioUrl) == []


def test_a_remote_speak_is_rejected_while_conversing() -> None:
    ms = machine(
        phase=Conversing(session_id="sess-1", deadline=NOW + 100),
        encounter=Encounter(encounter_id="e1"),
    )
    nxt, actions = step(ms, speak(remote=True), NOW)
    assert nxt is ms
    assert _rejection_codes(actions) == [ErrorCode.COMMAND_REJECTED_STATE]


def test_a_second_remote_speak_while_audio_is_busy_is_rejected() -> None:
    ms = machine()
    ms, _ = step(ms, speak(remote=True), NOW)
    nxt, actions = step(ms, dataclasses.replace(speak(remote=True), uid="u2"), NOW + 1)
    assert nxt is ms
    assert _rejection_codes(actions) == [ErrorCode.AUDIO_BUSY]


def test_status_is_published_with_every_transition_of_a_photo() -> None:
    _, actions = start_photo()
    assert [a for a in actions if isinstance(a, PublishStatus)]
