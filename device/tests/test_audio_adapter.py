"""Unit tests for the Audio_Adapter (device-core-loop task 25.2; R19.1, R19.3 to R19.7, R13.6).

The real ``AudioAdapter`` runs on a ``ScriptedRunner`` (``aplay``), a ``ScriptedOpener``
(downloads) and a ``ManualScheduler``; see ``tests/scripted.py``. The worker is a real thread,
so each test calls ``handle()`` and then ``wait_idle()``; nothing sleeps. Interruption tests hold
the worker inside a download with a gate event instead of racing it. WAV bytes are built with
the stdlib ``wave`` module. Defaults: ``audio_timeout_s`` 12, ``download_timeout_s`` 5,
``probe_timeout_s`` 5.
"""

from __future__ import annotations

import io
import logging
import subprocess
import threading
import urllib.error
import urllib.request
import wave
from pathlib import Path

import pytest

from tests.scripted import OpenStep, ScriptedOpener, ScriptedRunner, Step
from warashi_agent.adapters.audio import (
    AUDIO_DEVICE_HINT,
    DOWNLOAD_MAX_BYTES,
    AudioAdapter,
    HttpsOnlyRedirect,
    download,
    is_pcm16_wav,
    pcm_names,
)
from warashi_agent.config import Config
from warashi_agent.model import (
    AdapterError,
    AudioFailed,
    AudioFinished,
    Category,
    Event,
    PlayAudioUrl,
    PlayLine,
)
from warashi_agent.timebase import ManualScheduler
from warashi_agent.voice import VoiceLine

IDLE_TIMEOUT_S = 5.0  # real-time safety net for wait_idle; a passing test returns at once
DEVICE = Config().audio.audio_device
URL = "https://example.test/voice/hello.wav?token=SECRET-TOKEN-123"
LISTING_OK = (
    "null\n    Discard all samples (playback) or generate zero samples (capture)\n"
    f"{DEVICE}\n    USB Audio, USB Audio\n    Hardware device with all software conversions\n"
)


def make_wav(*, sampwidth: int = 2, channels: int = 1, frames: int = 160) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sampwidth)
        wav.setframerate(16_000)
        wav.writeframes(b"\x00" * (frames * channels * sampwidth))
    return buf.getvalue()


GOOD_WAV = make_wav()
WAV_AT_LIMIT = make_wav(frames=(DOWNLOAD_MAX_BYTES - 44) // 2)
WAV_OVER_LIMIT = make_wav(frames=(DOWNLOAD_MAX_BYTES - 44) // 2 + 1)


class Rig:
    """An audio adapter on scripted collaborators, with the posted events."""

    def __init__(
        self,
        tmp_path: Path,
        steps: list[Step] | None = None,
        opens: list[OpenStep] | None = None,
        *,
        with_line_file: bool = True,
    ) -> None:
        self.scheduler = ManualScheduler()
        self.runner = ScriptedRunner(self.scheduler, steps or [])
        self.opener = ScriptedOpener(opens or [], self.scheduler)
        self.voice_dir = tmp_path / "voice"
        self.voice_dir.mkdir()
        self.download_dir = tmp_path / "dl"
        self.download_dir.mkdir()
        if with_line_file:
            (self.voice_dir / "hello.wav").write_bytes(GOOD_WAV)
        self.posted: list[Event] = []
        voice = VoiceLine(
            id="hello", category=Category.FAMILY, ja="こんにちは", en="Hello", wav="hello.wav"
        )
        self.adapter = AudioAdapter(
            self.posted.append,
            self.scheduler,
            Config(),
            [voice],
            voice_dir=self.voice_dir,
            runner=self.runner,
            opener=self.opener,
            download_dir=self.download_dir,
        )

    def play(self, action: PlayLine | PlayAudioUrl) -> list[Event]:
        self.adapter.handle(action)
        assert self.adapter.wait_idle(IDLE_TIMEOUT_S)
        return self.posted

    def leftovers(self) -> list[Path]:
        return list(self.download_dir.iterdir())


def line(play_id: str = "p1") -> PlayLine:
    return PlayLine(line_id="hello", play_id=play_id)


def url(play_id: str = "p1", target: str = URL) -> PlayAudioUrl:
    return PlayAudioUrl(url=target, play_id=play_id)


# --------------------------------------------------------------------------------------------
# Cached lines (R19.1, R19.3)
# --------------------------------------------------------------------------------------------


def test_cached_line_runs_aplay_with_device_and_file(tmp_path: Path) -> None:
    rig = Rig(tmp_path, [Step(duration=1.5)])
    assert rig.play(line()) == [AudioFinished(play_id="p1")]
    assert rig.runner.calls == [["aplay", "-q", "-D", DEVICE, str(rig.voice_dir / "hello.wav")]]
    assert rig.scheduler.now() == 1.5


def test_handle_does_not_start_anything_before_the_first_request(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    assert rig.runner.calls == []
    assert rig.adapter.wait_idle(IDLE_TIMEOUT_S)
    assert rig.posted == []


def test_aplay_still_running_at_the_timeout_is_stopped_and_fails(tmp_path: Path) -> None:
    rig = Rig(tmp_path, [Step(duration=100.0)])
    assert rig.play(line()) == [AudioFailed(play_id="p1", code="audio_failed")]
    (proc,) = rig.runner.processes
    assert proc.terminate_calls == 1
    assert rig.scheduler.now() == Config().timing.audio_timeout_s


def test_aplay_ignoring_sigterm_is_killed(tmp_path: Path) -> None:
    rig = Rig(tmp_path, [Step(duration=100.0, ignore_terminate=True)])
    assert rig.play(line()) == [AudioFailed(play_id="p1", code="audio_failed")]
    (proc,) = rig.runner.processes
    assert (proc.terminate_calls, proc.kill_calls) == (1, 1)


def test_nonzero_exit_is_audio_failed(tmp_path: Path) -> None:
    rig = Rig(tmp_path, [Step(exit_code=1, stderr="no device")])
    assert rig.play(line()) == [AudioFailed(play_id="p1", code="audio_failed")]


def test_aplay_missing_executable_is_audio_failed(tmp_path: Path) -> None:
    rig = Rig(tmp_path, [Step(start_error=FileNotFoundError("aplay"))])
    assert rig.play(line()) == [AudioFailed(play_id="p1", code="audio_failed")]


def test_missing_wav_file_is_audio_failed_without_starting_aplay(tmp_path: Path) -> None:
    rig = Rig(tmp_path, with_line_file=False)
    assert rig.play(line()) == [AudioFailed(play_id="p1", code="audio_failed")]
    assert rig.runner.calls == []


def test_unknown_line_id_is_audio_failed(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    assert rig.play(PlayLine(line_id="nope", play_id="p1")) == [
        AudioFailed(play_id="p1", code="audio_failed")
    ]
    assert rig.runner.calls == []


def test_one_result_per_play_id_over_a_sequence(tmp_path: Path) -> None:
    rig = Rig(tmp_path, [Step(), Step(exit_code=2), Step()])
    for play_id in ("a", "b", "c"):
        rig.play(line(play_id))
    assert rig.posted == [
        AudioFinished(play_id="a"),
        AudioFailed(play_id="b", code="audio_failed"),
        AudioFinished(play_id="c"),
    ]


# --------------------------------------------------------------------------------------------
# Redirects and URL checks (R19.5)
# --------------------------------------------------------------------------------------------


def test_redirect_handler_refuses_an_http_target() -> None:
    req = urllib.request.Request("https://example.test/a.wav")
    with pytest.raises(urllib.error.URLError):
        HttpsOnlyRedirect().redirect_request(
            req, None, 302, "Found", {}, "http://example.test/b.wav"
        )


def test_redirect_handler_follows_an_https_target() -> None:
    req = urllib.request.Request("https://example.test/a.wav")
    new = HttpsOnlyRedirect().redirect_request(
        req, io.BytesIO(), 302, "Found", {}, "https://other.test/b.wav"
    )
    assert new is not None
    assert new.full_url == "https://other.test/b.wav"


@pytest.mark.parametrize(
    "target", ["http://example.test/a.wav", "file:///etc/passwd", "ftp://example.test/a.wav", "x"]
)
def test_non_https_url_is_download_failed_and_never_opened(tmp_path: Path, target: str) -> None:
    rig = Rig(tmp_path)
    assert rig.play(url(target=target)) == [AudioFailed(play_id="p1", code="download_failed")]
    assert rig.opener.urls == []
    assert rig.runner.calls == []
    assert rig.leftovers() == []


def test_refused_redirect_during_open_is_download_failed(tmp_path: Path) -> None:
    refused = urllib.error.URLError("redirect to a non-https URL")
    rig = Rig(tmp_path, opens=[OpenStep(error=refused)])
    assert rig.play(url()) == [AudioFailed(play_id="p1", code="download_failed")]
    assert rig.leftovers() == []


# --------------------------------------------------------------------------------------------
# Downloads (R19.5, R19.6)
# --------------------------------------------------------------------------------------------


def test_download_plays_the_file_and_deletes_it_afterwards(tmp_path: Path) -> None:
    seen: list[tuple[bool, bytes]] = []

    def check(argv: object) -> None:
        path = Path(list(argv)[-1])  # type: ignore[call-overload]
        seen.append((path.exists(), path.read_bytes()))

    rig = Rig(tmp_path, [Step(on_finish=check)], [OpenStep(body=GOOD_WAV)])
    assert rig.play(url()) == [AudioFinished(play_id="p1")]
    assert seen == [(True, GOOD_WAV)]
    argv = rig.runner.calls[0]
    assert argv[:4] == ["aplay", "-q", "-D", DEVICE]
    assert Path(argv[4]).parent == rig.download_dir
    assert rig.leftovers() == []
    assert rig.opener.urls == [URL]
    assert rig.opener.timeouts == [2.0]  # min(download_timeout_s, 2 s)


def test_stereo_16_bit_download_is_accepted(tmp_path: Path) -> None:
    rig = Rig(tmp_path, [Step()], [OpenStep(body=make_wav(channels=2))])
    assert rig.play(url()) == [AudioFinished(play_id="p1")]


def test_playback_failure_of_a_download_is_audio_failed_and_file_is_deleted(
    tmp_path: Path,
) -> None:
    rig = Rig(tmp_path, [Step(exit_code=1)], [OpenStep(body=GOOD_WAV)])
    assert rig.play(url()) == [AudioFailed(play_id="p1", code="audio_failed")]
    assert rig.leftovers() == []


def test_playback_timeout_of_a_download_deletes_the_file(tmp_path: Path) -> None:
    rig = Rig(tmp_path, [Step(duration=100.0)], [OpenStep(body=GOOD_WAV)])
    assert rig.play(url()) == [AudioFailed(play_id="p1", code="audio_failed")]
    assert rig.leftovers() == []


@pytest.mark.parametrize(
    "body",
    [b"this is not a wav file", b"", make_wav(sampwidth=1), GOOD_WAV[:30]],
    ids=["not-wav", "empty", "8-bit", "truncated-header"],
)
def test_unacceptable_content_is_download_failed_and_deleted(tmp_path: Path, body: bytes) -> None:
    rig = Rig(tmp_path, opens=[OpenStep(body=body)])
    assert rig.play(url()) == [AudioFailed(play_id="p1", code="download_failed")]
    assert rig.runner.calls == []
    assert rig.leftovers() == []


def test_body_at_the_size_limit_is_accepted(tmp_path: Path) -> None:
    assert len(WAV_AT_LIMIT) == DOWNLOAD_MAX_BYTES
    rig = Rig(tmp_path, [Step()], [OpenStep(body=WAV_AT_LIMIT)])
    assert rig.play(url()) == [AudioFinished(play_id="p1")]
    assert rig.opener.bytes_served == DOWNLOAD_MAX_BYTES


def test_body_above_the_size_limit_is_cut_and_deleted(tmp_path: Path) -> None:
    assert len(WAV_OVER_LIMIT) > DOWNLOAD_MAX_BYTES
    rig = Rig(tmp_path, opens=[OpenStep(body=WAV_OVER_LIMIT + b"\x00" * 100_000)])
    assert rig.play(url()) == [AudioFailed(play_id="p1", code="download_failed")]
    assert rig.opener.bytes_served == DOWNLOAD_MAX_BYTES + 1  # one byte beyond the limit
    assert rig.runner.calls == []
    assert rig.leftovers() == []


def test_read_error_is_download_failed(tmp_path: Path) -> None:
    rig = Rig(tmp_path, opens=[OpenStep(read_error=TimeoutError("timed out"))])
    assert rig.play(url()) == [AudioFailed(play_id="p1", code="download_failed")]
    assert rig.leftovers() == []


def test_slow_download_hits_the_total_deadline(tmp_path: Path) -> None:
    # Each read costs 2 virtual seconds; the 3rd read passes download_timeout_s = 5.
    body = make_wav(frames=40_000)  # about 80 KB: several 16 KiB reads
    rig = Rig(tmp_path, opens=[OpenStep(body=body, read_cost=2.0)])
    assert rig.play(url()) == [AudioFailed(play_id="p1", code="download_failed")]
    assert rig.opener.bytes_served < len(body)
    assert rig.leftovers() == []


def test_download_function_deletes_the_partial_file_on_cancel(tmp_path: Path) -> None:
    cancel = threading.Event()
    cancel.set()
    dest = tmp_path / "x.wav"
    opener = ScriptedOpener([OpenStep(body=GOOD_WAV)])
    assert download("https://example.test/a.wav", dest, 5.0, cancel, opener=opener) is False
    assert not dest.exists()


def test_download_function_accepts_a_valid_wav(tmp_path: Path) -> None:
    dest = tmp_path / "x.wav"
    opener = ScriptedOpener([OpenStep(body=GOOD_WAV)])
    assert download("https://example.test/a.wav", dest, 5.0, threading.Event(), opener=opener)
    assert dest.read_bytes() == GOOD_WAV


def test_is_pcm16_wav(tmp_path: Path) -> None:
    good, eight, junk, missing = (tmp_path / n for n in ("g", "e", "j", "m"))
    good.write_bytes(GOOD_WAV)
    eight.write_bytes(make_wav(sampwidth=1))
    junk.write_bytes(b"RIFFxxxx")
    assert is_pcm16_wav(good)
    assert not is_pcm16_wav(eight)
    assert not is_pcm16_wav(junk)
    assert not is_pcm16_wav(missing)


# --------------------------------------------------------------------------------------------
# Probe (R19.7)
# --------------------------------------------------------------------------------------------


def probe_with(tmp_path: Path, step: Step):  # noqa: ANN201 - returns ProbeResult
    rig = Rig(tmp_path, [step])
    return rig, rig.adapter.probe()


def test_pcm_names_takes_only_lines_without_leading_whitespace() -> None:
    listing = (
        "null\n    Discard\n\nplughw:CARD=Device,DEV=0\n\tTab description\nhw:CARD=X,DEV=0   \n"
    )
    assert pcm_names(listing) == ("null", "plughw:CARD=Device,DEV=0", "hw:CARD=X,DEV=0")


def test_probe_passes_when_the_device_is_listed(tmp_path: Path) -> None:
    rig, result = probe_with(tmp_path, Step(stdout=LISTING_OK))
    assert result.ok
    assert rig.runner.calls == [["aplay", "-L"]]


def test_probe_fails_with_the_hint_when_the_device_is_not_listed(tmp_path: Path) -> None:
    _, result = probe_with(tmp_path, Step(stdout="null\n    Discard\nhw:CARD=Other,DEV=0\n"))
    assert not result.ok
    assert result.code == "audio_device_missing"
    assert result.hint == AUDIO_DEVICE_HINT
    assert "PWR" in result.hint and "USB" in result.hint


def test_device_name_inside_a_description_line_does_not_count(tmp_path: Path) -> None:
    listing = f"null\n    see {DEVICE} somewhere\n    {DEVICE}\n"
    _, result = probe_with(tmp_path, Step(stdout=listing))
    assert result.code == "audio_device_missing"


def test_probe_fails_on_nonzero_exit(tmp_path: Path) -> None:
    _, result = probe_with(tmp_path, Step(exit_code=1, stdout=LISTING_OK))
    assert result.code == "audio_device_missing"


def test_probe_fails_on_start_error(tmp_path: Path) -> None:
    _, result = probe_with(tmp_path, Step(start_error=FileNotFoundError("aplay")))
    assert result.code == "audio_device_missing"


def test_probe_timeout_stops_the_process_and_fails(tmp_path: Path) -> None:
    rig, result = probe_with(tmp_path, Step(duration=100.0, stdout=LISTING_OK))
    assert result.code == "audio_device_missing"
    assert rig.runner.processes[0].terminate_calls == 1
    assert rig.scheduler.now() >= Config().timing.probe_timeout_s


def test_probe_does_not_post_events(tmp_path: Path) -> None:
    rig, _ = probe_with(tmp_path, Step(stdout=LISTING_OK))
    assert rig.posted == []


# --------------------------------------------------------------------------------------------
# Interruption and stop (R19.4, R19.9)
# --------------------------------------------------------------------------------------------


def test_new_request_interrupts_a_running_download(tmp_path: Path) -> None:
    gate, entered = threading.Event(), threading.Event()
    rig = Rig(tmp_path, [Step()], [OpenStep(body=GOOD_WAV, gate=gate, entered=entered)])
    rig.adapter.handle(url("old"))
    assert entered.wait(IDLE_TIMEOUT_S)  # the worker is inside the download
    rig.adapter.handle(line("new"))
    assert rig.posted == [AudioFailed(play_id="old", code="interrupted")]  # posted at once
    gate.set()
    assert rig.adapter.wait_idle(IDLE_TIMEOUT_S)
    assert rig.posted == [
        AudioFailed(play_id="old", code="interrupted"),
        AudioFinished(play_id="new"),
    ]
    assert len(rig.runner.calls) == 1  # only the new line was played
    assert rig.leftovers() == []


def test_request_after_stop_is_interrupted_without_playing(tmp_path: Path) -> None:
    rig = Rig(tmp_path, [Step()])
    rig.adapter.stop()
    assert rig.play(line()) == [AudioFailed(play_id="p1", code="interrupted")]
    assert rig.runner.calls == []


def test_stop_interrupts_a_running_download_and_deletes_the_file(tmp_path: Path) -> None:
    gate, entered = threading.Event(), threading.Event()
    rig = Rig(tmp_path, opens=[OpenStep(body=GOOD_WAV, gate=gate, entered=entered)])
    rig.adapter.handle(url("old"))
    assert entered.wait(IDLE_TIMEOUT_S)
    rig.adapter.stop()
    gate.set()
    assert rig.adapter.wait_idle(IDLE_TIMEOUT_S)
    assert rig.posted == [AudioFailed(play_id="old", code="interrupted")]
    assert rig.runner.calls == []
    assert rig.leftovers() == []


def test_unexpected_worker_exception_posts_adapter_error_and_one_result(tmp_path: Path) -> None:
    class Boom:
        def open(self, fullurl: str, data: None = None, timeout: float | None = None) -> object:
            raise RuntimeError("boom")

    rig = Rig(tmp_path)
    rig.adapter._opener = Boom()  # type: ignore[assignment]  # noqa: SLF001
    rig.play(url())
    assert AdapterError(code="adapter_failed") in rig.posted
    assert [e for e in rig.posted if isinstance(e, AudioFailed)] == [
        AudioFailed(play_id="p1", code="download_failed")
    ]
    assert rig.leftovers() == []


# --------------------------------------------------------------------------------------------
# Privacy of logs (R13.6)
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("outcome", ["played", "bad-content", "open-error", "playback-failed"])
def test_url_query_token_never_reaches_a_log_line(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, outcome: str
) -> None:
    steps: list[Step] = []
    opens: list[OpenStep]
    if outcome == "played":
        steps, opens = [Step()], [OpenStep(body=GOOD_WAV)]
    elif outcome == "bad-content":
        opens = [OpenStep(body=b"junk")]
    elif outcome == "open-error":
        opens = [OpenStep(error=urllib.error.URLError(f"failed for {URL}"))]
    else:
        steps, opens = [Step(exit_code=1)], [OpenStep(body=GOOD_WAV)]
    rig = Rig(tmp_path, steps, opens)
    with caplog.at_level(logging.DEBUG):
        rig.play(url())
    assert "SECRET-TOKEN-123" not in caplog.text
    assert "token=" not in caplog.text
    assert "https://example.test/voice/hello.wav" in caplog.text


def test_subprocess_timeout_type_is_used_by_the_scripted_runner() -> None:
    # Guards the assumption behind the timeout tests: the scripted child raises the real error.
    runner = ScriptedRunner(ManualScheduler(), [Step(duration=10.0)])
    with pytest.raises(subprocess.TimeoutExpired):
        runner(["aplay"]).communicate(timeout=1.0)
