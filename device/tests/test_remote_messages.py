"""Codec tests for the optional fields of the remote actions (remote-actions R1 to R3).

``snapshot.request.purpose``, ``snapshot.captured.purpose`` and ``speak.remote`` are optional on
the wire: absent means the old behaviour, a present value is checked, and ``None`` is never
written back.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from warashi_agent.inbound import to_command_event
from warashi_agent.messages import (
    Malformed,
    SnapshotCaptured,
    SnapshotRequest,
    SpeakData,
    Valid,
    decode,
    encode,
)
from warashi_agent.model import SnapshotRequest as SnapshotRequestEvent
from warashi_agent.model import Speak


def envelope(type_: str, data: dict[str, Any]) -> bytes:
    return json.dumps(
        {
            "v": 1,
            "id": "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a99",
            "ts": "2026-11-20T12:34:56.789Z",
            "deviceId": "warashi-01",
            "encounterId": None,
            "type": type_,
            "data": data,
        }
    ).encode()


def valid(raw: bytes) -> Any:
    result = decode(raw)
    assert isinstance(result, Valid), result
    return result.message


def test_snapshot_request_purpose_is_optional_and_maps_to_the_event() -> None:
    plain = valid(envelope("snapshot.request", {"requestId": "r-1"}))
    assert isinstance(plain.data, SnapshotRequest) and plain.data.purpose is None
    event = to_command_event(plain)
    assert isinstance(event, SnapshotRequestEvent) and event.purpose == "look"

    photo = valid(envelope("snapshot.request", {"requestId": "r-1", "purpose": "photo"}))
    event = to_command_event(photo)
    assert isinstance(event, SnapshotRequestEvent) and event.purpose == "photo"


@pytest.mark.parametrize("purpose", ["judge", "", "PHOTO", 1, True])
def test_snapshot_request_rejects_an_unknown_purpose(purpose: object) -> None:
    result = decode(envelope("snapshot.request", {"requestId": "r-1", "purpose": purpose}))
    assert isinstance(result, Malformed)


def test_snapshot_captured_purpose_round_trips_and_none_is_omitted() -> None:
    base = {
        "snapshotId": "s-1",
        "width": 640,
        "height": 480,
        "panDeg": 0.0,
        "tiltDeg": 0.0,
        "jpegBase64": "/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==",
    }
    plain = valid(envelope("snapshot.captured", base))
    assert isinstance(plain.data, SnapshotCaptured) and plain.data.purpose is None
    assert "purpose" not in json.loads(encode(plain))["data"]

    photo = valid(envelope("snapshot.captured", {**base, "requestId": "r-1", "purpose": "photo"}))
    assert photo.data.purpose == "photo"
    assert json.loads(encode(photo))["data"]["purpose"] == "photo"

    assert isinstance(
        decode(envelope("snapshot.captured", {**base, "purpose": "look"})), Malformed
    )


def test_speak_remote_is_optional_and_reaches_the_event() -> None:
    base = {
        "lineId": None,
        "audioUrl": "https://example.invalid/a.wav",
        "ja": "こんにちは",
        "en": "Hi",
    }
    plain = valid(envelope("speak", base))
    assert isinstance(plain.data, SpeakData) and plain.data.remote is None
    assert "remote" not in json.loads(encode(plain))["data"]
    event = to_command_event(plain)
    assert isinstance(event, Speak) and event.remote is False

    remote = valid(envelope("speak", {**base, "remote": True}))
    event = to_command_event(remote)
    assert isinstance(event, Speak) and event.remote is True
    assert json.loads(encode(remote))["data"]["remote"] is True


@pytest.mark.parametrize("remote", ["yes", 1, 0, "true"])
def test_speak_remote_must_be_a_boolean(remote: object) -> None:
    data = {
        "lineId": None,
        "audioUrl": "https://example.invalid/a.wav",
        "ja": "x",
        "en": "y",
        "remote": remote,
    }
    assert isinstance(decode(envelope("speak", data)), Malformed)
