"""Property 4: Schema round trip and robustness (design "Correctness Properties", R29.6).

One ``@given`` function checks every clause of Property 4 on each example:

- **Round trip.** A valid Wire_Message of any type with a millisecond ``ts`` survives
  ``decode(encode(m))`` unchanged, the encoded ``ts`` is ``YYYY-MM-DDTHH:MM:SS.mmmZ``, and the
  encoded JSON holds exactly the fields of ``docs/schema.md`` (R22.1 to R22.3).
- **No raise.** ``decode`` and ``route_inbound`` return a result for arbitrary bytes, arbitrary
  JSON values, valid envelopes with an arbitrary JSON value in one field, huge integers and
  deep nesting (R22.6).
- **One broken rule.** A valid message changed to break exactly one rule decodes as
  ``Ignored("unsupported_version")`` for an integer ``v`` > 1, ``Ignored("unknown_type")`` for
  an undefined ``type``, and ``Malformed`` for each rule of R22.6 (R22.4 to R22.6, R22.11).
  ``route_inbound`` maps the results to ``error.reported`` codes with the R12.10 / R22.4
  ``refId``; a valid event or status type received as a command gives ``unknown_type``, and a
  command for another device gives ``wrong_device`` (R21.8, R22.7).
- **``error.reported`` encoding.** ``message`` is cut to 200 code points and ``refId`` is
  always written; a received ``error.reported`` without ``refId`` decodes with ``refId: null``
  (R22.1, R22.10).

The expected wire layout (``SCHEMA`` below) is written by hand from the Events, Commands and
Status tables of ``docs/schema.md``. It is not built from ``messages.REGISTRY``, so a
registry mistake cannot hide behind its own oracle. Only the payload dataclasses are imported,
to build the messages that are encoded.

Interim design rules F1 and F4 are part of the oracle: a ``ts`` without a UTC offset is
malformed, and undefined top-level fields are dropped.

Every ``Malformed`` result carries the message ``id`` when the top level is an object with a
string ``id``, and null otherwise (R12.10). This includes a non-finite number (``NaN``,
``Infinity`` or ``1e400``): the decoder parses it, reads the ``id``, then rejects the message.
"""

# Feature: device-core-loop, Property 4: Schema round trip and robustness

from __future__ import annotations

import json
import re
import string
from datetime import UTC, datetime
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from warashi_agent.inbound import Deduplicator, ErrorToPublish, route_inbound
from warashi_agent.messages import (
    EncounterEnded,
    Envelope,
    ErrorCode,
    ErrorReported,
    GazeData,
    Ignored,
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
    Gaze,
    JudgementResult,
    Lantern,
    Mode,
    ModeSet,
    Reason,
    Speak,
    State,
    Verdict,
)

# --------------------------------------------------------------------------------------------
# Oracle: the wire layout of docs/schema.md, written by hand
# --------------------------------------------------------------------------------------------

MAX_BYTES = 131_072
MESSAGE_CUT = 200
TS_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
ENVELOPE_KEYS = ("v", "id", "ts", "deviceId", "encounterId", "type", "data")

STATES = (
    "sleeping",
    "waking",
    "seeking",
    "gazing",
    "greeting",
    "warning",
    "uncertain",
    "conversing",
    "cooldown",
)
REASONS = (
    "presence",
    "arrived",
    "verdict",
    "no_face",
    "timeout",
    "offline",
    "audio_done",
    "manual",
    "cooldown_done",
    "error",
)
END_REASONS = ("cooldown", "manual", "error")
CATEGORIES = ("family", "stranger", "uncertain")
VERDICTS = ("family", "stranger", "no_face", "uncertain")
MODES = ("guard", "sleep")
SOURCES = ("pir", "sound", "manual")
ERROR_CODES = (
    "unknown_type",
    "unsupported_version",
    "malformed_message",
    "wrong_device",
    "speak_rejected",
    "audio_busy",
    "command_rejected_state",
    "unknown_line",
    "voice_line_missing",
    "voice_line_invalid",
    "voice_file_missing",
    "audio_failed",
    "download_failed",
    "audio_device_missing",
    "camera_missing",
    "camera_failed",
    "snapshot_too_large",
    "internal_error",
    "adapter_failed",
)


def _f(kind: str, *, nullable: bool = False, values: tuple[str, ...] = ()) -> dict[str, Any]:
    return {"kind": kind, "nullable": nullable, "values": values}


# wire type -> (direction, {data field: spec}); field order as in docs/schema.md.
SCHEMA: dict[str, tuple[str, dict[str, dict[str, Any]]]] = {
    "presence.detected": ("event", {"source": _f("enum", values=SOURCES)}),
    "snapshot.captured": (
        "event",
        {
            "snapshotId": _f("str"),
            "width": _f("int"),
            "height": _f("int"),
            "panDeg": _f("number"),
            "tiltDeg": _f("number"),
            "jpegBase64": _f("str"),
        },
    ),
    "state.changed": (
        "event",
        {
            "from": _f("enum", values=STATES),
            "to": _f("enum", values=STATES),
            "reason": _f("enum", values=REASONS),
        },
    ),
    "reaction.performed": (
        "event",
        {
            "kind": _f("enum", values=CATEGORIES),
            "lineId": _f("str", nullable=True),
            "offline": _f("bool"),
        },
    ),
    "encounter.ended": ("event", {"reason": _f("enum", values=END_REASONS)}),
    "error.reported": (
        "event",
        {
            "code": _f("enum", values=ERROR_CODES),
            "message": _f("str"),
            "refId": _f("str", nullable=True),
        },
    ),
    "judgement.result": (
        "command",
        {
            "snapshotId": _f("str"),
            "verdict": _f("enum", values=VERDICTS),
            "confidence": _f("number"),
            "face": _f("face", nullable=True),
        },
    ),
    "speak": (
        "command",
        {
            "lineId": _f("str", nullable=True),
            "audioUrl": _f("str", nullable=True),
            "ja": _f("str"),
            "en": _f("str"),
        },
    ),
    "gaze": ("command", {"panDeg": _f("number"), "tiltDeg": _f("number")}),
    "lantern": ("command", {"level": _f("number"), "fadeMs": _f("int")}),
    "mode.set": ("command", {"mode": _f("enum", values=MODES)}),
    "status.report": (
        "status",
        {
            "state": _f("enum", values=STATES),
            "mode": _f("enum", values=MODES),
            "panDeg": _f("number"),
            "tiltDeg": _f("number"),
            "lantern": _f("number"),
            "cameraActive": _f("bool"),
            "micActive": _f("bool"),
            "motionEnabled": _f("bool"),
            "uptimeSec": _f("int"),
            "agentVersion": _f("str"),
        },
    ),
    "status.offline": ("status", {}),
}
FACE_KEYS = ("left", "top", "width", "height")

# refId is the only data field a receiver may miss: it then decodes as null (R22.1).
OPTIONAL_ON_DECODE = {("error.reported", "refId")}

# Values of the wrong JSON type per field kind. A JSON boolean is never a number (R22.6).
WRONG_TYPE_VALUES: dict[str, tuple[Any, ...]] = {
    "str": (0, 1.5, True, [], {}),
    "int": (1.5, -0.5, True, False, "1", [], {}),
    "number": (True, False, "1", [], {}),
    "bool": (0, 1, "true", [], {}),
    "enum": (0, True, [], {}),
    "face": (0, 1.5, "face", [], True),
}

COMMAND_EVENT_CLASS = {
    "judgement.result": JudgementResult,
    "speak": Speak,
    "gaze": Gaze,
    "lantern": Lantern,
    "mode.set": ModeSet,
}

# --------------------------------------------------------------------------------------------
# Generators
# --------------------------------------------------------------------------------------------

# Valid UTF-8 cannot carry lone surrogates, so the text excludes them.
texts = st.text(st.characters(exclude_categories=("Cs",)), max_size=40)
finite = st.floats(allow_nan=False, allow_infinity=False)  # includes out-of-range values
ints = st.integers(min_value=-(2**64), max_value=2**64)
uuids = st.uuids(version=4).map(str)
device_ids = st.text(string.ascii_lowercase + string.digits + "-", min_size=1, max_size=64)
timestamps = st.datetimes(
    min_value=datetime(1, 1, 1),
    max_value=datetime(9999, 12, 31, 23, 59, 59, 999_000),
    timezones=st.just(UTC),
).map(lambda t: t.replace(microsecond=t.microsecond // 1000 * 1000))


def _enum_of(enum_type: type, values: tuple[str, ...]) -> st.SearchStrategy[Any]:
    return st.sampled_from(values).map(enum_type)


faces = st.builds(FaceBox, left=finite, top=finite, width=finite, height=finite)


@st.composite
def speak_payloads(draw: st.DrawFn) -> SpeakData:
    url = draw(texts)
    line = draw(texts)
    use_line = draw(st.booleans())  # exactly one of lineId and audioUrl (R22.6)
    return SpeakData(
        line_id=line if use_line else None,
        audio_url=None if use_line else url,
        ja=draw(texts),
        en=draw(texts),
    )


def error_payloads(max_message: int) -> st.SearchStrategy[ErrorReported]:
    return st.builds(
        ErrorReported,
        code=_enum_of(ErrorCode, ERROR_CODES),
        message=st.text(st.characters(exclude_categories=("Cs",)), max_size=max_message),
        ref_id=st.none() | uuids,
    )


PAYLOADS: dict[str, st.SearchStrategy[Any]] = {
    "presence.detected": st.builds(PresenceDetected, source=st.sampled_from(SOURCES)),
    "snapshot.captured": st.builds(
        SnapshotCaptured,
        snapshot_id=texts,
        width=ints,
        height=ints,
        pan_deg=finite,
        tilt_deg=finite,
        jpeg_base64=st.text(string.ascii_letters + string.digits + "+/=", max_size=400),
    ),
    "state.changed": st.builds(
        StateChanged,
        from_=_enum_of(State, STATES),
        to=_enum_of(State, STATES),
        reason=_enum_of(Reason, REASONS),
    ),
    "reaction.performed": st.builds(
        ReactionPerformed,
        kind=_enum_of(Category, CATEGORIES),
        line_id=st.none() | texts,
        offline=st.booleans(),
    ),
    "encounter.ended": st.builds(EncounterEnded, reason=_enum_of(EndReason, END_REASONS)),
    "error.reported": error_payloads(MESSAGE_CUT),
    "judgement.result": st.builds(
        JudgementResultData,
        snapshot_id=texts,
        verdict=_enum_of(Verdict, VERDICTS),
        confidence=finite,
        face=st.none() | faces,
    ),
    "speak": speak_payloads(),
    "gaze": st.builds(GazeData, pan_deg=finite, tilt_deg=finite),
    "lantern": st.builds(LanternData, level=finite, fade_ms=ints),
    "mode.set": st.builds(ModeSetData, mode=_enum_of(Mode, MODES)),
    "status.report": st.builds(
        StatusReport,
        state=_enum_of(State, STATES),
        mode=_enum_of(Mode, MODES),
        pan_deg=finite,
        tilt_deg=finite,
        lantern=finite,
        camera_active=st.booleans(),
        mic_active=st.booleans(),
        motion_enabled=st.booleans(),
        uptime_sec=ints,
        agent_version=texts,
    ),
    "status.offline": st.just(StatusOffline()),
}
assert set(PAYLOADS) == set(SCHEMA)


def envelopes(wire_type: str, payload: st.SearchStrategy[Any] | None = None):
    return st.builds(
        Envelope,
        v=st.just(1),
        id=uuids,
        ts=timestamps,
        device_id=device_ids,
        encounter_id=st.none() | uuids,
        data=PAYLOADS[wire_type] if payload is None else payload,
    )


def any_envelope(types: tuple[str, ...] = tuple(SCHEMA)) -> st.SearchStrategy[Envelope]:
    return st.sampled_from(types).flatmap(envelopes)


json_values = st.recursive(
    st.none()
    | st.booleans()
    | st.integers(min_value=-(10**400), max_value=10**400)
    | st.floats()  # NaN and infinities included
    | st.text(max_size=20),
    lambda children: (
        st.lists(children, max_size=4) | st.dictionaries(st.text(max_size=8), children, max_size=4)
    ),
    max_leaves=20,
)

# Like ``json_values`` but without NaN and infinities. A mutation that breaks one rule must not
# break a second one: the decoder rejects a non-finite number right after JSON parsing, before
# it looks at ``type`` (design "Decode", step 1), so such garbage would decode as Malformed.
finite_json_values = st.recursive(
    st.none()
    | st.booleans()
    | st.integers(min_value=-(10**400), max_value=10**400)
    | st.floats(allow_nan=False, allow_infinity=False)
    | st.text(max_size=20),
    lambda children: (
        st.lists(children, max_size=4) | st.dictionaries(st.text(max_size=8), children, max_size=4)
    ),
    max_leaves=20,
)

# --------------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------------

SENTINEL = "\u2063ZQXJ-SENTINEL\u2063"  # invisible separators keep it out of generated text


def dumps(obj: Any) -> bytes:
    """Compact JSON; ``ensure_ascii`` escapes any lone surrogate from ``json_values``."""
    return json.dumps(obj, separators=(",", ":")).encode("utf-8")


def dumps_with_token(obj: Any, token: str) -> bytes:
    """Serialize ``obj`` and replace the one ``SENTINEL`` string value by a raw JSON token."""
    text = json.dumps(obj, separators=(",", ":"))
    quoted = json.dumps(SENTINEL)
    assert text.count(quoted) == 1
    return text.replace(quoted, token).encode("utf-8")


def check_any_result(raw: bytes) -> None:
    """Clause "no raise": decode and route_inbound return a result for any input."""
    result = decode(raw)
    assert isinstance(result, Valid | Ignored | Malformed)
    dedup = Deduplicator(window=16)
    kept, routed = route_inbound(raw, dedup, "warashi-01")
    assert isinstance(kept, Deduplicator)
    assert routed is None or isinstance(
        routed, ErrorToPublish | JudgementResult | Speak | Gaze | Lantern | ModeSet
    )


def expect_malformed(raw: bytes, message_id: str | None) -> None:
    """The message is Malformed with the given id, and routed as ``malformed_message``."""
    result = decode(raw)
    assert isinstance(result, Malformed), result
    assert result.message_id == message_id
    dedup = Deduplicator(window=16)
    kept, routed = route_inbound(raw, dedup, "warashi-01")
    assert kept == dedup
    assert isinstance(routed, ErrorToPublish)
    assert routed.code.value == "malformed_message"
    assert routed.ref_id == result.message_id


def expect_ignored(raw: bytes, reason: str, message_id: str | None) -> None:
    """The message is Ignored for ``reason`` and routed with that code and ``refId``."""
    result = decode(raw)
    assert result == Ignored(reason=reason, message_id=message_id), result
    dedup = Deduplicator(window=16)
    kept, routed = route_inbound(raw, dedup, "warashi-01")
    assert kept == dedup
    assert isinstance(routed, ErrorToPublish)
    assert routed.code.value == reason
    assert routed.ref_id == message_id


def fields_of(wire_type: str) -> dict[str, dict[str, Any]]:
    return SCHEMA[wire_type][1]


# --------------------------------------------------------------------------------------------
# Clauses
# --------------------------------------------------------------------------------------------


def check_round_trip(data: st.DataObject) -> None:
    env = data.draw(any_envelope(), label="valid message")
    raw = encode(env)
    obj = json.loads(raw)

    # Exactly the fields of docs/schema.md, in envelope and data (R22.1).
    assert tuple(obj) == ENVELOPE_KEYS
    assert obj["type"] == env.type
    assert tuple(obj["data"]) == tuple(fields_of(env.type))
    if obj["data"].get("face") is not None:
        assert tuple(obj["data"]["face"]) == FACE_KEYS
    assert TS_PATTERN.match(obj["ts"]), obj["ts"]  # R22.3

    assert decode(raw) == Valid(message=env)  # R22.2

    # route_inbound on a valid message (R21.8 steps 2, 3 and 5).
    own_id = data.draw(st.sampled_from([env.device_id, env.device_id + "-x"]), label="own id")
    dedup = Deduplicator(window=16)
    kept, routed = route_inbound(raw, dedup, own_id)
    direction = SCHEMA[env.type][0]
    if direction != "command":
        assert routed == ErrorToPublish(code=routed.code, ref_id=env.id)
        assert routed.code.value == "unknown_type"
        assert kept == dedup
    elif own_id != env.device_id:
        assert isinstance(routed, ErrorToPublish)
        assert routed.code.value == "wrong_device"
        assert routed.ref_id == env.id
        assert kept == dedup
    else:
        assert type(routed) is COMMAND_EVENT_CLASS[env.type]
        assert routed.ref_id == env.id
        assert kept.ids == (env.id,)
        assert not hasattr(routed, "ja") and not hasattr(routed, "en")  # R13.6


def check_error_reported_encoding(data: st.DataObject) -> None:
    env = data.draw(
        envelopes("error.reported", error_payloads(2 * MESSAGE_CUT)), label="error.reported"
    )
    obj = json.loads(encode(env))
    assert "refId" in obj["data"]  # always written (R22.1)
    assert obj["data"]["refId"] == env.data.ref_id
    assert obj["data"]["message"] == env.data.message[:MESSAGE_CUT]  # code points (R22.10)

    del obj["data"]["refId"]
    result = decode(dumps(obj))
    assert isinstance(result, Valid), result
    assert result.message.data.ref_id is None
    assert result.message.data.message == env.data.message[:MESSAGE_CUT]
    assert result.message.data.code == env.data.code


def check_no_raise(data: st.DataObject) -> None:
    check_any_result(data.draw(st.binary(max_size=4096), label="bytes"))

    value = data.draw(json_values, label="json value")
    check_any_result(dumps(value))

    # A valid envelope with an arbitrary JSON value in one envelope or data field.
    env = data.draw(any_envelope(), label="host message")
    obj = json.loads(encode(env))
    paths = [(k,) for k in ENVELOPE_KEYS] + [("data", k) for k in obj["data"]]
    path = data.draw(st.sampled_from(paths), label="weird field")
    target = obj["data"] if len(path) == 2 else obj
    target[path[-1]] = data.draw(json_values, label="weird value")
    check_any_result(dumps(obj))

    # Huge integers (beyond the int digit limit) and deep nesting inside a valid envelope.
    obj = json.loads(encode(env))
    shape = data.draw(st.sampled_from(["huge_int", "deep_list", "deep_object"]), label="shape")
    if shape == "huge_int":
        digits = data.draw(st.integers(min_value=1, max_value=6000), label="digits")
        token = "9" * digits
    elif shape == "deep_list":  # up to 128,000 bytes: inside the size limit
        depth = data.draw(st.integers(min_value=1, max_value=64_000), label="depth")
        token = "[" * depth + "]" * depth
    else:  # up to 140,001 bytes: crosses the size limit near the top
        depth = data.draw(st.integers(min_value=1, max_value=20_000), label="depth")
        token = '{"a":' * depth + "0" + "}" * depth
    key = data.draw(st.sampled_from(["v", "id", "data"]), label="host field")
    obj[key] = SENTINEL
    check_any_result(dumps_with_token(obj, token))


MUTATIONS = (
    "v_higher",
    "v_invalid",
    "unknown_type",
    "drop_envelope_field",
    "envelope_wrong_type",
    "ts_without_offset",
    "drop_data_field",
    "data_wrong_type",
    "data_null",
    "out_of_enum",
    "face_field",
    "non_finite",
    "speak_rule",
    "too_large",
    "below_limit",
    "broken_utf8",
    "not_an_object",
)


def check_one_broken_rule(data: st.DataObject) -> None:
    mutation = data.draw(st.sampled_from(MUTATIONS), label="mutation")
    with_fields = tuple(t for t in SCHEMA if fields_of(t))
    if mutation == "speak_rule":
        env = data.draw(envelopes("speak"), label="message")
    elif mutation == "face_field":
        payload = st.builds(
            JudgementResultData,
            snapshot_id=texts,
            verdict=_enum_of(Verdict, VERDICTS),
            confidence=finite,
            face=faces,
        )
        env = data.draw(envelopes("judgement.result", payload), label="message")
    elif mutation == "out_of_enum":
        with_enums = tuple(
            t for t in SCHEMA if any(s["kind"] == "enum" for s in fields_of(t).values())
        )
        env = data.draw(any_envelope(with_enums), label="message")
    elif mutation in ("drop_data_field", "data_wrong_type", "data_null"):
        env = data.draw(any_envelope(with_fields), label="message")
    else:
        env = data.draw(any_envelope(), label="message")
    obj = json.loads(encode(env))
    specs = fields_of(env.type)
    draw = data.draw

    if mutation == "v_higher":
        obj["v"] = draw(st.integers(min_value=2, max_value=10**30), label="v")
        # The other fields are not validated (R22.4): optionally break one more of them.
        extra = draw(st.sampled_from(["none", "no_data", "bad_ts", "bad_type", "id_not_str"]))
        expected_id: str | None = env.id
        if extra == "no_data":
            del obj["data"]
        elif extra == "bad_ts":
            obj["ts"] = "not a timestamp"
        elif extra == "bad_type":
            obj["type"] = 7
        elif extra == "id_not_str":
            obj["id"] = draw(st.sampled_from([None, 7, [], {}]), label="id")
            expected_id = None
        expect_ignored(dumps(obj), "unsupported_version", expected_id)

    elif mutation == "v_invalid":
        bad = draw(
            st.sampled_from([0, -1, -(10**20), 1.5, "1", True, False, None, [], {}, "missing"])
        )
        if bad == "missing":
            del obj["v"]
        else:
            obj["v"] = bad
        expect_malformed(dumps(obj), env.id)

    elif mutation == "unknown_type":
        obj["type"] = draw(texts.filter(lambda t: t not in SCHEMA), label="type")
        # data is not validated for an unknown type (R22.5). The garbage is finite JSON, so
        # the unknown type stays the only broken rule (see ``finite_json_values``).
        if draw(st.booleans(), label="garbage data"):
            obj["data"] = draw(finite_json_values, label="data")
        expect_ignored(dumps(obj), "unknown_type", env.id)

    elif mutation == "drop_envelope_field":
        key = draw(st.sampled_from(["id", "ts", "deviceId", "encounterId", "type", "data"]))
        del obj[key]
        expect_malformed(dumps(obj), None if key == "id" else env.id)

    elif mutation == "envelope_wrong_type":
        key = draw(st.sampled_from(["id", "ts", "deviceId", "encounterId", "type", "data"]))
        options: list[Any] = [7, 1.5, True, [], {}]
        if key == "data":
            options = [7, 1.5, True, [], "data", None]
        elif key != "encounterId":
            options.append(None)
        obj[key] = draw(st.sampled_from(options), label="value")
        expect_malformed(dumps(obj), None if key == "id" else env.id)

    elif mutation == "ts_without_offset":
        naive = env.ts.replace(tzinfo=None).isoformat(timespec="milliseconds")
        obj["ts"] = draw(st.sampled_from([naive, "", "yesterday", "2026-13-01T00:00:00Z"]))
        expect_malformed(dumps(obj), env.id)

    elif mutation == "drop_data_field":
        names = [n for n in specs if (env.type, n) not in OPTIONAL_ON_DECODE]
        name = draw(st.sampled_from(names), label="field")
        del obj["data"][name]
        expect_malformed(dumps(obj), env.id)

    elif mutation == "data_wrong_type":
        name = draw(st.sampled_from(list(specs)), label="field")
        obj["data"][name] = draw(st.sampled_from(WRONG_TYPE_VALUES[specs[name]["kind"]]))
        expect_malformed(dumps(obj), env.id)

    elif mutation == "data_null":
        names = [n for n, s in specs.items() if not s["nullable"]]
        assert names, env.type
        obj["data"][draw(st.sampled_from(names), label="field")] = None
        expect_malformed(dumps(obj), env.id)

    elif mutation == "out_of_enum":
        names = [n for n, s in specs.items() if s["kind"] == "enum"]
        name = draw(st.sampled_from(names), label="field")
        allowed = specs[name]["values"]
        obj["data"][name] = draw(texts.filter(lambda t: t not in allowed), label="value")
        expect_malformed(dumps(obj), env.id)

    elif mutation == "face_field":
        key = draw(st.sampled_from(FACE_KEYS), label="face field")
        if draw(st.booleans(), label="drop"):
            del obj["data"]["face"][key]
        else:
            obj["data"]["face"][key] = draw(st.sampled_from(WRONG_TYPE_VALUES["number"] + (None,)))
        expect_malformed(dumps(obj), env.id)

    elif mutation == "non_finite":
        token = draw(st.sampled_from(["NaN", "Infinity", "-Infinity", "1e400", "-1e400"]))
        numbers = [n for n, s in specs.items() if s["kind"] == "number"]
        place = draw(st.sampled_from(["number_field", "extra_field", "id"]), label="place")
        expected_id = env.id
        if place == "number_field" and numbers:
            obj["data"][draw(st.sampled_from(numbers), label="field")] = SENTINEL
        elif place == "id":
            obj["id"] = SENTINEL  # the id is the number itself, so it is not readable
            expected_id = None
        else:
            obj["data"]["zqxjExtra"] = SENTINEL  # an undefined field still breaks the rule
        expect_malformed(dumps_with_token(obj, token), expected_id)

    elif mutation == "speak_rule":
        both = draw(st.booleans(), label="both")
        obj["data"]["lineId"] = draw(texts) if both else None
        obj["data"]["audioUrl"] = draw(texts) if both else None
        expect_malformed(dumps(obj), env.id)

    elif mutation in ("too_large", "below_limit"):
        obj["zqxjPad"] = ""  # an undefined top-level field, dropped by the codec (F4)
        base = len(dumps(obj))
        delta = draw(st.integers(min_value=0, max_value=64), label="delta")
        size = MAX_BYTES + 1 + delta if mutation == "too_large" else MAX_BYTES - delta
        obj["zqxjPad"] = "a" * (size - base)
        raw = dumps(obj)
        assert len(raw) == size
        if mutation == "too_large":
            expect_malformed(raw, None)
        else:
            assert decode(raw) == Valid(message=env)

    elif mutation == "broken_utf8":
        raw = encode(env)
        at = draw(st.integers(min_value=0, max_value=len(raw)), label="position")
        bad = draw(st.sampled_from([b"\xff", b"\xfe", b"\xc0\x80", b"\xed\xa0\x80"]))
        expect_malformed(raw[:at] + bad + raw[at:], None)

    elif mutation == "not_an_object":
        wrapped = draw(st.sampled_from(["list", "string", "number", "null", "bool"]))
        value = {"list": [obj], "string": "x", "number": 1, "null": None, "bool": True}[wrapped]
        expect_malformed(dumps(value), None)

    else:  # pragma: no cover - every mutation above is handled
        raise AssertionError(mutation)


# --------------------------------------------------------------------------------------------
# Property 4
# --------------------------------------------------------------------------------------------


@pytest.mark.timeout(300)
@settings(deadline=None)
@given(st.data())
def test_schema_round_trip_and_robustness(data: st.DataObject) -> None:
    """Property 4: round trip, no raise, one broken rule and error.reported encoding.

    **Validates: Requirements 12.10, 21.8, 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7, 22.10,
    22.11, 29.6**
    """
    check_round_trip(data)
    check_error_reported_encoding(data)
    check_no_raise(data)
    check_one_broken_rule(data)
