"""Smoke tests for the scaffold: the package imports without hardware.

Feature tests are added by the device-core-loop spec.
"""

import importlib
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st

MODULES = [
    "warashi_agent",
    "warashi_agent.__main__",
    "warashi_agent.model",
    "warashi_agent.state_machine",
    "warashi_agent.messages",
    "warashi_agent.inbound",
    "warashi_agent.config",
    "warashi_agent.glide",
    "warashi_agent.head_tracker",
    "warashi_agent.voice",
    "warashi_agent.timebase",
    "warashi_agent.redact",
    "warashi_agent.dispatcher",
    "warashi_agent.selftest",
    "warashi_agent.cli",
    "warashi_agent.adapters",
    "warashi_agent.adapters.audio",
    "warashi_agent.adapters.camera",
    "warashi_agent.adapters.cloud",
    "warashi_agent.adapters.fakes",
    "warashi_agent.adapters.lantern",
    "warashi_agent.adapters.pir",
    "warashi_agent.adapters.ports",
    "warashi_agent.adapters.servo",
]

HARDWARE_LIBRARIES = ("gpiozero", "lgpio")

# Runs in a fresh interpreter, so modules other tests imported cannot hide or fake a result.
_FRESH_IMPORT_CHECK = """
import importlib, sys, threading
for name in {modules!r}:
    importlib.import_module(name)
loaded = [m for m in {libraries!r} if m in sys.modules]
assert not loaded, f"hardware libraries loaded at import: {{loaded}}"
assert threading.active_count() == 1, f"threads started at import: {{threading.enumerate()}}"
"""

VOICE_LINES = Path(__file__).parent.parent / "warashi_agent" / "voice" / "lines.toml"


@pytest.mark.parametrize("name", MODULES)
def test_module_imports_without_hardware(name: str) -> None:
    importlib.import_module(name)


def test_importing_every_module_loads_no_hardware_library_and_starts_no_thread() -> None:
    code = _FRESH_IMPORT_CHECK.format(modules=MODULES, libraries=HARDWARE_LIBRARIES)
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=Path(__file__).parent.parent,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_module_list_covers_every_source_file() -> None:
    package = Path(__file__).parent.parent / "warashi_agent"
    found = {
        "warashi_agent." + ".".join(path.relative_to(package).with_suffix("").parts)
        for path in package.rglob("*.py")
        if path.name != "__init__.py"
    }
    found |= {"warashi_agent", "warashi_agent.adapters"}
    assert found == set(MODULES)


def test_voice_lines_have_id_japanese_and_subtitle() -> None:
    lines = tomllib.loads(VOICE_LINES.read_text(encoding="utf-8"))["lines"]
    ids = [line["id"] for line in lines]
    assert len(ids) == len(set(ids)), "line ids must be unique"
    for line in lines:
        assert line["ja"].strip() and line["en"].strip()


@given(st.integers())
def test_hypothesis_is_configured(n: int) -> None:
    assert isinstance(n, int)
