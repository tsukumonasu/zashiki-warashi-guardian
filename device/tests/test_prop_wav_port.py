"""Property test for the Python port of the WAV wrapper (cloud-judgement task 21.5).

Feature: cloud-judgement, Property 17: WAV wrapper

The TypeScript half is ``cloud/test/prop-wav.test.ts``; the checks are the same.

**Validates: Requirements 7.10, 7.11, 22.6**
"""

from __future__ import annotations

import importlib.util
import struct
from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "generate_voice_lines.py"
_spec = importlib.util.spec_from_file_location("generate_voice_lines_wav_port", _SCRIPT)
assert _spec is not None and _spec.loader is not None
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
pcm16_to_wav = _module.pcm16_to_wav

rates = st.sampled_from([16000, 8000])
even_pcm = st.binary(max_size=2000).map(lambda b: b[: len(b) - len(b) % 2])
odd_pcm = st.tuples(even_pcm, st.binary(min_size=1, max_size=1)).map(lambda t: t[0] + t[1])


@settings(max_examples=100)
@given(pcm=even_pcm, rate=rates)
def test_property_17_wav_wrapper_header_and_data(pcm: bytes, rate: int) -> None:
    """Feature: cloud-judgement, Property 17: WAV wrapper (even-length PCM)."""
    wav = pcm16_to_wav(pcm, rate)

    assert len(wav) == 44 + len(pcm)
    assert wav[0:4] == b"RIFF"
    assert struct.unpack_from("<I", wav, 4)[0] == 36 + len(pcm)
    assert wav[8:12] == b"WAVE"
    assert wav[12:16] == b"fmt "
    assert struct.unpack_from("<I", wav, 16)[0] == 16
    assert struct.unpack_from("<H", wav, 20)[0] == 1
    assert struct.unpack_from("<H", wav, 22)[0] == 1
    assert struct.unpack_from("<I", wav, 24)[0] == rate
    assert struct.unpack_from("<I", wav, 28)[0] == rate * 2
    assert struct.unpack_from("<H", wav, 32)[0] == 2
    assert struct.unpack_from("<H", wav, 34)[0] == 16
    assert wav[36:40] == b"data"
    assert struct.unpack_from("<I", wav, 40)[0] == len(pcm)
    assert wav[44:] == pcm


@settings(max_examples=100)
@given(pcm=odd_pcm, rate=rates)
def test_property_17_wav_wrapper_rejects_odd_length(pcm: bytes, rate: int) -> None:
    """Feature: cloud-judgement, Property 17: WAV wrapper (odd length is rejected)."""
    with pytest.raises(ValueError):
        pcm16_to_wav(pcm, rate)
