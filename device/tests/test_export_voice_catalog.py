"""Tests for scripts/export_voice_catalog.py (dashboard-simulation task 5.1). No hardware."""

from __future__ import annotations

import importlib.util
import json
import wave
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "export_voice_catalog.py"
spec = importlib.util.spec_from_file_location("export_voice_catalog", SCRIPT)
assert spec is not None and spec.loader is not None
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

LINES_TOML = """
[[lines]]
id = "hello"
category = "family"
ja = "おかえり。"
en = "Welcome home."
wav = "hello.wav"

[[lines]]
id = "silent"
category = "uncertain"
ja = "……だれ？"
en = "...Who?"
wav = "silent.wav"
"""


def write_wav(path: Path, frames: int, rate: int = 16000) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\x00\x00" * frames)


@pytest.fixture
def layout(tmp_path: Path) -> dict[str, Path]:
    voice = tmp_path / "voice"
    voice.mkdir()
    (voice / "lines.toml").write_text(LINES_TOML, encoding="utf-8")
    write_wav(voice / "hello.wav", frames=8000)  # 500 ms at 16 kHz
    return {
        "lines": voice / "lines.toml",
        "catalog": tmp_path / "out" / "voice-catalog.json",
        "audio": tmp_path / "public" / "audio",
    }


def args(layout: dict[str, Path], *extra: str) -> list[str]:
    return [
        "--lines", str(layout["lines"]),
        "--catalog", str(layout["catalog"]),
        "--audio-dir", str(layout["audio"]),
        *extra,
    ]  # fmt: skip


def test_export_writes_catalog_and_copies_wav(layout: dict[str, Path]) -> None:
    assert exporter.main(args(layout)) == 0
    catalog = json.loads(layout["catalog"].read_text(encoding="utf-8"))
    assert catalog == [
        {
            "id": "hello",
            "category": "family",
            "ja": "おかえり。",
            "en": "Welcome home.",
            "durationMs": 500,
            "audio": "audio/hello.wav",
        },
        {
            "id": "silent",
            "category": "uncertain",
            "ja": "……だれ？",
            "en": "...Who?",
            "durationMs": None,
            "audio": None,
        },
    ]
    assert (layout["audio"] / "hello.wav").is_file()
    assert not (layout["audio"] / "silent.wav").exists()


def test_check_passes_after_export(layout: dict[str, Path]) -> None:
    assert exporter.main(args(layout)) == 0
    assert exporter.main(args(layout, "--check")) == 0


def test_check_fails_when_catalog_is_missing(layout: dict[str, Path]) -> None:
    assert exporter.main(args(layout, "--check")) == 1


def test_check_fails_when_text_drifts(layout: dict[str, Path]) -> None:
    exporter.main(args(layout))
    layout["lines"].write_text(LINES_TOML.replace("Welcome home.", "Hi."), encoding="utf-8")
    assert exporter.main(args(layout, "--check")) == 1


def test_check_names_a_missing_id(
    layout: dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    exporter.main(args(layout))
    catalog = json.loads(layout["catalog"].read_text(encoding="utf-8"))
    layout["catalog"].write_text(json.dumps(catalog[:1]), encoding="utf-8")
    assert exporter.main(args(layout, "--check")) == 1
    assert "silent" in capsys.readouterr().err


def test_check_writes_nothing(layout: dict[str, Path]) -> None:
    exporter.main(args(layout, "--check"))
    assert not layout["catalog"].exists()
    assert not layout["audio"].exists()


def test_committed_catalog_matches_device_lines() -> None:
    """The real catalog in the repository is current (the same check as `make test`)."""
    assert exporter.main(["--check"]) == 0
