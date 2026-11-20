"""Keyboard grammar of ``--fake`` mode as a pure parser and a message builder (R27.2, R27.4).

Why a separate pure module: the grammar and the encoding are the testable part of the CLI.
Reading stdin, printing and posting to the Fake_Cloud_Link stay in ``__main__.py``. Nothing
here does I/O, starts a thread or reads a clock; the fresh message id and ``ts`` come from
callables the caller injects.

Grammar (one command per line, tokens split on whitespace, words in lower case)::

    p | u                                         PIR rising / falling
    family   [<confidence> [<left> <top> <width> <height>]]
    stranger [<confidence> [<left> <top> <width> <height>]]
    noface | unsure                               verdict no_face / uncertain
    speak <lineId>
    gaze <pan> <tilt>
    lantern <level> <fadeMs>                      fadeMs is an integer
    mode sleep | mode guard
    online | offline                              connectivity of the Fake_Cloud_Link
    help | quit

Numbers must be finite. They are not clamped here: the device clamps them (R12, R22.11), and a
developer typing ``gaze 500 0`` wants to see that clamping happen.
"""

import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from warashi_agent.messages import (
    Envelope,
    GazeData,
    JudgementResultData,
    LanternData,
    ModeSetData,
    SpeakData,
    encode,
)
from warashi_agent.model import FaceBox, Mode, Verdict

NO_SNAPSHOT_TEXT = "no snapshot is pending"

HELP_TEXT = """\
Keyboard commands (--fake):
  p | u                                    PIR rising / falling
  family   [<confidence> [<left> <top> <width> <height>]]
  stranger [<confidence> [<left> <top> <width> <height>]]
  noface | unsure                          verdict no_face / uncertain
  speak <lineId>                           say a cached voice line
  gaze <pan> <tilt>                        look in a direction (degrees)
  lantern <level> <fadeMs>                 level 0..1, fadeMs an integer
  mode sleep | mode guard
  online | offline                         cloud connectivity
  help | quit"""


# --------------------------------------------------------------------------------------------
# Parsed results
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class PirKey:
    """``p`` (``rising=True``) or ``u`` (``rising=False``): an edge through the PIR fake."""

    rising: bool


@dataclass(frozen=True, kw_only=True)
class VerdictKey:
    """A ``judgement.result`` for the pending snapshot; ``face`` is ``None`` without a box."""

    verdict: Verdict
    confidence: float
    face: FaceBox | None


@dataclass(frozen=True, kw_only=True)
class SpeakKey:
    """``speak <lineId>``: a cached line, so ``audioUrl`` is null and ``ja``, ``en`` are empty."""

    line_id: str


@dataclass(frozen=True, kw_only=True)
class GazeKey:
    """``gaze <pan> <tilt>``, unclamped."""

    pan_deg: float
    tilt_deg: float


@dataclass(frozen=True, kw_only=True)
class LanternKey:
    """``lantern <level> <fadeMs>``, unclamped."""

    level: float
    fade_ms: int


@dataclass(frozen=True, kw_only=True)
class ModeKey:
    """``mode sleep`` or ``mode guard``."""

    mode: Mode


@dataclass(frozen=True, kw_only=True)
class ConnectivityKey:
    """``online`` or ``offline``: scripts the Fake_Cloud_Link; nothing goes on the wire."""

    online: bool


KeyCommand = PirKey | VerdictKey | SpeakKey | GazeKey | LanternKey | ModeKey | ConnectivityKey
WireKeyCommand = VerdictKey | SpeakKey | GazeKey | LanternKey | ModeKey


@dataclass(frozen=True, kw_only=True)
class HelpRequest:
    """``help``."""


@dataclass(frozen=True, kw_only=True)
class Quit:
    """``quit``: shut down like SIGINT and exit 0 (R27.11)."""


@dataclass(frozen=True, kw_only=True)
class ParseError:
    """Input that does not match the grammar. The caller prints ``HELP_TEXT`` (R27.4)."""

    reason: str


ParseResult = KeyCommand | HelpRequest | Quit | ParseError


# --------------------------------------------------------------------------------------------
# Parser
# --------------------------------------------------------------------------------------------


class _BadNumberError(Exception):
    """Internal signal for a non-numeric or non-finite argument."""


def _number(token: str) -> float:
    try:
        value = float(token)
    except ValueError:
        raise _BadNumberError(token) from None
    if not math.isfinite(value):
        raise _BadNumberError(token)
    return value


def _integer(token: str) -> int:
    try:
        return int(token)
    except ValueError:
        raise _BadNumberError(token) from None


def _parse_verdict(verdict: Verdict, args: list[str]) -> ParseResult:
    """``<confidence>`` and then a whole box, or nothing: 0, 1 or 5 arguments."""
    if len(args) not in (0, 1, 5):
        return ParseError(reason="expected [<confidence> [<left> <top> <width> <height>]]")
    confidence = _number(args[0]) if args else 1.0
    face = None
    if len(args) == 5:
        left, top, width, height = (_number(token) for token in args[1:])
        face = FaceBox(left=left, top=top, width=width, height=height)
    return VerdictKey(verdict=verdict, confidence=confidence, face=face)


def _parse_command(words: list[str]) -> ParseResult:
    name, args = words[0], words[1:]
    simple: dict[str, KeyCommand | HelpRequest | Quit] = {
        "p": PirKey(rising=True),
        "u": PirKey(rising=False),
        "noface": VerdictKey(verdict=Verdict.NO_FACE, confidence=1.0, face=None),
        "unsure": VerdictKey(verdict=Verdict.UNCERTAIN, confidence=1.0, face=None),
        "online": ConnectivityKey(online=True),
        "offline": ConnectivityKey(online=False),
        "help": HelpRequest(),
        "quit": Quit(),
    }
    if name in simple:
        return simple[name] if not args else ParseError(reason=f"{name} takes no arguments")
    if name == "family":
        return _parse_verdict(Verdict.FAMILY, args)
    if name == "stranger":
        return _parse_verdict(Verdict.STRANGER, args)
    if name == "speak":
        if len(args) != 1:
            return ParseError(reason="expected speak <lineId>")
        return SpeakKey(line_id=args[0])
    if name == "gaze":
        if len(args) != 2:
            return ParseError(reason="expected gaze <pan> <tilt>")
        return GazeKey(pan_deg=_number(args[0]), tilt_deg=_number(args[1]))
    if name == "lantern":
        if len(args) != 2:
            return ParseError(reason="expected lantern <level> <fadeMs>")
        return LanternKey(level=_number(args[0]), fade_ms=_integer(args[1]))
    if name == "mode":
        if len(args) != 1 or args[0] not in (Mode.SLEEP.value, Mode.GUARD.value):
            return ParseError(reason="expected mode sleep | mode guard")
        return ModeKey(mode=Mode(args[0]))
    return ParseError(reason=f"unknown command: {name[:40]}")


def parse_line(text: str) -> ParseResult:
    """Parse one keyboard line. Never raises, whatever the input (Property 22)."""
    try:
        words = text.split()
        if not words:
            return ParseError(reason="empty line")
        return _parse_command(words)
    except _BadNumberError:
        return ParseError(reason="arguments must be finite numbers (fadeMs an integer)")
    except Exception:  # noqa: BLE001 - the parser's contract is "never raises"
        return ParseError(reason="unreadable input")


# --------------------------------------------------------------------------------------------
# Wire_Message builder
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class NoSnapshotPending:
    """A verdict was typed before any ``TakeSnapshot``; nothing is posted (R27.4)."""

    text: str = NO_SNAPSHOT_TEXT


def build_wire_message(
    command: WireKeyCommand,
    *,
    device_id: str,
    snapshot_id: str | None,
    new_id: Callable[[], str],
    now: Callable[[], datetime],
) -> bytes | NoSnapshotPending:
    """Encode a typed verdict or command as a Wire_Message, as the cloud would send it.

    The envelope carries a fresh ``id``, the Config ``deviceId`` and ``encounterId: null``
    (R22.9 allows null on commands). A verdict uses the latest Snapshot_Id; with none, the
    result is ``NoSnapshotPending``. ``now`` must return a timezone-aware datetime.
    """
    data: JudgementResultData | SpeakData | GazeData | LanternData | ModeSetData
    match command:
        case VerdictKey():
            if snapshot_id is None:
                return NoSnapshotPending()
            data = JudgementResultData(
                snapshot_id=snapshot_id,
                verdict=command.verdict,
                confidence=command.confidence,
                face=command.face,
            )
        case SpeakKey():
            data = SpeakData(line_id=command.line_id, audio_url=None, ja="", en="")
        case GazeKey():
            data = GazeData(pan_deg=command.pan_deg, tilt_deg=command.tilt_deg)
        case LanternKey():
            data = LanternData(level=command.level, fade_ms=command.fade_ms)
        case ModeKey():
            data = ModeSetData(mode=command.mode)
        case _:
            raise TypeError(f"{type(command).__name__} has no wire form")
    envelope = Envelope(id=new_id(), ts=now(), device_id=device_id, encounter_id=None, data=data)
    return encode(envelope)
