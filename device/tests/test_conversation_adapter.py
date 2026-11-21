"""Unit tests for the conversation adapter (voice-conversation task 16.8).

No sockets and no audio hardware: ``connect`` is a scripted coroutine and the microphone and
speaker are the recorded fakes of ``voice_fixtures.py``. The property test of task 16.9 covers
random sequences; these tests pin the basic contract.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest

from tests.voice_fixtures import RecordedMic, RecordedSpeaker
from warashi_agent.adapters.conversation import ConversationAdapter
from warashi_agent.config import Config
from warashi_agent.model import (
    AdapterError,
    ConversationFinished,
    Event,
    StartConversation,
    StopConversation,
)

pytestmark = pytest.mark.timeout(15)

TOKEN = "SECRET-token-0123456789"


def start(sid: str) -> StartConversation:
    return StartConversation(session_id=sid, token=TOKEN, max_s=120, silence_s=30)


class Collector:
    def __init__(self) -> None:
        self.events: list[Event] = []
        self._lock = threading.Lock()

    def __call__(self, event: Event) -> None:
        with self._lock:
            self.events.append(event)

    def finished(self) -> list[tuple[str, str]]:
        return [
            (e.session_id, e.reason) for e in self.events if isinstance(e, ConversationFinished)
        ]


async def refuse(_url: str, **_kw: Any) -> Any:
    raise OSError("connection refused")


async def hang(_url: str, **_kw: Any) -> Any:
    await asyncio.sleep(3600)


def make_adapter(post: Collector, connect: Any) -> ConversationAdapter:
    return ConversationAdapter(
        post,
        Config(),
        connect=connect,
        mic_factory=lambda: RecordedMic(),
        speaker_factory=lambda: RecordedSpeaker(),
    )


def test_connect_failure_posts_error_then_one_adapter_failed_end() -> None:
    post = Collector()
    adapter = make_adapter(post, refuse)
    adapter.handle(start("s1"))
    assert adapter.wait_idle(10)
    assert post.events == [
        AdapterError(code="conversation_failed"),
        ConversationFinished(session_id="s1", reason="adapter_failed"),
    ]


def test_stop_ends_a_running_session_with_user_and_is_idempotent() -> None:
    post = Collector()
    adapter = make_adapter(post, hang)
    adapter.handle(start("s1"))
    adapter.handle(StopConversation(session_id="other"))  # stale: changes nothing
    adapter.handle(StopConversation(session_id="s1"))
    adapter.handle(StopConversation(session_id="s1"))
    assert adapter.wait_idle(10)
    adapter.handle(StopConversation(session_id="s1"))  # after the end: still nothing
    adapter.stop()
    adapter.stop()
    assert post.finished() == [("s1", "user")]


def test_a_new_start_ends_the_old_session_with_error() -> None:
    post = Collector()
    adapter = make_adapter(post, hang)
    adapter.handle(start("s1"))
    adapter.handle(start("s2"))
    adapter.stop()
    assert adapter.wait_idle(10)
    assert sorted(post.finished()) == [("s1", "error"), ("s2", "user")]


def test_start_after_stop_is_refused_with_one_end() -> None:
    post = Collector()
    adapter = make_adapter(post, hang)
    adapter.stop()
    adapter.handle(start("s1"))
    adapter.handle(start("s1"))
    assert post.finished() == [("s1", "error")]


def test_token_is_not_in_repr_or_logs(caplog: pytest.LogCaptureFixture) -> None:
    post = Collector()
    with caplog.at_level("DEBUG"):
        adapter = make_adapter(post, refuse)
        adapter.handle(start("s1"))
        assert adapter.wait_idle(10)
    assert TOKEN not in caplog.text
    assert TOKEN not in repr(post.events)
