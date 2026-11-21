#!/usr/bin/env python3
"""Measure message ordering and delay inside one AppSync Events channel (voice-conversation 19.2).

Owner tool, design point V9. It publishes numbered events at a fixed rate on one channel of a
test Events API, receives them on a second subscription of the same connection and prints the
number of out-of-order, duplicate and missing events plus the p50 and p95 delivery delay. The
owner copies the result into ``design.md`` (owner step O3).

It needs a real test API and a token, so it is never part of ``make test`` or CI. Importing the
module needs no credentials and no third-party package: ``websockets`` is imported only when
``main`` runs (``pip install websockets`` on the laptop; it is not a dependency of /device).

Configuration comes from the command line or the environment. Nothing is stored in the repo.

    APPSYNC_HTTP_HOST       <id>.appsync-api.<region>.amazonaws.com
    APPSYNC_REALTIME_HOST   <id>.appsync-realtime-api.<region>.amazonaws.com
    APPSYNC_TOKEN           session token accepted by the test API's authorizer
    APPSYNC_CHANNEL         channel to use, for example /voice/ordering-test/out

Use a test API or a test channel. The token must be allowed to publish and subscribe on it.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import json
import math
import os
import sys
import time
import uuid
from dataclasses import dataclass

DEFAULT_COUNT = 500
DEFAULT_RATE = 10.0  # events per second; the AppSync limit is 25 publishes per second
SUBPROTOCOL = "aws-appsync-event-ws"


# ---------------------------------------------------------------------------
# Pure analysis
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OrderingReport:
    """Result of one run. Delays are in seconds and ``None`` when nothing arrived."""

    sent: int
    received: int
    out_of_order: int
    duplicates: int
    missing: int
    p50_delay: float | None
    p95_delay: float | None


def percentile(values: list[float], fraction: float) -> float | None:
    """Nearest-rank percentile; ``None`` for an empty list."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(fraction * len(ordered)))
    return ordered[rank - 1]


def analyze(
    sent: list[tuple[int, float]], received: list[tuple[int, float]]
) -> OrderingReport:
    """Compare what was sent with what arrived.

    ``sent`` holds ``(seq, send_time)`` and ``received`` holds ``(seq, receive_time)`` in arrival
    order, both in seconds on the same clock.

    - *Duplicate*: an arrival of a ``seq`` that already arrived. Only the first arrival counts for
      the other numbers.
    - *Out of order*: a first arrival whose ``seq`` is lower than the highest ``seq`` seen so far.
    - *Missing*: a sent ``seq`` that never arrived.
    - *Delay*: first arrival time minus send time, for every sent ``seq`` that arrived.
    """
    send_time = dict(sent)
    seen: set[int] = set()
    highest = -math.inf
    out_of_order = 0
    duplicates = 0
    delays: list[float] = []
    for seq, at in received:
        if seq in seen:
            duplicates += 1
            continue
        seen.add(seq)
        if seq < highest:
            out_of_order += 1
        highest = max(highest, seq)
        if seq in send_time:
            delays.append(at - send_time[seq])
    missing = sum(1 for seq in send_time if seq not in seen)
    return OrderingReport(
        sent=len(send_time),
        received=len(seen),
        out_of_order=out_of_order,
        duplicates=duplicates,
        missing=missing,
        p50_delay=percentile(delays, 0.50),
        p95_delay=percentile(delays, 0.95),
    )


def format_report(report: OrderingReport) -> str:
    """Plain-text result for the owner to paste into design.md."""

    def ms(value: float | None) -> str:
        return "n/a" if value is None else f"{value * 1000:.0f} ms"

    return "\n".join(
        [
            f"sent:         {report.sent}",
            f"received:     {report.received} (distinct)",
            f"out of order: {report.out_of_order}",
            f"duplicates:   {report.duplicates}",
            f"missing:      {report.missing}",
            f"delay p50:    {ms(report.p50_delay)}",
            f"delay p95:    {ms(report.p95_delay)}",
        ]
    )


def header_subprotocol(token: str, http_host: str) -> str:
    """The ``header-<base64url>`` subprotocol that carries the authorization."""
    raw = json.dumps({"Authorization": token, "host": http_host}).encode()
    return "header-" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


# ---------------------------------------------------------------------------
# Network run (owner only)
# ---------------------------------------------------------------------------


async def run(
    http_host: str,
    realtime_host: str,
    token: str,
    channel: str,
    count: int,
    rate: float,
    settle_s: float,
) -> OrderingReport:
    import websockets  # imported here so the module loads without the package

    auth = {"Authorization": token, "host": http_host}
    url = f"wss://{realtime_host}/event/realtime"
    sent: list[tuple[int, float]] = []
    received: list[tuple[int, float]] = []

    async with websockets.connect(
        url, subprotocols=[SUBPROTOCOL, header_subprotocol(token, http_host)]
    ) as ws:
        await ws.send(json.dumps({"type": "connection_init"}))
        await _wait_for(ws, "connection_ack")

        sub_id = str(uuid.uuid4())
        await ws.send(
            json.dumps(
                {"type": "subscribe", "id": sub_id, "channel": channel, "authorization": auth}
            )
        )
        await _wait_for(ws, "subscribe_success")

        async def reader() -> None:
            async for raw in ws:
                message = json.loads(raw)
                if message.get("type") == "data":
                    body = json.loads(message["event"])
                    received.append((int(body["seq"]), time.time()))
                elif message.get("type") in ("publish_error", "error", "subscribe_error"):
                    print(f"server error: {message}", file=sys.stderr)

        reader_task = asyncio.create_task(reader())
        interval = 1.0 / rate
        start = time.monotonic()
        for seq in range(count):
            delay = start + seq * interval - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            sent.append((seq, time.time()))
            await ws.send(
                json.dumps(
                    {
                        "type": "publish",
                        "id": str(uuid.uuid4()),
                        "channel": channel,
                        "events": [json.dumps({"seq": seq})],
                        "authorization": auth,
                    }
                )
            )
        await asyncio.sleep(settle_s)  # let the last events arrive
        reader_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await reader_task
    return analyze(sent, received)


async def _wait_for(ws, expected: str, timeout: float = 15.0) -> None:
    """Read until a message of the expected type arrives; fail on an error message."""

    async def loop() -> None:
        async for raw in ws:
            message = json.loads(raw)
            kind = message.get("type")
            if kind == expected:
                return
            if kind in ("connection_error", "subscribe_error", "error"):
                raise RuntimeError(f"server answered {kind}: {message}")

    await asyncio.wait_for(loop(), timeout)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--http-host", default=os.environ.get("APPSYNC_HTTP_HOST"))
    parser.add_argument("--realtime-host", default=os.environ.get("APPSYNC_REALTIME_HOST"))
    parser.add_argument("--channel", default=os.environ.get("APPSYNC_CHANNEL"))
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT)
    parser.add_argument("--rate", type=float, default=DEFAULT_RATE, help="events per second")
    parser.add_argument("--settle", type=float, default=5.0, help="seconds to wait at the end")
    args = parser.parse_args(argv)

    # The token is never a command-line option: it would reach the shell history.
    token = os.environ.get("APPSYNC_TOKEN")
    missing = [
        name
        for name, value in (
            ("APPSYNC_HTTP_HOST / --http-host", args.http_host),
            ("APPSYNC_REALTIME_HOST / --realtime-host", args.realtime_host),
            ("APPSYNC_CHANNEL / --channel", args.channel),
            ("APPSYNC_TOKEN", token),
        )
        if not value
    ]
    if missing:
        parser.error("missing: " + ", ".join(missing))
    if args.count < 1 or not 0 < args.rate <= 25:
        parser.error("--count must be at least 1 and --rate in (0, 25]")

    report = asyncio.run(
        run(
            args.http_host,
            args.realtime_host,
            token,
            args.channel,
            args.count,
            args.rate,
            args.settle,
        )
    )
    print(format_report(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
