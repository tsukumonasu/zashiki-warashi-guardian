"""Tests for the Cloud_Link adapters: LocalCloudLink and FakeCloudLink (R21.1, R21.4, R21.5).

Time is virtual (``ManualScheduler``), so nothing sleeps.
"""

import json
import logging
import threading
from datetime import UTC, datetime

import pytest

from warashi_agent.adapters.cloud import InboundRaw, LocalCloudLink
from warashi_agent.adapters.fakes import FakeCloudLink
from warashi_agent.messages import (
    Envelope,
    GazeData,
    ModeSetData,
    PresenceDetected,
    SnapshotCaptured,
    Valid,
    decode,
    encode,
)
from warashi_agent.model import CloudConnected, CloudDisconnected
from warashi_agent.timebase import ManualClock, ManualScheduler

JPEG_TEXT = "QUJD" * 50  # 200 characters of base64 text
SECRET = "SECRET-PAYLOAD-VALUE"


def _envelope(data: object, *, message_id: str = "m1", ts: datetime | None = None) -> Envelope:
    return Envelope(
        id=message_id,
        ts=ts if ts is not None else datetime(2026, 11, 20, 12, 0, 0, tzinfo=UTC),
        device_id="warashi-01",
        encounter_id="e1",
        data=data,  # type: ignore[arg-type]
    )


def _snapshot() -> Envelope:
    return _envelope(
        SnapshotCaptured(
            snapshot_id="s1",
            width=640,
            height=480,
            pan_deg=1.0,
            tilt_deg=2.0,
            jpeg_base64=JPEG_TEXT,
        )
    )


@pytest.fixture
def scheduler() -> ManualScheduler:
    return ManualScheduler(ManualClock())


# --------------------------------------------------------------------------------------------
# LocalCloudLink
# --------------------------------------------------------------------------------------------


def test_local_link_logs_one_json_line_with_the_base64_length(
    caplog: pytest.LogCaptureFixture,
) -> None:
    link = LocalCloudLink()
    with caplog.at_level(logging.INFO):
        link.publish(_snapshot())
    records = [r for r in caplog.records if r.name == "warashi_agent.adapters.cloud"]
    assert len(records) == 1
    message = records[0].getMessage()
    assert "\n" not in message
    obj = json.loads(message)
    assert obj["type"] == "snapshot.captured"
    assert obj["data"]["jpegBase64"] == len(JPEG_TEXT)
    assert JPEG_TEXT not in caplog.text


def test_local_link_never_posts_anything() -> None:
    posted: list[object] = []
    link = LocalCloudLink()
    link.start(posted.append)
    link.publish(_envelope(PresenceDetected(source="pir")))
    link.stop()
    assert posted == []


def test_local_link_survives_unencodable_envelopes_without_logging_values(
    caplog: pytest.LogCaptureFixture,
) -> None:
    link = LocalCloudLink()
    naive = _envelope(PresenceDetected(source="pir"), ts=datetime(2026, 1, 1))
    nan = _envelope(GazeData(pan_deg=float("nan"), tilt_deg=0.0), message_id=SECRET)
    with caplog.at_level(logging.INFO):
        link.publish(naive)
        link.publish(nan)
    assert len(caplog.records) == 2
    assert SECRET not in caplog.text
    assert "nan" not in caplog.text.lower()


# --------------------------------------------------------------------------------------------
# FakeCloudLink
# --------------------------------------------------------------------------------------------


def test_fake_link_records_envelopes_in_publish_order(scheduler: ManualScheduler) -> None:
    link = FakeCloudLink(scheduler)
    first = _envelope(PresenceDetected(source="pir"), message_id="a")
    second = _snapshot()
    link.publish(first)
    link.publish(second)
    assert link.envelopes == [first, second]
    assert link.encoded == [encode(first), encode(second)]
    assert link.published == [(first, encode(first)), (second, encode(second))]


def test_fake_link_keeps_every_envelope_when_threads_publish(scheduler: ManualScheduler) -> None:
    link = FakeCloudLink(scheduler)
    per_thread = 50

    def work(prefix: str) -> None:
        for i in range(per_thread):
            link.publish(_envelope(PresenceDetected(source="pir"), message_id=f"{prefix}{i}"))

    threads = [threading.Thread(target=work, args=(p,)) for p in "abcd"]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    ids = [e.id for e in link.envelopes]
    assert len(ids) == 4 * per_thread
    for prefix in "abcd":  # each thread's own order is kept
        mine = [i for i in ids if i.startswith(prefix)]
        assert mine == [f"{prefix}{i}" for i in range(per_thread)]


def test_fake_link_keeps_none_for_an_unencodable_envelope(
    scheduler: ManualScheduler, caplog: pytest.LogCaptureFixture
) -> None:
    link = FakeCloudLink(scheduler)
    bad = _envelope(PresenceDetected(source="pir"), message_id=SECRET, ts=datetime(2026, 1, 1))
    good = _envelope(PresenceDetected(source="pir"))
    with caplog.at_level(logging.WARNING):
        link.publish(bad)
    link.publish(good)
    assert link.published == [(bad, None), (good, encode(good))]
    assert link.encoded == [encode(good)]
    assert SECRET not in caplog.text


def test_fake_link_posts_scripted_items_at_their_times_in_time_order(
    scheduler: ManualScheduler,
) -> None:
    posted: list[object] = []
    link = FakeCloudLink(scheduler)
    link.start(posted.append)
    link.go_offline(at=3.0)
    link.go_online(at=1.0)
    raw = link.type_command(ModeSetData(mode="sleep"), at=2.0)
    assert posted == []
    scheduler.advance(0.9)
    assert posted == []
    scheduler.advance(0.1)
    assert posted == [CloudConnected()]
    scheduler.advance(1.0)
    assert posted == [CloudConnected(), InboundRaw(payload=raw)]
    scheduler.advance(5.0)
    assert posted[-1] == CloudDisconnected()
    assert len(posted) == 3


def test_fake_link_posts_at_once_without_a_time(scheduler: ManualScheduler) -> None:
    posted: list[object] = []
    link = FakeCloudLink(scheduler)
    link.start(posted.append)
    link.go_online()
    link.script_raw(b"not json")
    assert posted == [CloudConnected(), InboundRaw(payload=b"not json")]


def test_fake_link_delivers_nothing_before_start(scheduler: ManualScheduler) -> None:
    posted: list[object] = []
    link = FakeCloudLink(scheduler)
    link.go_online()
    link.go_online(at=1.0)
    scheduler.advance(2.0)
    link.start(posted.append)
    assert posted == []


def test_type_command_bytes_decode_to_the_same_command(scheduler: ManualScheduler) -> None:
    posted: list[object] = []
    link = FakeCloudLink(scheduler)
    link.start(posted.append)
    command = GazeData(pan_deg=5.0, tilt_deg=-2.0)
    raw = link.type_command(command, message_id="c1", encounter_id="e9")
    assert posted == [InboundRaw(payload=raw)]
    result = decode(raw)
    assert isinstance(result, Valid)
    assert result.message.data == command
    assert result.message.id == "c1"
    assert result.message.encounter_id == "e9"
    assert result.message.device_id == "warashi-01"


def test_type_command_device_id_override_gives_a_wrong_device_input(
    scheduler: ManualScheduler,
) -> None:
    link = FakeCloudLink(scheduler, device_id="warashi-07")
    own = decode(link.type_command(ModeSetData(mode="guard")))
    other = decode(link.type_command(ModeSetData(mode="guard"), device_id="warashi-99"))
    assert isinstance(own, Valid) and own.message.device_id == "warashi-07"
    assert isinstance(other, Valid) and other.message.device_id == "warashi-99"


def test_fake_link_delivers_nothing_after_stop_and_cancels_pending(
    scheduler: ManualScheduler,
) -> None:
    posted: list[object] = []
    link = FakeCloudLink(scheduler)
    link.start(posted.append)
    link.go_online(at=1.0)
    link.script_raw(b"x", at=2.0)
    assert scheduler.pending() == 2
    link.stop()
    assert scheduler.pending() == 0
    scheduler.advance(5.0)
    link.go_offline()
    link.script_raw(b"y")
    assert posted == []
