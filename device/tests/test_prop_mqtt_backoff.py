"""Property test for the MQTT reconnect backoff helper."""

from hypothesis import given, settings
from hypothesis import strategies as st

from warashi_agent.adapters.cloud import next_reconnect_delay

_bounds = st.tuples(
    st.floats(min_value=0.1, max_value=100, allow_nan=False),
    st.floats(min_value=0.1, max_value=10_000, allow_nan=False),
).map(lambda t: (min(t), max(t)))


@settings(max_examples=200, deadline=None)
@given(bounds=_bounds, failures=st.integers(min_value=1, max_value=40))
def test_backoff_bounds(bounds: tuple[float, float], failures: int) -> None:
    """Feature: cloud-judgement, Backoff bounds (R23.17)

    **Validates: Requirements 23.5, 23.17**

    The delay sequence stays within [min_s, max_s], doubles until the maximum,
    and restarts at min_s after a connect (previous=None).
    """
    min_s, max_s = bounds
    delay = next_reconnect_delay(None, min_s, max_s)
    assert delay == min_s
    for _ in range(failures):
        nxt = next_reconnect_delay(delay, min_s, max_s)
        assert min_s <= nxt <= max_s
        assert nxt == min(delay * 2, max_s)
        delay = nxt
    # A connect resets the sequence to the minimum.
    assert next_reconnect_delay(None, min_s, max_s) == min_s
