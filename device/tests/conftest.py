"""Shared pytest configuration.

Hypothesis does not read pyproject.toml, so its settings live here as profiles.
Select one with HYPOTHESIS_PROFILE=ci (default: dev).

It also holds the network guard: ``make test`` must pass with no broker and no AWS account,
so any non-loopback connection fails the test and names the host (cloud-judgement R26.3).
"""

import ipaddress
import os
import socket
from collections.abc import Iterator

import pytest
from hypothesis import settings

settings.register_profile("dev", max_examples=100)
settings.register_profile("ci", max_examples=500, deadline=None, print_blob=True)
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "dev"))


class NetworkBlockedError(OSError):
    """Raised when a test tries to leave the machine."""


def is_loopback_host(host: object) -> bool:
    """True for localhost and loopback addresses; unix socket paths and None are local too."""
    if host is None or host == "":
        return True
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    if not isinstance(host, str):
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def _blocked(violations: list[str], host: object, port: object) -> NetworkBlockedError:
    target = f"{host}:{port}" if port is not None else f"{host}"
    violations.append(target)
    return NetworkBlockedError(
        f"Blocked outbound network connection to {target}. "
        "make test must not use the network; use a fake adapter."
    )


@pytest.fixture
def network_violations() -> list[str]:
    """Blocked attempts of the running test. A test that provokes one empties this list."""
    return _VIOLATIONS


_VIOLATIONS: list[str] = []


@pytest.fixture(autouse=True)
def _block_network(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Allow loopback only. Fails the test even if the code under test swallows the error."""
    _VIOLATIONS.clear()
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_getaddrinfo = socket.getaddrinfo

    def check(address: object) -> None:
        # AF_UNIX addresses are str/bytes paths and are not network connections.
        if isinstance(address, tuple) and address and not is_loopback_host(address[0]):
            port = address[1] if len(address) > 1 else None
            raise _blocked(_VIOLATIONS, address[0], port)

    def guarded_connect(self: socket.socket, address: object) -> None:
        check(address)
        return real_connect(self, address)  # type: ignore[arg-type]

    def guarded_connect_ex(self: socket.socket, address: object) -> int:
        check(address)
        return real_connect_ex(self, address)  # type: ignore[arg-type]

    def guarded_getaddrinfo(host, port, *args, **kwargs):  # type: ignore[no-untyped-def]
        # Name lookups would otherwise hang before connect() is reached.
        if not is_loopback_host(host):
            raise _blocked(_VIOLATIONS, host, port)
        return real_getaddrinfo(host, port, *args, **kwargs)

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", guarded_connect_ex)
    monkeypatch.setattr(socket, "getaddrinfo", guarded_getaddrinfo)
    yield
    if _VIOLATIONS:
        blocked = ", ".join(_VIOLATIONS)
        _VIOLATIONS.clear()
        pytest.fail(f"Test attempted outbound network connection(s) to: {blocked}")
