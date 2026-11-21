"""Unit tests for ``MqttCloudLink`` (cloud-judgement R23.3, R23.4, R23.6 to R23.14, R23.17).

A complete fake MQTT client, a fake timer factory and a fixed clock stand in for paho, the
network and real waiting: nothing here imports paho or sleeps. The callbacks are invoked with
the argument lists paho-mqtt 2.x passes under ``CallbackAPIVersion.VERSION2``:

- ``on_connect(client, userdata, connect_flags, reason_code, properties)``
- ``on_subscribe(client, userdata, mid, reason_code_list, properties)``
- ``on_disconnect(client, userdata, disconnect_flags, reason_code, properties)``
- ``on_message(client, userdata, message)``
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import pytest

from warashi_agent.adapters.cloud import (
    QUEUE_LIMIT,
    SUBSCRIBE_TIMEOUT_S,
    InboundRaw,
    MqttCloudLink,
)
from warashi_agent.config import AwsConfig
from warashi_agent.messages import (
    EncounterEnded,
    Envelope,
    PresenceDetected,
    SnapshotCaptured,
    StatusReport,
    encode,
)
from warashi_agent.model import CloudConnected, CloudDisconnected

DEVICE_ID = "warashi-test"
EVENTS = f"warashi/{DEVICE_ID}/events"
STATUS = f"warashi/{DEVICE_ID}/status"
COMMANDS = f"warashi/{DEVICE_ID}/commands"
SECRET_IMAGE = "SECRETJPEGDATA"
SECRET_ENDPOINT = "secret-endpoint.example.invalid"
SECRET_PATH = "/secret/path/ca.pem"
NOW = datetime(2026, 11, 20, 12, 0, 0, tzinfo=UTC)

CFG = AwsConfig(
    enabled=True,
    endpoint=SECRET_ENDPOINT,
    port=8883,
    ca_file=SECRET_PATH,
    cert_file="/secret/path/cert.pem",
    key_file="/secret/path/key.pem",
    keepalive_s=60,
    reconnect_min_s=1.0,
    reconnect_max_s=8.0,
)


@dataclass
class FakeReasonCode:
    """Stands in for paho's ``ReasonCode``: only ``is_failure`` is read."""

    is_failure: bool = False


@dataclass
class FakeInfo:
    rc: int = 0


@dataclass
class FakeMessage:
    payload: bytes


class FakeClient:
    """Records every call the link makes; the failure switches are set by the tests."""

    def __init__(self, client_id: str) -> None:
        self.client_id = client_id
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.on_connect: Any = None
        self.on_subscribe: Any = None
        self.on_disconnect: Any = None
        self.on_message: Any = None
        self.next_mid = 1
        self.publish_rc = 0
        self.publish_error: Exception | None = None
        self.subscribe_rc = 0
        self.disconnect_error: Exception | None = None
        self.loop_stop_error: Exception | None = None

    def _rec(self, name: str, *args: Any, **kwargs: Any) -> None:
        self.calls.append((name, args, kwargs))

    def named(self, name: str) -> list[tuple[tuple[Any, ...], dict[str, Any]]]:
        return [(a, k) for n, a, k in self.calls if n == name]

    def names(self) -> list[str]:
        return [n for n, _, _ in self.calls]

    def tls_set(self, *, ca_certs: str, certfile: str, keyfile: str) -> None:
        self._rec("tls_set", ca_certs=ca_certs, certfile=certfile, keyfile=keyfile)

    def will_set(self, topic: str, payload: bytes, qos: int, retain: bool) -> None:
        self._rec("will_set", topic, payload, qos=qos, retain=retain)

    def reconnect_delay_set(self, min_delay: float, max_delay: float) -> None:
        self._rec("reconnect_delay_set", min_delay=min_delay, max_delay=max_delay)

    def max_queued_messages_set(self, queue_size: int) -> None:
        self._rec("max_queued_messages_set", queue_size)

    def connect_async(self, host: str, port: int, keepalive: int) -> None:
        self._rec("connect_async", host, port, keepalive)

    def loop_start(self) -> None:
        self._rec("loop_start")

    def loop_stop(self) -> None:
        self._rec("loop_stop")
        if self.loop_stop_error:
            raise self.loop_stop_error

    def subscribe(self, topic: str, qos: int) -> tuple[int, int]:
        self._rec("subscribe", topic, qos=qos)
        mid = self.next_mid
        self.next_mid += 1
        return (self.subscribe_rc, mid)

    def publish(self, topic: str, payload: bytes, qos: int) -> FakeInfo:
        self._rec("publish", topic, payload, qos=qos)
        if self.publish_error:
            raise self.publish_error
        return FakeInfo(rc=self.publish_rc)

    def disconnect(self) -> None:
        self._rec("disconnect")
        if self.disconnect_error:
            raise self.disconnect_error


class FakeTimer:
    def __init__(self, delay_s: float, fn: Any) -> None:
        self.delay_s = delay_s
        self.fn = fn
        self.started = False
        self.cancelled = False

    def start(self) -> None:
        self.started = True

    def cancel(self) -> None:
        self.cancelled = True

    def fire(self) -> None:
        if self.started and not self.cancelled:
            self.fn()


class ListHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


@dataclass
class Rig:
    link: MqttCloudLink
    clients: list[FakeClient]
    timers: list[FakeTimer]
    posted: list[Any]
    log_lines: list[str]
    ids: list[str] = field(default_factory=list)

    @property
    def client(self) -> FakeClient:
        return self.clients[-1]

    def start(self) -> FakeClient:
        self.link.start(self.posted.append)
        return self.client

    def connect(self) -> None:
        """The paho thread reports a connect and the broker acknowledges the subscription."""
        self.client.on_connect(self.client, None, object(), FakeReasonCode(), None)
        mid = self.client.next_mid - 1
        self.client.on_subscribe(self.client, None, mid, [FakeReasonCode()], None)

    def drop(self) -> None:
        self.client.on_disconnect(self.client, None, object(), FakeReasonCode(True), None)

    def live_timers(self) -> list[FakeTimer]:
        return [t for t in self.timers if t.started and not t.cancelled]


def make_rig() -> Rig:
    clients: list[FakeClient] = []
    timers: list[FakeTimer] = []
    counter = iter(range(1, 1000))

    def factory(client_id: str) -> FakeClient:
        clients.append(FakeClient(client_id))
        return clients[-1]

    def make_timer(delay_s: float, fn: Any) -> FakeTimer:
        timers.append(FakeTimer(delay_s, fn))
        return timers[-1]

    logger = logging.getLogger(f"test.mqtt.{id(clients)}")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    handler = ListHandler()
    logger.addHandler(handler)

    link = MqttCloudLink(
        CFG,
        DEVICE_ID,
        factory,
        encode,
        logger,
        now=lambda: NOW,
        new_id=lambda: f"will-id-{next(counter)}",
        make_timer=make_timer,
    )
    return Rig(link, clients, timers, [], handler.lines)


def env(data: Any, msg_id: str = "m-1", encounter: str | None = None) -> Envelope:
    return Envelope(id=msg_id, ts=NOW, device_id=DEVICE_ID, encounter_id=encounter, data=data)


def status_env(msg_id: str, uptime: int = 1) -> Envelope:
    return env(
        StatusReport(
            state="sleeping",
            mode="guard",
            pan_deg=0.0,
            tilt_deg=0.0,
            lantern=0.0,
            camera_active=False,
            mic_active=False,
            motion_enabled=False,
            uptime_sec=uptime,
            agent_version="test",
        ),
        msg_id,
    )


def snapshot_env(msg_id: str = "snap-1") -> Envelope:
    return env(
        SnapshotCaptured(
            snapshot_id="s1",
            width=640,
            height=480,
            pan_deg=0.0,
            tilt_deg=0.0,
            jpeg_base64=SECRET_IMAGE,
        ),
        msg_id,
        "enc-1",
    )


def presence_env(msg_id: str = "ev-1") -> Envelope:
    return env(PresenceDetected(source="pir"), msg_id, "enc-1")


@pytest.fixture
def rig() -> Rig:
    return make_rig()


def assert_no_secrets(lines: list[str]) -> None:
    text = "\n".join(lines)
    for secret in (SECRET_IMAGE, SECRET_ENDPOINT, SECRET_PATH, "secret"):
        assert secret not in text


# -- start: connect options and last will (R23.3, R23.4) --------------------------------------


def test_start_configures_client_and_connects_in_the_background(rig: Rig) -> None:
    client = rig.start()

    assert client.client_id == DEVICE_ID
    assert client.named("tls_set") == [
        ((), {"ca_certs": SECRET_PATH, "certfile": CFG.cert_file, "keyfile": CFG.key_file})
    ]
    assert client.named("connect_async") == [((SECRET_ENDPOINT, 8883, 60), {})]
    assert client.named("max_queued_messages_set") == [((QUEUE_LIMIT,), {})]
    assert QUEUE_LIMIT == 32
    assert client.named("reconnect_delay_set") == [((), {"min_delay": 1.0, "max_delay": 8.0})]
    assert client.named("loop_start") == [((), {})]
    assert client.on_connect and client.on_subscribe and client.on_disconnect and client.on_message
    assert rig.posted == []  # nothing is connected yet


def test_last_will_is_status_offline_qos1_and_registered_before_connecting(rig: Rig) -> None:
    client = rig.start()

    ((args, kwargs),) = client.named("will_set")
    topic, payload = args
    assert topic == STATUS
    assert kwargs == {"qos": 1, "retain": False}
    body = json.loads(payload)
    assert body["type"] == "status.offline"
    assert body["deviceId"] == DEVICE_ID
    assert body["id"] == "will-id-1"
    assert body["encounterId"] is None
    assert client.names().index("will_set") < client.names().index("connect_async")
    assert client.names().index("connect_async") < client.names().index("loop_start")


def test_start_twice_builds_one_client(rig: Rig) -> None:
    rig.start()
    rig.start()
    assert len(rig.clients) == 1


def test_start_failure_is_swallowed_and_logged_without_private_values(rig: Rig) -> None:
    def broken(client_id: str) -> FakeClient:
        raise OSError(f"cannot read {SECRET_PATH} for {SECRET_ENDPOINT}")

    link = MqttCloudLink(CFG, DEVICE_ID, broken, encode, logging.getLogger("test.broken"))
    link.start(lambda _m: None)
    link.publish(presence_env())  # still must not raise
    link.stop()


# -- connect, subscribe, connected / disconnected posting (R23.6, R23.7, R23.8) ----------------


def test_connected_is_posted_only_after_the_subscription_is_acknowledged(rig: Rig) -> None:
    client = rig.start()

    client.on_connect(client, None, object(), FakeReasonCode(), None)
    assert client.named("subscribe") == [((COMMANDS,), {"qos": 1})]
    assert rig.posted == []

    client.on_subscribe(client, None, 1, [FakeReasonCode()], None)
    assert rig.posted == [CloudConnected()]

    client.on_subscribe(client, None, 1, [FakeReasonCode()], None)  # duplicate ack
    assert rig.posted == [CloudConnected()]


def test_subscribes_again_on_every_connect(rig: Rig) -> None:
    client = rig.start()
    rig.connect()
    rig.drop()
    rig.connect()

    assert len(client.named("subscribe")) == 2
    assert rig.posted == [CloudConnected(), CloudDisconnected(), CloudConnected()]


def test_ack_for_another_message_id_is_ignored(rig: Rig) -> None:
    client = rig.start()
    client.on_connect(client, None, object(), FakeReasonCode(), None)
    client.on_subscribe(client, None, 99, [FakeReasonCode()], None)
    assert rig.posted == []


def test_refused_connection_does_not_subscribe_or_post(rig: Rig) -> None:
    client = rig.start()
    client.on_connect(client, None, object(), FakeReasonCode(True), None)
    assert client.named("subscribe") == []
    assert rig.posted == []
    assert_no_secrets(rig.log_lines)


def test_disconnected_is_posted_once_per_established_connection(rig: Rig) -> None:
    rig.start()
    rig.connect()
    rig.drop()
    rig.drop()  # paho may report the same loss again
    assert rig.posted == [CloudConnected(), CloudDisconnected()]


def test_disconnect_without_established_connection_posts_nothing(rig: Rig) -> None:
    rig.start()
    rig.drop()
    assert rig.posted == []


def test_disconnect_callback_accepts_the_paho_v2_argument_list(rig: Rig) -> None:
    client = rig.start()
    rig.connect()
    # paho 2.x: (client, userdata, disconnect_flags, reason_code, properties)
    client.on_disconnect(client, None, object(), FakeReasonCode(True), None)
    assert rig.posted[-1] == CloudDisconnected()


def test_a_second_connection_gets_its_own_connected_and_disconnected(rig: Rig) -> None:
    rig.start()
    for _ in range(3):
        rig.connect()
        rig.drop()
    assert rig.posted == [CloudConnected(), CloudDisconnected()] * 3


# -- subscription failure and timeout (R23.7) --------------------------------------------------


def test_rejected_subscription_disconnects_posts_nothing_and_retries(rig: Rig) -> None:
    client = rig.start()
    client.on_connect(client, None, object(), FakeReasonCode(), None)
    client.on_subscribe(client, None, 1, [FakeReasonCode(True)], None)

    assert client.named("disconnect") == [((), {})]
    assert rig.posted == []
    (retry,) = [t for t in rig.live_timers() if t.delay_s == CFG.reconnect_min_s]
    retry.fire()
    assert client.names()[-3:] == ["loop_stop", "connect_async", "loop_start"]


def test_unacknowledged_subscription_times_out_after_ten_seconds(rig: Rig) -> None:
    client = rig.start()
    client.on_connect(client, None, object(), FakeReasonCode(), None)

    (timeout,) = [t for t in rig.live_timers() if t.delay_s == SUBSCRIBE_TIMEOUT_S]
    assert SUBSCRIBE_TIMEOUT_S == 10.0
    timeout.fire()

    assert client.named("disconnect") == [((), {})]
    assert rig.posted == []
    # A late ack of the abandoned connection must not post cloud.connected.
    client.on_subscribe(client, None, 1, [FakeReasonCode()], None)
    assert rig.posted == []


def test_subscribe_call_failure_disconnects_and_retries(rig: Rig) -> None:
    client = rig.start()
    client.subscribe_rc = 4  # MQTT_ERR_NO_CONN
    client.on_connect(client, None, object(), FakeReasonCode(), None)
    assert client.named("disconnect") == [((), {})]
    assert rig.posted == []


def test_timeout_timer_of_an_acknowledged_subscription_does_nothing(rig: Rig) -> None:
    client = rig.start()
    rig.connect()
    for timer in rig.live_timers():
        timer.fire()
    assert client.named("disconnect") == []
    assert rig.posted == [CloudConnected()]


def test_retry_delay_doubles_up_to_the_maximum_and_resets_after_a_connect(rig: Rig) -> None:
    client = rig.start()

    def fail_once() -> float:
        client.on_connect(client, None, object(), FakeReasonCode(), None)
        client.on_subscribe(client, None, client.next_mid - 1, [FakeReasonCode(True)], None)
        return rig.live_timers()[-1].delay_s

    delays = [fail_once()]
    rig.live_timers()[-1].fire()
    for _ in range(4):
        delays.append(fail_once())
        rig.live_timers()[-1].fire()
    assert delays == [1.0, 2.0, 4.0, 8.0, 8.0]

    rig.connect()  # established: the backoff starts again
    rig.drop()
    assert fail_once() == 1.0


# -- inbound messages (R23.9) ------------------------------------------------------------------


def test_message_payload_is_posted_raw_and_unparsed(rig: Rig) -> None:
    client = rig.start()
    rig.connect()
    for payload in (b'{"v":1}', b"\xff\xfe not json", b""):
        client.on_message(client, None, FakeMessage(payload))
    assert rig.posted[1:] == [
        InboundRaw(b'{"v":1}'),
        InboundRaw(b"\xff\xfe not json"),
        InboundRaw(b""),
    ]


def test_message_with_a_bytearray_payload_is_posted_as_bytes(rig: Rig) -> None:
    client = rig.start()
    client.on_message(client, None, FakeMessage(bytearray(b"abc")))  # type: ignore[arg-type]
    (raw,) = rig.posted
    assert isinstance(raw, InboundRaw)
    assert raw.payload == b"abc"
    assert type(raw.payload) is bytes


def test_inbound_payload_never_appears_in_the_repr_or_the_log(rig: Rig) -> None:
    client = rig.start()
    client.on_message(client, None, FakeMessage(b"nickname-secret"))
    assert "nickname-secret" not in repr(rig.posted[0])
    assert "nickname-secret" not in "\n".join(rig.log_lines)


# -- publish: topic routing (R23.10) -----------------------------------------------------------


def test_status_goes_to_the_status_topic_and_everything_else_to_events(rig: Rig) -> None:
    client = rig.start()
    rig.connect()
    rig.link.publish(status_env("st-1"))
    rig.link.publish(presence_env("ev-1"))
    rig.link.publish(env(EncounterEnded(reason="cooldown"), "ev-2", "enc-1"))

    sent = client.named("publish")
    assert [a[0] for a, _ in sent] == [STATUS, EVENTS, EVENTS]
    assert all(k == {"qos": 1} for _, k in sent)
    assert [json.loads(a[1])["id"] for a, _ in sent] == ["st-1", "ev-1", "ev-2"]


def test_snapshot_is_sent_while_connected(rig: Rig) -> None:
    client = rig.start()
    rig.connect()
    rig.link.publish(snapshot_env())
    ((args, _),) = client.named("publish")
    assert args[0] == EVENTS
    assert json.loads(args[1])["type"] == "snapshot.captured"


# -- publish while disconnected (R23.12) -------------------------------------------------------


def test_events_and_snapshots_are_dropped_with_type_and_id_but_no_payload(rig: Rig) -> None:
    client = rig.start()
    rig.link.publish(snapshot_env("snap-9"))
    rig.link.publish(presence_env("ev-9"))

    assert client.named("publish") == []
    joined = "\n".join(rig.log_lines)
    assert "snapshot.captured" in joined and "snap-9" in joined
    assert "presence.detected" in joined and "ev-9" in joined
    assert_no_secrets(rig.log_lines)


def test_publish_before_start_drops_without_raising(rig: Rig) -> None:
    rig.link.publish(presence_env("ev-early"))
    assert any("ev-early" in line for line in rig.log_lines)


def test_only_the_latest_status_is_kept_and_sent_after_reconnect(rig: Rig) -> None:
    client = rig.start()
    rig.link.publish(status_env("st-1", uptime=1))
    rig.link.publish(status_env("st-2", uptime=2))
    rig.link.publish(status_env("st-3", uptime=3))
    assert client.named("publish") == []

    rig.connect()

    ((args, kwargs),) = client.named("publish")
    assert args[0] == STATUS and kwargs == {"qos": 1}
    assert json.loads(args[1])["id"] == "st-3"

    rig.drop()
    rig.connect()  # the kept status was consumed and is not sent twice
    assert len(client.named("publish")) == 1


def test_status_kept_across_a_failed_subscription_is_sent_after_the_next_success(rig: Rig) -> None:
    client = rig.start()
    rig.link.publish(status_env("st-1"))
    client.on_connect(client, None, object(), FakeReasonCode(), None)
    client.on_subscribe(client, None, 1, [FakeReasonCode(True)], None)
    assert client.named("publish") == []
    rig.live_timers()[-1].fire()
    rig.connect()
    assert [json.loads(a[1])["id"] for a, _ in client.named("publish")] == ["st-1"]


def test_publish_after_a_disconnect_is_dropped_again(rig: Rig) -> None:
    client = rig.start()
    rig.connect()
    rig.drop()
    rig.link.publish(presence_env())
    assert client.named("publish") == []


# -- queue bound and client failures (R23.11, R23.13) ------------------------------------------


def test_full_client_queue_drops_the_new_envelope_and_logs_it(rig: Rig) -> None:
    client = rig.start()
    rig.connect()
    client.publish_rc = 15  # paho MQTT_ERR_QUEUE_SIZE
    rig.link.publish(snapshot_env("snap-full"))  # must not raise

    joined = "\n".join(rig.log_lines)
    assert "snapshot.captured" in joined and "snap-full" in joined
    assert_no_secrets(rig.log_lines)


def test_client_publish_exception_is_swallowed_and_logged_without_content(rig: Rig) -> None:
    client = rig.start()
    rig.connect()
    client.publish_error = RuntimeError(f"broker said {SECRET_IMAGE}")
    rig.link.publish(snapshot_env("snap-err"))
    rig.link.publish(status_env("st-err"))

    joined = "\n".join(rig.log_lines)
    assert "snap-err" in joined and "RuntimeError" in joined
    assert_no_secrets(rig.log_lines)


def test_encode_failure_is_swallowed(rig: Rig) -> None:
    def bad_encode(_e: Envelope) -> bytes:
        raise ValueError(SECRET_IMAGE)

    link = MqttCloudLink(
        CFG,
        DEVICE_ID,
        lambda cid: FakeClient(cid),
        bad_encode,
        logging.getLogger("test.encode"),
    )
    link.start(lambda _m: None)
    link.publish(presence_env())


# -- stop (R23.14) -----------------------------------------------------------------------------


def test_stop_disconnects_cleanly_then_stops_the_loop(rig: Rig) -> None:
    client = rig.start()
    rig.connect()
    rig.link.stop()

    names = client.names()
    assert names.index("disconnect") < names.index("loop_stop")
    assert names.count("disconnect") == 1 and names.count("loop_stop") == 1


def test_stop_twice_ignores_the_second_call(rig: Rig) -> None:
    client = rig.start()
    rig.connect()
    rig.link.stop()
    rig.link.stop()
    assert client.names().count("disconnect") == 1
    assert client.names().count("loop_stop") == 1


def test_stop_before_start_is_harmless_and_prevents_a_later_start(rig: Rig) -> None:
    rig.link.stop()
    rig.link.start(rig.posted.append)
    assert rig.clients == []


def test_nothing_is_posted_after_stop(rig: Rig) -> None:
    client = rig.start()
    rig.connect()
    rig.link.stop()
    posted_at_stop = list(rig.posted)

    client.on_disconnect(client, None, object(), FakeReasonCode(), None)  # the clean disconnect
    client.on_connect(client, None, object(), FakeReasonCode(), None)
    client.on_subscribe(client, None, 1, [FakeReasonCode()], None)
    client.on_message(client, None, FakeMessage(b"late"))

    assert rig.posted == posted_at_stop == [CloudConnected()]


def test_stop_cancels_pending_timers_and_publish_after_stop_sends_nothing(rig: Rig) -> None:
    client = rig.start()
    client.on_connect(client, None, object(), FakeReasonCode(), None)
    assert rig.live_timers()
    rig.link.stop()
    assert rig.live_timers() == []
    rig.link.publish(presence_env())
    assert client.named("publish") == []


def test_stop_survives_client_errors(rig: Rig) -> None:
    client = rig.start()
    client.disconnect_error = OSError(SECRET_PATH)
    client.loop_stop_error = OSError(SECRET_ENDPOINT)
    rig.link.stop()  # must not raise
    assert client.names().count("loop_stop") == 1
    assert_no_secrets(rig.log_lines)


def test_late_retry_timer_after_stop_does_not_reconnect(rig: Rig) -> None:
    client = rig.start()
    client.on_connect(client, None, object(), FakeReasonCode(), None)
    client.on_subscribe(client, None, 1, [FakeReasonCode(True)], None)
    (retry,) = rig.live_timers()[-1:]
    rig.link.stop()
    retry.fn()  # a timer thread that was already running when stop() was called
    assert client.names().count("connect_async") == 1
