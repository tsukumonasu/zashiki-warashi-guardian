"""Property 13: Deduplicator (design "Correctness Properties", R22.8, R22.9, R29.14).

Feeding a sequence of command ids through the inbound rule (drop when ``seen``, otherwise
``accept``) must drop exactly the ids that appear among the last ``window`` accepted ids, and
the Deduplicator must never hold more than ``window`` ids, evicting the oldest first.

The reference model is a plain Python list of accepted ids, written here without using
``inbound.py``: an id is a duplicate when it occurs in the last ``window`` entries of that list.
The same sequence also runs through ``route_inbound`` as encoded ``mode.set`` commands for this
device, so the pipeline's step 4 (silent drop, R22.8) and step 5 (accept and return the
Command_Event, R21.8) are checked against the same model.

Generators follow the design: windows mostly in [16, 40] so that evictions happen, plus the
bounds 16 and 4096 and the default 256. Window 1 is added as an extra edge case of the
Deduplicator itself (the Config_Loader never allows it). Ids come from a pool of about
``window + 8`` values, mixing a cyclic walk over the pool (an id recurs just inside or just
outside the window) with free picks, so repeats inside and just outside the window are
frequent. Sequences are up to ``4 × window`` long, capped at 400 entries so large windows stay
within the test's time budget; the window 4096 therefore only checks the no-eviction case.
"""

# Feature: device-core-loop, Property 13: Deduplicator

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from hypothesis import event, example, given, settings
from hypothesis import strategies as st

from warashi_agent.inbound import Deduplicator, route_inbound
from warashi_agent.messages import Envelope, ModeSetData, encode
from warashi_agent.model import ModeRequest, ModeSet

DEVICE_ID = "warashi-01"
MAX_SEQUENCE = 400
TS = datetime(2026, 11, 20, 12, 34, 56, 789000, tzinfo=UTC)

windows = st.one_of(
    st.integers(min_value=16, max_value=40),
    st.integers(min_value=16, max_value=40),
    st.sampled_from([1, 16, 256, 4096]),
)


@st.composite
def window_and_ids(draw: st.DrawFn) -> tuple[int, list[str]]:
    """A window and an id sequence drawn from a pool of about ``window + 8`` ids."""
    window = draw(windows)
    # About window + 8 ids, mostly more than the window holds, so it can overflow and evict.
    offset = draw(st.one_of(st.integers(min_value=1, max_value=8), st.integers(-4, 8)))
    pool_size = max(1, window + offset)
    # Draw the length explicitly: plain st.lists favours short lists, which would rarely
    # exceed the window and so rarely exercise eviction.
    max_len = min(4 * window, MAX_SEQUENCE)
    length = draw(
        st.one_of(
            st.integers(min_value=0, max_value=max_len),
            st.integers(min_value=max_len // 2, max_value=max_len),
        )
    )
    # Each entry is either the next id of a cyclic walk over the pool, or a free pick.
    # Hypothesis biases free integers toward small values, so free picks alone would rarely
    # cover more than the window. The cyclic walk makes an id recur at distance
    # `pool_size`, which is just outside the window (offset > 0) or just inside it
    # (offset <= 0); free picks add repeats at any distance.
    picks = draw(
        st.lists(
            st.one_of(st.none(), st.integers(min_value=0, max_value=pool_size - 1)),
            min_size=length,
            max_size=length,
        )
    )
    indices: list[int] = []
    cursor = 0
    for pick in picks:
        if pick is None:
            indices.append(cursor % pool_size)
            cursor += 1
        else:
            indices.append(pick)
    return window, [f"msg-{i:05d}" for i in indices]


def mode_set_command(message_id: str) -> bytes:
    """A valid encoded ``mode.set`` command for this device with the given ``id``."""
    env = Envelope(
        id=message_id,
        ts=TS,
        device_id=DEVICE_ID,
        encounter_id=None,
        data=ModeSetData(mode=ModeRequest.GUARD),
    )
    return encode(env)


@pytest.mark.timeout(120)
@settings(deadline=None)
@given(case=window_and_ids())
@example(case=(16, [f"msg-{i % 17:05d}" for i in range(64)]))  # one id beyond the window
@example(case=(1, ["msg-00000", "msg-00000", "msg-00001", "msg-00000"]))
def test_deduplicator_drops_exactly_repeats_within_window(case: tuple[int, list[str]]) -> None:
    window, ids = case
    dedup = Deduplicator(window=window)
    routed = Deduplicator(window=window)
    accepted: list[str] = []  # reference model: every accepted id, oldest first

    for message_id in ids:
        expected_drop = message_id in accepted[-window:]

        # The inbound rule on the Deduplicator itself.
        dropped = dedup.seen(message_id)
        assert dropped == expected_drop, (message_id, accepted[-window:])
        if not dropped:
            dedup = dedup.accept(message_id)

        # The same rule through the pipeline, as an encoded valid command.
        routed_next, result = route_inbound(mode_set_command(message_id), routed, DEVICE_ID)
        if expected_drop:
            assert result is None  # silent drop, no error.reported (R22.8)
            assert routed_next == routed
        else:
            assert isinstance(result, ModeSet)
            assert result.ref_id == message_id
            assert result.mode is ModeRequest.GUARD
        routed = routed_next

        if not expected_drop:
            accepted.append(message_id)

        # At most `window` ids, and exactly the newest accepted ones, oldest first (R22.9).
        if len(accepted) > window:
            event("evicted")
        assert len(dedup.ids) <= window
        assert list(dedup.ids) == accepted[-window:]
        assert routed == dedup
