"""Frame-stability and end-of-book detection.

Two small stateful helpers, kept free of any screen/keyboard I/O so the
tricky timing logic can be unit-tested with synthetic thumbnails.

* ``StableFrameWaiter`` decides when a freshly-turned page has finished
  rendering, so we never capture a half-drawn / animating frame (精度).
* ``EndDetector`` notices when turning the page no longer changes anything,
  which is how we stop automatically at the last page instead of guessing a
  page count.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from .image_ops import mean_abs_diff


class StableFrameWaiter:
    """Tracks successive probe thumbnails and reports when they settle."""

    def __init__(self, threshold: float) -> None:
        self.threshold = threshold
        self._prev: Optional[np.ndarray] = None

    def reset(self) -> None:
        self._prev = None

    def update(self, thumb: np.ndarray) -> bool:
        """Feed the latest probe; return True once the frame is stable.

        Stability means the current probe is within ``threshold`` of the
        previous one — i.e. the reader stopped repainting. The very first
        probe can never be "stable" because there is nothing to compare to.
        """
        stable = self._prev is not None and \
            mean_abs_diff(self._prev, thumb) <= self.threshold
        self._prev = thumb
        return stable


class EndDetector:
    """Counts consecutive captured pages that are duplicates of the prior one.

    When a page turn produces the same page ``limit`` times in a row we treat
    the book as finished. ``is_duplicate`` is exposed separately so the
    controller can avoid saving repeated pages into the PDF.
    """

    def __init__(self, threshold: float, limit: int) -> None:
        self.threshold = threshold
        self.limit = limit
        self._prev: Optional[np.ndarray] = None
        self.duplicate_streak = 0

    def reset(self) -> None:
        self._prev = None
        self.duplicate_streak = 0

    def is_duplicate(self, thumb: np.ndarray) -> bool:
        """Update state with a new captured page; True if it repeats the last."""
        if self._prev is not None and \
                mean_abs_diff(self._prev, thumb) <= self.threshold:
            self.duplicate_streak += 1
            return True
        self.duplicate_streak = 0
        self._prev = thumb
        return False

    @property
    def reached_end(self) -> bool:
        return self.duplicate_streak >= self.limit
