"""Property test for the MQTT Cloud_Link (cloud-judgement R23.10, R23.12, R23.13).

Feature: cloud-judgement, Property 22: Link safety

``MqttCloudLink.publish`` never raises for any envelope or client failure, never publishes
``snapshot.captured`` while disconnected, and keeps at most one pending ``status.report``.

**Validates: Requirements 23.10, 23.12, 23.13**

The test drives the link with random sequences of connect, subscription acknowledgement,
disconnect, publish of every envelope type, and client or encoder failures. It uses its own
fake client and a manual timer, so it needs no network and no paho.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from warashi_agent.adapters.cloud import MqttCloudLink
from warashi_agent.config import AwsConfig
from warashi_agent.messages import (
    EncounterEnded,
    Envelope,
    ErrorCode,
    ErrorReported,
    GazeData,
    JudgementResultData,
    LanternData,
    ModeSetData,
    PresenceDetected,
    ReactionPerformed,
    SnapshotCaptured,
    SpeakData,
    StateChanged,
    StatusOffline,
    StatusReport,
    encode,
)
from warashi_agent.model import Category, EndReason, Mode, Reason, State, Verdict

DEVICE_ID = "warashi-01"
TS = datetime(2026, 11, 20, 12, 34, 56, 789_000, tzinfo=UTC)

PAYLOADS: list[Any] = [
    PresenceDetected(source="pir"),
    SnapshotCaptured(
        snapshot_id="snap-1",
        width=640,
        height=480,
        pan_deg=0.0,
        tilt_deg=0.0,
        jpeg_base64="/9j/4AAQ",
    ),
    StateChanged(from_=State.SLEEPING, to=State.WAKING, reason=Reason.PRESENCE),
    ReactionPerformed(kind=Category.UNCERTAIN, line_id="uncertain", offline=True),
    EncounterEnded(reason=EndReason.COOLDOWN),
    ErrorReported(code=ErrorCode.AUDIO_FAILED, message="x", ref_id=None),
    JudgementResultData(snapshot_id="snap-1", verdict=Verdict.FAMILY, confidence=0.9, face=None),
    SpeakData(line_id="greeting_family", audio_url=None, ja="ja", en="en"),
    GazeData(pan_deg=1.0, tilt_deg=2.0),
    LanternData(level=0.5, fade_ms=100),
    ModeSetData(mode=Mode.GUARD),
    StatusReport(
        state=State.SLEEPING,
        mode=Mode.GUARD,
        pan_deg=0.0,
        tilt_deg=0.0,
        lantern=0.0,
        camera_active=False,
        mic_active=False,
        motion_enabled=False,
        uptime_sec=1,
        agent_version="0.1.0",
    ),
    StatusOffline(),
]


@dataclass
class _Info:
    rc: int


@dataclass
class _FakeClient:
    """Records every publish attempt (before any failure is raised)."""

    mode: str = "ok"  # ok | raise | refuse
    attempts: list[str] = field(default_factory=list)  # envelope ids, in order
    topics: list[str] = field(default_factory=list)
    next_mid: int = 1
    on_connect: Any = None
    on_subscribe: Any = None
    on_disconnect: Any = None
    on_message: Any = None
    _by_payload: dict[bytes, str] = field(default_factory=dict)

    def tls_set(self, **_: Any) -> None: ...
    def will_set(self, *_: Any, **__: Any) -> None: ...
    def reconnect_delay_set(self, **_: Any) -> None: ...
    def max_queued_messages_set(self, _: int) -> None: ...
    def connect_async(self, *_: Any) -> None: ...
    def loop_start(self) -> None: ...
    def loop_stop(self) -> None: ...
    def disconnect(self) -> None: ...

    def subscribe(self, topic: str, qos: int) -> tuple[int, int]:
        mid = self.next_mid
        self.next_mid += 1
        return (0, mid)

    def publish(self, topic: str, payload: bytes, qos: int) -> _Info:
        self.attempts.append(self._by_payload.get(payload, "?"))
        self.topics.append(topic)
        if self.mode == "raise":
            raise OSError("boom")
        return _Info(rc=0 if self.mode == "ok" else 15)


class _Granted:
    """Stands in for a paho ``ReasonCode`` of a granted subscription."""

    is_failure = False


class _NoTimer:
    def start(self) -> None: ...

    def cancel(self) -> None: ...


def _envelope(index: int, payload: Any) -> Envelope:
    is_status = payload.TYPE.startswith("status.")
    return Envelope(
        id=f"id-{index}",
        ts=TS,
        device_id=DEVICE_ID,
        encounter_id=None if is_status else "enc-1",
        data=payload,
    )


op_strategy = st.one_of(
    st.just(("connect",)),
    st.just(("ack",)),
    st.just(("drop",)),
    st.tuples(st.just("mode"), st.sampled_from(["ok", "raise", "refuse"])),
    st.tuples(st.just("encoder"), st.booleans()),
    st.tuples(st.just("publish"), st.integers(0, len(PAYLOADS) - 1)),
)


@settings(
    max_examples=200,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(ops=st.lists(op_strategy, max_size=60))
def test_link_safety(ops: list[tuple[Any, ...]]) -> None:
    """Feature: cloud-judgement, Property 22: Link safety

    **Validates: Requirements 23.10, 23.12, 23.13**
    """
    client = _FakeClient()
    encoder_fails = False
    by_payload = client._by_payload

    def faulty_encode(envelope: Envelope) -> bytes:
        if encoder_fails:
            raise ValueError("cannot encode")
        data = encode(envelope)
        by_payload[data] = envelope.id
        return data

    link = MqttCloudLink(
        AwsConfig(),
        DEVICE_ID,
        lambda _client_id: client,
        faulty_encode,
        logging.getLogger("test-prop-mqtt-link"),
        now=lambda: TS,
        new_id=lambda: "will-id",
        make_timer=lambda _d, _f: _NoTimer(),
    )
    posts: list[object] = []
    link.start(posts.append)

    connected = False  # model: subscription acknowledged and not dropped since
    awaiting_ack = False
    pending_status: str | None = None

    for index, op in enumerate(ops):
        kind = op[0]
        if kind == "connect" and not connected and not awaiting_ack:
            client.on_connect(client, None, None, 0, None)
            awaiting_ack = True
        elif kind == "ack" and awaiting_ack:
            before = len(client.attempts)
            client.on_subscribe(client, None, client.next_mid - 1, [_Granted()], None)
            awaiting_ack = False
            connected = True
            sent = client.attempts[before:]
            # At most one status.report is flushed, and it is the latest one kept (R23.13).
            assert sent == ([pending_status] if pending_status and not encoder_fails else [])
            pending_status = None
        elif kind == "drop":
            client.on_disconnect(client, None, None, 0)
            connected = False
            awaiting_ack = False
        elif kind == "mode":
            client.mode = op[1]
        elif kind == "encoder":
            encoder_fails = op[1]
        elif kind == "publish":
            payload = PAYLOADS[op[1]]
            envelope = _envelope(index, payload)
            before = len(client.attempts)
            link.publish(envelope)  # must never raise (R23.10)
            sent = client.attempts[before:]
            if connected and not encoder_fails:
                assert sent == [envelope.id]
            else:
                assert sent == []  # nothing goes out while disconnected (R23.12)
                if not connected and envelope.type == "status.report":
                    pending_status = envelope.id  # replaces any older pending one

    link.stop()
    link.stop()
