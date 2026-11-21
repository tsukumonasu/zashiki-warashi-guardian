"""Tests for the pure helpers of ``scripts/check_appsync_ordering.py`` (voice-conversation 19.2).

No network and no ``websockets`` package: only ``analyze`` and friends are exercised.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import sys
from pathlib import Path

from hypothesis import given
from hypothesis import strategies as st

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "check_appsync_ordering", REPO / "scripts" / "check_appsync_ordering.py"
)
assert _spec and _spec.loader
mod = importlib.util.module_from_spec(_spec)
sys.modules["check_appsync_ordering"] = mod  # dataclasses looks the module up by name
_spec.loader.exec_module(mod)


def _sent(n: int) -> list[tuple[int, float]]:
    return [(i, float(i)) for i in range(n)]


def test_clean_run() -> None:
    received = [(i, i + 0.1) for i in range(10)]
    r = mod.analyze(_sent(10), received)
    assert (r.sent, r.received, r.out_of_order, r.duplicates, r.missing) == (10, 10, 0, 0, 0)
    assert abs(r.p50_delay - 0.1) < 1e-9 and abs(r.p95_delay - 0.1) < 1e-9


def test_scripted_disorder_duplicate_and_missing() -> None:
    # 0 1 3 2 (late) 3 (dup) 5 ; 4 and 6..9 never arrive
    received = [(0, 0.1), (1, 1.1), (3, 3.1), (2, 2.5), (3, 3.2), (5, 5.1)]
    r = mod.analyze(_sent(10), received)
    assert r.out_of_order == 1
    assert r.duplicates == 1
    assert r.missing == 5
    assert r.received == 5


def test_nothing_received() -> None:
    r = mod.analyze(_sent(3), [])
    assert r.missing == 3 and r.p50_delay is None and r.p95_delay is None
    assert "n/a" in mod.format_report(r)


def test_percentile_nearest_rank() -> None:
    values = [float(i) for i in range(1, 101)]
    assert mod.percentile(values, 0.50) == 50.0
    assert mod.percentile(values, 0.95) == 95.0
    assert mod.percentile([], 0.5) is None


def test_header_subprotocol_decodes() -> None:
    value = mod.header_subprotocol("tok", "host.example")
    assert value.startswith("header-") and "=" not in value
    raw = value[len("header-") :]
    decoded = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    assert decoded == {"Authorization": "tok", "host": "host.example"}


@given(st.permutations(list(range(30))))
def test_permutation_has_no_duplicates_or_missing(order: list[int]) -> None:
    received = [(seq, float(i)) for i, seq in enumerate(order)]
    r = mod.analyze(_sent(30), received)
    assert r.duplicates == 0 and r.missing == 0 and r.received == 30
    if order == sorted(order):
        assert r.out_of_order == 0
