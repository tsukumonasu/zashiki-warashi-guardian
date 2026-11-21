"""Voice frame codec, reorder window and golden frames (voice-conversation task 16.4).

Golden files in docs/fixtures/voice-v1/ are named ``<channel>.<t>.json`` and are decoded by the
TypeScript and dashboard tests too. A frame without a fixture, or a fixture without a frame, fails
and names it (schema.md, "Fixtures and contract checks").
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from warashi_agent.conversation.frames import (
    MAX_PCM_BYTES,
    Ignored,
    Malformed,
    Valid,
    audio_frame,
    bye_frame,
    decode_in,
    decode_out,
    decode_text,
    encode_in,
    hello_frame,
)
from warashi_agent.conversation.reorder import Reorder

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "docs" / "fixtures" / "voice-v1"
DECODERS = {"in": decode_in, "out": decode_out, "text": decode_text}
EXPECTED = {
    "in.hello",
    "in.audio",
    "in.look.result",
    "in.bye",
    "out.audio",
    "out.interrupt",
    "out.command",
    "text.state",
    "text.transcript",
    "text.end",
}


def _frame_fixtures() -> dict[str, Path]:
    return {
        p.name.removesuffix(".json"): p
        for p in sorted(FIXTURE_DIR.glob("*.json"))
        if p.name.split(".")[0] in DECODERS
    }


def pcm(n_bytes: int) -> str:
    return base64.b64encode(bytes(n_bytes)).decode("ascii")


def test_every_frame_has_a_fixture_and_every_fixture_a_frame() -> None:
    found = set(_frame_fixtures())
    assert not EXPECTED - found, f"frame without fixture: {sorted(EXPECTED - found)}"
    assert not found - EXPECTED, f"fixture without frame: {sorted(found - EXPECTED)}"


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_golden_frame_decodes_and_reencodes(name: str) -> None:
    raw = _frame_fixtures()[name].read_text(encoding="utf-8")
    channel, t = name.split(".", 1)
    result = DECODERS[channel](raw)
    assert isinstance(result, Valid), result
    assert result.frame["t"] == t
    assert result.frame == json.loads(raw)
    assert json.loads(encode_in(result.frame)) == json.loads(raw)
    assert DECODERS[channel](encode_in(result.frame)) == result


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "not json",
        "[]",
        "null",
        "42",
        '"audio"',
        "{}",
        '{"t":1}',
        "[" * 100_000,
        b"\xff\xfe",
    ],
)
@pytest.mark.parametrize("decode", [decode_in, decode_out, decode_text])
def test_garbage_is_malformed_and_never_raises(decode, raw) -> None:  # type: ignore[no-untyped-def]
    assert isinstance(decode(raw), Malformed)


@pytest.mark.parametrize(
    "frame",
    [
        {"t": "audio", "seq": -1, "pcm": ""},
        {"t": "audio", "seq": True, "pcm": ""},
        {"t": "audio", "seq": 1.5, "pcm": ""},
        {"t": "audio", "seq": 2**53, "pcm": ""},
        {"t": "audio", "seq": 0},
        {"t": "audio", "seq": 0, "pcm": 5},
        {"t": "audio", "seq": 0, "pcm": "!!!!"},
        {"t": "audio", "seq": 0, "pcm": "AAA"},  # missing padding
        {"t": "audio", "seq": 0, "pcm": "AAA="},  # 2 bytes: valid
        {"t": "audio", "seq": 0, "pcm": "AAAA"},  # 3 bytes: odd
        {"t": "audio", "seq": 0, "pcm": pcm(MAX_PCM_BYTES + 2)},
    ],
)
def test_audio_frame_rules(frame: dict) -> None:  # type: ignore[type-arg]
    expected_valid = frame.get("pcm") == "AAA="
    for decode in (decode_in, decode_out):
        assert isinstance(decode(json.dumps(frame)), Valid if expected_valid else Malformed)


def test_audio_size_boundary() -> None:
    ok = {"t": "audio", "seq": 0, "pcm": pcm(MAX_PCM_BYTES)}
    assert isinstance(decode_out(json.dumps(ok)), Valid)
    assert isinstance(decode_out(json.dumps({**ok, "pcm": ""})), Valid)


@pytest.mark.parametrize(
    "frame",
    [
        {"t": "hello", "client": "robot", "v": 1},
        {"t": "hello", "client": "device", "v": 2},
        {"t": "hello", "client": "device", "v": True},
        {"t": "hello", "client": "device"},
        {"t": "look.result", "requestId": "bad id", "verdict": "family"},
        {"t": "look.result", "requestId": "a" * 65, "verdict": "family"},
        {"t": "look.result", "requestId": "r1", "verdict": "friend"},
        {"t": "bye", "reason": "manual"},
        {"t": "bye"},
        {"t": "nope"},
    ],
)
def test_in_frames_malformed(frame: dict) -> None:  # type: ignore[type-arg]
    assert isinstance(decode_in(json.dumps(frame)), Malformed)


def test_out_and_text_unknown_t_is_ignored() -> None:
    assert decode_out('{"t":"future","x":1}') == Ignored("future")
    assert decode_text('{"t":"future"}') == Ignored("future")


@pytest.mark.parametrize(
    "frame",
    [
        {"t": "command"},
        {"t": "command", "envelope": []},
        {"t": "command", "envelope": "x"},
    ],
)
def test_out_command_needs_an_envelope(frame: dict) -> None:  # type: ignore[type-arg]
    assert isinstance(decode_out(json.dumps(frame)), Malformed)


@pytest.mark.parametrize(
    "frame",
    [
        {"t": "state", "state": "dead"},
        {"t": "transcript", "role": "system", "text": "x", "final": True},
        {"t": "transcript", "role": "user", "text": 1, "final": True},
        {"t": "transcript", "role": "user", "text": "x", "final": 1},
        {"t": "end", "reason": "bored"},
    ],
)
def test_text_frames_malformed(frame: dict) -> None:  # type: ignore[type-arg]
    assert isinstance(decode_text(json.dumps(frame)), Malformed)


def test_decoders_drop_unknown_fields() -> None:
    result = decode_out('{"t":"interrupt","name":"secret"}')
    assert result == Valid({"t": "interrupt"})


def test_encode_in_is_total() -> None:
    assert encode_in({"t": "x", "v": float("nan")}) == "{}"
    assert encode_in({"t": "x", "v": object()}) == "{}"
    loop: dict = {}  # type: ignore[type-arg]
    loop["self"] = loop
    assert encode_in(loop) == "{}"


def test_frame_builders_decode_valid() -> None:
    for frame in (hello_frame(), audio_frame(3, "AAA="), bye_frame("limit")):
        assert decode_in(encode_in(frame)) == Valid(frame)


# --- reorder window -------------------------------------------------------------------------


def seqs(items: list[tuple[int, str]]) -> list[int]:
    return [s for s, _ in items]


def test_in_order_frames_pass_straight_through() -> None:
    r = Reorder(4)
    assert [seqs(r.push(i, "p")) for i in range(3)] == [[0], [1], [2]]
    assert r.missed == 0


def test_first_frame_sets_the_start_point() -> None:
    r = Reorder(4)
    assert seqs(r.push(7, "p")) == [7]
    assert seqs(r.push(8, "p")) == [8]


def test_out_of_order_frame_is_held_until_the_gap_fills() -> None:
    r = Reorder(4)
    assert seqs(r.push(0, "a")) == [0]
    assert r.push(2, "c") == []
    assert r.push(3, "d") == []
    assert r.push(1, "b") == [(1, "b"), (2, "c"), (3, "d")]
    assert r.missed == 0


def test_duplicates_and_late_frames_are_dropped() -> None:
    r = Reorder(4)
    r.push(0, "a")
    r.push(2, "c")
    assert r.push(2, "again") == []
    assert r.push(0, "late") == []
    assert r.push(1, "b") == [(1, "b"), (2, "c")]
    assert r.push(1, "late") == []


def test_window_overflow_gives_up_on_the_gap_and_counts_it() -> None:
    r = Reorder(2)
    r.push(0, "a")
    assert r.push(3, "d") == []
    assert r.push(4, "e") == []
    out = r.push(5, "f")  # three held > window 2: skip 1 and 2
    assert seqs(out) == [3, 4, 5]
    assert r.missed == 2
    assert r.push(2, "late") == []


@pytest.mark.parametrize("seq", [-1, 2**53, True, 1.5, "1", None])
def test_invalid_seq_is_ignored(seq) -> None:  # type: ignore[no-untyped-def]
    assert Reorder(4).push(seq, "p") == []


@pytest.mark.parametrize("window", [0, -3, float("nan"), float("inf"), 0.4])
def test_degenerate_window_is_at_least_one(window: float) -> None:
    r = Reorder(window)
    r.push(0, "a")
    assert seqs(r.push(2, "c")) == []  # one held frame is allowed
    assert seqs(r.push(4, "e")) == [2]  # two held: give up on 1, deliver 2, keep 4
    assert r.missed == 1
