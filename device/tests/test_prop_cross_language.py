"""Feature: cloud-judgement, Property 10: Cross-language contract.

**Validates: Requirements 24.13, 24.14**

Every golden fixture in docs/fixtures/schema-v1, and every mutation of it from the corpus below,
gets the outcome kind declared in the corpus and, when valid, re-encodes to the expected value.
The TypeScript suite (cloud/test/prop-cross-language.test.ts) holds the SAME corpus (same names,
same order, same declared outcomes). Both suites check their codec against those declared
outcomes, so the two codecs agree with each other for the same input. Keep the two files in
sync: a mutation changes in both or in neither.

Known difference, deliberately not generated: the Python decoder rejects ``1.0`` for an integer
field, while ``messages.ts`` accepts it (JSON.parse cannot tell ``1.0`` from ``1``). No mutation
writes a float with a zero fraction into an integer field.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from hypothesis import given, settings
from hypothesis import strategies as st

from warashi_agent.messages import Ignored, Valid, decode, encode

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "docs" / "fixtures" / "schema-v1"

Obj = dict[str, Any]

FIXTURES: list[Obj] = [
    json.loads(path.read_text(encoding="utf-8")) for path in sorted(FIXTURE_DIR.glob("*.json"))
]

# Same alphabet in both languages; no lone surrogates.
ALPHABET = "abcXYZ019-_ .あいう界é"
PARAM = st.text(alphabet=ALPHABET, max_size=40)


@dataclass(frozen=True)
class Case:
    raw: str
    kind: str
    expected: Obj | None


def dump(obj: object) -> str:
    return json.dumps(obj, separators=(",", ":"))


def with_key(obj: Obj, key: str, value: object) -> Obj:
    return {**obj, key: value}


def without(obj: Obj, key: str) -> Obj:
    return {k: v for k, v in obj.items() if k != key}


def splice_literal(obj: Obj, literal: str) -> str:
    """Append ``"x":<literal>`` to a compact JSON object text."""
    return f'{dump(obj)[:-1]},"x":{literal}}}'


def reversed_keys(obj: Obj) -> Obj:
    return dict(reversed(list(obj.items())))


def valid(obj: Obj, expected: Obj) -> Case:
    return Case(dump(obj), "valid", expected)


def bad(raw: str) -> Case:
    return Case(raw, "malformed", None)


def ignored(obj: Obj) -> Case:
    return Case(dump(obj), "ignored", None)


def _first_data_field_is_array(f: Obj, _p: str) -> Case:
    # Wrong type for every field kind. A type with no data fields (status.offline) keeps its
    # empty data, so the case stays valid there.
    data = f["data"]
    if not data:
        return valid(f, f)
    first = next(iter(data))
    return bad(dump({**f, "data": with_key(data, first, [])}))


Build = Callable[[Obj, str], Case]

# Deterministic corpus. Order and names match the TypeScript file.
MUTATIONS: list[tuple[str, Build]] = [
    ("identity", lambda f, p: valid(f, f)),
    (
        "reversed_key_order",
        lambda f, p: valid({**reversed_keys(f), "data": reversed_keys(f["data"])}, f),
    ),
    ("extra_top_level_field", lambda f, p: valid(with_key(f, "extra", {"a": [1, 2]}), f)),
    (
        "extra_data_field",
        lambda f, p: valid({**f, "data": with_key(f["data"], "nickname", "x")}, f),
    ),
    ("device_id_text", lambda f, p: valid(with_key(f, "deviceId", p), with_key(f, "deviceId", p))),
    (
        "encounter_id_text",
        lambda f, p: valid(with_key(f, "encounterId", p), with_key(f, "encounterId", p)),
    ),
    (
        "encounter_id_null",
        lambda f, p: valid(with_key(f, "encounterId", None), with_key(f, "encounterId", None)),
    ),
    ("higher_version", lambda f, p: ignored(with_key(f, "v", 2))),
    (
        "much_higher_version_unknown_type",
        lambda f, p: ignored({**f, "v": 100, "type": "ghost.type"}),
    ),
    ("version_zero", lambda f, p: bad(dump(with_key(f, "v", 0)))),
    ("version_negative", lambda f, p: bad(dump(with_key(f, "v", -1)))),
    ("version_fraction", lambda f, p: bad(dump(with_key(f, "v", 1.5)))),
    ("version_string", lambda f, p: bad(dump(with_key(f, "v", "1")))),
    ("version_bool", lambda f, p: bad(dump(with_key(f, "v", True)))),
    ("version_null", lambda f, p: bad(dump(with_key(f, "v", None)))),
    ("unknown_type", lambda f, p: ignored({**f, "type": "ghost.type", "data": []})),
    ("missing_id", lambda f, p: bad(dump(without(f, "id")))),
    ("missing_ts", lambda f, p: bad(dump(without(f, "ts")))),
    ("missing_device_id", lambda f, p: bad(dump(without(f, "deviceId")))),
    ("missing_encounter_id", lambda f, p: bad(dump(without(f, "encounterId")))),
    ("missing_type", lambda f, p: bad(dump(without(f, "type")))),
    ("missing_data", lambda f, p: bad(dump(without(f, "data")))),
    ("ts_without_offset", lambda f, p: bad(dump(with_key(f, "ts", "2026-11-20T12:34:56.789")))),
    ("ts_not_a_time", lambda f, p: bad(dump(with_key(f, "ts", "yesterday")))),
    ("data_is_array", lambda f, p: bad(dump(with_key(f, "data", [])))),
    ("first_data_field_is_array", _first_data_field_is_array),
    ("non_finite_number", lambda f, p: bad(splice_literal(f, "1e400"))),
    (
        "non_finite_beats_higher_version",
        lambda f, p: bad(splice_literal(with_key(f, "v", 2), "1e400")),
    ),
    ("invalid_json", lambda f, p: bad("{")),
    ("top_level_array", lambda f, p: bad("[]")),
    ("top_level_string", lambda f, p: bad('"text"')),
    ("oversize", lambda f, p: bad(splice_literal(f, '"' + "a" * 131_100 + '"'))),
]


def _check(case: Case, label: str) -> None:
    result = decode(case.raw)
    kind = {Valid: "valid", Ignored: "ignored"}.get(type(result), "malformed")
    assert kind == case.kind, f"{label}: expected {case.kind}, got {result!r}"
    if isinstance(result, Valid):
        assert json.loads(encode(result.message)) == case.expected, f"{label}: round trip differs"


def test_has_fixtures_and_a_corpus() -> None:
    assert len(FIXTURES) >= 13
    names = [name for name, _ in MUTATIONS]
    assert len(set(names)) == len(names)


def test_every_fixture_decodes_valid_and_round_trips() -> None:
    """R24.13, R24.14."""
    for fixture in FIXTURES:
        _check(valid(fixture, fixture), fixture["type"])


def test_every_mutation_of_every_fixture_has_its_declared_outcome() -> None:
    for fixture in FIXTURES:
        for name, build in MUTATIONS:
            _check(build(fixture, "abc-あ"), f"{fixture['type']} / {name}")


@settings(max_examples=300, deadline=None)
@given(
    fixture=st.sampled_from(FIXTURES),
    mutation=st.sampled_from(MUTATIONS),
    param=PARAM,
)
def test_property_generated_fixture_mutation_and_text(
    fixture: Obj, mutation: tuple[str, Build], param: str
) -> None:
    name, build = mutation
    _check(build(fixture, param), f"{fixture['type']} / {name}")


def test_ignored_outcomes_carry_the_declared_reason() -> None:
    fixture = FIXTURES[0]
    for raw, reason in (
        (dump({**fixture, "v": 2}), "unsupported_version"),
        (dump({**fixture, "type": "ghost.type"}), "unknown_type"),
        (dump({**fixture, "v": 2, "type": "ghost.type"}), "unsupported_version"),
    ):
        result = decode(raw)
        assert isinstance(result, Ignored)
        assert result.reason == reason
