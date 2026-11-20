"""Property test for the pure JPEG size parser (R18.3)."""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from warashi_agent.adapters.camera import jpeg_size

SETTINGS = settings(max_examples=200, deadline=None)

_SOI = b"\xff\xd8"


def _segment(marker: int, payload: bytes, fill: int) -> bytes:
    """One marker segment: fill bytes, marker, 16-bit length (counts itself), payload."""
    return b"\xff" * fill + bytes([0xFF, marker]) + (len(payload) + 2).to_bytes(2, "big") + payload


@st.composite
def built_headers(draw):
    """Return ``(data, width, height, dims_end)``; ``dims_end`` is the offset after the width."""
    width = draw(st.integers(1, 65535))
    height = draw(st.integers(1, 65535))
    marker = draw(st.sampled_from([0xC0, 0xC2]))
    out = bytearray(_SOI)
    for _ in range(draw(st.integers(0, 4))):
        app = draw(st.integers(0xE0, 0xEF))
        payload = draw(st.binary(max_size=300))
        out += _segment(app, payload, draw(st.integers(0, 3)))
    out += b"\xff" * draw(st.integers(0, 3))
    components = draw(st.integers(1, 4))
    sof_payload = (
        bytes([8])
        + height.to_bytes(2, "big")
        + width.to_bytes(2, "big")
        + bytes([components])
        + draw(st.binary(min_size=3 * components, max_size=3 * components))
    )
    # Offset of the segment's marker byte, then 2 (marker) + 2 (length) + 1 (precision) + 4.
    start = len(out)
    out += bytes([0xFF, marker]) + (len(sof_payload) + 2).to_bytes(2, "big") + sof_payload
    dims_end = start + 2 + 2 + 1 + 4
    out += draw(st.binary(max_size=100))
    return bytes(out), width, height, dims_end


@st.composite
def soi_with_random_segments(draw):
    parts = [_SOI]
    for _ in range(draw(st.integers(0, 5))):
        marker = draw(st.integers(0, 255))
        parts.append(b"\xff" + bytes([marker]) + draw(st.binary(max_size=40)))
    return b"".join(parts)


def _valid(result) -> bool:
    return result is None or (
        isinstance(result, tuple)
        and len(result) == 2
        and all(isinstance(v, int) and v > 0 for v in result)
    )


# Feature: device-core-loop, Property 23: JPEG size parser
@SETTINGS
@given(st.one_of(st.binary(max_size=2048), soi_with_random_segments()))
def test_arbitrary_bytes_never_raise(data: bytes) -> None:
    """**Validates: Requirements 18.3**"""
    assert _valid(jpeg_size(data))
    assert _valid(jpeg_size(bytearray(data)))
    assert _valid(jpeg_size(memoryview(data)))


# Feature: device-core-loop, Property 23: JPEG size parser
@SETTINGS
@given(built_headers(), st.data())
def test_truncated_headers_never_raise(built, data) -> None:
    """**Validates: Requirements 18.3**"""
    raw = built[0]
    cut = data.draw(st.integers(0, len(raw)))
    assert _valid(jpeg_size(raw[:cut]))


# Feature: device-core-loop, Property 23: JPEG size parser
@SETTINGS
@given(built_headers())
def test_built_headers_give_their_size(built) -> None:
    """**Validates: Requirements 18.3**"""
    raw, width, height, _ = built
    assert jpeg_size(raw) == (width, height)
    assert jpeg_size(bytearray(raw)) == (width, height)
    assert jpeg_size(memoryview(raw)) == (width, height)


# Feature: device-core-loop, Property 23: JPEG size parser
@SETTINGS
@given(built_headers(), st.data())
def test_prefix_before_dimensions_end_gives_none(built, data) -> None:
    """**Validates: Requirements 18.3**"""
    raw, _, _, dims_end = built
    cut = data.draw(st.integers(0, dims_end - 1))
    assert jpeg_size(raw[:cut]) is None


# Feature: device-core-loop, Property 23: JPEG size parser
@SETTINGS
@given(
    built_headers(),
    st.sampled_from(["width", "height", "both"]),
)
def test_zero_dimension_gives_none(built, which) -> None:
    """**Validates: Requirements 18.3**"""
    raw, _, _, dims_end = built
    mutated = bytearray(raw)
    if which in ("height", "both"):
        mutated[dims_end - 4 : dims_end - 2] = b"\x00\x00"
    if which in ("width", "both"):
        mutated[dims_end - 2 : dims_end] = b"\x00\x00"
    assert jpeg_size(bytes(mutated)) is None
