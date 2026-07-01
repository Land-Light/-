import numpy as np
from PIL import Image

from kindle2pdf.image_ops import (autocrop, content_ratio, frames_equal,
                                   mean_abs_diff, to_thumb)


def test_to_thumb_shape_and_type():
    img = Image.new("RGB", (300, 500), "white")
    t = to_thumb(img, 64)
    assert t.shape == (64, 64)
    assert t.dtype == np.float32


def test_identical_frames_zero_diff():
    img = Image.new("RGB", (200, 200), (123, 50, 20))
    a = to_thumb(img)
    b = to_thumb(img)
    assert mean_abs_diff(a, b) == 0.0
    assert frames_equal(a, b, 1.0)


def test_different_frames_large_diff():
    a = to_thumb(Image.new("RGB", (200, 200), "white"))
    b = to_thumb(Image.new("RGB", (200, 200), "black"))
    assert mean_abs_diff(a, b) > 200
    assert not frames_equal(a, b, 1.0)


def test_mean_abs_diff_shape_mismatch():
    a = np.zeros((8, 8), dtype=np.float32)
    b = np.zeros((4, 4), dtype=np.float32)
    try:
        mean_abs_diff(a, b)
    except ValueError:
        return
    raise AssertionError("expected ValueError on shape mismatch")


def test_autocrop_removes_uniform_border():
    img = Image.new("RGB", (100, 100), "white")
    # a 20x20 black block near the middle
    for y in range(40, 60):
        for x in range(40, 60):
            img.putpixel((x, y), (0, 0, 0))
    out = autocrop(img, tolerance=12, pad=2)
    # content is 20px; with 2px pad on each side we expect ~24px, well under 100
    assert out.width < 40 and out.height < 40
    assert out.width >= 20 and out.height >= 20


def test_autocrop_blank_page_unchanged():
    img = Image.new("RGB", (80, 80), "white")
    out = autocrop(img)
    assert out.size == img.size


def test_content_ratio_blank_is_low():
    blank = to_thumb(Image.new("RGB", (100, 100), "white"))
    assert content_ratio(blank) < 0.01
