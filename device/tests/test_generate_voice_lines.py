"""Tests for ``scripts/generate_voice_lines.py`` (cloud-judgement R22.1-R22.4, R22.7, R22.8).

A fake Polly client records calls; ``boto3`` is never imported and the network guard in
``conftest.py`` fails any test that tries to leave the machine.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "generate_voice_lines", REPO / "scripts" / "generate_voice_lines.py"
)
assert _spec and _spec.loader
gen = importlib.util.module_from_spec(_spec)
sys.modules["generate_voice_lines"] = gen
_spec.loader.exec_module(gen)

PCM = b"\x01\x00\x02\x00" * 800  # 1,600 samples = 0.1 s at 16 kHz


class FakePolly:
    """Returns PCM for every call unless told to fail or answer empty for given texts."""

    def __init__(self, fail_texts=(), empty_texts=(), error: Exception | None = None) -> None:
        self.calls: list[dict] = []
        self.fail_texts = set(fail_texts)
        self.empty_texts = set(empty_texts)
        self.error = error

    def synthesize_speech(self, **kwargs):
        self.calls.append(kwargs)
        text = kwargs["Text"]
        if self.error is not None or text in self.fail_texts:
            raise self.error or RuntimeError("polly down")
        if text in self.empty_texts:
            return {"AudioStream": io.BytesIO(b"")}
        return {"AudioStream": io.BytesIO(PCM)}


def toml_text(lines: list[tuple[str, str]]) -> str:
    parts = []
    for line_id, ja in lines:
        parts.append(
            f'[[lines]]\nid = "{line_id}"\ncategory = "family"\nja = "{ja}"\nen = "en {line_id}"\n'
        )
    return "\n".join(parts)


class Env:
    def __init__(self, root: Path) -> None:
        self.dir = root / "voice"
        self.dir.mkdir()
        self.lines = self.dir / "lines.toml"
        self.json = root / "voice-lines.json"
        self.messages: list[str] = []

    def write(self, lines: list[tuple[str, str]]) -> None:
        self.lines.write_text(toml_text(lines), encoding="utf-8")

    def run(self, client, voice: str = "Kazuha") -> int:
        return gen.generate(client, self.lines, self.json, voice, self.messages.append)

    def snapshot(self) -> dict[str, bytes]:
        files = {p.name: p.read_bytes() for p in self.dir.iterdir()}
        if self.json.exists():
            files["__json__"] = self.json.read_bytes()
        return files

    @property
    def sidecar(self) -> Path:
        return self.dir / gen.SIDECAR_NAME


@pytest.fixture
def env(tmp_path: Path) -> Env:
    return Env(tmp_path)


def test_generates_wav_hash_and_json(env: Env) -> None:
    env.write([("a", "あ"), ("b", "い")])
    polly = FakePolly()
    assert env.run(polly) == 0
    assert len(polly.calls) == 2
    first = polly.calls[0]
    assert first["Engine"] == "neural"
    assert first["VoiceId"] == "Kazuha"
    assert first["OutputFormat"] == "pcm"
    assert first["SampleRate"] == "16000"
    assert (env.dir / "a.wav").read_bytes() == gen.pcm16_to_wav(PCM)
    assert set(json.loads(env.sidecar.read_text())) == {"a", "b"}
    assert "generated a 0.1s" in env.messages
    catalog = json.loads(env.json.read_text(encoding="utf-8"))
    assert [c["id"] for c in catalog] == ["a", "b"]
    assert set(catalog[0]) == {"id", "category", "ja", "en"}
    assert catalog[0]["ja"] == "あ"


def test_unchanged_lines_are_skipped(env: Env) -> None:
    env.write([("a", "あ")])
    assert env.run(FakePolly()) == 0
    before = env.snapshot()
    polly = FakePolly()
    env.messages.clear()
    assert env.run(polly) == 0
    assert polly.calls == []
    assert env.messages == ["skipped a"]
    assert env.snapshot() == before


def test_missing_wav_is_regenerated_despite_hash(env: Env) -> None:
    env.write([("a", "あ")])
    env.run(FakePolly())
    (env.dir / "a.wav").unlink()
    polly = FakePolly()
    assert env.run(polly) == 0
    assert len(polly.calls) == 1
    assert (env.dir / "a.wav").exists()


def test_text_change_regenerates_only_that_line(env: Env) -> None:
    env.write([("a", "あ"), ("b", "い")])
    env.run(FakePolly())
    env.write([("a", "あ"), ("b", "うう")])
    polly = FakePolly()
    assert env.run(polly) == 0
    assert [c["Text"] for c in polly.calls] == ["うう"]


def test_voice_change_regenerates_everything(env: Env) -> None:
    env.write([("a", "あ"), ("b", "い")])
    env.run(FakePolly(), voice="Kazuha")
    polly = FakePolly()
    assert env.run(polly, voice="Tomoko") == 0
    assert len(polly.calls) == 2
    assert {c["VoiceId"] for c in polly.calls} == {"Tomoko"}


def test_failed_line_keeps_old_files_and_exit_is_nonzero(env: Env) -> None:
    env.write([("a", "あ"), ("b", "い")])
    env.run(FakePolly())
    old_wav = (env.dir / "a.wav").read_bytes()
    old_hashes = json.loads(env.sidecar.read_text())
    env.write([("a", "新"), ("b", "い2")])
    polly = FakePolly(fail_texts={"新"})
    assert env.run(polly) == 1
    # The failed line keeps its previous wav and hash; the next line is still processed.
    assert (env.dir / "a.wav").read_bytes() == old_wav
    new_hashes = json.loads(env.sidecar.read_text())
    assert new_hashes["a"] == old_hashes["a"]
    assert new_hashes["b"] != old_hashes["b"]
    assert any(m.startswith("failed a:") for m in env.messages)
    assert json.loads(env.json.read_text(encoding="utf-8"))[0]["ja"] == "新"


def test_failed_new_line_writes_no_files(env: Env) -> None:
    env.write([("a", "あ")])
    assert env.run(FakePolly(fail_texts={"あ"})) == 1
    assert not (env.dir / "a.wav").exists()
    assert not env.sidecar.exists()
    assert not list(env.dir.glob("*.tmp"))


def test_empty_response_is_a_failure(env: Env) -> None:
    env.write([("a", "あ")])
    assert env.run(FakePolly(empty_texts={"あ"})) == 1
    assert not (env.dir / "a.wav").exists()
    assert any("empty audio" in m for m in env.messages)


def test_credentials_error_is_reported_per_line(env: Env) -> None:
    env.write([("a", "あ")])
    polly = FakePolly(error=RuntimeError("Unable to locate credentials"))
    assert env.run(polly) == 1
    assert any("Unable to locate credentials" in m for m in env.messages)
    assert not (env.dir / "a.wav").exists()


@pytest.mark.parametrize(
    "lines",
    [
        [("a", "あ"), ("a", "い")],  # duplicate id
        [("", "あ")],  # empty id
        [("Bad-Id", "あ")],  # id outside [a-z0-9_]+
        [("a", "  ")],  # blank text
        [("a", "あ" * (3000 + 1))],  # over-long text
    ],
)
def test_validation_failure_stops_before_any_call_and_changes_nothing(
    env: Env, lines: list[tuple[str, str]]
) -> None:
    env.write([("keep", "あ")])
    env.run(FakePolly())
    env.write(lines)
    before = env.snapshot()
    polly = FakePolly()
    env.messages.clear()
    assert env.run(polly) == 1
    assert polly.calls == []
    assert env.snapshot() == before
    assert env.messages and env.messages[0].startswith("error:")


def test_missing_lines_file_changes_nothing(env: Env) -> None:
    polly = FakePolly()
    assert env.run(polly) == 1
    assert polly.calls == []
    assert not env.json.exists()


def test_main_validates_before_creating_a_client(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    env.write([("a", "あ"), ("a", "い")])

    def no_client(region: str):
        raise AssertionError("client must not be created for an invalid lines.toml")

    monkeypatch.setattr(gen, "make_polly_client", no_client)
    assert gen.main(["--lines", str(env.lines), "--json", str(env.json)]) == 1


def test_write_atomic_leaves_no_temp_file(tmp_path: Path) -> None:
    target = tmp_path / "x.wav"
    gen.write_atomic(target, b"one")
    gen.write_atomic(target, b"two")
    assert target.read_bytes() == b"two"
    assert [p.name for p in tmp_path.iterdir()] == ["x.wav"]


def test_write_atomic_failure_keeps_previous_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "x.wav"
    gen.write_atomic(target, b"old")

    def broken_replace(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", broken_replace)
    with pytest.raises(OSError):
        gen.write_atomic(target, b"new")
    assert target.read_bytes() == b"old"


def test_damaged_sidecar_means_regenerate(env: Env) -> None:
    env.write([("a", "あ")])
    env.run(FakePolly())
    env.sidecar.write_text("{not json", encoding="utf-8")
    polly = FakePolly()
    assert env.run(polly) == 0
    assert len(polly.calls) == 1


def test_generated_json_matches_repository_catalog(tmp_path: Path) -> None:
    """Parity with task 10.7: the script's JSON output equals the committed voice-lines.json."""
    toml_path = REPO / "device" / "warashi_agent" / "voice" / "lines.toml"
    out = tmp_path / "voice-lines.json"
    gen.write_catalog_json(out, gen.load_lines(toml_path))
    committed = REPO / "cloud" / "lambda" / "_shared" / "voice-lines.json"
    assert json.loads(out.read_text(encoding="utf-8")) == json.loads(
        committed.read_text(encoding="utf-8")
    )


def test_importing_the_script_does_not_import_boto3() -> None:
    assert "boto3" not in sys.modules
