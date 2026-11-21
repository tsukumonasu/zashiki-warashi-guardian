#!/usr/bin/env python3
"""Export the device's voice lines to the dashboard (standard library only).

``device/warashi_agent/voice/lines.toml`` is the single source of the voice-line catalog
(docs/schema.md, "Shared definitions"). This script writes
``dashboard/src/simulation/data/voice-catalog.json`` and copies each line's WAV file to
``dashboard/public/audio/<id>.wav``. A line whose WAV file is absent (the files are
generated on a laptop and git-ignored) gets ``audio: null`` and is shown subtitle-only.

    python scripts/export_voice_catalog.py            write the catalog and copy the WAV files
    python scripts/export_voice_catalog.py --check    fail when the committed catalog differs

``--check`` regenerates the catalog in memory and compares it with the committed file. It
writes nothing, so ``make test`` leaves the working tree clean.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tomllib
import wave
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LINES = ROOT / "device" / "warashi_agent" / "voice" / "lines.toml"
DEFAULT_CATALOG = ROOT / "dashboard" / "src" / "simulation" / "data" / "voice-catalog.json"
DEFAULT_AUDIO_DIR = ROOT / "dashboard" / "public" / "audio"


def wav_duration_ms(path: Path) -> int:
    """Duration of a WAV file in whole milliseconds, rounded to the nearest one."""
    with wave.open(str(path), "rb") as wav:
        rate = wav.getframerate()
        if rate <= 0:
            raise ValueError(f"{path.name}: invalid sample rate")
        return round(wav.getnframes() * 1000 / rate)


def read_lines(lines_path: Path) -> list[dict[str, Any]]:
    """Read the ``[[lines]]`` entries of lines.toml, in file order."""
    with lines_path.open("rb") as fp:
        document = tomllib.load(fp)
    entries = document.get("lines")
    if not isinstance(entries, list):
        raise ValueError(f"{lines_path}: no [[lines]] entries")
    return entries


def build_catalog(lines_path: Path) -> list[dict[str, Any]]:
    """Build the catalog in memory. Never touches the dashboard folders."""
    catalog: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in read_lines(lines_path):
        line_id = entry["id"]
        if line_id in seen:
            raise ValueError(f"duplicate line id: {line_id}")
        seen.add(line_id)
        wav_path = lines_path.parent / entry["wav"]
        has_audio = wav_path.is_file()
        catalog.append(
            {
                "id": line_id,
                "category": entry["category"],
                "ja": entry["ja"],
                "en": entry["en"],
                "durationMs": wav_duration_ms(wav_path) if has_audio else None,
                "audio": f"audio/{line_id}.wav" if has_audio else None,
            }
        )
    return catalog


def render(catalog: list[dict[str, Any]]) -> str:
    """Stable text form of the catalog (UTF-8, two-space indent, trailing newline)."""
    return json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"


def export(lines_path: Path, catalog_path: Path, audio_dir: Path) -> list[dict[str, Any]]:
    """Write the catalog and copy the WAV files of lines that have one."""
    catalog = build_catalog(lines_path)
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    catalog_path.write_text(render(catalog), encoding="utf-8")
    entries = {e["id"]: e for e in read_lines(lines_path)}
    for line in catalog:
        if line["audio"] is not None:
            audio_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(lines_path.parent / entries[line["id"]]["wav"], audio_dir / f"{line['id']}.wav")
    return catalog


def check(lines_path: Path, catalog_path: Path, audio_dir: Path) -> list[str]:
    """Return the problems found; an empty list means the committed catalog is current."""
    expected = build_catalog(lines_path)
    if not catalog_path.is_file():
        return [f"{catalog_path} is missing; run scripts/export_voice_catalog.py"]
    try:
        committed = json.loads(catalog_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return [f"{catalog_path} is not valid JSON; run scripts/export_voice_catalog.py"]
    problems: list[str] = []
    committed_ids = {c.get("id") for c in committed if isinstance(c, dict)}
    for line in expected:
        if line["id"] not in committed_ids:
            problems.append(f"line id missing from the catalog: {line['id']}")
        if line["audio"] is not None and not (audio_dir / f"{line['id']}.wav").is_file():
            problems.append(f"audio file missing in the dashboard: {line['id']}.wav")
    if not problems and committed != expected:
        problems.append("the committed catalog differs from lines.toml; run scripts/export_voice_catalog.py")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when the committed catalog is out of date")
    parser.add_argument("--lines", type=Path, default=DEFAULT_LINES)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--audio-dir", type=Path, default=DEFAULT_AUDIO_DIR)
    args = parser.parse_args(argv)

    try:
        if args.check:
            problems = check(args.lines, args.catalog, args.audio_dir)
            for problem in problems:
                print(f"voice catalog: {problem}", file=sys.stderr)
            return 1 if problems else 0
        catalog = export(args.lines, args.catalog, args.audio_dir)
    except (OSError, KeyError, ValueError, tomllib.TOMLDecodeError, wave.Error) as error:
        print(f"voice catalog: {error}", file=sys.stderr)
        return 1
    with_audio = sum(1 for line in catalog if line["audio"] is not None)
    print(f"voice catalog: {len(catalog)} lines, {with_audio} with audio -> {args.catalog}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
