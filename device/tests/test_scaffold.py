"""Smoke tests that confirm the scaffold is importable and pytest + Hypothesis work.

These tests contain no hardware dependencies and must pass with `make test`
on any laptop. Real feature tests live alongside the modules they cover and
are added during each spec's implementation phase.
"""

from hypothesis import given, settings
from hypothesis import strategies as st


def test_placeholder_passes() -> None:
    """Confirm pytest itself is running."""
    assert True


@given(st.integers())
@settings(max_examples=50)
def test_hypothesis_runs(n: int) -> None:
    """Confirm Hypothesis is wired up correctly."""
    assert isinstance(n, int)
