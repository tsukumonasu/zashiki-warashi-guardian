"""Sequence reorder window for audio frames. Pure, no clock.

Mirrors ``cloud/lambda/_shared/voice/reorder.ts``. Delivers frames in increasing ``seq`` with no
duplicates. Holds at most ``window`` frames while waiting for a missing ``seq``; when more would be
held, it gives up on the gap, counts the skipped numbers in ``missed`` and delivers on. Frames
behind the delivery point are dropped.
"""

from __future__ import annotations

import math


class Reorder:
    def __init__(self, window: int | float) -> None:
        if isinstance(window, float) and not math.isfinite(window):
            window = 1
        self._size = max(1, math.floor(window))
        self._held: dict[int, str] = {}
        self._next: int | None = None  # next seq to deliver; set by the first frame
        self._missed = 0

    @property
    def missed(self) -> int:
        return self._missed

    def _drain(self, out: list[tuple[int, str]]) -> None:
        while self._next is not None and self._next in self._held:
            out.append((self._next, self._held.pop(self._next)))
            self._next += 1

    def push(self, seq: int, pcm: str) -> list[tuple[int, str]]:
        """Add a frame; return the frames now deliverable, in order, as ``(seq, pcm)``."""
        if isinstance(seq, bool) or not isinstance(seq, int) or seq < 0 or seq > 2**53 - 1:
            return []
        if self._next is None:
            self._next = seq
        if seq < self._next or seq in self._held:
            return []
        self._held[seq] = pcm
        out: list[tuple[int, str]] = []
        self._drain(out)
        while len(self._held) > self._size:
            lowest = min(self._held)
            self._missed += lowest - self._next
            self._next = lowest
            self._drain(out)
        return out
