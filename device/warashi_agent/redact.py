"""One place for log and print redaction (R13.6, R21.4, R27.3, R27.7).

The Dispatcher, the Local_Cloud_Link and the ``--fake`` CLI all print Events, Actions and
envelopes. They format them only through this module, so the privacy rules live in one place
instead of being repeated (and forgotten) at every call site:

- image data (``SnapshotReady.jpeg``, ``jpegBase64``) is replaced by its length;
- an ``audioUrl`` is shown as ``scheme://host/path``, without user info, port, query string or
  fragment, because a short-lived URL usually carries its token there;
- the ``ja`` and ``en`` texts of ``speak`` are removed, because they may hold a family
  nickname;
- any other field hidden from ``repr()`` is shown as ``<hidden>``, so a new private field is
  safe by default.

Every result is exactly one line with no colour codes: strings are written with ``repr()`` or
JSON escaping, and a final pass escapes any line break or escape character that is left, so a
crafted value cannot forge a second log line or change the terminal (R27.7).

The functions are pure and never raise, so a logging call cannot stop the main loop. Only the
standard library is used.
"""

import json
from dataclasses import fields, is_dataclass
from enum import Enum
from typing import Any
from urllib.parse import urlsplit

from warashi_agent.messages import Envelope, encode
from warashi_agent.model import Action, Event

URL_FIELDS = frozenset({"url", "audio_url"})
"""Attribute names that hold a URL which may carry a token in its query string."""

TEXT_FIELDS = frozenset({"ja", "en"})
"""Attribute names of spoken text; they are left out of every line (R13.6)."""

BASE64_FIELDS = frozenset({"jpeg_base64"})
"""Attribute names of base64 image data, printed as their number of characters."""

# Characters that end a line for str.splitlines() or a terminal, plus ESC (colour codes).
# repr() and json.dumps(ensure_ascii=True) already escape them; this table is the last guard.
_LINE_BREAKS = {
    ch: f"\\x{ch:02x}" if ch < 0x100 else f"\\u{ch:04x}"
    for ch in (0x0A, 0x0B, 0x0C, 0x0D, 0x1B, 0x1C, 0x1D, 0x1E, 0x85, 0x2028, 0x2029)
}


def one_line(text: str) -> str:
    """Escape every line break and ESC in ``text``, so it prints as one plain line."""
    return text.translate(_LINE_BREAKS)


def redact_url(url: str) -> str:
    """Return ``scheme://host/path`` of ``url``.

    The query string and the fragment may hold a token, and the user info may hold a
    password, so all three are dropped. The port is dropped too, to match the
    ``scheme://host/path`` form of R13.6. A URL that cannot be parsed is shown as
    ``<invalid url>`` instead of its text.
    """
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
    except ValueError:  # for example an unbalanced "[" in the host
        return "<invalid url>"
    return one_line(f"{parts.scheme}://{host}{parts.path}")


def format_event(event: Event) -> str:
    """One line for an Event, for example ``ServoArrived(rand=0.5, uid='…', motion_id='m1')``."""
    return one_line(_format_dataclass(event))


def format_action(action: Action) -> str:
    """One line for an Action. ``PublishEvent`` and ``PublishStatus`` show their payload."""
    return one_line(_format_dataclass(action))


def format_envelope(envelope: Envelope) -> str:
    """One compact JSON line for an envelope, as it goes on the wire but redacted (R21.4).

    The envelope is encoded by ``messages.encode``, so the line shows exactly the contract
    fields. Then ``jpegBase64`` becomes its number of characters, ``audioUrl`` becomes
    ``scheme://host/path``, and ``ja`` and ``en`` are removed. ``ensure_ascii`` escapes every
    non-ASCII character, so no Unicode line separator can split the line.
    """
    try:
        obj = json.loads(encode(envelope))
    except (ValueError, KeyError, TypeError, AttributeError):
        # encode() rejects a naive ts or a non-finite number. The values are not shown,
        # because the reason the envelope is broken may be one of them.
        return one_line(f"<unencodable envelope type={_safe_type(envelope)!r}>")
    data = obj.get("data")
    if isinstance(data, dict):
        obj["data"] = _redact_wire_data(data)
    return one_line(json.dumps(obj, ensure_ascii=True, separators=(",", ":")))


# --------------------------------------------------------------------------------------------
# Internals
# --------------------------------------------------------------------------------------------


def _redact_wire_data(data: dict[str, Any]) -> dict[str, Any]:
    """Apply the R13.6 exclusions to the ``data`` object of an encoded envelope."""
    out: dict[str, Any] = {}
    for key, value in data.items():
        if key in ("ja", "en"):
            continue
        if key == "jpegBase64" and isinstance(value, str):
            out[key] = len(value)
        elif key == "audioUrl" and isinstance(value, str):
            out[key] = redact_url(value)
        else:
            out[key] = value
    return out


def _safe_type(envelope: Envelope) -> str:
    """The wire ``type`` of an envelope, or ``"?"`` when its payload has none."""
    return str(getattr(envelope.data, "TYPE", "?"))


def _format_dataclass(obj: object) -> str:
    """``ClassName(field=value, …)`` with the redaction rules applied per field.

    Fields with ``repr=False`` are the ones the model marks as private, so their values are
    never written as they are: bytes and base64 become a length, URLs are cut, spoken text is
    left out, and anything else is ``<hidden>``.
    """
    parts: list[str] = []
    for f in fields(obj):
        value = getattr(obj, f.name)
        if f.name in TEXT_FIELDS:
            continue
        if f.name in URL_FIELDS:
            shown = "None" if value is None else redact_url(str(value))
        elif f.name in BASE64_FIELDS and isinstance(value, str):
            shown = f"<{len(value)} chars>"
        elif isinstance(value, bytes | bytearray | memoryview):
            shown = f"<{len(value)} bytes>"
        elif not f.repr:
            shown = "<hidden>"
        else:
            shown = _format_value(value)
        parts.append(f"{f.name}={shown}")
    return f"{type(obj).__name__}({', '.join(parts)})"


def _format_value(value: object) -> str:
    """Format one field value; strings use ``repr()`` so control characters are escaped."""
    if is_dataclass(value) and not isinstance(value, type):
        return _format_dataclass(value)
    if isinstance(value, Enum):
        return repr(value.value)
    if isinstance(value, bytes | bytearray | memoryview):
        return f"<{len(value)} bytes>"
    if isinstance(value, tuple | list):
        return "(" + ", ".join(_format_value(item) for item in value) + ")"
    return repr(value)
