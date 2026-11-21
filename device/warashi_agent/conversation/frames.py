"""Voice session channel frames (docs/schema.md, "Voice session channels").

Pure module, mirrors ``cloud/lambda/_shared/voice/frames.ts``. Decoders never raise: they return
``Valid``, ``Malformed`` or (for ``decode_out`` and ``decode_text``) ``Ignored`` for a frame whose
``t`` is a string this version does not know. Frames are plain dicts so they re-encode unchanged.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

#: Largest decoded ``pcm`` payload: 400 ms of 24 kHz S16LE mono.
MAX_PCM_BYTES = 12_800

_BASE64_RE = re.compile(r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")
_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_VERDICTS = ("family", "stranger", "no_face", "uncertain")
_BYE_REASONS = ("user", "silence", "limit", "error")
_END_REASONS = (
    "silence",
    "limit",
    "stranger",
    "user",
    "manual",
    "language",
    "unsafe_output",
    "error",
    "no_client",
    "offline",
)
_STATES = ("waiting", "live", "ending")
_ROLES = ("user", "assistant")


@dataclass(frozen=True)
class Valid:
    """A frame that passed every check; ``frame`` is the decoded JSON object."""

    frame: dict[str, Any]


@dataclass(frozen=True)
class Malformed:
    """A frame that broke a rule; ``reason`` is short text without frame content."""

    reason: str


@dataclass(frozen=True)
class Ignored:
    """A well-formed object whose ``t`` this version does not know (forward compatible)."""

    t: str


Result = Valid | Malformed | Ignored


def _is_int(x: object) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _base64_length(s: str) -> int | None:
    """Decoded byte length of a valid Base64 string, or None when it is not valid Base64."""
    if not _BASE64_RE.match(s):
        return None
    pad = 2 if s.endswith("==") else 1 if s.endswith("=") else 0
    return len(s) // 4 * 3 - pad


def _check_pcm(pcm: object) -> str | None:
    """Return an error text, or None when ``pcm`` is valid."""
    if not isinstance(pcm, str):
        return "pcm must be a string"
    n = _base64_length(pcm)
    if n is None:
        return "pcm is not valid Base64"
    if n % 2 != 0:
        return "pcm has an odd length"
    if n > MAX_PCM_BYTES:
        return "pcm is too large"
    return None


def _check_seq(seq: object) -> str | None:
    if not _is_int(seq) or seq < 0 or seq > 2**53 - 1:  # type: ignore[operator]
        return "bad seq"
    return None


def _parse_object(raw: str | bytes) -> dict[str, Any] | Malformed:
    try:
        value = json.loads(raw)
    except (ValueError, RecursionError):
        return Malformed("not JSON")
    if not isinstance(value, dict):
        return Malformed("frame is not an object")
    return value


def _audio_check(value: dict[str, Any]) -> Result:
    err = _check_seq(value.get("seq")) or _check_pcm(value.get("pcm"))
    if err is not None:
        return Malformed(err)
    return Valid({"t": "audio", "seq": value["seq"], "pcm": value["pcm"]})


def decode_in(raw: str | bytes) -> Result:
    """Decode a frame of the ``in`` channel (used by tests and the fake server)."""
    value = _parse_object(raw)
    if isinstance(value, Malformed):
        return value
    t = value.get("t")
    if t == "hello":
        if value.get("client") not in ("device", "browser"):
            return Malformed("bad client")
        if not _is_int(value.get("v")) or value["v"] != 1:
            return Malformed("bad v")
        return Valid({"t": "hello", "client": value["client"], "v": 1})
    if t == "audio":
        return _audio_check(value)
    if t == "look.result":
        rid = value.get("requestId")
        if not isinstance(rid, str) or not _ID_RE.match(rid):
            return Malformed("bad requestId")
        if value.get("verdict") not in _VERDICTS:
            return Malformed("bad verdict")
        return Valid({"t": "look.result", "requestId": rid, "verdict": value["verdict"]})
    if t == "bye":
        if value.get("reason") not in _BYE_REASONS:
            return Malformed("bad reason")
        return Valid({"t": "bye", "reason": value["reason"]})
    return Malformed("unknown or missing t")


def decode_out(raw: str | bytes) -> Result:
    """Decode a frame of the ``out`` channel. Never raises; an unknown ``t`` is ``Ignored``."""
    value = _parse_object(raw)
    if isinstance(value, Malformed):
        return value
    t = value.get("t")
    if t == "audio":
        return _audio_check(value)
    if t == "interrupt":
        return Valid({"t": "interrupt"})
    if t == "command":
        envelope = value.get("envelope")
        if not isinstance(envelope, dict):
            return Malformed("bad envelope")
        return Valid({"t": "command", "envelope": envelope})
    if isinstance(t, str):
        return Ignored(t)
    return Malformed("missing t")


def decode_text(raw: str | bytes) -> Result:
    """Decode a frame of the ``text`` channel. Never raises; an unknown ``t`` is ``Ignored``."""
    value = _parse_object(raw)
    if isinstance(value, Malformed):
        return value
    t = value.get("t")
    if t == "state":
        if value.get("state") not in _STATES:
            return Malformed("bad state")
        return Valid({"t": "state", "state": value["state"]})
    if t == "transcript":
        if value.get("role") not in _ROLES:
            return Malformed("bad role")
        if not isinstance(value.get("text"), str) or not isinstance(value.get("final"), bool):
            return Malformed("bad transcript")
        return Valid(
            {
                "t": "transcript",
                "role": value["role"],
                "text": value["text"],
                "final": value["final"],
            }
        )
    if t == "end":
        if value.get("reason") not in _END_REASONS:
            return Malformed("bad reason")
        return Valid({"t": "end", "reason": value["reason"]})
    if isinstance(t, str):
        return Ignored(t)
    return Malformed("missing t")


def encode_in(frame: dict[str, Any]) -> str:
    """Serialize a frame for the ``in`` channel. Total: unencodable input becomes ``{}``.

    ``{}`` has no ``t``, so every receiver ignores it.
    """
    try:
        return json.dumps(frame, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        return "{}"


def hello_frame() -> dict[str, Any]:
    return {"t": "hello", "client": "device", "v": 1}


def audio_frame(seq: int, pcm_base64: str) -> dict[str, Any]:
    return {"t": "audio", "seq": seq, "pcm": pcm_base64}


def bye_frame(reason: str) -> dict[str, Any]:
    return {"t": "bye", "reason": reason}
