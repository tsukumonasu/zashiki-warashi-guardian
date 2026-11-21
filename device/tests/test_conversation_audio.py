"""Unit tests for conversation/audio.py (property tests are task 16.2)."""

import struct

import pytest

from warashi_agent.conversation.audio import apply_gain, speech_energy, split_chunks


def pcm(*values: int) -> bytes:
    return struct.pack(f"<{len(values)}h", *values)


def test_gain_one_returns_input() -> None:
    data = pcm(1, -2, 32767, -32768)
    assert apply_gain(data, 1.0) is data


def test_gain_scales_and_clips_symmetrically() -> None:
    out = struct.unpack("<4h", apply_gain(pcm(100, -100, 30000, -30000), 4.0))
    assert out == (400, -400, 32767, -32767)


def test_min_sample_clips_without_overflow() -> None:
    assert struct.unpack("<h", apply_gain(pcm(-32768), 2.0)) == (-32767,)


def test_odd_length_rejected() -> None:
    with pytest.raises(ValueError):
        apply_gain(b"\x00\x00\x00", 2.0)


def test_split_chunks() -> None:
    chunks, rest = split_chunks(b"abcdefghij", 4)
    assert chunks == [b"abcd", b"efgh"] and rest == b"ij"
    assert split_chunks(b"", 4) == ([], b"")
    with pytest.raises(ValueError):
        split_chunks(b"abc", 3)


def test_speech_energy() -> None:
    assert speech_energy(b"") == 0.0
    assert speech_energy(pcm(100, -300)) == 200.0
