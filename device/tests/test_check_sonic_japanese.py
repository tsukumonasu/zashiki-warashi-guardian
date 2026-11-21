"""Tests for the pure helpers of ``scripts/check_sonic_japanese.py`` (voice-conversation 19.1).

The cases mirror ``japaneseRatio`` in ``cloud/lambda/_shared/voice/language.ts``. No AWS call is
made and neither ``boto3`` nor ``aws_sdk_bedrock_runtime`` is imported.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "check_sonic_japanese", REPO / "scripts" / "check_sonic_japanese.py"
)
assert _spec and _spec.loader
mod = importlib.util.module_from_spec(_spec)
sys.modules["check_sonic_japanese"] = mod
_spec.loader.exec_module(mod)

# (text, expected ratio); None means "under four letters".
SHARED_CASES = [
    ("", None),
    ("あい", None),
    ("1234 ！？", None),
    ("こんにちは", 1.0),
    ("こんにちは、元気？", 1.0),
    ("ありがとう ABC", 5 / 8),
    ("Hello there", 0.0),
    ("ラーメン", 1.0),  # prolonged sound mark counts as Japanese
    ("あ・い・う・え", 1.0),  # the middle dot is not a letter
    ("abcdあい", 2 / 6),
]


@pytest.mark.parametrize(("text", "expected"), SHARED_CASES)
def test_japanese_ratio_matches_cloud_cases(text: str, expected: float | None) -> None:
    got = mod.japanese_ratio(text)
    if expected is None:
        assert got is None
    else:
        assert got == pytest.approx(expected)


def test_japanese_ratio_non_string_is_none() -> None:
    assert mod.japanese_ratio(None) is None
    assert mod.japanese_ratio(123) is None


def test_collector_gathers_assistant_text_and_audio() -> None:
    c = mod.Collector()
    pcm = b"\x01\x00\x02\x00"
    for event in (
        {"contentStart": {"role": "USER"}},
        {"textOutput": {"content": "user words"}},
        {"contentStart": {"role": "ASSISTANT"}},
        {"textOutput": {"content": "こんにちは"}},
        {"audioOutput": {"content": base64.b64encode(pcm).decode()}},
        {"completionEnd": {}},
    ):
        c.feed(json.dumps({"event": event}))
    c.feed("not json")
    assert c.transcript == "こんにちは"
    assert bytes(c.pcm) == pcm
    assert c.done


def test_wav_has_header_and_even_payload() -> None:
    c = mod.Collector()
    c.pcm += b"\x01\x00\x02"  # odd byte is dropped
    wav = c.wav()
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
    assert len(wav) == 44 + 2


def test_input_events_order() -> None:
    events = [json.loads(e)["event"] for e in mod.build_input_events("p", "tiffany", "sys", "hi")]
    names = [next(iter(e)) for e in events]
    assert names[:2] == ["sessionStart", "promptStart"]
    assert names[2:] == ["contentStart", "textInput", "contentEnd"] * 2
    assert events[1]["promptStart"]["audioOutputConfiguration"]["voiceId"] == "tiffany"
