"""Golden fixtures of docs/fixtures/schema-v1/ against the device codec (task 3.3).

Every wire type of docs/schema.md has exactly one golden file named ``<type>.json``. The
TypeScript tests check the same files, so both codecs agree with the document.

- R24.13: every fixture decodes to ``Valid`` and re-encodes to a semantically equal value
  (JSON values compared, key order ignored).
- R24.14: the fixture ``type`` equals the file name, so a file cannot silently test another type.
- R24.15: a type of docs/schema.md without a fixture, or a fixture without such a type, fails
  and names the type or the file.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.test_schema_tables import _first_column_values
from warashi_agent.messages import Valid, decode, encode

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "docs" / "fixtures" / "schema-v1"

_WIRE_TABLES = (
    "Events (device → cloud)",
    "Commands (cloud → device)",
    "Status (device → cloud)",
)

FIXTURE_FILES = sorted(FIXTURE_DIR.glob("*.json"))


def _documented_types() -> set[str]:
    return {t for heading in _WIRE_TABLES for t in _first_column_values(heading)}


def test_every_type_has_a_fixture_and_every_fixture_has_a_type() -> None:
    """R24.15: names the type without a fixture or the file without a type."""
    documented = _documented_types()
    files = {path.stem for path in FIXTURE_FILES}
    missing = sorted(documented - files)
    extra = sorted(f"{name}.json" for name in files - documented)
    assert not missing, f"types in docs/schema.md without a fixture: {missing}"
    assert not extra, f"fixtures without a matching type in docs/schema.md: {extra}"


@pytest.mark.parametrize("path", FIXTURE_FILES, ids=lambda p: p.name)
def test_fixture_decodes_valid_and_round_trips(path: Path) -> None:
    """R24.13, R24.14: decode to ``Valid``, re-encode, compare as JSON values."""
    raw = path.read_bytes()
    original = json.loads(raw)
    assert original["type"] == path.stem, f"{path.name}: type is {original['type']!r}"

    result = decode(raw)
    assert isinstance(result, Valid), f"{path.name} did not decode to valid: {result!r}"

    assert json.loads(encode(result.message)) == original, f"{path.name}: round trip differs"
