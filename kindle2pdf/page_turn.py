"""Advance the Kindle reader to the next page.

Wraps ``pyautogui`` for keystrokes / clicks. Imported lazily so the pure
core and its tests never require a display or the input libraries.

A ``PageTurner`` is a callable-ish object with ``turn()``; the controller
depends only on that interface, so tests can inject a counter instead.
"""

from __future__ import annotations

from typing import Optional, Protocol, Tuple


class PageTurner(Protocol):
    def turn(self) -> None: ...


class KeyPageTurner:
    """Sends a single keystroke (e.g. Right arrow / PageDown) to turn a page."""

    def __init__(self, key: str = "right") -> None:
        self.key = key
        self._pg = None

    def _ensure(self):
        if self._pg is None:
            import pyautogui
            pyautogui.FAILSAFE = True   # slam mouse to a corner to abort
            pyautogui.PAUSE = 0.0       # we manage our own timing for speed
            self._pg = pyautogui
        return self._pg

    def turn(self) -> None:
        self._ensure().press(self.key)


class ClickPageTurner:
    """Clicks a fixed screen point (the reader's forward tap-zone)."""

    def __init__(self, point: Tuple[int, int]) -> None:
        self.point = point
        self._pg = None

    def _ensure(self):
        if self._pg is None:
            import pyautogui
            pyautogui.FAILSAFE = True
            pyautogui.PAUSE = 0.0
            self._pg = pyautogui
        return self._pg

    def turn(self) -> None:
        pg = self._ensure()
        pg.click(self.point[0], self.point[1])


def make_turner(config) -> PageTurner:
    """Build the right turner from a :class:`CaptureConfig`."""
    if config.turn_method == "click":
        if not config.click_point:
            raise ValueError("click turn method requires click_point")
        return ClickPageTurner(tuple(config.click_point))
    return KeyPageTurner(config.turn_key)
