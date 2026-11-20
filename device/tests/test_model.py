"""Unit tests for the shared value types in warashi_agent.model (task 2.3).

The enum values are written to the wire as they are, so each enum is compared with the strings
transcribed from docs/schema.md. Events and Actions must be frozen so that step() can stay pure
(R1.1, R1.2), and fields that may carry private data must stay out of repr() (R13.6).
"""

from __future__ import annotations

import dataclasses
from enum import StrEnum

import pytest

from warashi_agent.model import (
    AcceptedVerdict,
    AdapterError,
    AudioFailed,
    AudioFinished,
    Axis,
    Category,
    CloudConnected,
    CloudDisconnected,
    EndReason,
    FaceBox,
    Gaze,
    GazeTarget,
    JudgementResult,
    Lantern,
    LanternFade,
    Mode,
    ModeSet,
    PirFalling,
    PirRising,
    PlayAudioUrl,
    PlayLine,
    PublishEvent,
    PublishStatus,
    Reason,
    ReleaseServos,
    ServoArrived,
    SnapshotFailed,
    SnapshotReady,
    Speak,
    State,
    TakeSnapshot,
    Tick,
    Verdict,
)

# Wire strings transcribed from docs/schema.md. A contract edit must be mirrored here.
SCHEMA_ENUMS: list[tuple[type[StrEnum], set[str]]] = [
    # "Shared definitions", State
    (
        State,
        {
            "sleeping",
            "waking",
            "seeking",
            "gazing",
            "greeting",
            "warning",
            "uncertain",
            "conversing",
            "cooldown",
        },
    ),
    # status.report.mode and mode.set.mode
    (Mode, {"guard", "sleep"}),
    # reaction.performed.kind
    (Category, {"family", "stranger", "uncertain"}),
    # judgement.result.verdict
    (Verdict, {"family", "stranger", "no_face", "uncertain"}),
    # "`state.changed` reasons" table
    (
        Reason,
        {
            "presence",
            "arrived",
            "verdict",
            "no_face",
            "timeout",
            "offline",
            "audio_done",
            "manual",
            "cooldown_done",
            "error",
        },
    ),
    # encounter.ended.reason (the draft value "timeout" was removed)
    (EndReason, {"cooldown", "manual", "error"}),
]


@pytest.mark.parametrize(("enum", "wire"), SCHEMA_ENUMS, ids=[e.__name__ for e, _ in SCHEMA_ENUMS])
def test_enum_values_equal_schema_wire_strings(enum: type[StrEnum], wire: set[str]) -> None:
    assert {member.value for member in enum} == wire


def test_accepted_verdict_uses_the_verdict_wire_strings() -> None:
    # Not on the wire itself, but its values must match Verdict so reactions map 1:1 (R4).
    assert {m.value for m in AcceptedVerdict} == {m.value for m in Verdict}


def test_axis_values() -> None:
    assert {m.value for m in Axis} == {"pan", "tilt"}


def test_enum_members_compare_equal_to_their_wire_string() -> None:
    # StrEnum members can be written to JSON without conversion.
    assert State.COOLDOWN == "cooldown"
    assert Reason.COOLDOWN_DONE == "cooldown_done"
    assert EndReason.ERROR == "error"


def test_event_base_placeholders() -> None:
    # Adapters post these placeholders; the Dispatcher replaces them (R1.5).
    tick = Tick()
    assert tick.rand == 0.0
    assert tick.uid == ""


@dataclasses.dataclass(frozen=True)
class _StubPayload:
    """Stand-in for a messages.py payload; PublishEvent only needs its TYPE."""

    TYPE = "presence.detected"


FACE = FaceBox(left=0.1, top=0.2, width=0.3, height=0.4)

EVENTS = [
    Tick(),
    PirRising(),
    PirFalling(),
    ServoArrived(motion_id="motion-1-u"),
    AudioFinished(play_id="play-1-u"),
    AudioFailed(play_id="play-1-u", code="audio_failed"),
    SnapshotReady(snapshot_id="snap-1-u", jpeg=b"\xff\xd8\xff\xd9", width=640, height=480),
    SnapshotFailed(snapshot_id="snap-1-u", code="camera_failed"),
    CloudConnected(),
    CloudDisconnected(),
    AdapterError(code="adapter_failed"),
    JudgementResult(
        ref_id="r", snapshot_id="snap-1-u", verdict=Verdict.FAMILY, confidence=0.9, face=FACE
    ),
    Speak(ref_id="r", line_id="uncertain", audio_url=None),
    Gaze(ref_id="r", pan_deg=1.0, tilt_deg=2.0),
    Lantern(ref_id="r", level=0.5, fade_ms=100),
    ModeSet(ref_id="r", mode=Mode.SLEEP),
]

ACTIONS = [
    LanternFade(level=0.8, fade_ms=1500),
    GazeTarget(pan_deg=0.0, tilt_deg=0.0, motion_id="motion-1-u"),
    ReleaseServos(),
    TakeSnapshot(snapshot_id="snap-1-u"),
    PlayLine(line_id="uncertain", play_id="play-1-u"),
    PlayAudioUrl(url="https://example.invalid/a.wav", play_id="play-1-u"),
    PublishEvent(data=_StubPayload(), encounter_id=None),
    PublishStatus(data=_StubPayload()),
]


@pytest.mark.parametrize("value", [*EVENTS, FACE, *ACTIONS], ids=lambda v: type(v).__name__)
def test_events_and_actions_are_frozen(value: object) -> None:
    assert dataclasses.is_dataclass(value)
    first_field = next(iter(dataclasses.fields(value)), None)
    name = first_field.name if first_field else "rand"
    with pytest.raises(dataclasses.FrozenInstanceError):
        setattr(value, name, None)


def test_publish_event_type_comes_from_the_payload() -> None:
    assert PublishEvent(data=_StubPayload(), encounter_id="e").type == "presence.detected"


def test_snapshot_ready_repr_hides_the_jpeg_bytes() -> None:
    jpeg = b"\xff\xd8ZQXJsecretimage\xff\xd9"
    text = repr(SnapshotReady(snapshot_id="snap-1-u", jpeg=jpeg, width=640, height=480))
    assert "ZQXJ" not in text
    assert repr(jpeg) not in text
    assert "jpeg" not in text
    assert "snap-1-u" in text  # the id is still useful in logs


def test_play_audio_url_repr_hides_the_url() -> None:
    url = "https://example.invalid/a.wav?token=ZQXJsecrettoken"
    text = repr(PlayAudioUrl(url=url, play_id="play-1-u"))
    assert "example.invalid" not in text
    assert "ZQXJ" not in text
    assert "url" not in text
    assert "play-1-u" in text
