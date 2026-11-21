"""Property 7: audio gain and chunking (voice-conversation, device half)."""

from __future__ import annotations

from array import array

from hypothesis import given, settings
from hypothesis import strategies as st

from warashi_agent.conversation.audio import apply_gain, split_chunks

# Feature: voice-conversation, Property 7: Audio gain

_samples = st.lists(st.integers(-32768, 32767), max_size=300)
_gains = st.floats(min_value=0.0, max_value=32.0, allow_nan=False, allow_infinity=False)


def _pack(values: list[int]) -> bytes:
    arr = array("h", values)
    if arr.itemsize != 2:  # pragma: no cover - 'h' is 16-bit on every supported platform
        raise AssertionError("array('h') is not 16-bit")
    import sys

    if sys.byteorder == "big":  # pragma: no cover
        arr.byteswap()
    return arr.tobytes()


def _unpack(pcm: bytes) -> list[int]:
    import sys

    arr = array("h")
    arr.frombytes(pcm)
    if sys.byteorder == "big":  # pragma: no cover
        arr.byteswap()
    return list(arr)


@settings(max_examples=200)
@given(values=_samples, gain=_gains)
def test_gain_preserves_length_range_and_sign(values: list[int], gain: float) -> None:
    """**Validates: Requirements 12.3, 12.4**"""
    pcm = _pack(values)
    out = apply_gain(pcm, gain)
    assert len(out) == len(pcm)
    result = _unpack(out)
    for before, after in zip(values, result, strict=True):
        assert -32768 <= after <= 32767
        assert after == 0 or (after > 0) == (before > 0)


@settings(max_examples=100)
@given(values=_samples)
def test_unit_gain_returns_input(values: list[int]) -> None:
    """**Validates: Requirements 12.3**"""
    pcm = _pack(values)
    assert apply_gain(pcm, 1.0) == pcm


@settings(max_examples=200)
@given(values=st.lists(st.integers(-32767, 32767), max_size=300), gain=_gains)
def test_clipping_is_symmetric(values: list[int], gain: float) -> None:
    """**Validates: Requirements 12.4**"""
    positive = _unpack(apply_gain(_pack(values), gain))
    negative = _unpack(apply_gain(_pack([-v for v in values]), gain))
    assert negative == [-v for v in positive]


@settings(max_examples=200)
@given(
    buffer=st.binary(max_size=2000),
    chunk_pairs=st.integers(1, 200),
)
def test_split_chunks_exact_size_remainder_and_concatenation(
    buffer: bytes, chunk_pairs: int
) -> None:
    """**Validates: Requirements 12.5**"""
    size = chunk_pairs * 2
    chunks, rest = split_chunks(buffer, size)
    assert all(len(c) == size for c in chunks)
    assert len(rest) < size
    assert b"".join(chunks) + rest == buffer
