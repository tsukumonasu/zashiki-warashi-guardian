"""Unit tests for the inbound pipeline (``warashi_agent/inbound.py``).

Every raw message is literal JSON written by hand from ``docs/schema.md``, so a codec mistake
cannot hide behind its own encoder. The tests pin one message per drop step of R21.8 and,
for messages that break several steps at once, check that the earliest step decides
(R12.10, R21.8, R22.4, R22.5, R22.7, R22.8). Property 4 (``test_prop_messages.py``) and
Property 13 (``test_prop_dedup.py``) cover the general rules.
"""

import dataclasses

import pytest

from warashi_agent.inbound import Deduplicator, ErrorToPublish, route_inbound
from warashi_agent.messages import ErrorCode
from warashi_agent.model import (
    FaceBox,
    Gaze,
    JudgementResult,
    Lantern,
    Mode,
    ModeSet,
    Speak,
    Verdict,
)

DEVICE_ID = "warashi-01"
OTHER_DEVICE = "warashi-02"
MESSAGE_ID = "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10"
OTHER_ID = "7d4e2a10-5b6c-4d7e-8f90-a1b2c3d4e5f6"
TS_TEXT = "2026-11-20T12:34:56.789Z"

GAZE_DATA = '{"panDeg":10.5,"tiltDeg":-4}'


def wire(
    type_: str,
    data: str,
    *,
    message_id: str = MESSAGE_ID,
    device_id: str = DEVICE_ID,
    v: str = "1",
) -> bytes:
    """A literal envelope with ``encounterId: null``, as commands may carry (R24.1 S8)."""
    return (
        f'{{"v":{v},"id":"{message_id}","ts":"{TS_TEXT}","deviceId":"{device_id}",'
        f'"encounterId":null,"type":"{type_}","data":{data}}}'
    ).encode()


def fresh() -> Deduplicator:
    return Deduplicator(window=16)


def route(raw: bytes, dedup: Deduplicator | None = None):
    return route_inbound(raw, fresh() if dedup is None else dedup, DEVICE_ID)


# --------------------------------------------------------------------------------------------
# Step 1: decode
# --------------------------------------------------------------------------------------------


def test_malformed_with_readable_id_reports_malformed_message_with_ref_id() -> None:
    # A boolean where a number is expected breaks R22.6; the id is still readable.
    raw = wire("gaze", '{"panDeg":true,"tiltDeg":0}')
    dedup = fresh()
    after, result = route(raw, dedup)
    assert result == ErrorToPublish(code=ErrorCode.MALFORMED_MESSAGE, ref_id=MESSAGE_ID)
    assert after == dedup


def test_unreadable_message_reports_malformed_message_without_ref_id() -> None:
    after, result = route(b"\xff\xfe not json")
    assert result == ErrorToPublish(code=ErrorCode.MALFORMED_MESSAGE, ref_id=None)
    assert after == fresh()


def test_non_string_id_gives_null_ref_id() -> None:
    raw = (
        f'{{"v":1,"id":42,"ts":"{TS_TEXT}","deviceId":"{DEVICE_ID}",'
        f'"encounterId":null,"type":"gaze","data":{GAZE_DATA}}}'
    ).encode()
    _, result = route(raw)
    assert result == ErrorToPublish(code=ErrorCode.MALFORMED_MESSAGE, ref_id=None)


def test_higher_version_reports_unsupported_version() -> None:
    _, result = route(wire("gaze", GAZE_DATA, v="2"))
    assert result == ErrorToPublish(code=ErrorCode.UNSUPPORTED_VERSION, ref_id=MESSAGE_ID)


def test_higher_version_with_non_string_id_gives_null_ref_id() -> None:
    _, result = route(b'{"v":7,"id":null}')
    assert result == ErrorToPublish(code=ErrorCode.UNSUPPORTED_VERSION, ref_id=None)


def test_undefined_type_reports_unknown_type() -> None:
    _, result = route(wire("doll.dance", '{"anything":1}'))
    assert result == ErrorToPublish(code=ErrorCode.UNKNOWN_TYPE, ref_id=MESSAGE_ID)


# --------------------------------------------------------------------------------------------
# Step 2: an event or status type received as a command
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("type_", "data"),
    [
        pytest.param("presence.detected", '{"source":"pir"}', id="event"),
        pytest.param("status.offline", "{}", id="status"),
    ],
)
def test_event_or_status_type_reports_unknown_type(type_: str, data: str) -> None:
    dedup = fresh()
    after, result = route(wire(type_, data), dedup)
    assert result == ErrorToPublish(code=ErrorCode.UNKNOWN_TYPE, ref_id=MESSAGE_ID)
    assert after == dedup


# --------------------------------------------------------------------------------------------
# Step 3: wrong device
# --------------------------------------------------------------------------------------------


def test_wrong_device_reports_wrong_device_and_records_nothing() -> None:
    dedup = fresh()
    after, result = route(wire("gaze", GAZE_DATA, device_id=OTHER_DEVICE), dedup)
    assert result == ErrorToPublish(code=ErrorCode.WRONG_DEVICE, ref_id=MESSAGE_ID)
    assert after == dedup


# --------------------------------------------------------------------------------------------
# Steps 4 and 5: duplicate and accept
# --------------------------------------------------------------------------------------------


def test_accepted_command_records_its_id() -> None:
    after, result = route(wire("gaze", GAZE_DATA))
    assert result == Gaze(ref_id=MESSAGE_ID, pan_deg=10.5, tilt_deg=-4.0)
    assert after.ids == (MESSAGE_ID,)


def test_duplicate_is_dropped_silently() -> None:
    raw = wire("gaze", GAZE_DATA)
    dedup, first = route(raw)
    assert isinstance(first, Gaze)
    after, second = route(raw, dedup)
    assert second is None  # no Command_Event and no error.reported (R22.8)
    assert after == dedup


def test_duplicate_id_with_different_content_is_still_dropped() -> None:
    dedup, _ = route(wire("gaze", GAZE_DATA))
    _, result = route(wire("mode.set", '{"mode":"sleep"}'), dedup)
    assert result is None


# --------------------------------------------------------------------------------------------
# Step order: the earliest failing step decides
# --------------------------------------------------------------------------------------------


def test_malformed_wins_over_wrong_device() -> None:
    raw = wire("gaze", '{"panDeg":"left","tiltDeg":0}', device_id=OTHER_DEVICE)
    _, result = route(raw)
    assert result == ErrorToPublish(code=ErrorCode.MALFORMED_MESSAGE, ref_id=MESSAGE_ID)


def test_unsupported_version_wins_over_wrong_device() -> None:
    _, result = route(wire("gaze", GAZE_DATA, v="2", device_id=OTHER_DEVICE))
    assert result == ErrorToPublish(code=ErrorCode.UNSUPPORTED_VERSION, ref_id=MESSAGE_ID)


def test_unknown_type_wins_over_wrong_device() -> None:
    _, result = route(wire("doll.dance", "{}", device_id=OTHER_DEVICE))
    assert result == ErrorToPublish(code=ErrorCode.UNKNOWN_TYPE, ref_id=MESSAGE_ID)


def test_event_type_check_comes_before_device_check() -> None:
    raw = wire("presence.detected", '{"source":"pir"}', device_id=OTHER_DEVICE)
    _, result = route(raw)
    assert result == ErrorToPublish(code=ErrorCode.UNKNOWN_TYPE, ref_id=MESSAGE_ID)


def test_wrong_device_wins_over_duplicate() -> None:
    dedup, _ = route(wire("gaze", GAZE_DATA))
    after, result = route(wire("gaze", GAZE_DATA, device_id=OTHER_DEVICE), dedup)
    assert result == ErrorToPublish(code=ErrorCode.WRONG_DEVICE, ref_id=MESSAGE_ID)
    assert after == dedup


@pytest.mark.parametrize(
    "rejected",
    [
        pytest.param(wire("gaze", '{"panDeg":true,"tiltDeg":0}'), id="malformed"),
        pytest.param(wire("gaze", GAZE_DATA, v="2"), id="unsupported_version"),
        pytest.param(wire("doll.dance", "{}"), id="unknown_type"),
        pytest.param(wire("presence.detected", '{"source":"pir"}'), id="event_type"),
        pytest.param(wire("gaze", GAZE_DATA, device_id=OTHER_DEVICE), id="wrong_device"),
    ],
)
def test_rejected_message_does_not_mark_its_id_as_seen(rejected: bytes) -> None:
    # Only step 5 records an id, so a dropped message cannot block a later genuine command.
    dedup, first = route(rejected)
    assert isinstance(first, ErrorToPublish)
    _, second = route(wire("gaze", GAZE_DATA), dedup)
    assert isinstance(second, Gaze)


# --------------------------------------------------------------------------------------------
# Command_Events
# --------------------------------------------------------------------------------------------


def test_judgement_result_becomes_a_command_event() -> None:
    data = (
        '{"snapshotId":"snap-1","verdict":"family","confidence":0.93,'
        '"face":{"left":0.4,"top":0.2,"width":0.1,"height":0.2}}'
    )
    _, result = route(wire("judgement.result", data))
    assert result == JudgementResult(
        ref_id=MESSAGE_ID,
        snapshot_id="snap-1",
        verdict=Verdict.FAMILY,
        confidence=0.93,
        face=FaceBox(left=0.4, top=0.2, width=0.1, height=0.2),
    )


def test_lantern_and_mode_set_become_command_events() -> None:
    dedup, lantern = route(wire("lantern", '{"level":0.5,"fadeMs":800}'))
    assert lantern == Lantern(ref_id=MESSAGE_ID, level=0.5, fade_ms=800)
    _, mode = route(wire("mode.set", '{"mode":"sleep"}', message_id=OTHER_ID), dedup)
    assert mode == ModeSet(ref_id=OTHER_ID, mode=Mode.SLEEP)


def test_speak_event_carries_no_ja_or_en() -> None:
    marker_ja = "ZQXJjaMarker0001"
    marker_en = "ZQXJenMarker0002"
    data = f'{{"lineId":"uncertain","audioUrl":null,"ja":"{marker_ja}","en":"{marker_en}"}}'
    _, result = route(wire("speak", data))
    assert result == Speak(ref_id=MESSAGE_ID, line_id="uncertain", audio_url=None)
    field_names = {f.name for f in dataclasses.fields(Speak)}
    assert not field_names & {"ja", "en"}
    assert "ZQXJ" not in repr(result)
    assert all("ZQXJ" not in str(getattr(result, name)) for name in field_names)


def test_speak_with_audio_url_keeps_the_url_only() -> None:
    url = "https://example.invalid/a.wav?k=1"
    data = f'{{"lineId":null,"audioUrl":"{url}","ja":"","en":""}}'
    _, result = route(wire("speak", data))
    assert result == Speak(ref_id=MESSAGE_ID, line_id=None, audio_url=url)


def test_undefined_data_field_never_reaches_the_command_event() -> None:
    data = '{"panDeg":1,"tiltDeg":2,"name":"ZQXJnameMarker03"}'
    _, result = route(wire("gaze", data))
    assert result == Gaze(ref_id=MESSAGE_ID, pan_deg=1.0, tilt_deg=2.0)
    assert "ZQXJ" not in repr(result)
