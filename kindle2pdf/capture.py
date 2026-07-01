"""Fast screen-region capture.

Wraps ``mss`` (the fastest cross-platform grabber available from Python) so
each frame costs a few milliseconds. ``mss`` is imported lazily and each
capturer keeps its own ``mss`` instance, because the library's objects are
not safe to share across threads.
"""

from __future__ import annotations

from typing import Protocol

from PIL import Image

from .config import Region


class Capturer(Protocol):
    """Anything that can return the current contents of the capture region.

    Declaring this Protocol lets the controller be tested with a fake
    capturer that replays a scripted sequence of pages.
    """

    def grab(self) -> Image.Image: ...
    def close(self) -> None: ...


class ScreenCapturer:
    """Grabs a fixed desktop rectangle as a Pillow RGB image."""

    def __init__(self, region: Region) -> None:
        if not region.is_valid:
            raise ValueError("capture region is not set")
        self.region = region
        self._monitor = region.as_mss_dict()
        self._sct = None  # created on first use, on the calling thread

    def _ensure(self):
        if self._sct is None:
            import mss  # lazy: only needed on a machine with a display
            self._sct = mss.mss()
        return self._sct

    def grab(self) -> Image.Image:
        sct = self._ensure()
        shot = sct.grab(self._monitor)
        # mss gives BGRA; Image.frombytes with "raw","BGRX" reorders channels
        # without an intermediate copy, which keeps the grab cheap.
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")

    def close(self) -> None:
        if self._sct is not None:
            self._sct.close()
            self._sct = None


def list_monitors() -> list:
    """Return the geometry of every monitor (index 0 is the virtual union)."""
    import mss
    with mss.mss() as sct:
        return list(sct.monitors)


def primary_monitor_region() -> Region:
    """Full-screen capture region for the primary monitor.

    Handy when the reader is shown full-screen and there is nothing to select
    by hand. ``mss`` reports monitor 1 as the primary display (index 0 is the
    virtual union of all monitors); auto-crop later trims any uniform borders.
    """
    import mss
    with mss.mss() as sct:
        mons = sct.monitors
        m = mons[1] if len(mons) > 1 else mons[0]
        return Region(m["left"], m["top"], m["width"], m["height"])
