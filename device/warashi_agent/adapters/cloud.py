"""Cloud_Link interface: how the Dispatcher talks to the cloud (R21).

Why this module exists:
- The core loop must run and be tested without AWS (tech.md, "Hardware-free tests"). The
  Dispatcher therefore depends only on the small ``CloudLink`` Protocol below. The
  Local_Cloud_Link and the Fake_Cloud_Link of this spec, and the real MQTT client of the
  ``cloud-judgement`` spec, all implement it and are interchangeable.
- Incoming commands cross the boundary still encoded, as ``InboundRaw``. The Cloud_Link never
  decodes them (R21.2), so every message, whatever its source, takes the one inbound pipeline
  in ``inbound.py`` inside the Dispatcher's loop (R21.8).

This module imports only the standard library and the package's own value types. ``paho`` is
imported lazily, inside ``PahoClientFactory`` (apt package ``python3-paho-mqtt``), and no AWS
SDK is used, so importing this module opens no connection and works without paho installed.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from warashi_agent.config import AwsConfig
from warashi_agent.messages import Envelope, StatusOffline
from warashi_agent.model import CloudConnected, CloudDisconnected
from warashi_agent.redact import format_envelope

_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class InboundRaw:
    """One encoded Wire_Message received from the cloud, not yet decoded (R21.2).

    ``payload`` is hidden from ``repr()``: the raw bytes of an incoming message may hold a
    nickname or a token and must never reach a log line (R13.6).
    """

    payload: bytes = field(repr=False)


CloudPost = Callable[[InboundRaw | CloudConnected | CloudDisconnected], None]
"""What a Cloud_Link may hand to the Dispatcher: raw messages and connectivity changes."""


class CloudLink(Protocol):
    """The cloud side of the Dispatcher (R21.1 to R21.3).

    ``publish`` is called from the main loop, so it must return without waiting on the network
    and must never raise: an implementation queues or logs the envelope and reports its own
    failures in its log (R21.1). Connectivity changes are posted as ``cloud.connected`` and
    ``cloud.disconnected`` (R21.3); the State_Machine treats the cloud as disconnected until
    the first ``cloud.connected`` (R9.1).
    """

    def start(self, post: CloudPost) -> None:
        """Begin delivering inbound messages and connectivity changes through ``post``."""
        ...

    def publish(self, envelope: Envelope) -> None:
        """Hand one envelope to the cloud. Never waits on the network, never raises."""
        ...

    def stop(self) -> None:
        """Stop delivering and release the connection; bounded in time (R20.7)."""
        ...


class LocalCloudLink:
    """Cloud_Link for ``--fake`` runs and for a doll with no cloud yet (R21.4, R21.5).

    It logs each published envelope as one redacted JSON line at INFO and does nothing else:
    it delivers no command and never posts ``cloud.connected``, so the State_Machine keeps
    treating the cloud as disconnected and the doll takes its offline path (R9.1). That is
    the honest behaviour of a link that has no cloud behind it.

    ``format_envelope`` does the redaction in the one shared place: ``jpegBase64`` becomes its
    character count, and the ``audioUrl`` query and the ``ja`` / ``en`` texts never reach the
    log (R13.6).
    """

    def start(self, post: CloudPost) -> None:
        """Nothing to deliver: no inbound message and no connectivity change ever comes."""

    def publish(self, envelope: Envelope) -> None:
        """Log the envelope. Does no I/O besides logging and never raises (R21.1)."""
        try:
            _log.info("%s", format_envelope(envelope))
        except Exception as exc:  # a logging call must never stop the main loop
            # Type name only: the message of the exception may quote payload content.
            _log.warning("could not log an envelope (%s)", type(exc).__name__)

    def stop(self) -> None:
        """Nothing to release."""


# --------------------------------------------------------------------------------------------
# MqttCloudLink (cloud-judgement R23)
# --------------------------------------------------------------------------------------------

QUEUE_LIMIT = 32
"""Messages the MQTT client may hold in its queue (R23.13)."""

SUBSCRIBE_TIMEOUT_S = 10.0
"""How long the broker may take to acknowledge the subscription (R23.7)."""

_QOS = 1
_MQTT_ERR_SUCCESS = 0


def next_reconnect_delay(previous: float | None, min_s: float, max_s: float) -> float:
    """The next reconnect delay: ``min_s`` first, then doubled, never above ``max_s`` (R23.5).

    ``previous`` is the delay used for the last failed attempt, or ``None`` after a
    connection was established (or before the first attempt), which resets to ``min_s``.
    Pure, so the property test can check the bounds without a clock.
    """
    if previous is None:
        return min(min_s, max_s)
    return min(max(previous, min_s) * 2, max_s)


class MqttClient(Protocol):
    """The slice of ``paho.mqtt.client.Client`` (callback API version 2) the link uses."""

    on_connect: Any
    on_subscribe: Any
    on_disconnect: Any
    on_message: Any

    def tls_set(self, *, ca_certs: str, certfile: str, keyfile: str) -> None: ...

    def will_set(self, topic: str, payload: bytes, qos: int, retain: bool) -> Any: ...

    def reconnect_delay_set(self, min_delay: float, max_delay: float) -> None: ...

    def max_queued_messages_set(self, queue_size: int) -> Any: ...

    def connect_async(self, host: str, port: int, keepalive: int) -> Any: ...

    def loop_start(self) -> Any: ...

    def loop_stop(self) -> Any: ...

    def subscribe(self, topic: str, qos: int) -> Any: ...

    def publish(self, topic: str, payload: bytes, qos: int) -> Any: ...

    def disconnect(self) -> Any: ...


class MqttClientFactory(Protocol):
    """Builds an MQTT client; a fake in tests, ``PahoClientFactory`` on the doll."""

    def __call__(self, client_id: str) -> MqttClient: ...


class PahoClientFactory:
    """Thin real factory: MQTT 3.1.1, clean session, paho callback API version 2 (R23.3).

    paho is imported here, on the first call, so the rest of the agent (and every test) runs
    without it. On the doll it comes from ``apt install python3-paho-mqtt`` (R23.16).
    """

    def __call__(self, client_id: str) -> MqttClient:
        import paho.mqtt.client as mqtt  # noqa: PLC0415  (lazy on purpose, see class docstring)

        return mqtt.Client(  # type: ignore[no-any-return]
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=client_id,
            protocol=mqtt.MQTTv311,
            clean_session=True,
        )


class _Timer(Protocol):
    def start(self) -> None: ...

    def cancel(self) -> None: ...


TimerFactory = Callable[[float, Callable[[], None]], _Timer]


def _thread_timer(delay_s: float, fn: Callable[[], None]) -> _Timer:
    timer = threading.Timer(delay_s, fn)
    timer.daemon = True
    return timer


def _is_failure(reason_code: object) -> bool:
    """True for a paho ``ReasonCode`` (or a plain int) that reports a failure."""
    flag = getattr(reason_code, "is_failure", None)
    if flag is not None:
        return bool(flag)
    return reason_code not in (0, None)


class MqttCloudLink:
    """Cloud_Link over MQTT to AWS IoT Core (cloud-judgement R23).

    Threads: paho runs its own network thread (``loop_start``). Callbacks run there and only
    hand data over: ``post`` receives raw bytes and connectivity changes, and nothing is
    parsed or waited on. ``publish`` runs on the main loop, takes a short lock, and calls
    paho's non-blocking ``publish``, so it returns at once and never raises (R23.10).

    "Connected" means the broker acknowledged the subscription to the commands topic, not only
    the TCP and TLS handshake: ``cloud.connected`` is posted at that moment (R23.6).
    Log lines carry envelope types and ids only, never payloads, the endpoint or file paths.
    """

    def __init__(
        self,
        cfg: AwsConfig,
        device_id: str,
        make_client: MqttClientFactory,
        encode: Callable[[Envelope], bytes],
        log: logging.Logger,
        *,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        new_id: Callable[[], str] = lambda: str(uuid.uuid4()),
        make_timer: TimerFactory = _thread_timer,
    ) -> None:
        self._cfg = cfg
        self._device_id = device_id
        self._make_client = make_client
        self._encode = encode
        self._log = log
        self._now = now
        self._new_id = new_id
        self._make_timer = make_timer
        self._events_topic = f"warashi/{device_id}/events"
        self._status_topic = f"warashi/{device_id}/status"
        self._commands_topic = f"warashi/{device_id}/commands"

        self._lock = threading.Lock()
        self._client: MqttClient | None = None
        self._post: CloudPost | None = None
        self._started = False
        self._stopped = False
        self._connected = False  # cloud.connected was posted for the current connection
        self._generation = 0  # counts connections, so a stale timer or ack is ignored
        self._subscribe_mid: int | None = None
        self._awaiting_ack = False  # a subscription of the current connection is pending
        self._pending_status: Envelope | None = None
        self._retry_delay: float | None = None
        self._timers: list[_Timer] = []

    # -- CloudLink -------------------------------------------------------------------------

    def start(self, post: CloudPost) -> None:
        """Configure the client, register the last will, and connect in the background."""
        with self._lock:
            if self._started or self._stopped:
                return
            self._started = True
            self._post = post
        try:
            client = self._make_client(self._device_id)
            client.on_connect = self._on_connect
            client.on_subscribe = self._on_subscribe
            client.on_disconnect = self._on_disconnect
            client.on_message = self._on_message
            client.tls_set(
                ca_certs=self._cfg.ca_file,
                certfile=self._cfg.cert_file,
                keyfile=self._cfg.key_file,
            )
            will = Envelope(
                id=self._new_id(),
                ts=self._now(),
                device_id=self._device_id,
                encounter_id=None,
                data=StatusOffline(),
            )
            client.will_set(self._status_topic, self._encode(will), qos=_QOS, retain=False)
            client.reconnect_delay_set(
                min_delay=self._cfg.reconnect_min_s, max_delay=self._cfg.reconnect_max_s
            )
            client.max_queued_messages_set(QUEUE_LIMIT)
            self._client = client
            self._connect_async(client)
            client.loop_start()
        except Exception as exc:  # the doll must keep running offline
            # Type name only: the message may quote a file path or the endpoint.
            self._log.error("MQTT link could not start (%s)", type(exc).__name__)

    def publish(self, envelope: Envelope) -> None:
        """Send ``envelope`` if connected; otherwise apply the offline rules (R23.10 to R23.13)."""
        try:
            self._publish(envelope)
        except Exception as exc:
            self._log.warning(
                "publish failed for %s %s (%s)", envelope.type, envelope.id, type(exc).__name__
            )

    def stop(self) -> None:
        """Disconnect cleanly, stop the network loop, and post nothing more (R23.14)."""
        with self._lock:
            if self._stopped:
                return
            self._stopped = True
            self._connected = False
            self._generation += 1
            timers, self._timers = self._timers, []
            client = self._client
        for timer in timers:
            timer.cancel()
        if client is None:
            return
        try:
            client.disconnect()  # a clean disconnect does not publish the last will
        except Exception as exc:
            self._log.warning("MQTT disconnect failed (%s)", type(exc).__name__)
        try:
            client.loop_stop()
        except Exception as exc:
            self._log.warning("MQTT loop stop failed (%s)", type(exc).__name__)

    # -- publish ---------------------------------------------------------------------------

    def _publish(self, envelope: Envelope) -> None:
        with self._lock:
            client = self._client
            if self._stopped or client is None:
                self._log_drop(envelope, "link not running")
                return
            if not self._connected:
                if envelope.type == "status.report":
                    self._pending_status = envelope  # only the latest one is kept
                elif envelope.type == "snapshot.captured":
                    self._log_drop(envelope, "disconnected, snapshot would be stale")
                else:
                    self._log_drop(envelope, "disconnected")
                return
        self._send(client, envelope)

    def _send(self, client: MqttClient, envelope: Envelope) -> None:
        topic = self._status_topic if envelope.type.startswith("status.") else self._events_topic
        try:
            info = client.publish(topic, self._encode(envelope), qos=_QOS)
        except Exception as exc:
            self._log.warning(
                "client publish failed for %s %s (%s), dropped",
                envelope.type,
                envelope.id,
                type(exc).__name__,
            )
            return
        rc = getattr(info, "rc", _MQTT_ERR_SUCCESS)
        if rc != _MQTT_ERR_SUCCESS:  # for example MQTT_ERR_QUEUE_SIZE when the queue is full
            self._log_drop(envelope, f"client refused it (rc {rc})")

    def _log_drop(self, envelope: Envelope, why: str) -> None:
        # Type and id only, never payload content (R23.12).
        self._log.info("dropped %s %s: %s", envelope.type, envelope.id, why)

    # -- connecting ------------------------------------------------------------------------

    def _connect_async(self, client: MqttClient) -> None:
        client.connect_async(self._cfg.endpoint, self._cfg.port, self._cfg.keepalive_s)

    def _on_connect(
        self, client: Any, userdata: Any, flags: Any, reason_code: Any, properties: Any = None
    ) -> None:
        try:
            with self._lock:
                if self._stopped:
                    return
                self._generation += 1
                generation = self._generation
                self._connected = False
            if _is_failure(reason_code):
                self._log.warning("MQTT connection refused by the broker")
                return  # paho retries under reconnect_delay_set
            result = client.subscribe(self._commands_topic, qos=_QOS)
            rc, mid = result if isinstance(result, tuple) else (_MQTT_ERR_SUCCESS, None)
            if rc != _MQTT_ERR_SUCCESS:
                self._subscription_failed(generation, "subscribe call failed")
                return
            with self._lock:
                self._subscribe_mid = mid
                self._awaiting_ack = True
            self._add_timer(
                SUBSCRIBE_TIMEOUT_S,
                lambda: self._subscription_failed(generation, "subscription timed out"),
            )
        except Exception as exc:
            self._log.warning("on_connect failed (%s)", type(exc).__name__)

    def _on_subscribe(
        self, client: Any, userdata: Any, mid: Any, reason_codes: Any, properties: Any = None
    ) -> None:
        try:
            with self._lock:
                if self._stopped or self._connected or not self._awaiting_ack:
                    return
                if self._subscribe_mid is not None and mid != self._subscribe_mid:
                    return
                generation = self._generation
            codes = reason_codes if isinstance(reason_codes, list | tuple) else [reason_codes]
            if any(_is_failure(code) for code in codes):
                self._subscription_failed(generation, "subscription rejected")
                return
            with self._lock:
                if self._stopped or generation != self._generation or self._connected:
                    return
                self._connected = True
                self._awaiting_ack = False
                self._retry_delay = None  # established: backoff restarts at the minimum
                pending, self._pending_status = self._pending_status, None
                post = self._post
                if post is not None:
                    post(CloudConnected())
            if pending is not None:
                self._send(client, pending)
        except Exception as exc:
            self._log.warning("on_subscribe failed (%s)", type(exc).__name__)

    def _on_disconnect(self, client: Any, userdata: Any, *args: Any) -> None:
        try:
            with self._lock:
                self._generation += 1  # a pending subscription timer is now stale
                self._subscribe_mid = None
                self._awaiting_ack = False
                was_connected = self._connected
                self._connected = False
                if self._stopped or not was_connected:
                    return
                # paho 2 passes (flags, reason_code, properties), paho 1 only (rc). The reason
                # tells a duplicate client id or a keepalive timeout from a Wi-Fi drop.
                reason = args[1] if len(args) >= 2 else (args[0] if args else None)
                self._log.warning("MQTT link lost (reason %s)", reason)
                post = self._post
                if post is not None:
                    post(CloudDisconnected())
        except Exception as exc:
            self._log.warning("on_disconnect failed (%s)", type(exc).__name__)

    def _on_message(self, client: Any, userdata: Any, message: Any) -> None:
        try:
            if self._stopped:
                return
            post = self._post
            if post is not None:
                post(InboundRaw(bytes(message.payload)))
        except Exception as exc:
            self._log.warning("on_message failed (%s)", type(exc).__name__)

    # -- subscription failure and retry ------------------------------------------------------

    def _subscription_failed(self, generation: int, why: str) -> None:
        """Disconnect, post nothing, and retry under the backoff rule (R23.7)."""
        with self._lock:
            if self._stopped or generation != self._generation or self._connected:
                return
            self._generation += 1  # one failure handles one connection
            self._awaiting_ack = False  # a late ack of this connection is ignored
            client = self._client
        if client is None:
            return
        self._log.warning("MQTT %s, reconnecting", why)
        self._retry_delay = next_reconnect_delay(
            self._retry_delay, self._cfg.reconnect_min_s, self._cfg.reconnect_max_s
        )
        try:
            client.disconnect()
        except Exception as exc:
            self._log.warning("MQTT disconnect failed (%s)", type(exc).__name__)
        self._add_timer(self._retry_delay, self._reconnect)

    def _reconnect(self) -> None:
        """Runs on a timer thread: a clean disconnect ended paho's loop, so restart it."""
        with self._lock:
            client = self._client
            if self._stopped or client is None:
                return
        try:
            client.loop_stop()
            self._connect_async(client)
            client.loop_start()
        except Exception as exc:
            self._log.warning("MQTT reconnect failed (%s)", type(exc).__name__)
            self._retry_delay = next_reconnect_delay(
                self._retry_delay, self._cfg.reconnect_min_s, self._cfg.reconnect_max_s
            )
            self._add_timer(self._retry_delay, self._reconnect)

    def _add_timer(self, delay_s: float, fn: Callable[[], None]) -> None:
        timer = self._make_timer(delay_s, fn)
        with self._lock:
            if self._stopped:
                return
            self._timers.append(timer)
        timer.start()
