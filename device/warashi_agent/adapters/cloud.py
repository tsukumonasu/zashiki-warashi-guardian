"""Cloud_Link interface: how the Dispatcher talks to the cloud (R21).

Why this module exists:
- The core loop must run and be tested without AWS (tech.md, "Hardware-free tests"). The
  Dispatcher therefore depends only on the small ``CloudLink`` Protocol below. The
  Local_Cloud_Link and the Fake_Cloud_Link of this spec, and the real MQTT client of the
  ``cloud-judgement`` spec, all implement it and are interchangeable.
- Incoming commands cross the boundary still encoded, as ``InboundRaw``. The Cloud_Link never
  decodes them (R21.2), so every message, whatever its source, takes the one inbound pipeline
  in ``inbound.py`` inside the Dispatcher's loop (R21.8).

This module imports only the standard library and the package's own value types. It never
imports ``paho`` or an AWS SDK, so importing it opens no connection.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

from warashi_agent.messages import Envelope
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
