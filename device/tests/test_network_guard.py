"""Proves the network guard in conftest.py (cloud-judgement R26.3).

The guard fails fast, so a test that tries to connect errors out instead of hanging until
the pytest-timeout limit.
"""

import socket

import pytest

from tests.conftest import NetworkBlockedError, is_loopback_host


def test_connect_to_remote_host_fails_and_names_host(network_violations: list[str]) -> None:
    sock = socket.socket()
    try:
        with pytest.raises(NetworkBlockedError, match=r"broker\.example\.invalid:8883"):
            sock.connect(("broker.example.invalid", 8883))
    finally:
        sock.close()
    assert network_violations == ["broker.example.invalid:8883"]
    network_violations.clear()  # this test provoked the block on purpose


def test_create_connection_names_host(network_violations: list[str]) -> None:
    with pytest.raises(NetworkBlockedError, match=r"iot\.example\.invalid"):
        socket.create_connection(("iot.example.invalid", 8883), timeout=1)
    network_violations.clear()


def test_remote_ip_is_blocked(network_violations: list[str]) -> None:
    sock = socket.socket()
    try:
        with pytest.raises(NetworkBlockedError, match=r"203\.0\.113\.7"):
            sock.connect_ex(("203.0.113.7", 443))
    finally:
        sock.close()
    network_violations.clear()


def test_loopback_connection_is_allowed() -> None:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        with socket.create_connection(server.getsockname(), timeout=2) as client:
            conn, _ = server.accept()
            conn.close()
            assert client.getpeername()[0] == "127.0.0.1"


def test_loopback_helper() -> None:
    assert is_loopback_host("localhost")
    assert is_loopback_host("127.0.0.5")
    assert is_loopback_host("::1")
    assert not is_loopback_host("example.com")
    assert not is_loopback_host("10.0.0.1")
