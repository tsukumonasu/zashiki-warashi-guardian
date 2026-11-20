"""Example-based unit tests for the Manifest_Loader and line choice (device-core-loop task 5.3).

Property 12 (tests/test_prop_manifest.py) checks the per-line rules over random manifests.
These tests pin the file-level behaviour that the property does not reach: the WAV_File_Check
against real files written with the stdlib ``wave`` module (R26.6), a missing or invalid
manifest (R26.11), first-wins for a repeated id (R26.9), problems without line text (R26.5,
R13.1), and the ``choose_line`` boundaries (R1.3).
"""

import json
import logging
import math
import wave
from pathlib import Path

import pytest

from warashi_agent.model import Category
from warashi_agent.voice import (
    ManifestProblem,
    VoiceLine,
    choose_line,
    is_pcm16_mono_wav,
    load_manifest,
)

FAMILY_JA = "おかえり。"
FAMILY_EN = "Welcome home."
STRANGER_JA = "……だあれ？"
STRANGER_EN = "...Who are you?"
UNCERTAIN_JA = "……だれか、いるの？"
UNCERTAIN_EN = "...Is someone there?"


def _line(
    line_id: str,
    category: str = "family",
    ja: str = FAMILY_JA,
    en: str = FAMILY_EN,
    wav: str | None = None,
) -> dict[str, str]:
    return {
        "id": line_id,
        "category": category,
        "ja": ja,
        "en": en,
        "wav": wav if wav is not None else f"{line_id}.wav",
    }


def _write_manifest(directory: Path, lines: list[dict[str, str]]) -> Path:
    """Write a ``lines.toml`` with one ``[[lines]]`` table per entry.

    JSON string literals are valid TOML basic strings for the texts used here.
    """
    chunks = []
    for entry in lines:
        body = "\n".join(f"{k} = {json.dumps(v, ensure_ascii=False)}" for k, v in entry.items())
        chunks.append(f"[[lines]]\n{body}\n")
    path = directory / "lines.toml"
    path.write_text("\n".join(chunks), encoding="utf-8")
    return path


def _write_wav(path: Path, *, sample_width: int = 2, channels: int = 1) -> None:
    """Write a short silent PCM WAV file with the given format."""
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sample_width)
        wav.setframerate(16000)
        wav.writeframes(b"\x00" * sample_width * channels * 160)


# --------------------------------------------------------------------------------------------
# WAV_File_Check (R26.6, R26.10)
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("case", "expected"),
    [("missing", False), ("8bit", False), ("stereo", False), ("valid", True)],
)
def test_is_pcm16_mono_wav(tmp_path: Path, case: str, expected: bool) -> None:
    """Only a 16-bit PCM mono file passes; a missing file is not an error but a False."""
    path = tmp_path / "line.wav"
    if case == "8bit":
        _write_wav(path, sample_width=1)
    elif case == "stereo":
        _write_wav(path, channels=2)
    elif case == "valid":
        _write_wav(path)

    assert is_pcm16_mono_wav(path) is expected


def test_is_pcm16_mono_wav_rejects_a_file_that_is_not_wav(tmp_path: Path) -> None:
    path = tmp_path / "line.wav"
    path.write_bytes(b"not a wav file at all")

    assert is_pcm16_mono_wav(path) is False


def test_wav_check_excludes_missing_8bit_and_stereo_files(tmp_path: Path) -> None:
    """With the check on, each bad file gives one voice_file_missing with the id (R26.6)."""
    manifest = _write_manifest(
        tmp_path,
        [
            _line("a_valid"),
            _line("b_missing"),
            _line("c_eight_bit"),
            _line("d_stereo"),
        ],
    )
    _write_wav(tmp_path / "a_valid.wav")
    _write_wav(tmp_path / "c_eight_bit.wav", sample_width=1)
    _write_wav(tmp_path / "d_stereo.wav", channels=2)

    result = load_manifest(manifest, blocked_words=(), wav_check=True)

    assert [line.id for line in result.available] == ["a_valid"]
    assert [(p.line_ref, p.code) for p in result.problems] == [
        ("b_missing", "voice_file_missing"),
        ("c_eight_bit", "voice_file_missing"),
        ("d_stereo", "voice_file_missing"),
    ]
    assert "b_missing.wav" in result.problems[0].rule


def test_wav_check_disabled_keeps_lines_without_files(tmp_path: Path) -> None:
    """With the check off, a valid line is available whether or not its WAV exists (R26.10)."""
    manifest = _write_manifest(tmp_path, [_line("greeting"), _line("other", wav="stereo.wav")])
    _write_wav(tmp_path / "stereo.wav", channels=2)

    result = load_manifest(manifest, blocked_words=(), wav_check=False)

    assert [line.id for line in result.available] == ["greeting", "other"]
    assert result.problems == ()


# --------------------------------------------------------------------------------------------
# Missing or invalid manifest (R26.11)
# --------------------------------------------------------------------------------------------


def test_missing_manifest_gives_no_lines_and_one_problem(tmp_path: Path) -> None:
    result = load_manifest(tmp_path / "absent.toml", blocked_words=(), wav_check=False)

    assert result.available == ()
    assert len(result.problems) == 1
    assert result.problems[0].line_ref == "manifest"
    assert result.problems[0].code == "voice_line_invalid"


def test_invalid_toml_manifest_gives_no_lines_and_one_problem(tmp_path: Path) -> None:
    path = tmp_path / "lines.toml"
    path.write_text('[[lines]]\nid = "greeting"\nja = "unterminated\n', encoding="utf-8")

    result = load_manifest(path, blocked_words=(), wav_check=False)

    assert result.available == ()
    assert len(result.problems) == 1
    assert result.problems[0].line_ref == "manifest"
    assert result.problems[0].code == "voice_line_invalid"


# --------------------------------------------------------------------------------------------
# Duplicate ids (R26.9) and problem contents (R26.5, R13.1)
# --------------------------------------------------------------------------------------------


def test_duplicate_id_keeps_the_first_line(tmp_path: Path) -> None:
    manifest = _write_manifest(
        tmp_path,
        [
            _line("greeting", "family", FAMILY_JA, FAMILY_EN),
            _line("greeting", "uncertain", UNCERTAIN_JA, UNCERTAIN_EN),
        ],
    )

    result = load_manifest(manifest, blocked_words=(), wav_check=False)

    assert len(result.available) == 1
    kept = result.available[0]
    assert kept.category is Category.FAMILY
    assert kept.ja == FAMILY_JA
    assert result.problems == (
        ManifestProblem(
            line_ref="greeting", rule="id repeats an earlier line", code="voice_line_invalid"
        ),
    )


def test_available_lines_are_sorted_by_id(tmp_path: Path) -> None:
    """Available_Lines are sorted by id in code-point order, not file order (R1.3)."""
    manifest = _write_manifest(tmp_path, [_line("b"), _line("a_1"), _line("a1")])

    result = load_manifest(manifest, blocked_words=(), wav_check=False)

    assert [line.id for line in result.available] == ["a1", "a_1", "b"]


def test_problems_and_log_lines_carry_no_line_text(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A rejected line is named by id or position and rule only (R26.5, R13.1)."""
    blocked = "Hanako"
    too_long_ja = "あ" * 41
    blocked_en = "Welcome home, hanako."
    manifest = _write_manifest(
        tmp_path,
        [
            _line("long_line", ja=too_long_ja),
            _line("blocked_line", en=blocked_en),
            _line("Bad-Id", ja=STRANGER_JA, en=STRANGER_EN),
        ],
    )

    with caplog.at_level(logging.DEBUG, logger="warashi_agent.voice"):
        result = load_manifest(manifest, blocked_words=(blocked,), wav_check=False)

    assert result.available == ()
    assert [p.line_ref for p in result.problems] == ["long_line", "blocked_line", "#3"]
    assert all(p.code == "voice_line_invalid" for p in result.problems)

    texts = [too_long_ja, blocked_en, STRANGER_JA, STRANGER_EN]
    forbidden = [*texts, blocked.casefold(), blocked]
    captured = [f"{p.line_ref} {p.rule} {p!r}" for p in result.problems]
    captured += [record.getMessage() for record in caplog.records]
    assert len(caplog.records) == 3
    for line in captured:
        for secret in forbidden:
            assert secret not in line
    # The bad id itself is user text too; a problem names the position instead.
    assert all("Bad-Id" not in line for line in captured)


def test_voice_line_repr_hides_ja_and_en() -> None:
    line = VoiceLine(
        id="greeting", category=Category.FAMILY, ja=FAMILY_JA, en=FAMILY_EN, wav="g.wav"
    )

    assert FAMILY_JA not in repr(line)
    assert FAMILY_EN not in repr(line)


# --------------------------------------------------------------------------------------------
# choose_line (R1.3, R7.7)
# --------------------------------------------------------------------------------------------


def _lines() -> tuple[VoiceLine, ...]:
    def make(line_id: str, category: Category) -> VoiceLine:
        return VoiceLine(id=line_id, category=category, ja=FAMILY_JA, en=FAMILY_EN, wav="x.wav")

    return (
        make("fam_a", Category.FAMILY),
        make("fam_b", Category.FAMILY),
        make("fam_c", Category.FAMILY),
        make("unc_a", Category.UNCERTAIN),
    )


def test_choose_line_rand_zero_picks_the_first_line_by_id() -> None:
    chosen = choose_line(_lines(), Category.FAMILY, 0.0)

    assert chosen is not None
    assert chosen.id == "fam_a"


def test_choose_line_largest_rand_picks_the_last_line_by_id() -> None:
    chosen = choose_line(_lines(), Category.FAMILY, math.nextafter(1.0, 0.0))

    assert chosen is not None
    assert chosen.id == "fam_c"


def test_choose_line_ignores_input_order() -> None:
    """The pool is sorted by id even if the caller's tuple is not."""
    chosen = choose_line(tuple(reversed(_lines())), Category.FAMILY, 0.0)

    assert chosen is not None
    assert chosen.id == "fam_a"


def test_choose_line_single_line_category() -> None:
    chosen = choose_line(_lines(), Category.UNCERTAIN, math.nextafter(1.0, 0.0))

    assert chosen is not None
    assert chosen.id == "unc_a"


def test_choose_line_empty_category_returns_none() -> None:
    assert choose_line(_lines(), Category.STRANGER, 0.0) is None
    assert choose_line((), Category.FAMILY, 0.5) is None
