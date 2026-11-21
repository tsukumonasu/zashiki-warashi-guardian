#!/usr/bin/env python3
"""Zashiki-Warashi Guardian: cloud link check (run on the doll after provisioning).

Usage:
    python3 check_cloud.py                       # reads ./config.toml
    python3 check_cloud.py --config PATH         # another config file
    python3 check_cloud.py --no-command          # skip the command round trip
    python3 check_cloud.py --timeout 10          # seconds to wait per step (default 10)

Steps, in order. The first one that fails ends the run with ``FAIL <step>`` and a hint:
    config    config.toml loads and ``[aws].enabled`` is true
    connect   the real MqttCloudLink reaches IoT Core and the subscription to the commands
              topic is acknowledged (``cloud.connected``)
    publish   one ``status.report`` is handed to the link
    command   a valid command arrives from the cloud. While the script waits, send any
              command to this doll, for example ``mode.set`` with ``"mode": "guard"`` from the
              dashboard or from the IoT Core MQTT test client. This step proves the doll's
              policy allows both publish and subscribe.

The script prints step names and short hints only. It never prints the endpoint, file paths,
certificate or key contents, or message payloads. It exits 0 on PASS and 1 on FAIL.
"""

from __future__ import annotations

import argparse
import logging
import queue
import sys
import uuid
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path

# Run from a plain checkout (``python3 tools/check_cloud.py``): make ``warashi_agent`` importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from warashi_agent.adapters.cloud import (  # noqa: E402
    InboundRaw,
    MqttClientFactory,
    MqttCloudLink,
    PahoClientFactory,
)
from warashi_agent.config import Config, ConfigRejected, format_rejection, load_config  # noqa: E402
from warashi_agent.messages import Envelope, StatusReport, Valid, decode, encode  # noqa: E402
from warashi_agent.model import CloudConnected, Mode, State  # noqa: E402

DEFAULT_TIMEOUT_S = 10.0
DEFAULT_CONFIG = "config.toml"

HINTS = {
    "config": (
        "Check that config.toml exists, that [aws] has enabled = true, an endpoint, and "
        "readable ca_file, cert_file and key_file."
    ),
    "connect": (
        "Check the clock first: run `timedatectl` and make sure 'System clock synchronized' "
        "is yes (a Pi Zero W has no battery clock, and TLS fails with a wrong date). Then check "
        "that the certificate is active in IoT Core, the CA file is the Amazon root CA, the "
        "endpoint belongs to this account and region, and Wi-Fi is up. A policy that denies "
        "subscribing to the commands topic also stops here."
    ),
    "publish": "The link did not accept the status report. See the log lines above.",
    "command": (
        "No valid command arrived. Send one (for example mode.set guard) while the script "
        "waits. Check that the IoT policy allows subscribing and receiving on "
        "warashi/<id>/commands, and that the command's deviceId matches [device].id."
    ),
}


class _StepError(Exception):
    """A step failed; ``step`` is a key of ``HINTS``."""

    def __init__(self, step: str) -> None:
        super().__init__(step)
        self.step = step


def build_status_report(device_id: str, version: str = "check_cloud") -> Envelope:
    """One ``status.report`` for a doll that is asleep; ``encounterId`` is null (schema.md)."""
    return Envelope(
        id=str(uuid.uuid4()),
        ts=datetime.now(UTC),
        device_id=device_id,
        encounter_id=None,
        data=StatusReport(
            state=State.SLEEPING,
            mode=Mode.GUARD,
            pan_deg=0.0,
            tilt_deg=0.0,
            lantern=0.0,
            camera_active=False,
            mic_active=False,
            motion_enabled=False,
            uptime_sec=0,
            agent_version=version,
        ),
    )


def _wait_for(
    inbox: queue.Queue,
    timeout_s: float,
    accept: Callable[[object], bool],
) -> bool:
    """True when an item accepted by ``accept`` arrives within ``timeout_s`` seconds."""
    deadline = datetime.now(UTC).timestamp() + timeout_s
    while True:
        remaining = deadline - datetime.now(UTC).timestamp()
        if remaining <= 0:
            return False
        try:
            item = inbox.get(timeout=remaining)
        except queue.Empty:
            return False
        if accept(item):
            return True


def _is_valid_command(item: object) -> bool:
    if not isinstance(item, InboundRaw):
        return False
    result = decode(item.payload)
    # Only the decode verdict is used: the payload itself is never printed.
    return isinstance(result, Valid)


def run_check(
    config: Config,
    make_client: MqttClientFactory,
    *,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    command: bool = True,
    out: Callable[[str], None] = print,
) -> bool:
    """Run the steps with a real ``MqttCloudLink``; return True on PASS."""
    inbox: queue.Queue = queue.Queue()
    link = MqttCloudLink(
        config.aws,
        config.device.id,
        make_client,
        encode,
        logging.getLogger("check_cloud.link"),
    )
    try:
        link.start(inbox.put)
        out("connect: waiting for the broker and the commands subscription ...")
        if not _wait_for(inbox, timeout_s, lambda i: isinstance(i, CloudConnected)):
            raise _StepError("connect")
        out("connect: ok")

        link.publish(build_status_report(config.device.id))
        out("publish: status.report handed to the link")

        if command:
            out(f"command: waiting up to {timeout_s:g} s for a command from the cloud ...")
            if not _wait_for(inbox, timeout_s, _is_valid_command):
                raise _StepError("command")
            out("command: ok (a valid command arrived)")
    except _StepError as failure:
        out(f"FAIL {failure.step}")
        out(f"hint: {HINTS[failure.step]}")
        return False
    finally:
        link.stop()
    out("PASS")
    return True


def main(
    argv: Sequence[str] | None = None,
    *,
    make_client: MqttClientFactory | None = None,
    out: Callable[[str], None] = print,
) -> int:
    parser = argparse.ArgumentParser(description="Check the doll's link to AWS IoT Core.")
    parser.add_argument("--config", default=DEFAULT_CONFIG, help="path to config.toml")
    parser.add_argument(
        "--timeout", type=float, default=DEFAULT_TIMEOUT_S, help="seconds per step"
    )
    parser.add_argument("--no-command", action="store_true", help="skip the command round trip")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")

    loaded = load_config(args.config, fake=False)
    if isinstance(loaded, ConfigRejected):
        # format_rejection hides the values of the private [aws] keys.
        out(format_rejection(loaded))
        out("FAIL config")
        out(f"hint: {HINTS['config']}")
        return 1
    if not loaded.aws.enabled:
        out("FAIL config")
        out("hint: [aws].enabled is false. " + HINTS["config"])
        return 1

    ok = run_check(
        loaded,
        make_client if make_client is not None else PahoClientFactory(),
        timeout_s=args.timeout,
        command=not args.no_command,
        out=out,
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
