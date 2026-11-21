"""AppSync Events WebSocket handshake builders and parsers (voice-conversation task 16.4).

Message shapes follow https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html
"""

from __future__ import annotations

import base64
import json
import re

import pytest

from warashi_agent.conversation import appsync
from warashi_agent.conversation.appsync import (
    ConnectionAck,
    Data,
    KeepAlive,
    PublishSuccess,
    Rejected,
    SubscribeSuccess,
    Unknown,
    parse_server_message,
)

HOST = "abc123.appsync-api.eu-west-1.amazonaws.com"
TOKEN = "11111111-2222-3333-4444-555555555555." + "A" * 43
CHANNEL = "/voice/11111111-2222-3333-4444-555555555555/in"


def decode_header(proto: str) -> dict[str, str]:
    assert proto.startswith("header-")
    body = proto.removeprefix("header-")
    assert re.fullmatch(r"[A-Za-z0-9_-]+", body)  # Base64URL alphabet, no padding
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))


def test_subprotocols_contain_the_marker_and_the_auth_header() -> None:
    protos = appsync.subprotocols(HOST, TOKEN)
    assert sorted(p.split("-")[0] for p in protos) == ["aws", "header"]
    assert "aws-appsync-event-ws" in protos
    header = next(p for p in protos if p.startswith("header-"))
    assert decode_header(header) == {"host": HOST, "Authorization": TOKEN}


@pytest.mark.parametrize("host", ["h", "a.b", "ü.example", "x" * 7, "x" * 8, "x" * 9])
def test_header_subprotocol_has_no_padding_for_any_length(host: str) -> None:
    proto = appsync.header_subprotocol(host, TOKEN)
    assert "=" not in proto and "+" not in proto and "/" not in proto
    assert decode_header(proto)["host"] == host


def test_connection_init_shape() -> None:
    assert json.loads(appsync.connection_init()) == {"type": "connection_init"}


def test_subscribe_shape() -> None:
    msg = json.loads(appsync.subscribe("sub-1", CHANNEL, HOST, TOKEN))
    assert msg == {
        "type": "subscribe",
        "id": "sub-1",
        "channel": CHANNEL,
        "authorization": {"host": HOST, "Authorization": TOKEN},
    }


def test_publish_shape_and_event_limit() -> None:
    frames = ['{"t":"hello"}', '{"t":"bye"}']
    msg = json.loads(appsync.publish("pub-1", CHANNEL, frames, HOST, TOKEN))
    assert msg["type"] == "publish"
    assert msg["id"] == "pub-1"
    assert msg["channel"] == CHANNEL
    assert msg["events"] == frames  # each event is a JSON *string*
    assert msg["authorization"] == {"host": HOST, "Authorization": TOKEN}
    appsync.publish("p", CHANNEL, ["{}"] * 5, HOST, TOKEN)
    for bad in ([], ["{}"] * 6):
        with pytest.raises(ValueError):
            appsync.publish("p", CHANNEL, bad, HOST, TOKEN)


def test_parse_documented_server_messages() -> None:
    assert parse_server_message('{"type":"connection_ack","connectionTimeoutMs":300000}') == (
        ConnectionAck(300000)
    )
    assert parse_server_message('{"type":"connection_ack"}') == ConnectionAck(None)
    assert parse_server_message('{"type":"connection_ack","connectionTimeoutMs":true}') == (
        ConnectionAck(None)
    )
    assert parse_server_message('{"type":"ka"}') == KeepAlive()
    assert parse_server_message('{"type":"subscribe_success","id":"s"}') == SubscribeSuccess("s")
    assert parse_server_message(
        '{"id":"p","type":"publish_success","successful":[{"identifier":"x","index":0}],"failed":[]}'
    ) == PublishSuccess("p")


def test_data_message_accepts_a_list_or_a_string() -> None:
    inner = '{"t":"interrupt"}'
    as_list = json.dumps({"type": "data", "id": "s", "event": [inner]})
    as_str = json.dumps({"type": "data", "id": "s", "event": inner})
    assert parse_server_message(as_list) == Data("s", (inner,))
    assert parse_server_message(as_str) == Data("s", (inner,))
    two = json.dumps({"type": "data", "id": "s", "event": [inner, inner]})
    assert parse_server_message(two) == Data("s", (inner, inner))
    mixed = json.dumps({"type": "data", "id": "s", "event": [inner, 3]})
    assert parse_server_message(mixed) == Unknown()


@pytest.mark.parametrize(
    "type_", ["connection_error", "subscribe_error", "publish_error", "broadcast_error", "error"]
)
def test_error_messages_become_rejected_without_the_message_text(type_: str) -> None:
    raw = json.dumps(
        {
            "type": type_,
            "id": "s",
            "errors": [{"errorType": "UnauthorizedException", "message": f"bad token {TOKEN}"}],
        }
    )
    result = parse_server_message(raw)
    assert result == Rejected(type_, "s", "UnauthorizedException")
    assert TOKEN not in repr(result)


def test_rejected_without_errors_has_unknown_code() -> None:
    assert parse_server_message('{"type":"error"}') == Rejected("error", None, "unknown")
    long_code = "E" * 500
    msg = json.dumps({"type": "error", "errors": [{"errorType": long_code}]})
    result = parse_server_message(msg)
    assert isinstance(result, Rejected) and len(result.code) == 64


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "nope",
        "[]",
        "3",
        '{"type":"subscribe_success"}',
        '{"type":"publish_success","id":5}',
        '{"type":"data","id":"s"}',
        '{"type":"mystery"}',
        "[" * 100_000,
        b"\xff",
    ],
)
def test_garbage_is_unknown_and_never_raises(raw: str | bytes) -> None:
    assert parse_server_message(raw) == Unknown()


def test_keepalive_expiry() -> None:
    assert not appsync.keepalive_expired(100.0, 0.0, 300_000)
    assert appsync.keepalive_expired(300.1, 0.0, 300_000)
    assert not appsync.keepalive_expired(300.0, 0.0, 300_000)
    assert appsync.keepalive_expired(300.1, 0.0, None)  # default 5 minutes
    assert appsync.keepalive_expired(10.1, 0.0, 10_000)
