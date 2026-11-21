"""AWS AppSync Events WebSocket protocol builders and parsers. Pure: no sockets, no clock.

The client opens ``wss://<realtime-host>/event/realtime`` with two subprotocols, sends
``connection_init``, waits for ``connection_ack``, then subscribes and publishes. Authorization is
the per-session token from ``conversation.start`` (a Lambda authorizer on the API side). The token
is a secret: nothing here logs it, and ``Rejected`` / ``describe`` never include it.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Any

SUBPROTOCOL = "aws-appsync-event-ws"
MAX_EVENTS_PER_PUBLISH = 5


def _auth(http_host: str, token: str) -> dict[str, str]:
    return {"host": http_host, "Authorization": token}


def header_subprotocol(http_host: str, token: str) -> str:
    """``header-<Base64URL without padding>`` of the JSON auth header (host and Authorization)."""
    raw = json.dumps(_auth(http_host, token), separators=(",", ":")).encode("utf-8")
    return "header-" + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def subprotocols(http_host: str, token: str) -> list[str]:
    """The two WebSocket subprotocols: ``header-...`` and ``aws-appsync-event-ws``.

    The AWS protocol page lists the header first and says ``aws-appsync-event-ws`` must be one of
    the subprotocols.
    """
    return [header_subprotocol(http_host, token), SUBPROTOCOL]


def connection_init() -> str:
    return json.dumps({"type": "connection_init"})


def subscribe(sub_id: str, channel: str, http_host: str, token: str) -> str:
    return json.dumps(
        {
            "type": "subscribe",
            "id": sub_id,
            "channel": channel,
            "authorization": _auth(http_host, token),
        }
    )


def publish(pub_id: str, channel: str, frames: list[str], http_host: str, token: str) -> str:
    """Publish up to 5 events; each event is an already-encoded JSON string.

    Raises ``ValueError`` for an empty list or more than 5 events (a programming error, not input).
    """
    if not 1 <= len(frames) <= MAX_EVENTS_PER_PUBLISH:
        raise ValueError("a publish carries 1 to 5 events")
    return json.dumps(
        {
            "type": "publish",
            "id": pub_id,
            "channel": channel,
            "events": frames,
            "authorization": _auth(http_host, token),
        }
    )


@dataclass(frozen=True)
class ConnectionAck:
    timeout_ms: int | None


@dataclass(frozen=True)
class KeepAlive:
    """``ka``: the server is alive. Resets the keep-alive timer; needs no answer."""


@dataclass(frozen=True)
class SubscribeSuccess:
    id: str


@dataclass(frozen=True)
class PublishSuccess:
    id: str


@dataclass(frozen=True)
class Data:
    """A ``data`` message: the JSON strings that publishers sent to the subscribed channel.

    The AWS protocol page shows ``event`` as a list of strings; a bare string is accepted too.
    """

    id: str
    events: tuple[str, ...]


@dataclass(frozen=True)
class Rejected:
    """An error message: ``connection_error``, ``subscribe_error``, ``publish_error``, etc."""

    type: str
    id: str | None
    code: str


@dataclass(frozen=True)
class Unknown:
    pass


ServerMessage = (
    ConnectionAck | KeepAlive | SubscribeSuccess | PublishSuccess | Data | Rejected | Unknown
)

_ERROR_TYPES = (
    "connection_error",
    "subscribe_error",
    "publish_error",
    "broadcast_error",
    "error",
)


def _first_error_code(msg: dict[str, Any]) -> str:
    errors = msg.get("errors")
    if isinstance(errors, list) and errors and isinstance(errors[0], dict):
        code = errors[0].get("errorType")
        if isinstance(code, str):
            return code[:64]
    return "unknown"


def parse_server_message(raw: str | bytes) -> ServerMessage:
    """Parse one WebSocket text message from AppSync. Never raises."""
    try:
        msg = json.loads(raw)
    except (ValueError, RecursionError):
        return Unknown()
    if not isinstance(msg, dict):
        return Unknown()
    t = msg.get("type")
    mid = msg.get("id") if isinstance(msg.get("id"), str) else None
    if t == "connection_ack":
        timeout = msg.get("connectionTimeoutMs")
        ok = isinstance(timeout, int) and not isinstance(timeout, bool)
        return ConnectionAck(timeout if ok else None)
    if t == "ka":
        return KeepAlive()
    if t == "subscribe_success" and mid is not None:
        return SubscribeSuccess(mid)
    if t == "publish_success" and mid is not None:
        return PublishSuccess(mid)
    if t == "data" and mid is not None:
        event = msg.get("event")
        if isinstance(event, str):
            return Data(mid, (event,))
        if isinstance(event, list) and all(isinstance(e, str) for e in event):
            return Data(mid, tuple(event))
    if t in _ERROR_TYPES:
        return Rejected(t, mid, _first_error_code(msg))
    return Unknown()


def keepalive_expired(now_s: float, last_message_s: float, timeout_ms: int | None) -> bool:
    """True when no message (``ka`` included) arrived within the server's connection timeout."""
    limit_s = (timeout_ms if timeout_ms and timeout_ms > 0 else 300_000) / 1000.0
    return now_s - last_message_s > limit_s
