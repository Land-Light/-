"""Shared test fixtures / fakes.

The controller talks to the screen and keyboard only through the ``Capturer``
and ``PageTurner`` protocols, so here we provide in-memory fakes that let the
whole capture loop run deterministically with no display.
"""

from __future__ import annotations

from typing import List

from PIL import Image


class ScriptedCapturer:
    """Replays a fixed list of pages.

    ``grab`` returns the page selected by an external "current index", which
    the fake turner advances. This models a real reader: grabbing repeatedly
    without turning yields the same page (used to test stability + end
    detection), and turning moves to the next one.
    """

    def __init__(self, pages: List[Image.Image]) -> None:
        self.pages = pages
        self.index = 0
        self.grabs = 0

    def grab(self) -> Image.Image:
        self.grabs += 1
        i = min(self.index, len(self.pages) - 1)
        return self.pages[i]

    def close(self) -> None:  # pragma: no cover - nothing to release
        pass


class ScriptedTurner:
    """Advances the shared capturer's page index, clamped at the last page."""

    def __init__(self, capturer: ScriptedCapturer) -> None:
        self.capturer = capturer
        self.turns = 0

    def turn(self) -> None:
        self.turns += 1
        # Clamp: past the end the reader just shows the final page again,
        # which is exactly what triggers duplicate/end detection.
        if self.capturer.index < len(self.capturer.pages) - 1:
            self.capturer.index += 1


def solid_page(color, size=(120, 160)) -> Image.Image:
    return Image.new("RGB", size, color)


def distinct_pages(n: int, size=(120, 160)) -> List[Image.Image]:
    """n visually different pages (a moving black bar on white)."""
    pages = []
    w, h = size
    for i in range(n):
        img = Image.new("RGB", size, "white")
        x = int((i + 1) / (n + 1) * (w - 10))
        for yy in range(20, h - 20):
            for xx in range(x, min(x + 10, w)):
                img.putpixel((xx, yy), (0, 0, 0))
        pages.append(img)
    return pages
