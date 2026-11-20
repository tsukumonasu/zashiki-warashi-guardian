"""Unit tests for the Message_Codec (``warashi_agent/messages.py``).

The literal JSON examples below are written by hand from ``docs/schema.md`` (one per wire
type), not built from the codec registry, so a registry mistake cannot hide in its own test.
Property 4 (``test_prop_messages.py``) covers the general round trip and robustness rules;
these tests pin concrete examples and boundaries (R13.7, R22.1, R22.3, R22.6, R22.10, R22.11).
"""

import json
from datetime import UTC, datetime, timedelta, timezone

import pytest

from warashi_agent.messages import (
    EncounterEnded,
    Envelope,
    ErrorCode,
    ErrorReported,
    GazeData,
    JudgementResultData,
    LanternData,
    Malformed,
    ModeSetData,
    PresenceDetected,
    ReactionPerformed,
    SnapshotCaptured,
    SpeakData,
    StateChanged,
    StatusOffline,
    StatusReport,
    Valid,
    decode,
    encode,
)
from warashi_agent.model import (
    Category,
    EndReason,
    FaceBox,
    Mode,
    Reason,
    State,
    Verdict,
)

MESSAGE_ID = "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10"
ENCOUNTER_ID = "c1d2e3f4-0000-4000-8000-000000000001"
TS_TEXT = "2026-11-20T12:34:56.789Z"
TS = datetime(2026, 11, 20, 12, 34, 56, 789_000, tzinfo=UTC)


def wire(type_: str, data: str, *, encounter_id: str | None = ENCOUNTER_ID) -> str:
    """The envelope example of docs/schema.md around a literal ``data`` object."""
    encounter = "null" if encounter_id is None else f'"{encounter_id}"'
    return (
        f'{{"v":1,"id":"{MESSAGE_ID}","ts":"{TS_TEXT}","deviceId":"warashi-01",'
        f'"encounterId":{encounter},"type":"{type_}","data":{data}}}'
    )


def decode_valid(raw: str | bytes) -> Envelope:
    result = decode(raw.encode("utf-8") if isinstance(raw, str) else raw)
    assert isinstance(result, Valid), result
    return result.message


def decode_malformed(raw: str | bytes) -> Malformed:
    result = decode(raw.encode("utf-8") if isinstance(raw, str) else raw)
    assert isinstance(result, Malformed), result
    return result


# One literal example per wire type: (raw JSON, expected payload, encounterId on the wire).
EXAMPLES = [
    pytest.param(
        wire("presence.detected", '{"source":"pir"}'),
        PresenceDetected(source="pir"),
        ENCOUNTER_ID,
        id="presence.detected",
    ),
    pytest.param(
        wire(
            "snapshot.captured",
            '{"snapshotId":"snap-1-abc","width":640,"height":480,'
            '"panDeg":-12.5,"tiltDeg":4,"jpegBase64":"/9j/4AAQSkZJRg=="}',
        ),
        SnapshotCaptured(
            snapshot_id="snap-1-abc",
            width=640,
            height=480,
            pan_deg=-12.5,
            tilt_deg=4.0,
            jpeg_base64="/9j/4AAQSkZJRg==",
        ),
        ENCOUNTER_ID,
        id="snapshot.captured",
    ),
    pytest.param(
        wire("state.changed", '{"from":"seeking","to":"gazing","reason":"verdict"}'),
        StateChanged(from_=State.SEEKING, to=State.GAZING, reason=Reason.VERDICT),
        ENCOUNTER_ID,
        id="state.changed",
    ),
    pytest.param(
        wire(
            "reaction.performed",
            '{"kind":"uncertain","lineId":"uncertain","offline":true}',
        ),
        ReactionPerformed(kind=Category.UNCERTAIN, line_id="uncertain", offline=True),
        ENCOUNTER_ID,
        id="reaction.performed",
    ),
    pytest.param(
        wire("encounter.ended", '{"reason":"cooldown"}'),
        EncounterEnded(reason=EndReason.COOLDOWN),
        ENCOUNTER_ID,
        id="encounter.ended",
    ),
    pytest.param(
        wire(
            "error.reported",
            '{"code":"unknown_line","message":"speak.lineId is not a cached voice line",'
            '"refId":"5d6e7f80-1111-4222-8333-444455556666"}',
        ),
        ErrorReported(
            code=ErrorCode.UNKNOWN_LINE,
            message="speak.lineId is not a cached voice line",
            ref_id="5d6e7f80-1111-4222-8333-444455556666",
        ),
        ENCOUNTER_ID,
        id="error.reported",
    ),
    pytest.param(
        wire(
            "judgement.result",
            '{"snapshotId":"snap-1-abc","verdict":"family","confidence":0.93,'
            '"face":{"left":0.4,"top":0.2,"width":0.2,"height":0.3}}',
            encounter_id=None,
        ),
        JudgementResultData(
            snapshot_id="snap-1-abc",
            verdict=Verdict.FAMILY,
            confidence=0.93,
            face=FaceBox(left=0.4, top=0.2, width=0.2, height=0.3),
        ),
        None,
        id="judgement.result",
    ),
    pytest.param(
        wire(
            "speak",
            '{"lineId":"greeting_family","audioUrl":null,"ja":"おかえり。","en":"Welcome home."}',
        ),
        SpeakData(line_id="greeting_family", audio_url=None, ja="おかえり。", en="Welcome home."),
        ENCOUNTER_ID,
        id="speak",
    ),
    pytest.param(
        wire("gaze", '{"panDeg":10,"tiltDeg":-5.5}'),
        GazeData(pan_deg=10.0, tilt_deg=-5.5),
        ENCOUNTER_ID,
        id="gaze",
    ),
    pytest.param(
        wire("lantern", '{"level":0.8,"fadeMs":1500}'),
        LanternData(level=0.8, fade_ms=1500),
        ENCOUNTER_ID,
        id="lantern",
    ),
    pytest.param(
        wire("mode.set", '{"mode":"sleep"}', encounter_id=None),
        ModeSetData(mode=Mode.SLEEP),
        None,
        id="mode.set",
    ),
    pytest.param(
        wire(
            "status.report",
            '{"state":"sleeping","mode":"guard","panDeg":0,"tiltDeg":0,"lantern":0,'
            '"cameraActive":false,"micActive":false,"motionEnabled":false,'
            '"uptimeSec":125,"agentVersion":"0.1.0"}',
            encounter_id=None,
        ),
        StatusReport(
            state=State.SLEEPING,
            mode=Mode.GUARD,
            pan_deg=0.0,
            tilt_deg=0.0,
            lantern=0.0,
            camera_active=False,
            mic_active=False,
            motion_enabled=False,
            uptime_sec=125,
            agent_version="0.1.0",
        ),
        None,
        id="status.report",
    ),
    pytest.param(
        wire("status.offline", "{}", encounter_id=None),
        StatusOffline(),
        None,
        id="status.offline",
    ),
]


@pytest.mark.parametrize(("raw", "payload", "encounter_id"), EXAMPLES)
def test_schema_example_decodes_to_the_expected_payload(raw, payload, encounter_id):
    env = decode_valid(raw)
    assert env == Envelope(
        v=1,
        id=MESSAGE_ID,
        ts=TS,
        device_id="warashi-01",
        encounter_id=encounter_id,
        data=payload,
    )
    assert env.type == payload.TYPE


@pytest.mark.parametrize(("raw", "payload", "encounter_id"), EXAMPLES)
def test_schema_example_encodes_back_to_exactly_its_fields(raw, payload, encounter_id):
    """R22.1: the encoding has exactly the fields of docs/schema.md, in schema order."""
    encoded = json.loads(encode(decode_valid(raw)))
    expected = json.loads(raw)
    assert encoded == expected  # 10 == 10.0 in Python, so number kinds do not matter here
    assert list(encoded) == list(expected)
    assert list(encoded["data"]) == list(expected["data"])


# --- ts (R22.3) --------------------------------------------------------------------------


def _status_envelope(ts: datetime) -> Envelope:
    return Envelope(
        id=MESSAGE_ID,
        ts=ts,
        device_id="warashi-01",
        encounter_id=None,
        data=StatusOffline(),
    )


@pytest.mark.parametrize(
    ("ts", "text"),
    [
        (datetime(2026, 11, 20, 12, 34, 56, 789_999, tzinfo=UTC), "2026-11-20T12:34:56.789Z"),
        (datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC), "2026-01-02T03:04:05.000Z"),
        (
            datetime(2026, 11, 20, 21, 34, 56, 7_000, tzinfo=timezone(timedelta(hours=9))),
            "2026-11-20T12:34:56.007Z",
        ),
    ],
    ids=["sub-millisecond-dropped", "zero-millis", "offset-converted-to-utc"],
)
def test_encode_formats_ts_as_utc_with_three_fractional_digits(ts, text):
    assert json.loads(encode(_status_envelope(ts)))["ts"] == text


def test_encode_rejects_a_naive_ts():
    with pytest.raises(ValueError):
        encode(_status_envelope(datetime(2026, 11, 20, 12, 34, 56)))


def test_decode_converts_an_offset_ts_to_utc():
    raw = wire("status.offline", "{}", encounter_id=None).replace(
        TS_TEXT, "2026-11-20T21:34:56.789+09:00"
    )
    assert decode_valid(raw).ts == TS


def test_decode_rejects_a_ts_without_offset():
    raw = wire("status.offline", "{}", encounter_id=None).replace(
        TS_TEXT, "2026-11-20T12:34:56.789"
    )
    assert decode_malformed(raw).message_id == MESSAGE_ID


# --- error.reported message and refId (R22.1, R22.10) ------------------------------------


def _error_envelope(message: str) -> Envelope:
    return Envelope(
        id=MESSAGE_ID,
        ts=TS,
        device_id="warashi-01",
        encounter_id=None,
        data=ErrorReported(code=ErrorCode.AUDIO_FAILED, message=message, ref_id=None),
    )


def test_error_message_of_exactly_200_code_points_is_kept():
    message = "あ" * 200  # 600 UTF-8 bytes: the limit counts code points, not bytes
    data = json.loads(encode(_error_envelope(message)))["data"]
    assert data["message"] == message


def test_error_message_of_201_code_points_is_cut_to_200():
    message = "あ" * 199 + "いう"
    data = json.loads(encode(_error_envelope(message)))["data"]
    assert data["message"] == "あ" * 199 + "い"
    assert len(data["message"]) == 200


def test_error_reported_always_encodes_ref_id():
    data = json.loads(encode(_error_envelope("x")))["data"]
    assert "refId" in data
    assert data["refId"] is None


def test_error_reported_without_ref_id_decodes_as_null():
    raw = wire("error.reported", '{"code":"camera_failed","message":"capture timed out"}')
    payload = decode_valid(raw).data
    assert isinstance(payload, ErrorReported)
    assert payload.ref_id is None


# --- malformed input (R22.6) -------------------------------------------------------------


@pytest.mark.parametrize("number", ["1e400", "-1e400", "NaN", "Infinity", "-Infinity"])
def test_non_finite_number_is_malformed_with_the_readable_id(number):
    malformed = decode_malformed(wire("gaze", f'{{"panDeg":{number},"tiltDeg":0}}'))
    # The id is read after parsing, so refId can name the message (R12.10).
    assert malformed.message_id == MESSAGE_ID
    assert "non-finite" in malformed.problem


@pytest.mark.parametrize("number", ["1e400", "NaN"])
def test_non_finite_number_wins_over_a_higher_version(number):
    raw = wire("gaze", f'{{"panDeg":{number},"tiltDeg":0}}').replace('"v":1', '"v":2', 1)
    assert '"v":2' in raw
    malformed = decode_malformed(raw)
    assert malformed.message_id == MESSAGE_ID
    assert "non-finite" in malformed.problem


@pytest.mark.parametrize("raw", ['{"id":NaN,"v":1}', '{"v":1,"x":Infinity}', "[1e400]"])
def test_non_finite_number_without_a_readable_id_is_malformed_with_null(raw):
    malformed = decode_malformed(raw)
    assert malformed.message_id is None
    assert "non-finite" in malformed.problem


def test_nesting_beyond_the_recursion_limit_is_malformed():
    depth = 60_000  # far beyond the interpreter's recursion limits, still under 131,072 bytes
    raw = wire("gaze", '{"panDeg":0,"tiltDeg":0,"x":' + "[" * depth + "]" * depth + "}")
    assert len(raw.encode("utf-8")) <= 131_072
    malformed = decode_malformed(raw)
    assert malformed.problem == "JSON nested too deeply"


@pytest.mark.parametrize(
    "data",
    [
        '{"panDeg":true,"tiltDeg":0}',
        '{"panDeg":0,"tiltDeg":false}',
    ],
    ids=["true-for-panDeg", "false-for-tiltDeg"],
)
def test_boolean_for_a_number_field_is_malformed(data):
    malformed = decode_malformed(wire("gaze", data))
    assert malformed.message_id == MESSAGE_ID
    assert malformed.problem.endswith("wrong type")


def test_boolean_for_an_int_field_is_malformed():
    assert decode_malformed(wire("lantern", '{"level":0.5,"fadeMs":true}'))


@pytest.mark.parametrize(
    "data",
    [
        '{"lineId":"uncertain","audioUrl":"https://example.invalid/a.wav","ja":"","en":""}',
        '{"lineId":null,"audioUrl":null,"ja":"","en":""}',
    ],
    ids=["both", "neither"],
)
def test_speak_needs_exactly_one_of_line_id_and_audio_url(data):
    malformed = decode_malformed(wire("speak", data))
    assert malformed.message_id == MESSAGE_ID
    assert "exactly one of lineId and audioUrl" in malformed.problem


def test_malformed_problem_never_contains_the_value():
    """R13.6: problem texts name the rule and the field path only."""
    malformed = decode_malformed(wire("mode.set", '{"mode":"ZQXJsecretvalue"}'))
    assert "ZQXJ" not in malformed.problem
    assert "data.mode" in malformed.problem


# --- extra fields and out-of-range numbers (R13.7, R22.11) -------------------------------


def test_extra_data_field_is_dropped():
    raw = wire(
        "speak",
        '{"lineId":"greeting_family","audioUrl":null,"ja":"","en":"","nickname":"ZQXJmarker1234"}',
    )
    env = decode_valid(raw)
    assert env.data == SpeakData(line_id="greeting_family", audio_url=None, ja="", en="")
    assert b"ZQXJ" not in encode(env)


def test_extra_top_level_field_is_dropped():
    raw = wire("mode.set", '{"mode":"guard"}', encounter_id=None)
    raw = raw[:-1] + ',"owner":"ZQXJmarker1234"}'
    env = decode_valid(raw)
    assert env.data == ModeSetData(mode=Mode.GUARD)
    assert b"ZQXJ" not in encode(env)


def test_finite_numbers_outside_their_ranges_are_valid():
    judgement = decode_valid(
        wire(
            "judgement.result",
            '{"snapshotId":"s","verdict":"stranger","confidence":1.5,'
            '"face":{"left":-0.2,"top":1.7,"width":3,"height":-1}}',
        )
    ).data
    assert judgement == JudgementResultData(
        snapshot_id="s",
        verdict=Verdict.STRANGER,
        confidence=1.5,
        face=FaceBox(left=-0.2, top=1.7, width=3.0, height=-1.0),
    )
    assert decode_valid(wire("lantern", '{"level":7,"fadeMs":99999}')).data == LanternData(
        level=7.0, fade_ms=99999
    )
    assert decode_valid(wire("gaze", '{"panDeg":1e300,"tiltDeg":-90}')).data == GazeData(
        pan_deg=1e300, tilt_deg=-90.0
    )
