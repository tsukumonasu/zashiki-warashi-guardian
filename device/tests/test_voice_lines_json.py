"""Parity between the cloud's voice-lines.json and the device's lines.toml (cloud-judgement R7.1).

The cloud keeps a JSON copy so that no TOML parser is needed in /cloud. This test fails with a
message naming the first difference whenever the two drift apart.
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JSON_PATH = ROOT / "cloud" / "lambda" / "_shared" / "voice-lines.json"
TOML_PATH = ROOT / "device" / "warashi_agent" / "voice" / "lines.toml"
FIELDS = ("id", "category", "ja", "en")


def first_difference(json_lines: list[dict], toml_lines: list[dict]) -> str | None:
    """Return a description of the first difference, or None when the catalogs agree."""
    if len(json_lines) != len(toml_lines):
        return f"line count differs: json={len(json_lines)} toml={len(toml_lines)}"
    for index, (from_json, from_toml) in enumerate(zip(json_lines, toml_lines, strict=True)):
        for field in FIELDS:
            if from_json.get(field) != from_toml.get(field):
                return (
                    f"line {index} (id={from_toml.get('id')!r}) field {field!r} differs: "
                    f"json={from_json.get(field)!r} toml={from_toml.get(field)!r}"
                )
    return None


def test_voice_lines_json_matches_toml() -> None:
    json_lines = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    toml_lines = tomllib.loads(TOML_PATH.read_text(encoding="utf-8"))["lines"]
    difference = first_difference(json_lines, toml_lines)
    assert difference is None, difference


def test_first_difference_names_the_field() -> None:
    a = [{"id": "x", "category": "family", "ja": "あ", "en": "a"}]
    b = [{"id": "x", "category": "family", "ja": "あ", "en": "b"}]
    message = first_difference(a, b)
    assert message is not None and "'en'" in message and "'x'" in message
    assert first_difference(a, a + a) is not None
