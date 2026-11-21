"""Inbound pipeline: from an encoded Wire_Message to a Command_Event or an error to publish.

The Dispatcher hands every message it receives from the Cloud_Link to ``route_inbound``
and acts on the result: it publishes an ``ErrorToPublish`` as ``error.reported`` and posts a
Command_Event onto its queue (R21.8). Keeping the pipeline here, as pure functions over
immutable values, means the drop rules and their order can be tested without threads, a
queue or a clock.

The steps run in the order R21.8 fixes and stop at the first step that drops the message:

1. decode with the Message_Codec; an ignored or malformed result is dropped and reported
   (R22.4 to R22.6, R12.10);
2. an event or status type received as a command is dropped as ``unknown_type``;
3. a command for another ``deviceId`` is dropped as ``wrong_device`` (R22.7);
4. a duplicate ``id`` is dropped silently (R22.8);
5. the ``id`` is recorded as accepted and the Command_Event is returned.

The duplicate check comes after the device check, so a stranger's or a broken message can
never push a genuine id out of the window.
"""

from dataclasses import dataclass, replace

from warashi_agent.messages import (
    REGISTRY,
    Envelope,
    ErrorCode,
    GazeData,
    Ignored,
    JudgementResultData,
    LanternData,
    Malformed,
    ModeSetData,
    SpeakData,
    decode,
)
from warashi_agent.messages import ConversationEnd as WireConversationEnd
from warashi_agent.messages import ConversationStart as WireConversationStart
from warashi_agent.messages import SnapshotRequest as WireSnapshotRequest
from warashi_agent.model import (
    CommandEvent,
    ConversationEnd,
    ConversationStart,
    Gaze,
    JudgementResult,
    Lantern,
    ModeSet,
    SnapshotRequest,
    Speak,
)


@dataclass(frozen=True, kw_only=True)
class Deduplicator:
    """The last ``window`` accepted command ids, oldest first (R22.8, R22.9).

    Frozen, so the Dispatcher replaces it on each accept and a test can compare states. The
    window is at most 4096 ids (R25 ``dedup_window_size``), which keeps the tuple copy in
    ``accept`` cheap even on the Pi Zero W.
    """

    window: int
    ids: tuple[str, ...] = ()

    def seen(self, message_id: str) -> bool:
        """True when ``message_id`` is among the remembered accepted ids."""
        return message_id in self.ids

    def accept(self, message_id: str) -> "Deduplicator":
        """Remember ``message_id``, evicting the oldest ids beyond the window."""
        ids = self.ids + (message_id,)
        if len(ids) > self.window:
            ids = ids[len(ids) - self.window :]
        return replace(self, ids=ids)


@dataclass(frozen=True, kw_only=True)
class ErrorToPublish:
    """An ``error.reported`` the Dispatcher must publish for a dropped message.

    ``ref_id`` is the incoming message ``id`` when it is readable, else ``None`` (R12.10,
    R22.4). No problem text is carried: the codec's rule names stay in debug logs only, and
    the Dispatcher writes a fixed message per code, so no incoming content can reach a
    published event (R13.6).
    """

    code: ErrorCode
    ref_id: str | None


InboundResult = CommandEvent | ErrorToPublish | None
"""``None`` means a silent drop (a duplicate, R22.8)."""

_IGNORED_CODES: dict[str, ErrorCode] = {
    "unsupported_version": ErrorCode.UNSUPPORTED_VERSION,
    "unknown_type": ErrorCode.UNKNOWN_TYPE,
}


def to_command_event(env: Envelope) -> CommandEvent:
    """Build the Command_Event for a decoded command envelope.

    ``ref_id`` is the envelope ``id``, so a later rejection by the State_Machine can carry it
    as ``refId`` (R12.12). ``speak`` loses ``ja`` and ``en`` here: the State_Machine does not
    need them, so no Action or log line downstream can repeat a nickname (R13.6). ``rand``
    and ``uid`` keep their placeholders; the Dispatcher stamps them before ``step()`` (R1.5).
    """
    data = env.data
    match data:
        case JudgementResultData():
            return JudgementResult(
                ref_id=env.id,
                snapshot_id=data.snapshot_id,
                verdict=data.verdict,
                confidence=data.confidence,
                face=data.face,
            )
        case SpeakData():
            return Speak(ref_id=env.id, line_id=data.line_id, audio_url=data.audio_url)
        case GazeData():
            return Gaze(ref_id=env.id, pan_deg=data.pan_deg, tilt_deg=data.tilt_deg)
        case LanternData():
            return Lantern(ref_id=env.id, level=data.level, fade_ms=data.fade_ms)
        case ModeSetData():
            return ModeSet(ref_id=env.id, mode=data.mode)
        case WireConversationStart():
            # The token is a secret: it moves into the event, whose repr hides it (R13.6).
            return ConversationStart(
                ref_id=env.id,
                session_id=data.session_id,
                token=data.token,
                max_s=data.max_seconds,
                silence_s=data.silence_seconds,
                source=data.source.value,
            )
        case WireConversationEnd():
            return ConversationEnd(
                ref_id=env.id, session_id=data.session_id, reason=data.reason.value
            )
        case WireSnapshotRequest():
            return SnapshotRequest(ref_id=env.id, request_id=data.request_id)
    raise ValueError(f"{env.type} is not a command type")


def route_inbound(
    raw: bytes, dedup: Deduplicator, device_id: str
) -> tuple[Deduplicator, InboundResult]:
    """Apply the R21.8 steps to one encoded message. Never raises for any input.

    Returns the Deduplicator to keep (changed only when a command is accepted) and the
    result: a Command_Event to post, an ``ErrorToPublish``, or ``None`` for a silent drop.
    """
    result = decode(raw)  # step 1
    if isinstance(result, Ignored):
        return dedup, ErrorToPublish(code=_IGNORED_CODES[result.reason], ref_id=result.message_id)
    if isinstance(result, Malformed):
        return dedup, ErrorToPublish(code=ErrorCode.MALFORMED_MESSAGE, ref_id=result.message_id)

    env = result.message
    if REGISTRY[env.type].direction != "command":  # step 2
        return dedup, ErrorToPublish(code=ErrorCode.UNKNOWN_TYPE, ref_id=env.id)
    if env.device_id != device_id:  # step 3 (R22.7)
        return dedup, ErrorToPublish(code=ErrorCode.WRONG_DEVICE, ref_id=env.id)
    if dedup.seen(env.id):  # step 4 (R22.8): silent
        return dedup, None
    return dedup.accept(env.id), to_command_event(env)  # step 5
