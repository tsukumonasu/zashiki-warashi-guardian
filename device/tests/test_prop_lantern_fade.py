"""Property 21: Lantern fade levels (design "Correctness Properties", R12.2, R16.1).

``fade_levels(start, target, fade_ms)`` is the pure plan the lantern adapter plays against
the Scheduler. For any finite inputs this file checks that:

- offsets are non-decreasing, the first offset is at most 20 ms after 0, and consecutive
  offsets are at most 20 ms apart;
- every level lies between the Clamped start and the Clamped target;
- the last entry is ``(clamp(fade_ms, 0, 10000), clamp(target, 0, 1))``;
- a Clamped ``fade_ms`` of 0 gives the single entry ``(0, clamp(target, 0, 1))``.

The Clamp is written again here, independently of the module, so the oracle does not share
a bug with the code under test.

Generators. Levels are drawn in [0, 1], in [-10, 10], from the boundaries (0, 1, values just
outside them) and from very large finite floats. ``fade_ms`` is drawn as an integer (what
``LanternFade.fade_ms`` carries) and, because the signature accepts ``float``, as a float:
the design range [-1000, 20000], the boundaries 0, 1, 19, 20, 21, 10000, 10001 and negatives,
and very large values. Non-finite inputs are not generated: the design states the property
for finite values only.
"""

from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from warashi_agent.adapters.lantern import fade_levels

STEP_MS = 20
FADE_MAX_MS = 10000


def _clamp(value: float, low: float, high: float) -> float:
    """Reference Clamp for finite values, independent of ``adapters/lantern.py``."""
    if value < low:
        return low
    if value > high:
        return high
    return value


_levels = st.one_of(
    st.floats(min_value=0.0, max_value=1.0),
    st.floats(min_value=-10.0, max_value=10.0),
    st.sampled_from([0.0, -0.0, 1.0, -1e-12, 1.0 + 1e-12, -1.0, 2.0]),
    st.floats(min_value=-1e300, max_value=1e300),
)

_FADE_BOUNDARIES = [0, 1, 19, 20, 21, 40, 9999, 10000, 10001, -1, -20, -10001]

_int_fades = st.one_of(
    st.integers(min_value=-1000, max_value=20000),
    st.sampled_from(_FADE_BOUNDARIES),
    st.integers(min_value=-(10**18), max_value=10**18),
)

_float_fades = st.one_of(
    st.floats(min_value=-1000.0, max_value=20000.0),
    st.sampled_from([float(b) for b in _FADE_BOUNDARIES]),
    st.floats(min_value=-1e300, max_value=1e300),
)


def _check_plan(start: float, target: float, fade_ms: float) -> None:
    """Assert every clause of Property 21 for one call of ``fade_levels``."""
    plan = fade_levels(start, target, fade_ms)
    clamped_start = _clamp(start, 0.0, 1.0)
    clamped_target = _clamp(target, 0.0, 1.0)
    clamped_fade = _clamp(fade_ms, 0, FADE_MAX_MS)

    assert len(plan) >= 1

    if clamped_fade == 0:
        assert plan == ((0, clamped_target),)
        return

    previous = 0
    for offset, _ in plan:
        assert offset >= previous, f"offsets go backwards: {plan}"
        assert offset - previous <= STEP_MS, f"gap above {STEP_MS} ms before {offset}: {plan}"
        previous = offset

    low, high = min(clamped_start, clamped_target), max(clamped_start, clamped_target)
    for _, level in plan:
        assert low <= level <= high, f"level {level} outside [{low}, {high}]"

    last_offset, last_level = plan[-1]
    assert last_offset == clamped_fade
    assert last_level == clamped_target


# Feature: device-core-loop, Property 21: Lantern fade levels
@given(start=_levels, target=_levels, fade_ms=_int_fades)
def test_fade_levels_integer_fade(start: float, target: float, fade_ms: int) -> None:
    """**Validates: Requirements 12.2, 16.1** (integer ``fade_ms``, as ``LanternFade`` carries)."""
    _check_plan(start, target, fade_ms)


# Feature: device-core-loop, Property 21: Lantern fade levels
@given(start=_levels, target=_levels, fade_ms=_float_fades)
def test_fade_levels_float_fade(start: float, target: float, fade_ms: float) -> None:
    """**Validates: Requirements 12.2, 16.1** (float ``fade_ms``, which the signature accepts)."""
    _check_plan(start, target, fade_ms)
