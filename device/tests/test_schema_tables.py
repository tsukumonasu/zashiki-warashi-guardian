"""The codec's type registry and enums against the tables of docs/schema.md (task 6.2).

docs/schema.md is the single source of truth (tech.md "Contract first"). These tests read the
document itself, so a type, error code or reason added on one side only fails the build:

- R24.2: the first-column values of the Events, Commands and Status tables equal the codec
  registry's types for that direction. The "Device-internal events (not on the wire)" section is
  not one of these tables and is never read.
- R24.5: the "`error.reported` codes" table equals ``ErrorCode``.
- R24.4: the "`state.changed` reasons" table equals ``Reason``, and every reason in the
  "Reason mapping" table is one of them.

A section ends at the next heading of any level, because the reason and code tables are
``###`` subsections inside the Events section.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from warashi_agent.messages import Direction, ErrorCode, types_for
from warashi_agent.model import Reason

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "docs" / "schema.md"

_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
_SEPARATOR_CELL = re.compile(r"^:?-{3,}:?$")
_BACKTICK_VALUE = re.compile(r"`([^`]+)`")


def _schema_lines() -> list[str]:
    return SCHEMA_PATH.read_text(encoding="utf-8").splitlines()


def _section_lines(lines: list[str], heading: str) -> list[str]:
    """The lines after the heading whose text is ``heading``, up to the next heading of any level.

    Lines inside fenced code blocks are never taken as headings (the envelope example contains
    none today, but a ``#`` comment in a future example must not end a section).
    """
    start: int | None = None
    in_fence = False
    for index, line in enumerate(lines):
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        match = None if in_fence else _HEADING.match(line)
        if match is None:
            continue
        if start is not None:
            return lines[start:index]
        if match.group(2) == heading:
            start = index + 1
    if start is None:
        pytest.fail(f"docs/schema.md has no heading {heading!r}")
    return lines[start:]


def _split_row(line: str) -> list[str]:
    """Split one Markdown table row into cells, honouring ``\\|`` escapes inside cells."""
    body = line.strip().removeprefix("|").removesuffix("|")
    return [cell.replace("\\|", "|").strip() for cell in re.split(r"(?<!\\)\|", body)]


def _table_rows(section: list[str], heading: str) -> list[list[str]]:
    """The body rows of the first table in a section, without its header and separator rows."""
    table: list[str] = []
    for line in section:
        if line.lstrip().startswith("|"):
            table.append(line)
        elif table:
            break
    if len(table) < 2 or not all(_SEPARATOR_CELL.match(c) for c in _split_row(table[1])):
        pytest.fail(f"no Markdown table found under heading {heading!r} in docs/schema.md")
    return [_split_row(line) for line in table[2:]]


def _first_column_values(heading: str) -> list[str]:
    """The backtick value in the first column of every body row of the table under ``heading``."""
    values = []
    for row in _table_rows(_section_lines(_schema_lines(), heading), heading):
        found = _BACKTICK_VALUE.findall(row[0])
        if len(found) != 1:
            pytest.fail(f"row {row!r} under {heading!r} has no single backtick value in column 1")
        values.append(found[0])
    return values


def _assert_same(documented: list[str], implemented: set[str], what: str) -> None:
    """Fail with the names that only one side has, and on duplicate rows in the document."""
    duplicates = sorted({v for v in documented if documented.count(v) > 1})
    only_doc = sorted(set(documented) - implemented)
    only_code = sorted(implemented - set(documented))
    problems = []
    if duplicates:
        problems.append(f"listed twice in docs/schema.md: {duplicates}")
    if only_doc:
        problems.append(f"only in docs/schema.md: {only_doc}")
    if only_code:
        problems.append(f"only in the code: {only_code}")
    assert not problems, f"{what} differ. " + "; ".join(problems)


@pytest.mark.parametrize(
    ("heading", "direction"),
    [
        ("Events (device → cloud)", "event"),
        ("Commands (cloud → device)", "command"),
        ("Status (device → cloud)", "status"),
    ],
)
def test_type_tables_match_codec_registry(heading: str, direction: Direction) -> None:
    """R24.2: each wire table lists exactly the codec's types of that direction."""
    _assert_same(
        _first_column_values(heading),
        set(types_for(direction)),
        f"{direction} types",
    )


def test_internal_events_are_not_wire_types() -> None:
    """R24.2: the Device-internal events section exists and none of its events is on the wire."""
    internal = set(_first_column_values("Device-internal events (not on the wire)"))
    assert "tick" in internal
    wire = types_for("event") | types_for("command") | types_for("status")
    both = sorted(internal & wire)
    assert not both, f"internal events registered as wire types: {both}"


def test_error_code_table_matches_error_code_enum() -> None:
    """R24.5: the device publishes exactly the documented error codes."""
    _assert_same(
        _first_column_values("`error.reported` codes"),
        {code.value for code in ErrorCode},
        "error.reported codes",
    )


def test_reason_table_matches_reason_enum() -> None:
    """R24.4: the documented state.changed reasons equal ``Reason``."""
    _assert_same(
        _first_column_values("`state.changed` reasons"),
        {reason.value for reason in Reason},
        "state.changed reasons",
    )


def test_reason_mapping_uses_only_documented_reasons() -> None:
    """R24.4: every row of the reason mapping table assigns one valid ``Reason`` value."""
    heading = "Reason mapping"
    rows = _table_rows(_section_lines(_schema_lines(), heading), heading)
    assert rows, "the Reason mapping table has no rows"
    valid = {reason.value for reason in Reason}
    for row in rows:
        found = _BACKTICK_VALUE.findall(row[-1])
        assert len(found) == 1, f"mapping row {row!r} has no single reason in its last column"
        assert found[0] in valid, f"mapping row {row!r} uses undefined reason {found[0]!r}"
