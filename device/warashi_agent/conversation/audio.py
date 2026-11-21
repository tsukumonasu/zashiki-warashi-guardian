"""Pure PCM helpers for the voice conversation: gain, chunking, energy.

Standard library only (``array``); ``audioop`` is gone in Python 3.13. All
buffers are 16-bit little-endian mono PCM.
"""

from __future__ import annotations

import sys
from array import array

# Symmetric limits: -32768 is never produced, so clipping is the same on both sides.
_MAX_SAMPLE = 32767


def _to_samples(pcm: bytes) -> array:
    if len(pcm) % 2:
        raise ValueError("PCM buffer must have an even number of bytes")
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def apply_gain(pcm: bytes, gain: float) -> bytes:
    """Scale 16-bit little-endian samples by gain with clipping. Length is preserved.

    Gain 1.0 returns the input unchanged. Results are clipped to +-32767 so the
    clipping is symmetric, and a sample keeps its sign (or becomes zero).
    """
    if gain == 1.0:
        return pcm
    samples = _to_samples(pcm)
    for i, value in enumerate(samples):
        scaled = int(value * gain)  # truncates toward zero: sign is never flipped
        samples[i] = max(-_MAX_SAMPLE, min(_MAX_SAMPLE, scaled))
    if sys.byteorder == "big":
        samples.byteswap()
    return samples.tobytes()


def split_chunks(buffer: bytes, chunk_bytes: int) -> tuple[list[bytes], bytes]:
    """Return whole chunks and the remainder. Chunks are always an even number of bytes."""
    if chunk_bytes <= 0 or chunk_bytes % 2:
        raise ValueError("chunk_bytes must be a positive even number")
    whole = len(buffer) - len(buffer) % chunk_bytes
    chunks = [buffer[i : i + chunk_bytes] for i in range(0, whole, chunk_bytes)]
    return chunks, buffer[whole:]


def speech_energy(pcm: bytes) -> float:
    """Mean absolute sample value, 0..32768. Used for the local silence timer only."""
    samples = _to_samples(pcm)
    if not samples:
        return 0.0
    return sum(abs(v) for v in samples) / len(samples)
