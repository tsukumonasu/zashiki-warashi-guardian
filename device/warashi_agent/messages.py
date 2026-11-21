"""Message_Codec: encode and decode the Wire_Messages of ``docs/schema.md``.

``docs/schema.md`` is the contract. This module mirrors it in one place: the type registry
``REGISTRY`` maps every wire ``type`` to its direction, its payload dataclass and its field
specs, and ``encode`` / ``decode`` are generic over that registry. Adding or changing a type
therefore means changing ``docs/schema.md`` first and then one registry entry here
(tech.md "Contract first"; R24.2 checks the two against each other).

``decode`` never raises (R22.6). It returns ``Valid``, ``Ignored`` or ``Malformed``, and the
inbound pipeline (``inbound.py``) turns the last two into ``error.reported``. Problem texts
name the broken rule and the field path but never a value, so a malformed message cannot
leak its content into a log line (R13.6).

Interim behaviour that ``docs/schema.md`` does not state yet (design rows F1 and F4, waiting
for a requirements decision):

- F1: ``ts`` must be an ISO 8601 timestamp with a UTC offset; anything else is malformed.
- F4: undefined top-level envelope fields are ignored and dropped, like undefined ``data``
  fields (R13.7).

Only the standard library is used.
"""

import json
import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field, fields
from datetime import UTC, datetime
from enum import Enum, StrEnum
from typing import Any, ClassVar, Literal

from warashi_agent.model import Category, EndReason, FaceBox, Mode, Reason, State, Verdict

CONTRACT_VERSION = 1
"""``v`` stays 1: no version of the contract has been deployed yet (R24.3)."""

MAX_MESSAGE_BYTES = 131_072
"""Incoming messages above this size are malformed, a safe input bound (R22.6)."""

ERROR_MESSAGE_MAX_CODE_POINTS = 200
"""The sender cuts ``error.reported.message`` to this many code points (R22.10)."""


class ErrorCode(StrEnum):
    """The only codes the device publishes in ``error.reported`` (R24.1, R24.5).

    Same order as the "``error.reported`` codes" table of ``docs/schema.md``.
    """

    UNKNOWN_TYPE = "unknown_type"
    UNSUPPORTED_VERSION = "unsupported_version"
    MALFORMED_MESSAGE = "malformed_message"
    WRONG_DEVICE = "wrong_device"
    SPEAK_REJECTED = "speak_rejected"
    AUDIO_BUSY = "audio_busy"
    COMMAND_REJECTED_STATE = "command_rejected_state"
    UNKNOWN_LINE = "unknown_line"
    VOICE_LINE_MISSING = "voice_line_missing"
    VOICE_LINE_INVALID = "voice_line_invalid"
    VOICE_FILE_MISSING = "voice_file_missing"
    AUDIO_FAILED = "audio_failed"
    DOWNLOAD_FAILED = "download_failed"
    AUDIO_DEVICE_MISSING = "audio_device_missing"
    CAMERA_MISSING = "camera_missing"
    CAMERA_FAILED = "camera_failed"
    SNAPSHOT_TOO_LARGE = "snapshot_too_large"
    INTERNAL_ERROR = "internal_error"
    ADAPTER_FAILED = "adapter_failed"
    CONVERSATION_FAILED = "conversation_failed"
    MICROPHONE_FAILED = "microphone_failed"


class ConversationEndReason(StrEnum):
    """Why a voice session ended (``docs/schema.md``, voice-conversation S3)."""

    SILENCE = "silence"
    LIMIT = "limit"
    STRANGER = "stranger"
    USER = "user"
    MANUAL = "manual"
    LANGUAGE = "language"
    UNSAFE_OUTPUT = "unsafe_output"
    ERROR = "error"
    NO_CLIENT = "no_client"
    OFFLINE = "offline"


class ConversationSource(StrEnum):
    """What started a voice session (``conversation.start.source``)."""

    FAMILY_VERDICT = "family_verdict"
    MANUAL = "manual"


ID_PATTERN = re.compile(r"[A-Za-z0-9-]{1,64}")
"""``sessionId`` and ``requestId`` (S4 to S6). ``fullmatch`` is used, so no newline slips in."""

TOKEN_MAX_LENGTH = 128
MAX_SECONDS_RANGE = (30, 420)
SILENCE_SECONDS_RANGE = (5, 60)


# --------------------------------------------------------------------------------------------
# Payloads. Field order equals the order of docs/schema.md, which is also the encode order.
# --------------------------------------------------------------------------------------------

# Events (device -> cloud)


@dataclass(frozen=True, kw_only=True)
class PresenceDetected:
    """A new encounter starts. The device emits ``source="pir"`` only in this spec."""

    TYPE: ClassVar[str] = "presence.detected"
    source: Literal["pir", "sound", "manual"]


@dataclass(frozen=True, kw_only=True)
class SnapshotCaptured:
    """A snapshot taken at the given head angles. The image is hidden from ``repr()``."""

    TYPE: ClassVar[str] = "snapshot.captured"
    snapshot_id: str
    width: int
    height: int
    pan_deg: float
    tilt_deg: float
    jpeg_base64: str = field(repr=False)
    request_id: str | None = None  # set only when answering a snapshot.request (S3)


@dataclass(frozen=True, kw_only=True)
class StateChanged:
    """A State_Machine transition with the R24.4 reason. ``from_`` is the wire ``from``."""

    TYPE: ClassVar[str] = "state.changed"
    from_: State
    to: State
    reason: Reason


@dataclass(frozen=True, kw_only=True)
class ReactionPerformed:
    """What the doll actually did; ``offline`` is true without a verdict."""

    TYPE: ClassVar[str] = "reaction.performed"
    kind: Category
    line_id: str | None
    offline: bool


@dataclass(frozen=True, kw_only=True)
class EncounterEnded:
    """The encounter is over."""

    TYPE: ClassVar[str] = "encounter.ended"
    reason: EndReason


@dataclass(frozen=True, kw_only=True)
class ErrorReported:
    """A recoverable problem.

    ``ref_id`` is always written on the wire (null when no incoming message caused the error)
    and decodes as ``None`` when absent (R22.1). ``message`` is cut to 200 code points on
    encode (R22.10).
    """

    TYPE: ClassVar[str] = "error.reported"
    code: ErrorCode
    message: str
    ref_id: str | None


@dataclass(frozen=True, kw_only=True)
class ConversationRequested:
    """The doll asks the cloud for a voice session (S1)."""

    TYPE: ClassVar[str] = "conversation.requested"
    reason: Literal["family_verdict"]


@dataclass(frozen=True, kw_only=True)
class ConversationEnded:
    """The doll left ``conversing`` (S2)."""

    TYPE: ClassVar[str] = "conversation.ended"
    session_id: str
    reason: ConversationEndReason


# Commands (cloud -> device)


@dataclass(frozen=True, kw_only=True)
class JudgementResultData:
    """Verdict for one snapshot. Finite out-of-range numbers are valid (R22.11)."""

    TYPE: ClassVar[str] = "judgement.result"
    snapshot_id: str
    verdict: Verdict
    confidence: float
    face: FaceBox | None


@dataclass(frozen=True, kw_only=True)
class SpeakData:
    """Say a line. Exactly one of ``line_id`` and ``audio_url`` is set (R22.6).

    ``ja``, ``en`` and ``audio_url`` are hidden from ``repr()``: they may hold a nickname or a
    token, and the inbound pipeline drops ``ja`` and ``en`` before the State_Machine (R13.6).
    """

    TYPE: ClassVar[str] = "speak"
    line_id: str | None
    audio_url: str | None = field(repr=False)
    ja: str = field(repr=False)
    en: str = field(repr=False)


@dataclass(frozen=True, kw_only=True)
class GazeData:
    """Look in a direction; the State_Machine clamps the angles (R12.1)."""

    TYPE: ClassVar[str] = "gaze"
    pan_deg: float
    tilt_deg: float


@dataclass(frozen=True, kw_only=True)
class LanternData:
    """Lantern level and fade time; the State_Machine clamps both (R12.2)."""

    TYPE: ClassVar[str] = "lantern"
    level: float
    fade_ms: int


@dataclass(frozen=True, kw_only=True)
class ModeSetData:
    """Set the Mode."""

    TYPE: ClassVar[str] = "mode.set"
    mode: Mode


@dataclass(frozen=True, kw_only=True)
class ConversationStart:
    """Start the audio client for a voice session (S4).

    ``token`` is a secret: it is hidden from ``repr()`` and never logged or published.
    ``max_seconds`` and ``silence_seconds`` are clamped on decode to 30..420 and 5..60.
    """

    TYPE: ClassVar[str] = "conversation.start"
    session_id: str
    token: str = field(repr=False)
    max_seconds: int
    silence_seconds: int
    source: ConversationSource


@dataclass(frozen=True, kw_only=True)
class ConversationEnd:
    """The cloud ends a session (S5). Safe to receive twice."""

    TYPE: ClassVar[str] = "conversation.end"
    session_id: str
    reason: ConversationEndReason


@dataclass(frozen=True, kw_only=True)
class SnapshotRequest:
    """Take a snapshot for a voice session (S6)."""

    TYPE: ClassVar[str] = "snapshot.request"
    request_id: str


# Status (device -> cloud)


@dataclass(frozen=True, kw_only=True)
class StatusReport:
    """Device status; its envelope always carries ``encounterId: null`` (R20.4)."""

    TYPE: ClassVar[str] = "status.report"
    state: State
    mode: Mode
    pan_deg: float
    tilt_deg: float
    lantern: float
    camera_active: bool
    mic_active: bool
    motion_enabled: bool
    uptime_sec: int
    agent_version: str


@dataclass(frozen=True, kw_only=True)
class StatusOffline:
    """Broker last will. Registered so the device can recognise it; never sent by the device."""

    TYPE: ClassVar[str] = "status.offline"


EventData = (
    PresenceDetected
    | SnapshotCaptured
    | StateChanged
    | ReactionPerformed
    | EncounterEnded
    | ErrorReported
    | ConversationRequested
    | ConversationEnded
)
CommandData = (
    JudgementResultData
    | SpeakData
    | GazeData
    | LanternData
    | ModeSetData
    | ConversationStart
    | ConversationEnd
    | SnapshotRequest
)
StatusData = StatusReport | StatusOffline
Payload = EventData | CommandData | StatusData


@dataclass(frozen=True, kw_only=True)
class Envelope:
    """One Wire_Message. ``ts`` is timezone-aware; the wire ``type`` comes from ``data``."""

    v: int = CONTRACT_VERSION
    id: str
    ts: datetime
    device_id: str
    encounter_id: str | None
    data: Payload

    @property
    def type(self) -> str:
        return self.data.TYPE


# --------------------------------------------------------------------------------------------
# Type registry
# --------------------------------------------------------------------------------------------

Direction = Literal["event", "command", "status"]
FieldKind = Literal["str", "int", "number", "bool", "enum", "face"]


@dataclass(frozen=True, kw_only=True)
class FieldSpec:
    """How one ``data`` field looks on the wire and where it lives in the payload class.

    Kinds: ``str``; ``int`` (a JSON integer, never a float or a boolean); ``number`` (a finite
    JSON integer or float, never a boolean, decoded as ``float``); ``bool``; ``enum`` (a string
    from ``allowed_values``, converted to ``enum_type`` when set); ``face`` (the nested face
    box object).
    """

    wire_name: str
    attribute: str
    kind: FieldKind
    nullable: bool = False
    allowed_values: tuple[str, ...] | None = None
    enum_type: type[StrEnum] | None = None
    # False only for error.reported refId: a missing field decodes as None (R22.1).
    required: bool = True
    # Set only for error.reported message: the sender cuts the text (R22.10).
    max_code_points: int | None = None
    # str rules of S4 to S6: ``pattern`` must fullmatch; length bounds count code points.
    pattern: re.Pattern[str] | None = None
    min_length: int | None = None
    max_length: int | None = None
    # int rule of S4: a finite integer outside the range is valid and clamped (R22.11).
    clamp: tuple[int, int] | None = None
    # True for the optional ``snapshot.captured.requestId``: ``None`` is not written at all.
    omit_if_none: bool = False


@dataclass(frozen=True, kw_only=True)
class TypeSpec:
    """One registered wire ``type``."""

    type: str
    direction: Direction
    payload: type
    fields: tuple[FieldSpec, ...]
    # Cross-field rule checked after the fields; returns a problem text or None.
    rule: Callable[[Any], str | None] | None = None


def _enum(wire: str, attr: str, enum_type: type[StrEnum]) -> FieldSpec:
    return FieldSpec(
        wire_name=wire,
        attribute=attr,
        kind="enum",
        allowed_values=tuple(member.value for member in enum_type),
        enum_type=enum_type,
    )


def _str(wire: str, attr: str, *, nullable: bool = False) -> FieldSpec:
    return FieldSpec(wire_name=wire, attribute=attr, kind="str", nullable=nullable)


def _id(wire: str, attr: str) -> FieldSpec:
    return FieldSpec(wire_name=wire, attribute=attr, kind="str", pattern=ID_PATTERN)


def _num(wire: str, attr: str) -> FieldSpec:
    return FieldSpec(wire_name=wire, attribute=attr, kind="number")


def _int(wire: str, attr: str) -> FieldSpec:
    return FieldSpec(wire_name=wire, attribute=attr, kind="int")


def _bool(wire: str, attr: str) -> FieldSpec:
    return FieldSpec(wire_name=wire, attribute=attr, kind="bool")


FACE_FIELDS: tuple[FieldSpec, ...] = (
    _num("left", "left"),
    _num("top", "top"),
    _num("width", "width"),
    _num("height", "height"),
)


def _speak_rule(payload: SpeakData) -> str | None:
    """R22.6: a ``speak`` with both or neither of ``lineId`` and ``audioUrl`` is malformed."""
    if (payload.line_id is None) == (payload.audio_url is None):
        return "data: speak needs exactly one of lineId and audioUrl"
    return None


_TYPE_SPECS: tuple[TypeSpec, ...] = (
    # Events
    TypeSpec(
        type=PresenceDetected.TYPE,
        direction="event",
        payload=PresenceDetected,
        fields=(
            FieldSpec(
                wire_name="source",
                attribute="source",
                kind="enum",
                allowed_values=("pir", "sound", "manual"),
            ),
        ),
    ),
    TypeSpec(
        type=SnapshotCaptured.TYPE,
        direction="event",
        payload=SnapshotCaptured,
        fields=(
            _str("snapshotId", "snapshot_id"),
            _int("width", "width"),
            _int("height", "height"),
            _num("panDeg", "pan_deg"),
            _num("tiltDeg", "tilt_deg"),
            _str("jpegBase64", "jpeg_base64"),
            FieldSpec(
                wire_name="requestId",
                attribute="request_id",
                kind="str",
                nullable=True,
                required=False,
                pattern=ID_PATTERN,
                omit_if_none=True,
            ),
        ),
    ),
    TypeSpec(
        type=StateChanged.TYPE,
        direction="event",
        payload=StateChanged,
        fields=(
            _enum("from", "from_", State),
            _enum("to", "to", State),
            _enum("reason", "reason", Reason),
        ),
    ),
    TypeSpec(
        type=ReactionPerformed.TYPE,
        direction="event",
        payload=ReactionPerformed,
        fields=(
            _enum("kind", "kind", Category),
            _str("lineId", "line_id", nullable=True),
            _bool("offline", "offline"),
        ),
    ),
    TypeSpec(
        type=EncounterEnded.TYPE,
        direction="event",
        payload=EncounterEnded,
        fields=(_enum("reason", "reason", EndReason),),
    ),
    TypeSpec(
        type=ErrorReported.TYPE,
        direction="event",
        payload=ErrorReported,
        fields=(
            _enum("code", "code", ErrorCode),
            FieldSpec(
                wire_name="message",
                attribute="message",
                kind="str",
                max_code_points=ERROR_MESSAGE_MAX_CODE_POINTS,
            ),
            FieldSpec(
                wire_name="refId", attribute="ref_id", kind="str", nullable=True, required=False
            ),
        ),
    ),
    TypeSpec(
        type=ConversationRequested.TYPE,
        direction="event",
        payload=ConversationRequested,
        fields=(
            FieldSpec(
                wire_name="reason",
                attribute="reason",
                kind="enum",
                allowed_values=("family_verdict",),
            ),
        ),
    ),
    TypeSpec(
        type=ConversationEnded.TYPE,
        direction="event",
        payload=ConversationEnded,
        fields=(
            _id("sessionId", "session_id"),
            _enum("reason", "reason", ConversationEndReason),
        ),
    ),
    # Commands
    TypeSpec(
        type=JudgementResultData.TYPE,
        direction="command",
        payload=JudgementResultData,
        fields=(
            _str("snapshotId", "snapshot_id"),
            _enum("verdict", "verdict", Verdict),
            _num("confidence", "confidence"),
            FieldSpec(wire_name="face", attribute="face", kind="face", nullable=True),
        ),
    ),
    TypeSpec(
        type=SpeakData.TYPE,
        direction="command",
        payload=SpeakData,
        fields=(
            _str("lineId", "line_id", nullable=True),
            _str("audioUrl", "audio_url", nullable=True),
            _str("ja", "ja"),
            _str("en", "en"),
        ),
        rule=_speak_rule,
    ),
    TypeSpec(
        type=GazeData.TYPE,
        direction="command",
        payload=GazeData,
        fields=(_num("panDeg", "pan_deg"), _num("tiltDeg", "tilt_deg")),
    ),
    TypeSpec(
        type=LanternData.TYPE,
        direction="command",
        payload=LanternData,
        fields=(_num("level", "level"), _int("fadeMs", "fade_ms")),
    ),
    TypeSpec(
        type=ModeSetData.TYPE,
        direction="command",
        payload=ModeSetData,
        fields=(_enum("mode", "mode", Mode),),
    ),
    TypeSpec(
        type=ConversationStart.TYPE,
        direction="command",
        payload=ConversationStart,
        fields=(
            _id("sessionId", "session_id"),
            FieldSpec(
                wire_name="token",
                attribute="token",
                kind="str",
                min_length=1,
                max_length=TOKEN_MAX_LENGTH,
            ),
            FieldSpec(
                wire_name="maxSeconds",
                attribute="max_seconds",
                kind="int",
                clamp=MAX_SECONDS_RANGE,
            ),
            FieldSpec(
                wire_name="silenceSeconds",
                attribute="silence_seconds",
                kind="int",
                clamp=SILENCE_SECONDS_RANGE,
            ),
            _enum("source", "source", ConversationSource),
        ),
    ),
    TypeSpec(
        type=ConversationEnd.TYPE,
        direction="command",
        payload=ConversationEnd,
        fields=(
            _id("sessionId", "session_id"),
            _enum("reason", "reason", ConversationEndReason),
        ),
    ),
    TypeSpec(
        type=SnapshotRequest.TYPE,
        direction="command",
        payload=SnapshotRequest,
        fields=(_id("requestId", "request_id"),),
    ),
    # Status
    TypeSpec(
        type=StatusReport.TYPE,
        direction="status",
        payload=StatusReport,
        fields=(
            _enum("state", "state", State),
            _enum("mode", "mode", Mode),
            _num("panDeg", "pan_deg"),
            _num("tiltDeg", "tilt_deg"),
            _num("lantern", "lantern"),
            _bool("cameraActive", "camera_active"),
            _bool("micActive", "mic_active"),
            _bool("motionEnabled", "motion_enabled"),
            _int("uptimeSec", "uptime_sec"),
            _str("agentVersion", "agent_version"),
        ),
    ),
    TypeSpec(type=StatusOffline.TYPE, direction="status", payload=StatusOffline, fields=()),
)

REGISTRY: dict[str, TypeSpec] = {spec.type: spec for spec in _TYPE_SPECS}
"""Every wire ``type`` of docs/schema.md (Events, Commands and Status tables)."""


def types_for(direction: Direction) -> frozenset[str]:
    """The registered wire types of one direction; used by the schema table test (R24.2)."""
    return frozenset(spec.type for spec in _TYPE_SPECS if spec.direction == direction)


def _check_registry() -> None:
    """Fail at import if a payload class and its field specs drift apart."""
    if len(REGISTRY) != len(_TYPE_SPECS):
        raise RuntimeError("duplicate wire type in the message registry")
    for spec in _TYPE_SPECS:
        if spec.type != spec.payload.TYPE:
            raise RuntimeError(f"{spec.type}: payload TYPE mismatch")
        attributes = [f.name for f in fields(spec.payload)]
        if attributes != [s.attribute for s in spec.fields]:
            raise RuntimeError(f"{spec.type}: field specs do not match the payload class")


_check_registry()


# --------------------------------------------------------------------------------------------
# Decode results
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class Valid:
    """A message that follows every rule of docs/schema.md."""

    message: Envelope


@dataclass(frozen=True, kw_only=True)
class Ignored:
    """A message that is not processed but not malformed (R22.4, R22.5)."""

    reason: Literal["unsupported_version", "unknown_type"]
    message_id: str | None  # the envelope id when it is a string


@dataclass(frozen=True, kw_only=True)
class Malformed:
    """A message that breaks a rule of R22.6.

    ``problem`` names the rule and the field path, never a value.
    """

    message_id: str | None  # the envelope id when it is readable
    problem: str


DecodeResult = Valid | Ignored | Malformed


# --------------------------------------------------------------------------------------------
# Timestamps
# --------------------------------------------------------------------------------------------


def format_ts(ts: datetime) -> str:
    """Format ``ts`` as ``YYYY-MM-DDTHH:MM:SS.mmmZ`` in UTC (R22.3).

    Built by hand instead of ``strftime`` because ``%Y`` does not zero-pad years below 1000 on
    every platform. Sub-millisecond digits are dropped.
    """
    if ts.tzinfo is None or ts.utcoffset() is None:
        raise ValueError("ts must be timezone-aware")
    t = ts.astimezone(UTC)
    return (
        f"{t.year:04d}-{t.month:02d}-{t.day:02d}"
        f"T{t.hour:02d}:{t.minute:02d}:{t.second:02d}.{t.microsecond // 1000:03d}Z"
    )


def parse_ts(text: str) -> datetime:
    """Parse an ISO 8601 timestamp with a UTC offset into a UTC datetime (interim rule F1).

    Raises ``ValueError`` for anything else, including a timestamp without an offset.
    """
    try:
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("timestamp has no UTC offset")
        return parsed.astimezone(UTC)
    except OverflowError as exc:  # the offset moves the time outside the datetime range
        raise ValueError("timestamp out of range") from exc


# --------------------------------------------------------------------------------------------
# Encode
# --------------------------------------------------------------------------------------------


def _encode_value(spec: FieldSpec, value: Any) -> Any:
    if value is None:
        return None
    if spec.kind == "enum":
        return value.value if isinstance(value, Enum) else value
    if spec.kind == "face":
        return _encode_fields(FACE_FIELDS, value)
    if spec.max_code_points is not None:
        return value[: spec.max_code_points]  # str slicing counts code points
    return value


def _encode_fields(specs: tuple[FieldSpec, ...], obj: object) -> dict[str, Any]:
    return {
        s.wire_name: _encode_value(s, getattr(obj, s.attribute))
        for s in specs
        if not (s.omit_if_none and getattr(obj, s.attribute) is None)
    }


def encode(envelope: Envelope) -> bytes:
    """Encode an envelope as compact UTF-8 JSON with exactly the fields of docs/schema.md.

    Fields appear in schema order. ``refId`` is always written for ``error.reported``, and
    ``message`` is cut to 200 code points (R22.1, R22.10). Raises ``ValueError`` for a
    non-finite number or a naive ``ts``; callers wrap ``publish`` so this cannot reach the loop.
    """
    spec = REGISTRY[envelope.data.TYPE]
    obj = {
        "v": envelope.v,
        "id": envelope.id,
        "ts": format_ts(envelope.ts),
        "deviceId": envelope.device_id,
        "encounterId": envelope.encounter_id,
        "type": spec.type,
        "data": _encode_fields(spec.fields, envelope.data),
    }
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return text.encode("utf-8")


# --------------------------------------------------------------------------------------------
# Decode
# --------------------------------------------------------------------------------------------


class _InvalidError(Exception):
    """Internal signal for a broken rule; ``decode`` turns it into ``Malformed``."""

    def __init__(self, problem: str) -> None:
        super().__init__(problem)
        self.problem = problem


def _parse(raw: bytes | bytearray | memoryview | str) -> tuple[Any, bool]:
    """Decode order step 1: size, UTF-8 and JSON.

    Returns the parsed value and whether it contains a non-finite number (``NaN``,
    ``Infinity``, ``-Infinity`` or an overflowing float such as ``1e400``). Such numbers do
    not abort parsing, so ``decode`` can still read the envelope ``id`` for ``refId``
    (R12.10) before it rejects the message.
    """
    non_finite = False

    def parse_constant(_name: str) -> float:
        nonlocal non_finite
        non_finite = True
        return math.nan

    def parse_float(text: str) -> float:
        nonlocal non_finite
        value = float(text)
        if not math.isfinite(value):  # for example 1e400
            non_finite = True
        return value

    if isinstance(raw, str):
        try:
            raw = raw.encode("utf-8")
        except UnicodeEncodeError:
            raise _InvalidError("not valid UTF-8") from None
    elif not isinstance(raw, bytes | bytearray | memoryview):
        raise _InvalidError("input is not bytes")
    data = bytes(raw)
    if len(data) > MAX_MESSAGE_BYTES:
        raise _InvalidError(f"message larger than {MAX_MESSAGE_BYTES} bytes")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise _InvalidError("not valid UTF-8") from None
    try:
        value = json.loads(text, parse_constant=parse_constant, parse_float=parse_float)
    except RecursionError:
        raise _InvalidError("JSON nested too deeply") from None
    except ValueError:  # JSONDecodeError, and integers beyond the int digit limit
        raise _InvalidError("not valid JSON") from None
    return value, non_finite


def _finite_float(value: int | float, where: str) -> float:
    try:
        number = float(value)
    except OverflowError:  # an integer too large for a float
        raise _InvalidError(f"{where}: non-finite number") from None
    if not math.isfinite(number):
        raise _InvalidError(f"{where}: non-finite number")
    return number


def _decode_value(spec: FieldSpec, value: Any, where: str) -> Any:
    """Check one present, non-null value against its kind. ``bool`` is never a number."""
    match spec.kind:
        case "str":
            if isinstance(value, str):
                if spec.pattern is not None and spec.pattern.fullmatch(value) is None:
                    raise _InvalidError(f"{where}: does not match the id pattern")
                if spec.min_length is not None and len(value) < spec.min_length:
                    raise _InvalidError(f"{where}: too short")
                if spec.max_length is not None and len(value) > spec.max_length:
                    raise _InvalidError(f"{where}: too long")
                return value
        case "int":
            if type(value) is int:
                if spec.clamp is not None:
                    return max(spec.clamp[0], min(spec.clamp[1], value))
                return value
        case "number":
            if type(value) is int or type(value) is float:
                return _finite_float(value, where)
        case "bool":
            if type(value) is bool:
                return value
        case "enum":
            if isinstance(value, str):
                if spec.allowed_values is None or value not in spec.allowed_values:
                    raise _InvalidError(f"{where}: value outside the allowed values")
                return spec.enum_type(value) if spec.enum_type is not None else value
        case "face":
            if isinstance(value, dict):
                return FaceBox(**_decode_fields(FACE_FIELDS, value, where))
    raise _InvalidError(f"{where}: wrong type")


def _decode_fields(specs: tuple[FieldSpec, ...], obj: dict[str, Any], path: str) -> dict[str, Any]:
    """Decode the defined fields of ``obj``. Undefined fields are dropped (R13.7)."""
    values: dict[str, Any] = {}
    for spec in specs:
        where = f"{path}.{spec.wire_name}"
        if spec.wire_name not in obj:
            if spec.required:
                raise _InvalidError(f"{where}: missing")
            values[spec.attribute] = None
            continue
        value = obj[spec.wire_name]
        if value is None:
            if not spec.nullable:
                raise _InvalidError(f"{where}: null not allowed")
            values[spec.attribute] = None
            continue
        values[spec.attribute] = _decode_value(spec, value, where)
    return values


def _require_str(obj: dict[str, Any], key: str, *, nullable: bool = False) -> str | None:
    if key not in obj:
        raise _InvalidError(f"{key}: missing")
    value = obj[key]
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise _InvalidError(f"{key}: wrong type")
    return value


def _decode_object(obj: dict[str, Any], message_id: str | None) -> DecodeResult:
    """Decode order steps 2 to 8 on a parsed top-level object."""
    # Steps 2 and 3: version. A higher integer v is ignored before any other check (R22.4).
    v = obj.get("v")
    if type(v) is int and v > CONTRACT_VERSION:
        return Ignored(reason="unsupported_version", message_id=message_id)
    if type(v) is not int or v < 1:
        raise _InvalidError("v: not an integer >= 1")

    # Step 4: envelope fields other than type and data. Undefined top-level fields are
    # ignored (interim rule F4).
    envelope_id = _require_str(obj, "id")
    ts_text = _require_str(obj, "ts")
    try:
        ts = parse_ts(ts_text)
    except ValueError:
        raise _InvalidError("ts: not an ISO 8601 timestamp with a UTC offset") from None
    device_id = _require_str(obj, "deviceId")
    encounter_id = _require_str(obj, "encounterId", nullable=True)

    # Step 5: an unknown type is ignored without validating data (R22.5).
    wire_type = _require_str(obj, "type")
    spec = REGISTRY.get(wire_type)
    if spec is None:
        return Ignored(reason="unknown_type", message_id=envelope_id)

    # Steps 6 to 8: data fields; finite out-of-range numbers stay valid (R22.11).
    data = obj.get("data")
    if not isinstance(data, dict):
        raise _InvalidError("data: missing or not an object")
    payload = spec.payload(**_decode_fields(spec.fields, data, "data"))
    if spec.rule is not None and (problem := spec.rule(payload)) is not None:
        raise _InvalidError(problem)

    return Valid(
        message=Envelope(
            v=v,
            id=envelope_id,
            ts=ts,
            device_id=device_id,
            encounter_id=encounter_id,
            data=payload,
        )
    )


def decode(raw: bytes | bytearray | memoryview | str) -> DecodeResult:
    """Decode one incoming message. Never raises (R22.6, R29.6).

    Returns ``Ignored`` for a higher ``v`` or an undefined ``type`` (R22.4, R22.5), and
    ``Malformed`` for every rule of R22.6, with the envelope ``id`` when it is a string.
    """
    try:
        obj, non_finite = _parse(raw)
    except _InvalidError as exc:
        return Malformed(message_id=None, problem=exc.problem)
    raw_id = obj.get("id") if isinstance(obj, dict) else None
    message_id = raw_id if isinstance(raw_id, str) else None
    # Still step 1: a non-finite number anywhere wins over v > 1 and an unknown type.
    if non_finite:
        return Malformed(message_id=message_id, problem="non-finite number")
    if not isinstance(obj, dict):
        return Malformed(message_id=None, problem="top level is not a JSON object")
    try:
        return _decode_object(obj, message_id)
    except _InvalidError as exc:
        return Malformed(message_id=message_id, problem=exc.problem)
