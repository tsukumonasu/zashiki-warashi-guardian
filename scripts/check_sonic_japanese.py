"""Listening test: does Nova Sonic answer in Japanese? (voice-conversation task 19.1, step O3)

Owner tool. It needs the owner's AWS credentials and Bedrock access to the Nova Sonic model in
Tokyo, plays nothing, and is never part of ``make test`` or CI. It sends one Japanese text prompt
through a Nova Sonic bidirectional stream, prints the assistant transcript and its
``japaneseRatio``, and writes the answer as a WAV file into a git-ignored folder for listening.

Dependencies (owner's computer only, never the Pi): ``boto3`` resolves the credentials and
``aws_sdk_bedrock_runtime`` (the experimental Python SDK)
carries the HTTP/2 bidirectional stream, which ``boto3`` cannot do. Both are imported lazily,
so this module imports cleanly without credentials or either package.

Usage::

    python scripts/check_sonic_japanese.py [--voice tiffany] [--model amazon.nova-2-5-sonic]
                                           [--region ap-northeast-1] [--prompt TEXT]
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import json
import os
import struct
import sys
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT_DIR = ROOT / ".sonic-check-out"  # git-ignored (see .gitignore)

DEFAULT_REGION = "ap-northeast-1"
DEFAULT_MODEL_ID = "amazon.nova-2-5-sonic"
DEFAULT_VOICE_ID = "tiffany"
DEFAULT_PROMPT = "こんにちは。今日はどんな一日でしたか？ 短く教えてください。"
SYSTEM_PROMPT = (
    "あなたは日本の家を守る座敷わらしの人形です。やさしい日本語で、二文以内で短く答えてください。"
)

OUTPUT_SAMPLE_RATE = 24000  # Nova Sonic audio out: 24 kHz 16-bit mono LPCM.
MAX_WAIT_S = 60.0  # Give up on one answer after this long.

# Mirror of cloud/lambda/_shared/voice/language.ts.
MIN_LETTERS = 4
_JAPANESE_RANGES = (
    (0x3040, 0x309F),  # hiragana
    (0x30A0, 0x30FF),  # katakana, includes the prolonged sound mark U+30FC
    (0x31F0, 0x31FF),  # katakana phonetic extensions
    (0x3400, 0x4DBF),  # CJK extension A
    (0x4E00, 0x9FFF),  # CJK unified ideographs
    (0xF900, 0xFAFF),  # CJK compatibility ideographs
    (0x20000, 0x2FA1F),  # CJK extensions B to F, compatibility supplement
)


def _is_japanese_letter(ch: str) -> bool:
    code = ord(ch)
    return any(lo <= code <= hi for lo, hi in _JAPANESE_RANGES)


def japanese_ratio(text: object) -> float | None:
    """Share of letters that are kana or kanji (0..1), or None under four letters.

    Python port of ``japaneseRatio``. Never raises; a non-string gives None.
    """
    if not isinstance(text, str):
        return None
    letters = 0
    japanese = 0
    for ch in text:
        # ``str.isalpha`` is the Unicode letter test (categories L*), like ``\\p{L}`` in the cloud.
        if not ch.isalpha():
            continue
        letters += 1
        if _is_japanese_letter(ch):
            japanese += 1
    if letters < MIN_LETTERS:
        return None
    return japanese / letters


def pcm16_to_wav(pcm: bytes, sample_rate: int = OUTPUT_SAMPLE_RATE) -> bytes:
    """Wrap 16-bit mono little-endian PCM in a 44-byte RIFF/WAVE header."""
    if len(pcm) % 2 != 0:
        raise ValueError("PCM length must be even (16-bit samples)")
    header = (
        b"RIFF"
        + struct.pack("<I", 36 + len(pcm))
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
        + b"data"
        + struct.pack("<I", len(pcm))
    )
    return header + pcm


def build_input_events(
    prompt_name: str, voice_id: str, system_prompt: str, user_text: str
) -> list[str]:
    """The Nova Sonic input events for one text turn, in the documented order.

    sessionStart, promptStart, system text block, user text block (interactive), then the stream
    stays open until the answer arrives; ``end_events`` closes it.
    """

    def ev(name: str, body: dict[str, Any]) -> str:
        return json.dumps({"event": {name: body}}, ensure_ascii=False)

    def text_block(content_name: str, role: str, text: str, interactive: bool) -> list[str]:
        return [
            ev(
                "contentStart",
                {
                    "promptName": prompt_name,
                    "contentName": content_name,
                    "type": "TEXT",
                    "role": role,
                    "interactive": interactive,
                    "textInputConfiguration": {"mediaType": "text/plain"},
                },
            ),
            ev(
                "textInput",
                {"promptName": prompt_name, "contentName": content_name, "content": text},
            ),
            ev("contentEnd", {"promptName": prompt_name, "contentName": content_name}),
        ]

    events = [
        ev(
            "sessionStart",
            {"inferenceConfiguration": {"maxTokens": 1024, "topP": 0.9, "temperature": 0.7}},
        ),
        ev(
            "promptStart",
            {
                "promptName": prompt_name,
                "textOutputConfiguration": {"mediaType": "text/plain"},
                "audioOutputConfiguration": {
                    "mediaType": "audio/lpcm",
                    "sampleRateHertz": OUTPUT_SAMPLE_RATE,
                    "sampleSizeBits": 16,
                    "channelCount": 1,
                    "voiceId": voice_id,
                    "encoding": "base64",
                    "audioType": "SPEECH",
                },
            },
        ),
    ]
    events += text_block("system", "SYSTEM", system_prompt, False)
    events += text_block("user", "USER", user_text, True)
    return events


def end_events(prompt_name: str) -> list[str]:
    """``promptEnd`` and ``sessionEnd``, sent once the answer is complete."""
    return [
        json.dumps({"event": {"promptEnd": {"promptName": prompt_name}}}),
        json.dumps({"event": {"sessionEnd": {}}}),
    ]


class Collector:
    """Accumulates assistant text and audio from Nova Sonic output events (pure, testable)."""

    def __init__(self) -> None:
        self.texts: list[str] = []
        self.pcm = bytearray()
        self.done = False
        self._role: str | None = None

    def feed(self, raw: str) -> None:
        """Process one output event JSON string. Never raises on malformed input."""
        try:
            event = json.loads(raw).get("event", {})
        except (ValueError, AttributeError):
            return
        if not isinstance(event, dict):
            return
        if "contentStart" in event:
            self._role = event["contentStart"].get("role")
        elif "textOutput" in event:
            out = event["textOutput"]
            role = out.get("role", self._role)
            if role == "ASSISTANT" and isinstance(out.get("content"), str):
                self.texts.append(out["content"])
        elif "audioOutput" in event:
            content = event["audioOutput"].get("content")
            if isinstance(content, str):
                with contextlib.suppress(ValueError):
                    self.pcm += base64.b64decode(content)
        elif "completionEnd" in event:
            self.done = True

    @property
    def transcript(self) -> str:
        return "".join(self.texts)

    def wav(self) -> bytes:
        usable = len(self.pcm) - (len(self.pcm) % 2)
        return pcm16_to_wav(bytes(self.pcm[:usable]))


async def run_session(
    region: str, model_id: str, voice_id: str, prompt: str
) -> Collector:  # pragma: no cover - needs AWS
    """Run one text turn against Bedrock and return what the model produced."""
    import boto3  # noqa: PLC0415 - lazy: owner tool only
    from aws_sdk_bedrock_runtime.client import (  # noqa: PLC0415
        BedrockRuntimeClient,
        InvokeModelWithBidirectionalStreamOperationInput,
    )
    from aws_sdk_bedrock_runtime.config import (  # noqa: PLC0415
        Config,
        HTTPAuthSchemeResolver,
        SigV4AuthScheme,
    )
    from aws_sdk_bedrock_runtime.models import (  # noqa: PLC0415
        BidirectionalInputPayloadPart,
        InvokeModelWithBidirectionalStreamInputChunk,
    )
    from smithy_aws_core.credentials_resolvers.environment import (  # noqa: PLC0415
        EnvironmentCredentialsResolver,
    )

    creds = boto3.Session().get_credentials()
    if creds is None:
        raise SystemExit("No AWS credentials found. Run `aws login` or set a profile first.")
    frozen = creds.get_frozen_credentials()
    # The SDK reads credentials from the environment; they stay in this process only.
    os.environ["AWS_ACCESS_KEY_ID"] = frozen.access_key
    os.environ["AWS_SECRET_ACCESS_KEY"] = frozen.secret_key
    if frozen.token:
        os.environ["AWS_SESSION_TOKEN"] = frozen.token

    config = Config(
        endpoint_uri=f"https://bedrock-runtime.{region}.amazonaws.com",
        region=region,
        aws_credentials_identity_resolver=EnvironmentCredentialsResolver(),
        auth_scheme_resolver=HTTPAuthSchemeResolver(),
        auth_schemes={"aws.auth#sigv4": SigV4AuthScheme(service_name="bedrock")},
    )
    client = BedrockRuntimeClient(config=config)
    stream = await client.invoke_model_with_bidirectional_stream(
        InvokeModelWithBidirectionalStreamOperationInput(model_id=model_id)
    )

    async def send(raw: str) -> None:
        chunk = InvokeModelWithBidirectionalStreamInputChunk(
            value=BidirectionalInputPayloadPart(bytes_=raw.encode("utf-8"))
        )
        await stream.input_stream.send(chunk)

    prompt_name = str(uuid.uuid4())
    for raw in build_input_events(prompt_name, voice_id, SYSTEM_PROMPT, prompt):
        await send(raw)

    collector = Collector()
    _, output_stream = await stream.await_output()

    async def read() -> None:
        while not collector.done:
            item = await output_stream.receive()
            if item is None:
                return
            if item.value and item.value.bytes_:
                raw = item.value.bytes_.decode("utf-8")
                collector.feed(raw)
                if '"contentEnd"' in raw and '"END_TURN"' in raw:
                    for end in end_events(prompt_name):
                        await send(end)

    try:
        await asyncio.wait_for(read(), timeout=MAX_WAIT_S)
    finally:
        await stream.input_stream.close()
    return collector


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check that Nova Sonic answers in Japanese.")
    parser.add_argument("--region", default=DEFAULT_REGION)
    parser.add_argument("--model", default=DEFAULT_MODEL_ID)
    parser.add_argument("--voice", default=DEFAULT_VOICE_ID)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    collector = asyncio.run(run_session(args.region, args.model, args.voice, args.prompt))
    transcript = collector.transcript
    ratio = japanese_ratio(transcript)
    print(f"model:          {args.model} ({args.region})")
    print(f"voice:          {args.voice}")
    print(f"prompt:         {args.prompt}")
    print(f"transcript:     {transcript!r}")
    print(f"japaneseRatio:  {'n/a (under four letters)' if ratio is None else f'{ratio:.2f}'}")
    if collector.pcm:
        args.out_dir.mkdir(parents=True, exist_ok=True)
        path = args.out_dir / f"{args.voice}-{uuid.uuid4().hex[:8]}.wav"
        path.write_bytes(collector.wav())
        print(f"audio written:  {path} (listen to it yourself; nothing is played)")
    else:
        print("audio written:  none (the model returned no audio)")
    return 0 if ratio is not None and ratio >= 0.6 else 1


if __name__ == "__main__":
    sys.exit(main())
