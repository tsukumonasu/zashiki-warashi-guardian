"""Property 15: Exactly one audio result (device-core-loop task 25.3).

**Validates: Requirements 19.3, 19.4, 19.6, 19.9, 29.15**

One test function runs against both audio implementations:

- ``real``: the ``AudioAdapter`` on a ``ScriptedRunner`` (``aplay``), a scripted opener and a
  ``ManualScheduler``. The worker is a real thread, so the test never advances the clock while
  the worker may run: it calls ``handle()`` and then ``wait_idle()`` before it advances. A
  request with gap 0 follows the previous one at once, so it interrupts a queued or running
  request. A "held" download blocks inside ``read`` on a gate event until the next request has
  interrupted it, which exercises an interruption of a running download without racing the clock.
- ``fake``: the ``FakeAudio`` with scripted outcomes on a ``ManualScheduler``.

Downloads use one URL per request, and a small opener maps each URL to its ``OpenStep`` (a
``ScriptedOpener`` is used underneath), so interrupted requests that never reach the opener
cannot shift the script of later ones. The ``aplay`` script is positional; when interruptions
shift it, only the outcome changes, never the property.
"""

from __future__ import annotations

import tempfile
import threading
import urllib.error
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from tests.scripted import OpenStep, ScriptedOpener, ScriptedRunner, Step
from tests.test_audio_adapter import GOOD_WAV, WAV_OVER_LIMIT
from warashi_agent.adapters.audio import AudioAdapter
from warashi_agent.adapters.fakes import AudioOutcome, FakeAudio
from warashi_agent.config import Config
from warashi_agent.model import (
    AudioFailed,
    AudioFinished,
    Category,
    Event,
    PlayAudioUrl,
    PlayLine,
)
from warashi_agent.timebase import ManualScheduler
from warashi_agent.voice import VoiceLine

CONFIG = Config()
AUDIO_TIMEOUT_S = CONFIG.timing.audio_timeout_s
DOWNLOAD_TIMEOUT_S = CONFIG.timing.download_timeout_s
MAX_GAP_S = DOWNLOAD_TIMEOUT_S + AUDIO_TIMEOUT_S + 5.0  # beyond every deadline
IDLE_TIMEOUT_S = 5.0  # real-time safety net for wait_idle and gates
ALLOWED_CODES = {"audio_failed", "download_failed", "interrupted"}
PAD = 12  # spare scripted steps, so a shifted script never runs dry

KINDS = ("line_known", "line_unknown", "url_https", "url_https", "url_http")
APLAY_OUTCOMES = ("ok", "exit_code", "start_error", "timeout", "hang")
DOWNLOAD_OUTCOMES = ("ok", "non_wav", "oversize", "open_error", "read_error", "slow")


@dataclass(frozen=True)
class Req:
    kind: str
    aplay: str
    download: str
    held: bool
    reuse: int | None  # index of an earlier request whose Play_Id this one repeats
    gap: float  # clock advance after the request; 0 means the next one follows at once


gaps = st.one_of(st.just(0.0), st.floats(min_value=0.0, max_value=MAX_GAP_S, allow_nan=False))
requests = st.builds(
    Req,
    kind=st.sampled_from(KINDS),
    aplay=st.sampled_from(APLAY_OUTCOMES),
    download=st.sampled_from(DOWNLOAD_OUTCOMES),
    held=st.booleans(),
    reuse=st.one_of(st.none(), st.none(), st.integers(min_value=0, max_value=5)),
    gap=gaps,
)


def aplay_step(outcome: str) -> Step:
    if outcome == "exit_code":
        return Step(exit_code=1)
    if outcome == "start_error":
        return Step(start_error=FileNotFoundError("aplay"))
    if outcome == "timeout":
        return Step(duration=AUDIO_TIMEOUT_S + 3.0)
    if outcome == "hang":
        return Step(duration=AUDIO_TIMEOUT_S + 3.0, ignore_terminate=True)
    return Step(duration=1.0)


def open_step(outcome: str) -> OpenStep:
    if outcome == "non_wav":
        return OpenStep(body=b"this is not a wav file")
    if outcome == "oversize":
        return OpenStep(body=WAV_OVER_LIMIT)
    if outcome == "open_error":
        return OpenStep(error=urllib.error.URLError("scripted"))
    if outcome == "read_error":
        return OpenStep(body=GOOD_WAV, read_error=OSError("scripted"))
    if outcome == "slow":
        return OpenStep(body=GOOD_WAV, read_cost=DOWNLOAD_TIMEOUT_S + 1.0)
    return OpenStep(body=GOOD_WAV)


class KeyedOpener:
    """Maps each URL to its scripted ``OpenStep`` and serves it through a ``ScriptedOpener``."""

    def __init__(self, scheduler: ManualScheduler, plan: dict[str, OpenStep]) -> None:
        self._inner = ScriptedOpener(scheduler=scheduler)
        self._plan = plan
        self._lock = threading.Lock()

    def open(self, fullurl: str, data: None = None, timeout: float | None = None):  # noqa: ANN201
        with self._lock:
            self._inner.steps = [self._plan.get(fullurl) or OpenStep(body=GOOD_WAV)]
            return self._inner.open(fullurl, data, timeout)


def play_ids(reqs: list[Req]) -> list[str]:
    ids: list[str] = []
    for index, req in enumerate(reqs):
        reuse = req.reuse
        ids.append(ids[reuse % index] if reuse is not None and index > 0 else f"p{index}")
    return ids


def check_results(posted: list[Event], ids: list[str]) -> None:
    results = [e for e in posted if isinstance(e, AudioFinished | AudioFailed)]
    assert Counter(e.play_id for e in results) == Counter(set(ids)), (
        "each Play_Id must get exactly one result"
    )
    for event in results:
        if isinstance(event, AudioFailed):
            assert event.code in ALLOWED_CODES


def run_real(reqs: list[Req]) -> None:
    ids = play_ids(reqs)
    with tempfile.TemporaryDirectory(prefix="prop15-") as base:
        voice_dir, download_dir = Path(base) / "voice", Path(base) / "dl"
        voice_dir.mkdir()
        download_dir.mkdir()
        (voice_dir / "hello.wav").write_bytes(GOOD_WAV)
        scheduler = ManualScheduler()
        plan: dict[str, OpenStep] = {}
        gates: dict[int, tuple[threading.Event, threading.Event]] = {}
        aplay_steps: list[Step] = []
        actions: list[PlayLine | PlayAudioUrl] = []
        for index, req in enumerate(reqs):
            play_id = ids[index]
            if req.kind.startswith("line"):
                line_id = "hello" if req.kind == "line_known" else "no-such-line"
                actions.append(PlayLine(line_id=line_id, play_id=play_id))
                aplay_steps.append(aplay_step(req.aplay))
                continue
            scheme = "https" if req.kind == "url_https" else "http"
            target = f"{scheme}://example.test/{index}.wav?token=SECRET"
            actions.append(PlayAudioUrl(url=target, play_id=play_id))
            if req.kind == "url_https" and req.held:
                gate, entered = threading.Event(), threading.Event()
                gates[index] = (gate, entered)
                plan[target] = OpenStep(body=GOOD_WAV, gate=gate, entered=entered)
            else:
                plan[target] = open_step(req.download)
            aplay_steps.append(aplay_step(req.aplay))
        runner = ScriptedRunner(scheduler, aplay_steps + [Step() for _ in range(PAD)])
        posted: list[Event] = []
        adapter = AudioAdapter(
            posted.append,
            scheduler,
            CONFIG,
            [
                VoiceLine(
                    id="hello",
                    category=Category.FAMILY,
                    ja="こんにちは",
                    en="Hello",
                    wav="hello.wav",
                )
            ],
            voice_dir=voice_dir,
            runner=runner,
            opener=KeyedOpener(scheduler, plan),
            download_dir=download_dir,
        )
        held_gate: threading.Event | None = None
        try:
            for index, (req, action) in enumerate(zip(reqs, actions, strict=True)):
                adapter.handle(action)
                if held_gate is not None:
                    held_gate.set()  # the request above has interrupted the held download
                    held_gate = None
                if index in gates:
                    gate, entered = gates[index]
                    assert entered.wait(IDLE_TIMEOUT_S), "the worker never reached the download"
                    held_gate = gate
                elif req.gap > 0 or index == len(reqs) - 1:
                    assert adapter.wait_idle(IDLE_TIMEOUT_S)
                    scheduler.advance(req.gap)
            if held_gate is not None:
                held_gate.set()
            assert adapter.wait_idle(IDLE_TIMEOUT_S)
            scheduler.advance(10 * MAX_GAP_S)  # pass every deadline
            assert adapter.wait_idle(IDLE_TIMEOUT_S)
            check_results(posted, ids)
            assert list(download_dir.iterdir()) == [], "a downloaded file was left behind"
        finally:
            for gate, _ in gates.values():
                gate.set()
            adapter.stop()


fake_outcomes = st.builds(
    AudioOutcome,
    duration_s=st.floats(min_value=0.0, max_value=MAX_GAP_S, allow_nan=False),
    failure=st.sampled_from((None, "audio_failed", "download_failed")),
)


def run_fake(reqs: list[Req], outcomes: list[AudioOutcome]) -> None:
    ids = play_ids(reqs)
    scheduler = ManualScheduler()
    posted: list[Event] = []
    audio = FakeAudio(posted.append, scheduler)
    audio.script(*outcomes)
    for index, req in enumerate(reqs):
        play_id = ids[index]
        if req.kind.startswith("line"):
            audio.handle(PlayLine(line_id="hello", play_id=play_id))
        else:
            audio.handle(PlayAudioUrl(url=f"https://example.test/{index}.wav", play_id=play_id))
        scheduler.advance(req.gap)
    scheduler.advance(10 * MAX_GAP_S)  # pass every deadline
    check_results(posted, ids)


# Feature: device-core-loop, Property 15: Exactly one audio result
@pytest.mark.timeout(600)
@settings(deadline=None)
@pytest.mark.parametrize("implementation", ["real", "fake"])
@given(data=st.data())
def test_exactly_one_audio_result(implementation: str, data: st.DataObject) -> None:
    reqs = data.draw(st.lists(requests, min_size=1, max_size=6), label="requests")
    if implementation == "real":
        run_real(reqs)
    else:
        outcomes = data.draw(
            st.lists(fake_outcomes, min_size=len(reqs), max_size=len(reqs)), label="outcomes"
        )
        run_fake(reqs, outcomes)
