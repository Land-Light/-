"""Pure image helpers used by the capture pipeline.

These functions only depend on Pillow + numpy, contain no I/O or global
state, and are therefore fully unit-testable in a headless environment.

The comparison helpers deliberately work on a tiny grayscale thumbnail: a
64x64 diff costs microseconds, which keeps the capture loop fast (作業速度)
while remaining sensitive enough to tell a rendered page from a
mid-transition frame or a duplicate (精度).
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from PIL import Image


def to_thumb(img: Image.Image, size: int = 64) -> np.ndarray:
    """Return a ``size`` x ``size`` grayscale float32 array for fast diffing.

    A fixed square shape makes two thumbnails directly comparable regardless
    of the source aspect ratio, and BOX resampling averages pixels so the
    result is stable against sub-pixel jitter.
    """
    thumb = img.convert("L").resize((size, size), Image.BOX)
    return np.asarray(thumb, dtype=np.float32)


def mean_abs_diff(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute difference (0..255) between two equally-shaped arrays."""
    if a.shape != b.shape:
        raise ValueError(f"shape mismatch: {a.shape} vs {b.shape}")
    return float(np.abs(a - b).mean())


def frames_equal(a: np.ndarray, b: np.ndarray, threshold: float) -> bool:
    """True when two thumbnails differ by no more than ``threshold``."""
    return mean_abs_diff(a, b) <= threshold


def autocrop(img: Image.Image, tolerance: int = 12, pad: int = 4) -> Image.Image:
    """Trim near-uniform margins (the reader chrome / page borders).

    The border colour is sampled from the four corners; any outer rows and
    columns whose pixels are all within ``tolerance`` of that colour are
    removed, then ``pad`` pixels are added back so text is never clipped.
    Returns the original image unchanged if nothing distinct is found.
    """
    rgb = img.convert("RGB")
    arr = np.asarray(rgb, dtype=np.int16)
    h, w = arr.shape[:2]
    if h == 0 or w == 0:
        return img

    corners = np.stack([arr[0, 0], arr[0, -1], arr[-1, 0], arr[-1, -1]])
    bg = corners.mean(axis=0)

    # A pixel is "content" if any channel is further than tolerance from bg.
    dist = np.abs(arr - bg).max(axis=2)
    mask = dist > tolerance

    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    if rows.size == 0 or cols.size == 0:
        return img  # blank / uniform page: leave it alone

    top = max(int(rows[0]) - pad, 0)
    bottom = min(int(rows[-1]) + 1 + pad, h)
    left = max(int(cols[0]) - pad, 0)
    right = min(int(cols[-1]) + 1 + pad, w)
    if left >= right or top >= bottom:
        return img
    return img.crop((left, top, right, bottom))


def content_ratio(thumb: np.ndarray, tolerance: int = 8) -> float:
    """Fraction of a thumbnail that differs from its border colour.

    Useful as a cheap "is this basically a blank page?" signal; a value near
    0 means the frame is almost entirely uniform.
    """
    if thumb.size == 0:
        return 0.0
    bg = float(np.median(np.concatenate([
        thumb[0, :], thumb[-1, :], thumb[:, 0], thumb[:, -1]
    ])))
    return float((np.abs(thumb - bg) > tolerance).mean())
