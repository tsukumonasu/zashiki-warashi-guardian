"""Property 6: Frame codec round trip and robustness (Python), voice-conversation task 16.4.

**Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.7, 5.10, 16.4, 16.5**
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st

from warashi_agent.conversation.frames import (
    MAX_PCM_BYTES,
    Ignored,
    Malformed,
    Valid,
    decode_in,
    decode_out,
    decode_text,
    encode_in,
)
from warashi_agent.conversation.reorder import Reorder

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "docs" / "fixtures" / "voice-v1"

pcm_strings = st.integers(0, MAX_PCM_BYTES // 2).flatmap(
    lambda n: st.binary(min_size=2 * n, max_size=2 * n).map(
        lambda b: base64.b64encode(b).decode("ascii")
    )
)
seqs = st.integers(0, 2**53 - 1)
ids = st.from_regex(r"[A-Za-z0-9-]{1,64}", fullmatch=True)

in_frames = st.one_of(
    st.just({"t": "hello", "client": "device", "v": 1}),
    st.builds(lambda s, p: {"t": "audio", "seq": s, "pcm": p}, seqs, pcm_strings),
    st.builds(
        lambda r, v: {"t": "look.result", "requestId": r, "verdict": v},
        ids,
        st.sampled_from(["family", "stranger", "no_face", "uncertain"]),
    ),
    st.builds(
        lambda r: {"t": "bye", "reason": r}, st.sampled_from(["user", "silence", "limit", "error"])
    ),
)
out_frames = st.one_of(
    st.builds(lambda s, p: {"t": "audio", "seq": s, "pcm": p}, seqs, pcm_strings),
    st.just({"t": "interrupt"}),
    st.builds(
        lambda d: {"t": "command", "envelope": d},
        st.dictionaries(st.text(max_size=5), st.integers(), max_size=4),
    ),
)
text_frames = st.one_of(
    st.builds(
        lambda s: {"t": "state", "state": s}, st.sampled_from(["waiting", "live", "ending"])
    ),
    st.builds(
        lambda r, x, f: {"t": "transcript", "role": r, "text": x, "final": f},
        st.sampled_from(["user", "assistant"]),
        st.text(max_size=40),
        st.booleans(),
    ),
    st.builds(
        lambda r: {"t": "end", "reason": r},
        st.sampled_from(
            [
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
            ]
        ),
    ),
)

json_values = st.recursive(
    st.none() | st.booleans() | st.integers() | st.floats(allow_nan=False) | st.text(max_size=8),
    lambda c: st.lists(c, max_size=3) | st.dictionaries(st.text(max_size=4), c, max_size=3),
    max_leaves=10,
)


@settings(max_examples=200)
@given(frame=in_frames)
def test_in_round_trip(frame: dict) -> None:  # type: ignore[type-arg]
    assert decode_in(encode_in(frame)) == Valid(frame)


@settings(max_examples=200)
@given(frame=out_frames)
def test_out_round_trip(frame: dict) -> None:  # type: ignore[type-arg]
    assert decode_out(encode_in(frame)) == Valid(frame)


@settings(max_examples=200)
@given(frame=text_frames)
def test_text_round_trip(frame: dict) -> None:  # type: ignore[type-arg]
    assert decode_text(encode_in(frame)) == Valid(frame)


@settings(max_examples=300)
@given(raw=st.one_of(st.text(max_size=60), st.binary(max_size=60), json_values.map(json.dumps)))
def test_decoders_never_raise(raw: str | bytes) -> None:
    for decode in (decode_in, decode_out, decode_text):
        assert isinstance(decode(raw), Valid | Malformed | Ignored)


@settings(max_examples=200)
@given(frame=in_frames, key=st.sampled_from(["pcm", "seq", "reason", "client", "verdict"]))
def test_dropping_a_required_field_is_malformed(frame: dict, key: str) -> None:  # type: ignore[type-arg]
    if key not in frame:
        return
    broken = {k: v for k, v in frame.items() if k != key}
    assert isinstance(decode_in(json.dumps(broken)), Malformed)


@settings(max_examples=100)
@given(
    frame=st.sampled_from(sorted(FIXTURE_DIR.glob("in.*.json"))).map(
        lambda p: json.loads(p.read_text())
    )
)
def test_fixtures_survive_the_codec(frame: dict) -> None:  # type: ignore[type-arg]
    assert json.loads(encode_in(decode_in(json.dumps(frame)).frame)) == frame  # type: ignore[union-attr]


@settings(max_examples=300)
@given(
    order=st.lists(st.integers(0, 40), max_size=80),
    window=st.integers(1, 8),
)
def test_reorder_delivers_increasing_without_duplicates_and_bounded(
    order: list[int], window: int
) -> None:
    r = Reorder(window)
    delivered: list[int] = []
    for seq in order:
        delivered += [s for s, _ in r.push(seq, "p")]
        assert len(r._held) <= window  # noqa: SLF001 - the bound is the property
    assert delivered == sorted(set(delivered))
    assert set(delivered) <= set(order)
