"""Smoke tests for the scaffold: the package imports without hardware.

Feature tests are added by the device-core-loop spec.
"""

import importlib
import tomllib
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st

MODULES = [
    "warashi_agent",
    "warashi_agent.state_machine",
    "warashi_agent.messages",
    "warashi_agent.config",
    "warashi_agent.adapters.fakes",
]

VOICE_LINES = Path(__file__).parent.parent / "warashi_agent" / "voice" / "lines.toml"


@pytest.mark.parametrize("name", MODULES)
def test_module_imports_without_hardware(name: str) -> None:
    importlib.import_module(name)


def test_voice_lines_have_id_japanese_and_subtitle() -> None:
    lines = tomllib.loads(VOICE_LINES.read_text(encoding="utf-8"))["lines"]
    ids = [line["id"] for line in lines]
    assert len(ids) == len(set(ids)), "line ids must be unique"
    for line in lines:
        assert line["ja"].strip() and line["en"].strip()


@given(st.integers())
def test_hypothesis_is_configured(n: int) -> None:
    assert isinstance(n, int)
