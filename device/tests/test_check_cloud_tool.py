"""Tests for ``device/tools/check_cloud.py`` (cloud-judgement R23.3, R23.6, R23.17).

A fake MQTT client stands in for paho; nothing touches the network.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path

from warashi_agent.config import AwsConfig, Config
from warashi_agent.messages import Envelope, ModeSetData, decode, encode

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "check_cloud", REPO / "device" / "tools" / "check_cloud.py"
)
assert _spec and _spec.loader
tool = importlib.util.module_from_spec(_spec)
sys.modules["check_cloud"] = tool
_spec.loader.exec_module(tool)

SECRET_ENDPOINT = "secret-endpoint.example.invalid"
SECRET_PATH = "/secret/path/key.pem"


class FakeClient:
    """Acknowledges the subscription on ``loop_start`` and optionally answers with a command."""

    def __init__(self, *, ack: bool = True, send_command: bool = True, garbage: bool = False):
        self.ack = ack
        self.send_command = send_command
        self.garbage = garbage
        self.published: list[tuple[str, bytes]] = []
        self.on_connect = self.on_subscribe = self.on_disconnect = self.on_message = None

    def tls_set(self, **kwargs) -> None: ...
    def will_set(self, *args, **kwargs) -> None: ...
    def reconnect_delay_set(self, **kwargs) -> None: ...
    def max_queued_messages_set(self, size) -> None: ...
    def connect_async(self, host, port, keepalive) -> None: ...

    def loop_start(self) -> None:
        self.on_connect(self, None, {}, 0, None)

    def loop_stop(self) -> None: ...
    def disconnect(self) -> None: ...

    def subscribe(self, topic, qos):
        # Like paho, answer from the network thread after subscribe() has returned.
        if self.ack:
            threading.Timer(0.01, self._answer).start()
        return (0, 1)

    def _answer(self) -> None:
        self.on_subscribe(self, None, 1, [0], None)
        if self.send_command:
            self.on_message(self, None, _Message(self._command()))

    def publish(self, topic, payload, qos):
        self.published.append((topic, payload))
        return _Info()

    def _command(self) -> bytes:
        if self.garbage:
            return b"{not json"
        env = Envelope(
            id="0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
            ts=datetime.now(UTC),
            device_id="warashi-01",
            encounter_id=None,
            data=ModeSetData(mode="guard"),
        )
        return encode(env)


class _Message:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload


class _Info:
    rc = 0


def _config() -> Config:
    return Config(
        aws=AwsConfig(
            enabled=True,
            endpoint=SECRET_ENDPOINT,
            ca_file=SECRET_PATH,
            cert_file=SECRET_PATH,
            key_file=SECRET_PATH,
        )
    )


def _run(client: FakeClient, **kwargs) -> tuple[bool, list[str]]:
    lines: list[str] = []
    ok = tool.run_check(_config(), lambda _id: client, timeout_s=0.2, out=lines.append, **kwargs)
    return ok, lines


def test_pass_publishes_one_status_report_and_receives_a_command() -> None:
    client = FakeClient()
    ok, lines = _run(client)
    assert ok
    assert lines[-1] == "PASS"
    assert [t for t, _ in client.published] == ["warashi/warashi-01/status"]
    sent = decode(client.published[0][1])
    assert sent.message.type == "status.report"


def test_fail_connect_names_the_step_and_the_clock_and_certificate_hint() -> None:
    ok, lines = _run(FakeClient(ack=False))
    assert not ok
    assert "FAIL connect" in lines
    hint = next(line for line in lines if line.startswith("hint:"))
    assert "clock" in hint and "certificate" in hint


def test_fail_command_when_nothing_arrives_and_when_the_payload_is_malformed() -> None:
    for client in (FakeClient(send_command=False), FakeClient(garbage=True)):
        ok, lines = _run(client)
        assert not ok
        assert "FAIL command" in lines


def test_no_command_flag_skips_the_round_trip() -> None:
    ok, lines = _run(FakeClient(send_command=False), command=False)
    assert ok and lines[-1] == "PASS"


def test_output_never_contains_the_endpoint_paths_or_payloads() -> None:
    for client in (FakeClient(), FakeClient(ack=False), FakeClient(garbage=True)):
        _, lines = _run(client)
        text = "\n".join(lines)
        assert SECRET_ENDPOINT not in text
        assert SECRET_PATH not in text
        assert "not json" not in text and "0b8f6c1e" not in text


def test_main_fails_on_a_missing_config_without_connecting(tmp_path: Path) -> None:
    lines: list[str] = []

    def no_client(_id):  # pragma: no cover - must not be called
        raise AssertionError("no connection may be attempted")

    code = tool.main(
        ["--config", str(tmp_path / "missing.toml")], make_client=no_client, out=lines.append
    )
    assert code == 1
    assert "FAIL config" in lines


def test_main_fails_when_aws_is_disabled(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text("[aws]\nenabled = false\n", encoding="utf-8")
    lines: list[str] = []
    code = tool.main(["--config", str(path)], out=lines.append)
    assert code == 1
    assert "FAIL config" in lines
    assert json.dumps(lines)  # plain strings only
