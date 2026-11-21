"""Shared value types of the device agent: enums, Events and Actions.

These types live in their own module so that the pure core (``state_machine``, ``glide``,
``head_tracker``), the Dispatcher, the adapters, the fakes and the tests can all import them
without import cycles. ``messages.py`` imports the enums from here; this module refers to the
payload types of ``messages.py`` only for type checking.

Every type is a frozen dataclass holding only immutable values, so ``step()`` can stay pure:
it builds new values and never mutates its arguments (R1.1, R1.2). Enum values are the wire
strings of ``docs/schema.md``, so a ``StrEnum`` member can be written to JSON as it is.

Fields that could carry private data (snapshot bytes, the ``audioUrl`` with its query string)
use ``repr=False``, so an accidental ``repr()`` in a log line cannot leak them (R13.6).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    # Only for annotations: messages.py imports this module, so a runtime import would cycle.
    from warashi_agent.messages import EventData, StatusReport


# --------------------------------------------------------------------------------------------
# Enums (values are the wire strings of docs/schema.md)
# --------------------------------------------------------------------------------------------


class State(StrEnum):
    """State of the State_Machine, as reported in ``state.changed`` and ``status.report``."""

    SLEEPING = "sleeping"
    WAKING = "waking"
    SEEKING = "seeking"
    GAZING = "gazing"
    GREETING = "greeting"
    WARNING = "warning"
    UNCERTAIN = "uncertain"
    COOLDOWN = "cooldown"
    # The P1 voice conversation (voice-conversation R11); entered only when
    # ``conversation_enabled`` is true.
    CONVERSING = "conversing"


class Mode(StrEnum):
    """Mode set by ``mode.set``. ``sleep`` differs from the State ``sleeping``."""

    GUARD = "guard"
    SLEEP = "sleep"


class Category(StrEnum):
    """Voice_Line category; also the Reaction kind and the Situation_Category."""

    FAMILY = "family"
    STRANGER = "stranger"
    UNCERTAIN = "uncertain"


class Verdict(StrEnum):
    """``judgement.result`` verdict as sent by the cloud, before the thresholds of R4."""

    FAMILY = "family"
    STRANGER = "stranger"
    NO_FACE = "no_face"
    UNCERTAIN = "uncertain"


class AcceptedVerdict(StrEnum):
    """Verdict after the confidence thresholds of R4.

    Kept separate from ``Verdict`` so the type shows whether the thresholds were applied.
    """

    FAMILY = "family"
    STRANGER = "stranger"
    UNCERTAIN = "uncertain"
    NO_FACE = "no_face"


class Reason(StrEnum):
    """``state.changed`` reason, assigned by the R24.4 mapping table."""

    PRESENCE = "presence"
    ARRIVED = "arrived"
    VERDICT = "verdict"
    NO_FACE = "no_face"
    TIMEOUT = "timeout"
    OFFLINE = "offline"
    AUDIO_DONE = "audio_done"
    MANUAL = "manual"
    COOLDOWN_DONE = "cooldown_done"
    ERROR = "error"
    # voice-conversation S7: entered ``conversing`` / left it after a normal end.
    CONVERSATION = "conversation"
    CONVERSATION_DONE = "conversation_done"


class EndReason(StrEnum):
    """``encounter.ended`` reason. ``timeout`` was removed from the contract (R24.1)."""

    COOLDOWN = "cooldown"
    MANUAL = "manual"
    ERROR = "error"


class Axis(StrEnum):
    """Servo axis, used by the Glide_Planner and the Servo_Adapter."""

    PAN = "pan"
    TILT = "tilt"


# --------------------------------------------------------------------------------------------
# Events
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class EventBase:
    """Fields every Event carries.

    Adapters post Events with these placeholders. The Dispatcher replaces both with
    ``dataclasses.replace`` before ``step()`` (R1.5), so the State_Machine never reads a
    random source or a UUID generator itself.
    """

    rand: float = 0.0  # replaced with a value in [0, 1)
    uid: str = ""  # replaced with a fresh UUID v4 string


# Internal_Events: exist only inside the device and never go on the wire (docs/schema.md,
# "Device-internal events (not on the wire)").


@dataclass(frozen=True, kw_only=True)
class Tick(EventBase):
    """Periodic clock event; every deadline is checked on a Tick (R10.3)."""


@dataclass(frozen=True, kw_only=True)
class PirRising(EventBase):
    """PIR output went from low to high (R17.1)."""


@dataclass(frozen=True, kw_only=True)
class PirFalling(EventBase):
    """PIR output went from high to low (R17.2)."""


@dataclass(frozen=True, kw_only=True)
class ServoArrived(EventBase):
    """A glide finished. ``motion_id`` lets the State_Machine ignore stale arrivals (R5.8)."""

    motion_id: str


@dataclass(frozen=True, kw_only=True)
class AudioFinished(EventBase):
    """A playback ended normally (R19.2)."""

    play_id: str


@dataclass(frozen=True, kw_only=True)
class AudioFailed(EventBase):
    """A playback or download failed or was interrupted (R19.3, R19.4, R19.6).

    ``interrupted`` is internal only and is never reported as ``error.reported`` (R20.9).
    """

    play_id: str
    code: Literal["audio_failed", "download_failed", "interrupted"]


@dataclass(frozen=True, kw_only=True)
class SnapshotReady(EventBase):
    """A JPEG of at most ``jpeg_max_bytes`` is available (R18.3).

    ``jpeg`` is hidden from ``repr()`` because image data must never reach a log line (R13.6).
    """

    snapshot_id: str
    jpeg: bytes = field(repr=False)
    width: int
    height: int


@dataclass(frozen=True, kw_only=True)
class SnapshotFailed(EventBase):
    """A snapshot could not be taken (R18.2, R18.4)."""

    snapshot_id: str
    code: Literal["camera_failed", "snapshot_too_large"]


@dataclass(frozen=True, kw_only=True)
class CloudConnected(EventBase):
    """The Cloud_Link came online (R21.3)."""


@dataclass(frozen=True, kw_only=True)
class CloudDisconnected(EventBase):
    """The Cloud_Link went offline (R21.3)."""


@dataclass(frozen=True, kw_only=True)
class AdapterError(EventBase):
    """A hardware adapter failed.

    ``code`` is a code of the ``error.reported`` list in docs/schema.md only (R20.11).
    """

    code: str


# Command_Events: built from a decoded command by the inbound pipeline. ``ref_id`` is the
# command's envelope ``id``, so a rejection can carry it as ``refId`` (R12.12).


@dataclass(frozen=True, kw_only=True)
class FaceBox:
    """Face box of a ``judgement.result`` as fractions of the image.

    Values may lie outside 0..1 on the wire; the Head_Tracker clamps them (R5.1, R22.11).
    """

    left: float
    top: float
    width: float
    height: float


@dataclass(frozen=True, kw_only=True)
class JudgementResult(EventBase):
    """Verdict for one snapshot, matched by ``snapshot_id`` only (R3.3, R3.4)."""

    ref_id: str
    snapshot_id: str
    verdict: Verdict
    confidence: float
    face: FaceBox | None


@dataclass(frozen=True, kw_only=True)
class Speak(EventBase):
    """Say a cached line or a downloaded WAV.

    The command's ``ja`` and ``en`` texts are deliberately not carried: the State_Machine does
    not need them, so no Action or log line can repeat them (R13.6). ``audio_url`` is hidden
    from ``repr()`` because its query string may hold a token.
    """

    ref_id: str
    line_id: str | None
    audio_url: str | None = field(repr=False)


@dataclass(frozen=True, kw_only=True)
class Gaze(EventBase):
    """Manual look command; the angles are clamped by the State_Machine (R12.1)."""

    ref_id: str
    pan_deg: float
    tilt_deg: float


@dataclass(frozen=True, kw_only=True)
class Lantern(EventBase):
    """Manual lantern command; level and fade are clamped by the State_Machine (R12.2)."""

    ref_id: str
    level: float
    fade_ms: int


@dataclass(frozen=True, kw_only=True)
class ModeSet(EventBase):
    """Set the Mode (R12.7 to R12.9)."""

    ref_id: str
    mode: Mode


@dataclass(frozen=True, kw_only=True)
class ConversationStart(EventBase):
    """Start a voice session (S4). ``token`` is a secret, hidden from ``repr()`` (R13.6).

    ``max_s`` and ``silence_s`` are the command's ``maxSeconds`` and ``silenceSeconds``; the
    State_Machine clamps ``max_s`` to ``conversation_max_s``. ``source`` is ``"family_verdict"``
    or ``"manual"``.
    """

    ref_id: str
    session_id: str
    token: str = field(repr=False)
    max_s: int
    silence_s: int
    source: str


@dataclass(frozen=True, kw_only=True)
class ConversationEnd(EventBase):
    """The cloud ends a session (S5). ``reason`` is a ``ConversationEndReason`` wire value."""

    ref_id: str
    session_id: str
    reason: str


@dataclass(frozen=True, kw_only=True)
class SnapshotRequest(EventBase):
    """Take a snapshot for a voice session (S6); valid in ``conversing`` only."""

    ref_id: str
    request_id: str


@dataclass(frozen=True, kw_only=True)
class ConversationFinished(EventBase):
    """The conversation adapter ended, exactly once per session (R12.8).

    Internal: never on the wire. ``reason`` is a ``ConversationEndReason`` wire value or
    ``"adapter_failed"``.
    """

    session_id: str
    reason: str


InternalEvent = (
    Tick
    | PirRising
    | PirFalling
    | ServoArrived
    | AudioFinished
    | AudioFailed
    | SnapshotReady
    | SnapshotFailed
    | CloudConnected
    | CloudDisconnected
    | AdapterError
    | ConversationFinished
)
CommandEvent = (
    JudgementResult
    | Speak
    | Gaze
    | Lantern
    | ModeSet
    | ConversationStart
    | ConversationEnd
    | SnapshotRequest
)
Event = InternalEvent | CommandEvent


# --------------------------------------------------------------------------------------------
# Actions (outputs of step(); the Dispatcher routes each one to an adapter or the Cloud_Link)
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class LanternFade:
    """Fade the lantern to ``level`` over ``fade_ms`` (R16.1)."""

    level: float
    fade_ms: int


@dataclass(frozen=True, kw_only=True)
class GazeTarget:
    """Glide the head to an angle relative to the calibrated center.

    The State_Machine always clamps the angles to the Calibrated_Range before emitting (R5.7);
    the Glide_Planner clamps again as a second guard (R14.1).
    """

    pan_deg: float
    tilt_deg: float
    motion_id: str


@dataclass(frozen=True, kw_only=True)
class ReleaseServos:
    """Detach both servos (R8.2, R15.5)."""


@dataclass(frozen=True, kw_only=True)
class TakeSnapshot:
    """Take one snapshot; the Camera_Adapter answers with exactly one result (R18.8)."""

    snapshot_id: str


@dataclass(frozen=True, kw_only=True)
class PlayLine:
    """Play a cached Voice_Line (R19.1)."""

    line_id: str
    play_id: str


@dataclass(frozen=True, kw_only=True)
class PlayAudioUrl:
    """Download and play a WAV; only emitted while the Situation_Category is ``family`` (R13.2).

    ``url`` is hidden from ``repr()`` and printed only through the redaction module, because
    its query string may hold a token (R13.6).
    """

    url: str = field(repr=False)
    play_id: str


@dataclass(frozen=True, kw_only=True)
class PublishEvent:
    """Publish an event; the Dispatcher wraps ``data`` in an envelope (R20.4).

    The wire ``type`` comes from the payload class, so it is defined in exactly one place.
    """

    data: EventData
    encounter_id: str | None

    @property
    def type(self) -> str:
        return self.data.TYPE


@dataclass(frozen=True, kw_only=True)
class PublishStatus:
    """Publish a ``status.report``; its envelope always carries ``encounterId: null`` (R20.4)."""

    data: StatusReport


@dataclass(frozen=True, kw_only=True)
class StartConversation:
    """Start the conversation adapter (R11.5). ``token`` is hidden from ``repr()``."""

    session_id: str
    token: str = field(repr=False)
    max_s: int
    silence_s: int


@dataclass(frozen=True, kw_only=True)
class StopConversation:
    """Stop the conversation adapter; safe to repeat (R11.8, R12.9)."""

    session_id: str


Action = (
    LanternFade
    | GazeTarget
    | ReleaseServos
    | TakeSnapshot
    | PlayLine
    | PlayAudioUrl
    | PublishEvent
    | PublishStatus
    | StartConversation
    | StopConversation
)
