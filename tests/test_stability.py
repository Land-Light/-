import numpy as np

from kindle2pdf.stability import EndDetector, StableFrameWaiter


def thumb(val):
    return np.full((8, 8), float(val), dtype=np.float32)


def test_waiter_first_probe_never_stable():
    w = StableFrameWaiter(threshold=1.0)
    assert w.update(thumb(10)) is False


def test_waiter_settles_when_probes_agree():
    w = StableFrameWaiter(threshold=1.0)
    w.update(thumb(10))
    # next probe very different -> still repainting
    assert w.update(thumb(200)) is False
    # now two agree -> stable
    assert w.update(thumb(200)) is True


def test_end_detector_flags_duplicates_and_end():
    d = EndDetector(threshold=1.0, limit=2)
    assert d.is_duplicate(thumb(10)) is False   # first page
    assert d.is_duplicate(thumb(20)) is False   # new page
    assert d.is_duplicate(thumb(20)) is True    # dup #1
    assert d.reached_end is False
    assert d.is_duplicate(thumb(20)) is True    # dup #2
    assert d.reached_end is True


def test_end_detector_streak_resets_on_change():
    d = EndDetector(threshold=1.0, limit=2)
    d.is_duplicate(thumb(10))
    d.is_duplicate(thumb(10))                   # dup, streak=1
    assert d.duplicate_streak == 1
    d.is_duplicate(thumb(99))                   # changed -> reset
    assert d.duplicate_streak == 0
    assert d.reached_end is False
