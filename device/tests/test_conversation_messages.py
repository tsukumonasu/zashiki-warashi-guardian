"""Field rules of the voice-conversation types (S3 to S6 of docs/schema.md, task 2.4)."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from warashi_agent.messages import (
    REGISTRY,
    ConversationStart,
    ErrorCode,
    Malformed,
    SnapshotCaptured,
    SnapshotRequest,
    Valid,
    decode,
    encode,
)

FIXTURES = Path(__file__).resolve().parents[2] / "docs" / "fixtures" / "schema-v1"


def _fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def _decode(obj: dict[str, Any]):
    return decode(json.dumps(obj))


def _with_data(name: str, **changes: Any) -> dict[str, Any]:
    obj = copy.deepcopy(_fixture(name))
    obj["data"].update(changes)
    return obj


def test_registry_types_all_have_fixtures() -> None:
    """Every registered type, including the five voice types, has a golden file."""
    files = {p.stem for p in FIXTURES.glob("*.json")}
    assert sorted(set(REGISTRY) - files) == []
    assert sorted(files - set(REGISTRY)) == []


def test_new_error_codes_exist() -> None:
    assert ErrorCode("conversation_failed") is ErrorCode.CONVERSATION_FAILED
    assert ErrorCode("microphone_failed") is ErrorCode.MICROPHONE_FAILED


@pytest.mark.parametrize(
    ("name", "key", "value"),
    [
        ("conversation.start", "sessionId", ""),
        ("conversation.start", "sessionId", "a" * 65),
        ("conversation.start", "sessionId", "bad id"),
        ("conversation.start", "sessionId", "abc\n"),
        ("conversation.end", "sessionId", "a_b"),
        ("conversation.ended", "sessionId", "é"),
        ("snapshot.request", "requestId", ""),
        ("snapshot.request", "requestId", "x" * 65),
        ("snapshot.request", "requestId", "a.b"),
        ("conversation.start", "token", ""),
        ("conversation.start", "token", "t" * 129),
        ("conversation.start", "maxSeconds", 1.5),
        ("conversation.start", "silenceSeconds", True),
        ("conversation.start", "source", "elsewhere"),
        ("conversation.end", "reason", "nope"),
        ("conversation.requested", "reason", "manual"),
    ],
)
def test_invalid_field_is_malformed(name: str, key: str, value: Any) -> None:
    assert isinstance(_decode(_with_data(name, **{key: value})), Malformed)


@pytest.mark.parametrize("length", [1, 128])
def test_token_length_bounds_are_valid(length: int) -> None:
    result = _decode(_with_data("conversation.start", token="t" * length))
    assert isinstance(result, Valid)


@pytest.mark.parametrize("value", ["a", "A-9" * 21 + "z"])
def test_id_bounds_are_valid(value: str) -> None:
    assert isinstance(_decode(_with_data("snapshot.request", requestId=value)), Valid)
    assert isinstance(_decode(_with_data("conversation.end", sessionId=value)), Valid)


@pytest.mark.parametrize(
    ("max_in", "max_out", "silence_in", "silence_out"),
    [(0, 30, 0, 5), (-10, 30, 1000, 60), (30, 30, 5, 5), (420, 420, 60, 60), (99999, 420, 61, 60)],
)
def test_seconds_are_clamped(max_in: int, max_out: int, silence_in: int, silence_out: int) -> None:
    result = _decode(
        _with_data("conversation.start", maxSeconds=max_in, silenceSeconds=silence_in)
    )
    assert isinstance(result, Valid)
    data = result.message.data
    assert isinstance(data, ConversationStart)
    assert (data.max_seconds, data.silence_seconds) == (max_out, silence_out)


def test_token_is_hidden_from_repr() -> None:
    result = _decode(_fixture("conversation.start"))
    assert isinstance(result, Valid)
    token = _fixture("conversation.start")["data"]["token"]
    assert token not in repr(result.message)
    assert token not in repr(result)


def test_snapshot_request_decodes_request_id() -> None:
    result = _decode(_fixture("snapshot.request"))
    assert isinstance(result, Valid)
    assert isinstance(result.message.data, SnapshotRequest)
    assert result.message.data.request_id == "00000000-0000-4000-8000-000000000001"


def test_snapshot_captured_request_id_defaults_to_none_and_is_omitted() -> None:
    original = _fixture("snapshot.captured")
    # The golden fixture is a photo (it carries both optional fields); drop them for this test.
    del original["data"]["requestId"]
    del original["data"]["purpose"]
    result = _decode(original)
    assert isinstance(result, Valid)
    assert isinstance(result.message.data, SnapshotCaptured)
    assert result.message.data.request_id is None
    assert result.message.data.purpose is None
    assert "requestId" not in json.loads(encode(result.message))["data"]
    assert "purpose" not in json.loads(encode(result.message))["data"]


def test_snapshot_captured_request_id_round_trips() -> None:
    obj = _with_data("snapshot.captured", requestId="req-1")
    result = _decode(obj)
    assert isinstance(result, Valid)
    assert result.message.data.request_id == "req-1"
    assert json.loads(encode(result.message)) == obj


def test_snapshot_captured_null_request_id_is_valid_and_bad_one_is_not() -> None:
    assert isinstance(_decode(_with_data("snapshot.captured", requestId=None)), Valid)
    assert isinstance(_decode(_with_data("snapshot.captured", requestId="no good")), Malformed)
