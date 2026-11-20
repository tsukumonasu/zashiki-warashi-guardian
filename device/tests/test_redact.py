"""Unit tests for log and print redaction (``warashi_agent/redact.py``).

Private values carry the marker ``ZQXJ`` (in the ``audioUrl`` query, user info and fragment,
in the ``ja`` and ``en`` texts, inside the JPEG bytes and inside the base64 text). Every
formatted line is checked to contain no marker, to be exactly one line and to hold no ESC
(R13.6, R21.4, R27.3).
"""

import json
import math
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest

from warashi_agent.messages import (
    Envelope,
    ErrorCode,
    ErrorReported,
    GazeData,
    SnapshotCaptured,
    SpeakData,
)
from warashi_agent.model import (
    JudgementResult,
    PlayAudioUrl,
    PublishEvent,
    SnapshotReady,
    Speak,
    Verdict,
)
from warashi_agent.redact import (
    format_action,
    format_envelope,
    format_event,
    one_line,
    redact_url,
)

MARKER = "ZQXJ"
SECRET_URL = (
    f"https://{MARKER}user:{MARKER}pass@Media.Example.com:8443/voice/a.wav"
    f"?X-Amz-Signature={MARKER}sig&token={MARKER}tok#{MARKER}frag"
)
SAFE_URL = "https://media.example.com/voice/a.wav"
JPEG = b"\xff\xd8\xff\xe0" + MARKER.encode() + b"-image-bytes\xff\xd9"
JPEG_BASE64 = "/9j/4A" + MARKER * 8 + "AAAA"
JA = f"{MARKER}花子ちゃん、おかえり"
EN = f"Welcome home, {MARKER}"
TS = datetime(2026, 11, 20, 12, 34, 56, 789000, tzinfo=UTC)


def assert_clean(line: str) -> None:
    """No marker, exactly one line for ``str.splitlines()``, no ESC."""
    assert MARKER not in line
    assert len(line.splitlines()) == 1
    assert "\x1b" not in line


def envelope(data, *, ts: datetime = TS) -> Envelope:
    return Envelope(
        id="0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
        ts=ts,
        device_id="warashi-01",
        encounter_id=None,
        data=data,
    )


def speak_data() -> SpeakData:
    return SpeakData(line_id=None, audio_url=SECRET_URL, ja=JA, en=EN)


def snapshot_captured() -> SnapshotCaptured:
    return SnapshotCaptured(
        snapshot_id="s1",
        width=640,
        height=480,
        pan_deg=1.5,
        tilt_deg=-2.0,
        jpeg_base64=JPEG_BASE64,
    )


# --------------------------------------------------------------------------------------------
# jpegBase64 replaced by its length
# --------------------------------------------------------------------------------------------


def test_envelope_jpeg_base64_becomes_its_number_of_characters():
    line = format_envelope(envelope(snapshot_captured()))
    assert_clean(line)
    obj = json.loads(line)
    assert obj["type"] == "snapshot.captured"
    assert obj["data"]["jpegBase64"] == len(JPEG_BASE64)
    assert obj["data"]["snapshotId"] == "s1"
    assert obj["data"]["width"] == 640


def test_publish_event_action_shows_base64_as_char_count():
    line = format_action(PublishEvent(data=snapshot_captured(), encounter_id="e1"))
    assert_clean(line)
    assert f"jpeg_base64=<{len(JPEG_BASE64)} chars>" in line
    assert "snapshot_id='s1'" in line


# --------------------------------------------------------------------------------------------
# audioUrl query removed
# --------------------------------------------------------------------------------------------


def test_envelope_audio_url_is_scheme_host_path():
    line = format_envelope(envelope(speak_data()))
    assert_clean(line)
    assert json.loads(line)["data"]["audioUrl"] == SAFE_URL


def test_speak_event_audio_url_is_redacted():
    line = format_event(Speak(ref_id="c1", line_id=None, audio_url=SECRET_URL))
    assert_clean(line)
    assert f"audio_url={SAFE_URL}" in line


def test_speak_event_without_audio_url_shows_none():
    line = format_event(Speak(ref_id="c1", line_id="greet_01", audio_url=None))
    assert_clean(line)
    assert "audio_url=None" in line
    assert "line_id='greet_01'" in line


def test_play_audio_url_action_is_redacted():
    line = format_action(PlayAudioUrl(url=SECRET_URL, play_id="p1"))
    assert_clean(line)
    assert line == f"PlayAudioUrl(url={SAFE_URL}, play_id='p1')"


# --------------------------------------------------------------------------------------------
# ja and en removed
# --------------------------------------------------------------------------------------------


def test_envelope_speak_drops_ja_and_en():
    line = format_envelope(envelope(speak_data()))
    assert_clean(line)
    assert set(json.loads(line)["data"]) == {"lineId", "audioUrl"}


def test_speak_data_dataclass_drops_ja_and_en():
    # A payload printed through the dataclass formatter must not show the texts either.
    line = format_action(PublishEvent(data=speak_data(), encounter_id=None))  # type: ignore[arg-type]
    assert_clean(line)
    assert "ja=" not in line
    assert "en=" not in line


# --------------------------------------------------------------------------------------------
# SnapshotReady bytes never printed
# --------------------------------------------------------------------------------------------


def test_snapshot_ready_bytes_become_their_length():
    line = format_event(SnapshotReady(snapshot_id="s1", jpeg=JPEG, width=640, height=480))
    assert_clean(line)
    assert f"jpeg=<{len(JPEG)} bytes>" in line
    assert "\\xff" not in line


# --------------------------------------------------------------------------------------------
# Other formatter rules
# --------------------------------------------------------------------------------------------


def test_enums_are_written_as_wire_values():
    line = format_event(
        JudgementResult(
            ref_id="c1", snapshot_id="s1", verdict=Verdict.NO_FACE, confidence=0.4, face=None
        )
    )
    assert_clean(line)
    assert "verdict='no_face'" in line


def test_unknown_private_field_is_hidden():
    @dataclass(frozen=True)
    class WithSecret:
        public: str
        secret: str = field(repr=False)

    line = format_event(WithSecret(public="ok", secret=MARKER))  # type: ignore[arg-type]
    assert_clean(line)
    assert line == "WithSecret(public='ok', secret=<hidden>)"


@pytest.mark.parametrize("text", ["a\nb", "a\r\nb", "a\u2028b", "a\u2029b", "a\x85b", "\x1b[2J"])
def test_crafted_text_stays_on_one_line(text):
    data = ErrorReported(code=ErrorCode("audio_failed"), message=text, ref_id=None)
    assert_clean(format_action(PublishEvent(data=data, encounter_id=None)))
    assert_clean(format_envelope(envelope(data)))


def test_one_line_escapes_every_line_break_and_esc():
    text = "a\nb\rc\x0bd\x0ce\x1cf\x1dg\x1eh\x85i\u2028j\u2029k\x1bl"
    line = one_line(text)
    assert_clean(line)
    assert line.startswith("a\\x0ab")
    assert "\\u2028" in line
    assert "\\x1b" in line


# --------------------------------------------------------------------------------------------
# Unencodable envelope
# --------------------------------------------------------------------------------------------


def test_naive_ts_envelope_is_unencodable_and_shows_no_values():
    line = format_envelope(envelope(speak_data(), ts=datetime(2026, 11, 20, 12, 0)))
    assert_clean(line)
    assert line == "<unencodable envelope type='speak'>"


def test_non_finite_number_envelope_is_unencodable():
    line = format_envelope(envelope(GazeData(pan_deg=math.nan, tilt_deg=0.0)))
    assert line == "<unencodable envelope type='gaze'>"


# --------------------------------------------------------------------------------------------
# redact_url edge cases
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (SECRET_URL, SAFE_URL),
        ("https://host.example", "https://host.example"),
        (f"https://host.example?token={MARKER}", "https://host.example"),
        (f"https://host.example/a.wav#{MARKER}", "https://host.example/a.wav"),
        (f"https://u:{MARKER}@x@host.example/a.wav", "https://host.example/a.wav"),
        ("https://host.example:99999/a.wav", "https://host.example/a.wav"),
    ],
)
def test_redact_url_keeps_scheme_host_and_path_only(url, expected):
    line = redact_url(url)
    assert_clean(line)
    assert line == expected


@pytest.mark.parametrize("url", [f"https://[::1/{MARKER}", f"http://[{MARKER}]/a?t={MARKER}"])
def test_unparsable_url_is_not_shown(url):
    assert redact_url(url) == "<invalid url>"


def test_line_breaks_in_url_path_stay_on_one_line():
    assert_clean(redact_url("https://host.example/a\u2028b\x1b[2J?t=" + MARKER))
