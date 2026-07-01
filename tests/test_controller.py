"""End-to-end tests of the capture loop using in-memory fakes.

No display, keyboard, or real timing: the fake capturer/turner model a reader,
and clock/sleep are stubbed so the loop runs instantly.
"""

from pathlib import Path

from kindle2pdf.config import CaptureConfig, Region
from kindle2pdf.controller import CaptureController

from conftest import ScriptedCapturer, ScriptedTurner, distinct_pages


def make_config(tmp_path, **over):
    cfg = CaptureConfig(
        region=Region(0, 0, 120, 160),
        start_delay=0.0,
        page_settle=0.0,
        stabilize_interval=0.0,
        stabilize_timeout=0.0,   # with a fake clock, take the first stable pair
        max_pages=50,
        end_after_duplicates=2,
        output_pdf=str(tmp_path / "out.pdf"),
        image_dir=str(tmp_path / "imgs"),
        autocrop=False,
    )
    for k, v in over.items():
        setattr(cfg, k, v)
    return cfg


class FakeClock:
    """Monotonic clock that advances a fixed step on each read."""
    def __init__(self, step=1.0):
        self.t = 0.0
        self.step = step

    def __call__(self):
        self.t += self.step
        return self.t


def build(tmp_path, n_pages, **over):
    pages = distinct_pages(n_pages)
    cap = ScriptedCapturer(pages)
    turner = ScriptedTurner(cap)
    cfg = make_config(tmp_path, **over)
    ctrl = CaptureController(cfg, cap, turner,
                             clock=FakeClock(step=10.0), sleep=lambda s: None)
    return ctrl, cap, turner


def test_captures_all_pages_and_detects_end(tmp_path):
    ctrl, cap, turner = build(tmp_path, 5)
    result = ctrl.run()
    # 5 unique pages captured, then the reader repeats the last page until the
    # end detector trips.
    assert result.pages_captured == 5
    assert result.reached_end is True
    assert result.output_pdf is not None
    assert Path(result.output_pdf).exists()
    assert Path(result.output_pdf).read_bytes().startswith(b"%PDF")


def test_no_duplicate_pages_saved(tmp_path):
    ctrl, cap, turner = build(tmp_path, 4)
    result = ctrl.run()
    assert result.pages_captured == 4  # not more, despite dup frames at the end


def test_max_pages_cap_respected(tmp_path):
    # Book longer than the cap: we should stop exactly at the cap.
    ctrl, cap, turner = build(tmp_path, 30, max_pages=10, end_after_duplicates=99)
    result = ctrl.run()
    assert result.pages_captured == 10
    assert result.reached_end is False


def test_request_stop_ends_early(tmp_path):
    ctrl, cap, turner = build(tmp_path, 20, end_after_duplicates=99)

    original = ctrl._grab_stable_frame

    def grab_then_maybe_stop():
        frame, thumb = original()
        if cap.index >= 3:
            ctrl.request_stop()
        return frame, thumb

    ctrl._grab_stable_frame = grab_then_maybe_stop
    result = ctrl.run()
    assert result.stopped_early is True
    assert result.pages_captured <= 5


def test_stop_before_first_page(tmp_path):
    # Stop requested before the loop starts is honoured on the first iteration
    # (the flag is re-cleared by run(), so we set it via a pre-loop hook).
    ctrl, cap, turner = build(tmp_path, 5, end_after_duplicates=99)
    real_run = ctrl.run

    # Set the flag right after run() clears it by patching the clock's first tick.
    original_grab = ctrl._grab_stable_frame
    calls = {"n": 0}

    def maybe_stop():
        ctrl.request_stop()   # stop after this first grab
        return original_grab()

    ctrl._grab_stable_frame = maybe_stop
    result = real_run()
    # Exactly one page is saved before the stop is seen at the next loop top.
    assert result.pages_captured == 1
    assert result.stopped_early is True
