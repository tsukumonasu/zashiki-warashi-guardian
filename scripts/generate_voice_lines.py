"""Generate the doll's cached voice lines with Amazon Polly (cloud-judgement R22).

Runs on the owner's computer with the owner's AWS credentials, never on the Pi. For each line in
``device/warashi_agent/voice/lines.toml`` it calls Polly (neural, 16 kHz raw PCM), wraps the PCM
in a WAV header and writes ``<id>.wav`` beside ``lines.toml``. It also writes
``cloud/lambda/_shared/voice-lines.json`` so the cloud catalog matches the device catalog.

A line is skipped when its text and voice settings are unchanged since the last successful run
and its WAV file exists. The hashes live in a git-ignored sidecar file next to ``lines.toml``.

``boto3`` is imported lazily, so the rest of this module (and its tests) runs without it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import sys
import tomllib
from collections.abc import Callable
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LINES_PATH = ROOT / "device" / "warashi_agent" / "voice" / "lines.toml"
DEFAULT_JSON_PATH = ROOT / "cloud" / "lambda" / "_shared" / "voice-lines.json"
SIDECAR_NAME = ".voice-hashes.json"

DEFAULT_REGION = "ap-northeast-1"
DEFAULT_VOICE = "Kazuha"
ENGINE = "neural"
LANGUAGE_CODE = "ja-JP"
SAMPLE_RATE = 16000
MAX_TEXT_CHARS = 3000  # Polly's limit for plain text input.
ID_PATTERN = re.compile(r"[a-z0-9_]+")
JSON_FIELDS = ("id", "category", "ja", "en")

HEADER_BYTES = 44
BYTES_PER_SAMPLE = 2


class ConfigError(Exception):
    """lines.toml is missing, unreadable or invalid. Nothing has been generated."""


def pcm16_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    """Wrap raw 16-bit mono little-endian PCM in a 44-byte RIFF/WAVE header.

    Port of ``pcm16ToWav`` in ``cloud/lambda/_shared/wav.ts``. Raises ``ValueError`` when the PCM
    length is odd or the sample rate is not 8,000 or 16,000 (the rates Polly allows for ``pcm``).
    """
    if sample_rate not in (8000, 16000):
        raise ValueError("sample_rate must be 8000 or 16000")
    if len(pcm) % BYTES_PER_SAMPLE != 0:
        raise ValueError("PCM length must be even (16-bit samples)")
    header = (
        b"RIFF"
        + struct.pack("<I", 36 + len(pcm))
        + b"WAVE"
        + b"fmt "
        + struct.pack("<I", 16)  # fmt chunk size
        + struct.pack("<H", 1)  # format 1 = PCM
        + struct.pack("<H", 1)  # mono
        + struct.pack("<I", sample_rate)
        + struct.pack("<I", sample_rate * BYTES_PER_SAMPLE)  # byte rate
        + struct.pack("<H", BYTES_PER_SAMPLE)  # block align
        + struct.pack("<H", 16)  # bits per sample
        + b"data"
        + struct.pack("<I", len(pcm))
    )
    return header + pcm


def load_lines(path: Path) -> list[dict[str, Any]]:
    """Read and validate lines.toml (R22.8). Raises ConfigError before any Polly call."""
    try:
        document = tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ConfigError(f"{path} does not exist") from exc
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from exc

    lines = document.get("lines")
    if not isinstance(lines, list) or not lines:
        raise ConfigError(f"{path} has no [[lines]] entries")

    seen: set[str] = set()
    for index, line in enumerate(lines):
        line_id = line.get("id") if isinstance(line, dict) else None
        if not isinstance(line_id, str) or not line_id:
            raise ConfigError(f"line {index} has an empty or missing id")
        if ID_PATTERN.fullmatch(line_id) is None:
            raise ConfigError(f"line {index} id {line_id!r} must match [a-z0-9_]+")
        if line_id in seen:
            raise ConfigError(f"duplicate line id {line_id!r}")
        seen.add(line_id)
        text = line.get("ja")
        if not isinstance(text, str) or not text.strip():
            raise ConfigError(f"line {line_id!r} has an empty or missing ja text")
        if len(text) > MAX_TEXT_CHARS:
            raise ConfigError(
                f"line {line_id!r} ja text is longer than {MAX_TEXT_CHARS} characters"
            )
    return lines


def line_hash(text: str, voice: str) -> str:
    """Hash of everything that changes the audio: text, voice, engine, rate and language."""
    material = json.dumps(
        {
            "ja": text,
            "voice": voice,
            "engine": ENGINE,
            "rate": SAMPLE_RATE,
            "lang": LANGUAGE_CODE,
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def load_hashes(path: Path) -> dict[str, str]:
    """Read the sidecar. A missing or damaged file means "nothing generated yet"."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def write_atomic(path: Path, data: bytes) -> None:
    """Write through a temporary file so a crash never leaves a half-written file."""
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def synthesize_pcm(client: Any, text: str, voice: str) -> bytes:
    """Call Polly and return the raw PCM. Raises RuntimeError for an empty response."""
    response = client.synthesize_speech(
        Engine=ENGINE,
        VoiceId=voice,
        LanguageCode=LANGUAGE_CODE,
        OutputFormat="pcm",
        SampleRate=str(SAMPLE_RATE),
        Text=text,
        TextType="text",
    )
    stream = response.get("AudioStream") if isinstance(response, dict) else None
    pcm = stream.read() if stream is not None else b""
    if not pcm:
        raise RuntimeError("Polly returned an empty audio stream")
    return bytes(pcm)


def duration_seconds(pcm: bytes) -> float:
    """Duration of 16 kHz mono 16-bit PCM, rounded to 0.1 s."""
    return round(len(pcm) / (SAMPLE_RATE * BYTES_PER_SAMPLE), 1)


def write_catalog_json(path: Path, lines: list[dict[str, Any]]) -> None:
    """Write voice-lines.json (id, category, ja, en) in the order of lines.toml (R7.1)."""
    catalog = [{field: line.get(field) for field in JSON_FIELDS} for line in lines]
    text = json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"
    write_atomic(path, text.encode("utf-8"))


def generate(
    client: Any,
    lines_path: Path = DEFAULT_LINES_PATH,
    json_path: Path = DEFAULT_JSON_PATH,
    voice: str = DEFAULT_VOICE,
    report: Callable[[str], None] = print,
) -> int:
    """Generate every changed line. Returns the process exit code (0 only when all lines are fine).

    ``client`` is a Polly client (or a fake with ``synthesize_speech``).
    """
    try:
        lines = load_lines(lines_path)
    except ConfigError as exc:
        report(f"error: {exc}")
        return 1

    voice_dir = lines_path.parent
    sidecar_path = voice_dir / SIDECAR_NAME
    hashes = load_hashes(sidecar_path)
    failed = 0

    for line in lines:
        line_id = line["id"]
        wav_path = voice_dir / f"{line_id}.wav"
        digest = line_hash(line["ja"], voice)
        if hashes.get(line_id) == digest and wav_path.exists():
            report(f"skipped {line_id}")
            continue
        try:
            pcm = synthesize_pcm(client, line["ja"], voice)
            wav = pcm16_to_wav(pcm)
            write_atomic(wav_path, wav)
        except Exception as exc:  # noqa: BLE001 - any failure of one line must not stop the rest
            failed += 1
            report(f"failed {line_id}: {type(exc).__name__}: {exc}")
            continue
        hashes[line_id] = digest
        # Save after each line so an interruption keeps the progress made so far.
        write_atomic(
            sidecar_path, json.dumps(hashes, indent=2, sort_keys=True).encode("utf-8")
        )
        report(f"generated {line_id} {duration_seconds(pcm):.1f}s")

    write_catalog_json(json_path, lines)
    if failed:
        report(f"{failed} of {len(lines)} lines failed")
        return 1
    return 0


def make_polly_client(region: str) -> Any:
    """Create the Polly client. boto3 is imported here so the module loads without it."""
    try:
        import boto3
    except ImportError as exc:
        raise SystemExit(
            "boto3 is required on the owner's computer: pip install boto3"
        ) from exc
    return boto3.client("polly", region_name=region)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the doll's cached voice lines with Polly."
    )
    parser.add_argument(
        "--lines", type=Path, default=DEFAULT_LINES_PATH, help="path to lines.toml"
    )
    parser.add_argument(
        "--json", type=Path, default=DEFAULT_JSON_PATH, help="path to voice-lines.json"
    )
    parser.add_argument(
        "--voice",
        default=os.environ.get("WARASHI_POLLY_VOICE", DEFAULT_VOICE),
        help=f"Polly voice id (env WARASHI_POLLY_VOICE, default {DEFAULT_VOICE})",
    )
    parser.add_argument(
        "--region",
        default=os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or DEFAULT_REGION,
        help=f"AWS Region (default {DEFAULT_REGION})",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    # Validate first so a bad lines.toml never reaches AWS (and works without boto3).
    try:
        load_lines(args.lines)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    client = make_polly_client(args.region)
    return generate(client, args.lines, args.json, args.voice)


if __name__ == "__main__":
    sys.exit(main())
